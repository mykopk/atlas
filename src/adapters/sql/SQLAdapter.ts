import type { PoolClient } from "pg";
import { Pool } from "pg";
import type {
  SQLAdapterConfig,
  Transaction,
  DatabaseResult,
  PaginatedResult,
  QueryOptions,
  DatabaseHealthStatus,
  Filter,
  DatabaseAdapterType,
} from "@myko.pk/types/db";
import { failure, success } from "@utils/databaseResultHelpers";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";
import { calculatePagination } from "@utils/pagination";
import { isNonEmptyString, isObject } from "@utils/typeGuards";
import { DB_REGEX } from "@utils/regex";

/**
 * Maximum number of characters of the SQL string to include in error messages.
 * Longer queries are truncated with "..." to keep error output readable.
 */
const SQL_ERROR_TRUNCATE_LENGTH = 500;

/**
 * Plain SQL adapter implementation for raw parameterised queries.
 *
 * @description
 * Provides a direct SQL interface on top of PostgreSQL's `node-pg` driver without
 * any ORM layer. Supports CRUD operations, transactions, health checks, schema-qualified
 * table names, and optional SQL-in-error-message debugging.
 *
 * Tables may be manually registered via `registerTable` or auto-registered on first
 * access. ID columns can be configured globally through `tableIdColumns` in the config
 * or overridden per table at registration time.
 *
 * This adapter is ideal when you need full control over SQL or need to use
 * database-specific features not exposed by ORM abstractions.
 */
export class SQLAdapter implements DatabaseAdapterType {
  private pool: Pool;
  private config: SQLAdapterConfig;
  private tableMap: Map<string, string> = new Map();
  private idColumnMap: Map<string, string> = new Map();
  private configIdColumns: Record<string, string>;
  private defaultSchema: string;
  private showSqlInErrors: boolean;

  /**
   * Create a new SQLAdapter instance.
   *
   * @description
   * Initialises the PostgreSQL connection pool and stores adapter configuration.
   * Reads the optional schema (defaults to "public"), the showSqlInErrors flag
   * (defaults to true), and any custom ID-column mappings from config.
   *
   * @param config - Adapter configuration including connectionString, pool settings,
   *                 schema, tableIdColumns and showSqlInErrors
   */
  constructor(config: SQLAdapterConfig) {
    this.config = config;
    this.defaultSchema = config.schema ?? "public";
    this.showSqlInErrors = config.showSqlInErrors ?? true;
    this.pool = new Pool({
      connectionString: config.connectionString,
      ...config.pool,
    });
    // Store custom ID column mappings from config
    this.configIdColumns = config.tableIdColumns ?? {};
  }

  /**
   * Return the fully-qualified table name including schema.
   *
   * @description
   * Prepends the schema namespace to the table name. If the table already
   * contains a dot (e.g. "tenant_acme.users") it is returned as-is.
   *
   * @param table - The table name (may already be schema-qualified)
   * @param schema - Optional schema override; defaults to this.defaultSchema
   * @returns The qualified table name (e.g. "public.users")
   */
  private getQualifiedTableName(table: string, schema?: string): string {
    const targetSchema = schema ?? this.defaultSchema;

    // If table already has schema prefix (e.g., "tenant_acme.users"), use as-is
    if (table.includes(".")) {
      return table;
    }

    // Apply schema prefix
    return `${targetSchema}.${table}`;
  }

  /**
   * Initialise the adapter and verify connectivity.
   *
   * @description
   * Acquires a client from the pool and, if a non-default schema is configured,
   * sets the search_path. The client is released immediately after. Returns a
   * DatabaseResult rather than throwing.
   *
   * @returns A success result if the pool is reachable, failure otherwise
   */
  async initialize(): Promise<DatabaseResult<void>> {
    try {
      const client = await this.pool.connect();

      // Set search_path for the connection if schema is configured
      if (this.defaultSchema && this.defaultSchema !== "public") {
        await client.query(`SET search_path TO ${this.defaultSchema}, public`);
      }

      client.release();
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to initialize PlainSQL adapter: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.INIT_FAILED,
          {
            context: {
              source: "SQLAdapter.initialize",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Establish a database connection from the pool.
   *
   * @description
   * Acquires a single client from the pool to verify connectivity. The client
   * is not explicitly released here — a subsequent release happens implicitly
   * when the pool recycles it.
   *
   * @throws {DatabaseError} When no connection can be established
   */
  async connect(): Promise<void> {
    await this.pool.connect();
  }

  /**
   * Gracefully shut down the connection pool.
   *
   * @description
   * Closes all idle connections and waits for active queries to finish.
   * Should be called during application shutdown.
   *
   * @throws {DatabaseError} When the pool fails to shut down
   */
  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Close the database connection, returning a DatabaseResult.
   *
   * @description
   * Delegates to disconnect() but catches errors and returns a failure
   * result instead of throwing.
   *
   * @returns A success result on clean shutdown, failure otherwise
   */
  async close(): Promise<DatabaseResult<void>> {
    try {
      await this.disconnect();
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to close connection: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DISCONNECT_FAILED,
        ),
      );
    }
  }

  /**
   * Return the underlying PostgreSQL connection pool.
   *
   * @template TClient - Type to cast the pool to (defaults to object)
   * @returns The pg Pool instance, cast to the requested type
   */
  getClient<TClient extends object = object>(): TClient {
    return this.pool as TClient;
  }

  /**
   * Execute a raw SQL query against the database.
   *
   * @description
   * Runs a parameterised SQL string directly via the pg pool. When
   * showSqlInErrors is enabled (default), a truncated copy of the SQL is
   * included in error messages to aid debugging.
   *
   * @template TResult - The row shape returned by the query
   * @template TParams - The SQL parameter type (default unknown)
   * @param sql - The SQL statement to execute
   * @param params - Optional parameterised values
   * @returns An array of result rows
   * @throws {DatabaseError} When the query fails
   */
  async query<TResult, TParams = unknown>(
    sql: string,
    params?: TParams[],
  ): Promise<TResult[]> {
    try {
      const result = await this.pool.query(sql, params);
      return result.rows as TResult[];
    } catch (error) {
      // Optionally include SQL in error message for debugging (default: true)
      const truncatedSql = sql.slice(0, SQL_ERROR_TRUNCATE_LENGTH);
      const sqlSuffix = sql.length > SQL_ERROR_TRUNCATE_LENGTH ? "..." : "";
      const errorMessage = this.showSqlInErrors
        ? `SQL Error: ${(error as Error).message}\n  Query: ${truncatedSql}${sqlSuffix}`
        : `SQL Error: ${(error as Error).message}`;

      throw new DatabaseError(errorMessage, DATABASE_ERROR_CODES.QUERY_FAILED, {
        context: {
          source: "SQLAdapter.query",
        },
        cause: error as Error,
      });
    }
  }

  /**
   * Register a table and optional ID column.
   *
   * @description
   * Maps a logical table name to its physical name and optionally registers
   * the primary-key column. If `idColumn` is omitted the value is resolved
   * from config or falls back to "id" at query time.
   *
   * @param name - Logical name used to reference the table in subsequent calls
   * @param table - Physical table name (string)
   * @param idColumn - Optional primary-key column name
   */
  registerTable<TTable, TIdColumn>(
    name: string,
    table?: TTable,
    idColumn?: TIdColumn,
  ): void {
    this.tableMap.set(name, table as string);

    if (idColumn) {
      this.idColumnMap.set(name, idColumn as string);
    }
  }

  /**
   * Find a single record by its primary-key value.
   *
   * @description
   * Constructs a SELECT ... WHERE "idColumn" = $1 LIMIT 1 query using the
   * qualified table name and resolved ID column. Validates basic parameters
   * before executing. Returns null when no matching record is found.
   *
   * @template T - The expected record type
   * @param table - Logical or physical table name
   * @param id - The primary-key value to look up
   * @returns A DatabaseResult containing the record or null if not found
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    try {
      const validationError = this.validateBasicParams(table, id);
      if (validationError) return failure(validationError);

      const tableName = this.getTableName(table);
      const qualifiedTable = this.getQualifiedTableName(tableName);
      const idColumn = this.getIdColumn(table);
      const sql = `SELECT * FROM ${qualifiedTable} WHERE "${idColumn}" = $1`;
      const result = await this.pool.query(sql, [id]);

      if (!result?.rows) {
        return failure(
          new DatabaseError(
            "Invalid query result",
            DATABASE_ERROR_CODES.INVALID_RESULT,
          ),
        );
      }

      return success((result.rows?.[0] as T) ?? null);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to find record: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.FIND_BY_ID_FAILED,
          {
            context: {
              source: "SQLAdapter.findById",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Find multiple records with filtering, sorting and pagination.
   *
   * @description
   * Runs a COUNT(*) query first to calculate total matching records, then
   * executes the main SELECT with optional WHERE, ORDER BY, LIMIT and OFFSET
   * clauses. Supports single or multiple filters (AND-combined). All user
   * values are passed as positional parameters to prevent SQL injection.
   *
   * @template T - The expected record type
   * @param table - Logical or physical table name
   * @param options - Query options including filters, sort, and pagination
   * @returns A DatabaseResult containing paginated data, total count and pagination metadata
   */
  // eslint-disable-next-line complexity
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    try {
      const tableName = this.getTableName(table);
      const qualifiedTable = this.getQualifiedTableName(tableName);
      const params: Object[] = [];
      let whereClause = "";
      let paramIndex = 1;

      // Build WHERE clause — prefer multi-filter array, fall back to single filter
      const filters = options?.filters?.length ? options.filters : options?.filter ? [options.filter] : [];
      if (filters.length > 0) {
        whereClause = this.buildWhereClauseFromFilters(filters, params, paramIndex);
        paramIndex += params.length;
      }

      // Count total
      const countSql = `SELECT COUNT(*) as total FROM ${qualifiedTable}${whereClause}`;
      const countResult = await this.pool.query(countSql, params);

      if (!countResult.rows || countResult.rows.length === 0) {
        throw new DatabaseError(
          "Count query returned no results",
          DATABASE_ERROR_CODES.COUNT_NO_RESULTS,
        );
      }

      const total = Number.parseInt(countResult.rows[0].total);
      if (isNaN(total) || total < 0) {
        throw new DatabaseError(
          "Invalid count result",
          DATABASE_ERROR_CODES.INVALID_COUNT,
        );
      }

      // ORDER BY clause
      let orderClause = "";
      if (options?.sort?.length) {
        orderClause =
          " ORDER BY " +
          options.sort
            .map((s) => `${s.field} ${s.direction.toUpperCase()}`)
            .join(", ");
      }

      // LIMIT & OFFSET
      let limitClause = "";
      if (options?.pagination?.limit) {
        limitClause += ` LIMIT $${paramIndex++}`;
        params.push(options.pagination.limit);
      }
      if (options?.pagination?.offset) {
        limitClause += ` OFFSET $${paramIndex++}`;
        params.push(options.pagination.offset);
      }

      // Final query
      const sql = `SELECT * FROM ${qualifiedTable}${whereClause}${orderClause}${limitClause}`;
      const result = await this.pool.query(sql, params);

      return success({
        data: result.rows as T[],
        total,
        pagination: calculatePagination(total, options?.pagination),
      });
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to find many in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.FIND_MANY_FAILED,
          {
            context: {
              source: "SQLAdapter.findMany",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Create a new record.
   *
   * @description
   * Constructs an INSERT INTO ... RETURNING * query with escaped column names
   * and positional value placeholders. Validates input parameters and field
   * names before executing. Returns the created record with any server-generated
   * fields (auto-increment IDs, defaults).
   *
   * @template T - The record data type
   * @param table - Logical or physical table name
   * @param data - The record data to insert
   * @returns A DatabaseResult containing the created record
   */
  async create<T>(table: string, data: T): Promise<DatabaseResult<T>> {
    try {
      const validationError = this.validateCreateParams(table, data);
      if (validationError) return failure(validationError);

      const tableName = this.getTableName(table);
      const qualifiedTable = this.getQualifiedTableName(tableName);
      const keys = Object.keys(data as Record<string, T>);
      const values = Object.values(data as Record<string, T>);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
      const escapedKeys = keys.map((k) => `"${k}"`).join(", ");

      const sql = `INSERT INTO ${qualifiedTable} (${escapedKeys}) VALUES (${placeholders}) RETURNING *`;
      const result = await this.pool.query(sql, values);

      if (!result?.rows?.length) {
        return failure(
          new DatabaseError(
            "Insert operation failed",
            DATABASE_ERROR_CODES.INSERT_FAILED,
          ),
        );
      }

      return success(result.rows[0] as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to create record: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.CREATE_FAILED,
          {
            context: {
              source: "SQLAdapter.create",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Update an existing record by its primary-key value.
   *
   * @description
   * Constructs an UPDATE ... SET ... WHERE ... RETURNING * query. Only the
   * fields present in `data` are included in the SET clause (partial update).
   * Validates input parameters and field names before executing.
   *
   * @template T - The record data type
   * @param table - Logical or physical table name
   * @param id - The primary-key value of the record to update
   * @param data - Partial record data containing only changed fields
   * @returns A DatabaseResult containing the updated record
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    try {
      const validationError = this.validateUpdateParams(table, id, data);
      if (validationError) return failure(validationError);

      const tableName = this.getTableName(table);
      const qualifiedTable = this.getQualifiedTableName(tableName);
      const keys = Object.keys(data as Record<string, T>);
      const values = Object.values(data as Record<string, T>);
      const setClause = keys.map((key, i) => `"${key}" = $${i + 1}`).join(", ");
      const idColumn = this.getIdColumn(table);

      const sql = `UPDATE ${qualifiedTable} SET ${setClause} WHERE "${idColumn}" = $${keys.length + 1} RETURNING *`;
      const result = await this.pool.query(sql, [...values, id]);

      if (!result.rows?.length) {
        return failure(
          new DatabaseError(
            "Record not found or no changes made",
            DATABASE_ERROR_CODES.UPDATE_NO_CHANGES,
          ),
        );
      }

      return success(result.rows[0] as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to update record: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: {
              source: "SQLAdapter.update",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Delete a record by its primary-key value.
   *
   * @description
   * Constructs a DELETE FROM ... WHERE ... query. Returns success even when
   * no rows were matched (the operation is still valid).
   *
   * @param table - Logical or physical table name
   * @param id - The primary-key value of the record to delete
   * @returns A DatabaseResult indicating success or failure
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    try {
      if (!table || !id) {
        return failure(
          new DatabaseError(
            "Invalid parameters",
            DATABASE_ERROR_CODES.INVALID_PARAMS,
          ),
        );
      }

      const tableName = this.getTableName(table);
      const qualifiedTable = this.getQualifiedTableName(tableName);
      const idColumn = this.getIdColumn(table);
      const sql = `DELETE FROM ${qualifiedTable} WHERE "${idColumn}" = $1`;
      const result = await this.pool.query(sql, [id]);

      if (!result) {
        return failure(
          new DatabaseError(
            "Delete operation failed",
            DATABASE_ERROR_CODES.DELETE_FAILED,
          ),
        );
      }

      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to delete record: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: {
              source: "SQLAdapter.delete",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Execute a callback within a database transaction.
   *
   * @description
   * Acquires a dedicated PoolClient, begins a transaction (BEGIN), and creates
   * a scoped Transaction object mirroring the adapter's CRUD methods
   * (findById, create, update, delete, updateMany, deleteMany, upsert).
   * Automatically commits on success or rolls back on error. The dedicated
   * client is always released in the finally block.
   *
   * @template T - The return type of the callback
   * @param callback - Function that receives a scoped Transaction object
   * @returns A DatabaseResult containing the callback's return value
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const trx: Transaction = {
        findById: async <T>(table: string, id: string) => {
          const tableName = this.getTableName(table);
          const qualifiedTable = this.getQualifiedTableName(tableName);
          const idColumn = this.getIdColumn(table);
          const sql = `SELECT * FROM ${qualifiedTable} WHERE "${idColumn}" = $1`;
          const result = await client.query(sql, [id]);
          return success((result.rows[0] as T) ?? null);
        },
        create: async <T>(table: string, data: T) => {
          const tableName = this.getTableName(table);
          const qualifiedTable = this.getQualifiedTableName(tableName);
          const keys = Object.keys(data as Record<string, T>);
          const values = Object.values(data as Record<string, T>);
          const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
          const escapedKeys = keys.map((k) => `"${k}"`).join(", ");

          const sql = `INSERT INTO ${qualifiedTable} (${escapedKeys}) VALUES (${placeholders}) RETURNING *`;
          const result = await client.query(sql, values);
          return success(result.rows[0] as T);
        },
        update: async <T>(table: string, id: string, data: Partial<T>) => {
          const tableName = this.getTableName(table);
          const qualifiedTable = this.getQualifiedTableName(tableName);
          const keys = Object.keys(data as Record<string, T>);
          const values = Object.values(data as Record<string, T>);
          const setClause = keys
            .map((key, i) => `"${key}" = $${i + 1}`)
            .join(", ");
          const idColumn = this.getIdColumn(table);

          const sql = `UPDATE ${qualifiedTable} SET ${setClause} WHERE "${idColumn}" = $${keys.length + 1} RETURNING *`;
          const result = await client.query(sql, [...values, id]);
          return success(result.rows[0] as T);
        },
        delete: async (table: string, id: string) => {
          const tableName = this.getTableName(table);
          const qualifiedTable = this.getQualifiedTableName(tableName);
          const idColumn = this.getIdColumn(table);
          const sql = `DELETE FROM ${qualifiedTable} WHERE "${idColumn}" = $1`;
          await client.query(sql, [id]);
          return success();
        },
        updateMany: async (table: string, where: Record<string, any>, data: Record<string, any>) => {
          const tableName = this.getTableName(table);
          const qualifiedTable = this.getQualifiedTableName(tableName);
          const setKeys = Object.keys(data);
          const setClause = setKeys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
          const whereEntries = Object.entries(where);
          const whereClause = whereEntries.map(([k], i) => `"${k}" = $${setKeys.length + i + 1}`).join(" AND ");
          const sql = `UPDATE ${qualifiedTable} SET ${setClause} WHERE ${whereClause}`;
          const result = await client.query(sql, [...Object.values(data), ...Object.values(where)]);
          return success(result.rowCount ?? 0);
        },
        deleteMany: async (table: string, where: Record<string, any>) => {
          const tableName = this.getTableName(table);
          const qualifiedTable = this.getQualifiedTableName(tableName);
          const whereEntries = Object.entries(where);
          const whereClause = whereEntries.map(([k], i) => `"${k}" = $${i + 1}`).join(" AND ");
          const sql = `DELETE FROM ${qualifiedTable} WHERE ${whereClause}`;
          const result = await client.query(sql, Object.values(where));
          return success(result.rowCount ?? 0);
        },
        upsert: async <T>(table: string, where: Record<string, any>, create: Record<string, any>, update: Record<string, any>) => {
          const tableName = this.getTableName(table);
          const qualifiedTable = this.getQualifiedTableName(tableName);
          const conflictCols = Object.keys(where).map((k) => `"${k}"`).join(", ");
          const allData = { ...create, ...update };
          const keys = Object.keys(allData);
          const values = Object.values(allData);
          const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
          const escapedKeys = keys.map((k) => `"${k}"`).join(", ");
          const updateSet = keys.map((k) => `"${k}" = EXCLUDED."${k}"`).join(", ");
          const sql = `INSERT INTO ${qualifiedTable} (${escapedKeys}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSet} RETURNING *`;
          const result = await client.query(sql, values);
          return success(result.rows[0] as T);
        },
        commit: async () => {
          await client.query("COMMIT");
        },
        rollback: async () => {
          await client.query("ROLLBACK");
        },
      };

      const result = await callback(trx);
      await trx.commit();
      return success(result);
    } catch (error) {
      await client.query("ROLLBACK");
      return failure(
        new DatabaseError(
          `Transaction failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.TRANSACTION_FAILED,
          {
            context: {
              source: "SQLAdapter.transaction",
            },
            cause: error as Error,
          },
        ),
      );
    } finally {
      client.release();
    }
  }

  /**
   * Check whether a record with the given primary-key value exists.
   *
   * @description
   * Executes SELECT 1 ... WHERE "idColumn" = $1 LIMIT 1. Returns true if at
   * least one matching row is found.
   *
   * @param table - Logical or physical table name
   * @param id - The primary-key value to check
   * @returns A DatabaseResult containing true if the record exists
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    try {
      const tableName = this.getTableName(table);
      const qualifiedTable = this.getQualifiedTableName(tableName);
      const idColumn = this.getIdColumn(table);
      const sql = `SELECT 1 FROM ${qualifiedTable} WHERE "${idColumn}" = $1 LIMIT 1`;
      const result = await this.pool.query(sql, [id]);
      return success(result.rows.length > 0);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to check existence in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.EXISTS_FAILED,
          {
            context: {
              source: "SQLAdapter.exists",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Count records matching an optional filter.
   *
   * @description
   * Constructs a SELECT COUNT(*) query with an optional WHERE clause built
   * from the provided filter(s). Accepts a single filter or an array of
   * filters which are combined with AND.
   *
   * @param table - Logical or physical table name
   * @param filter - Optional filter or array of filters
   * @returns A DatabaseResult containing the count of matching records
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T> | Filter<T>[],
  ): Promise<DatabaseResult<number>> {
    try {
      const tableName = this.getTableName(table);
      const qualifiedTable = this.getQualifiedTableName(tableName);
      let whereClause = "";
      let params: object[] = [];

      const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
      if (filters.length > 0) {
        whereClause = this.buildWhereClauseFromFilters(filters, params, 1);
      }

      const sql = `SELECT COUNT(*) as count FROM ${qualifiedTable}${whereClause}`;
      const result = await this.pool.query(sql, params);
      const rowCount = Number.parseInt(result.rows[0].count);
      return success(Number(rowCount));
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to count in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.COUNT_FAILED,
          {
            context: {
              source: "SQLAdapter.count",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Perform a health check against the database.
   *
   * @description
   * Executes a simple SELECT 1 query and measures response time. Returns
   * the health status including isHealthy flag, responseTime in ms, and
   * adapter details. Does not throw — connectivity errors are captured in
   * the returned status.
   *
   * @returns A DatabaseResult containing the health status
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    const startTime = Date.now();
    try {
      await this.pool.query("SELECT 1");
      const responseTime = Date.now() - startTime;
      return success({
        isHealthy: true,
        responseTime,
        details: { adapter: "sql" },
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return success({
        isHealthy: false,
        responseTime,
        details: { adapter: "sql", error: (error as Error).message },
      });
    }
  }

  /**
   * Resolve a logical table name to its physical name, auto-registering if absent.
   *
   * @description
   * Looks up the table map. When no entry exists the table is auto-registered
   * with itself as the physical name and any config-provided ID column is
   * associated.
   *
   * @param name - Logical table name to resolve
   * @returns The physical table name
   */
  private getTableName(name: string): string {
    let tableName = this.tableMap.get(name);
    if (!tableName) {
      // Auto-register table with same name
      // Only set ID column from config if not already registered (runtime override takes precedence)
      const hasRuntimeIdColumn = this.idColumnMap.has(name);
      const customIdColumn = hasRuntimeIdColumn
        ? undefined
        : this.configIdColumns[name];
      this.registerTable(name, name, customIdColumn);
      tableName = name;
    }
    return tableName;
  }

  /**
   * Resolve the ID column name for a given table.
   *
   * @description
   * Checks runtime-registered ID columns first, then config-provided columns,
   * and finally falls back to "id".
   *
   * @param table - Logical table name
   * @returns The column name used as the primary key
   */
  private getIdColumn(table: string): string {
    // Check runtime registered first
    const runtimeIdColumn = this.idColumnMap.get(table);
    if (runtimeIdColumn) {
      return runtimeIdColumn;
    }

    // Check config-provided ID columns
    const configIdColumn = this.configIdColumns[table];
    if (configIdColumn) {
      return configIdColumn;
    }

    // Default to 'id'
    return "id";
  }

  /**
   * Validate basic findById / delete parameters.
   *
   * @description
   * Returns a DatabaseError if either table or id is falsy, otherwise null.
   *
   * @param table - The table name to check
   * @param id - The ID value to check
   * @returns A DatabaseError when invalid, or null if valid
   */
  private validateBasicParams(table: string, id: string): DatabaseError | null {
    if (!table || !id) {
      return new DatabaseError(
        "Invalid parameters",
        DATABASE_ERROR_CODES.INVALID_PARAMS,
      );
    }
    return null;
  }

  /**
   * Validate create parameters.
   *
   * @description
   * Ensures the table name is non-empty, data is an object with at least one
   * key, and every field name passes the DB_REGEX field-name validator.
   *
   * @param table - The table name to check
   * @param data - The data object to validate
   * @returns A DatabaseError when invalid, or null if valid
   */
  private validateCreateParams<T>(
    table: string,
    data: T,
  ): DatabaseError | null {
    if (!isNonEmptyString(table) || !isObject(data)) {
      return new DatabaseError(
        "Invalid parameters",
        DATABASE_ERROR_CODES.INVALID_PARAMS,
      );
    }

    const keys = Object.keys(data as Record<string, T>);
    if (keys.length === 0) {
      return new DatabaseError(
        "No data to insert",
        DATABASE_ERROR_CODES.NO_DATA,
      );
    }

    for (const key of keys) {
      if (!DB_REGEX.isValidFieldName(key)) {
        return new DatabaseError(
          "Invalid field name",
          DATABASE_ERROR_CODES.INVALID_FIELD_NAME,
        );
      }
    }
    return null;
  }

  /**
   * Validate update parameters.
   *
   * @description
   * Ensures table and id are non-empty, data is an object with at least one
   * key, and every field name passes the DB_REGEX field-name validator.
   *
   * @param table - The table name to check
   * @param id - The ID value to check
   * @param data - The partial data object to validate
   * @returns A DatabaseError when invalid, or null if valid
   */
  private validateUpdateParams<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): DatabaseError | null {
    if (!isNonEmptyString(table) || !isNonEmptyString(id) || !isObject(data)) {
      return new DatabaseError(
        "Invalid parameters for update operation",
        DATABASE_ERROR_CODES.INVALID_UPDATE_PARAMS,
      );
    }

    const keys = Object.keys(data as Record<string, T>);
    if (keys.length === 0) {
      return new DatabaseError(
        "No fields to update",
        DATABASE_ERROR_CODES.NO_UPDATE_FIELDS,
      );
    }

    for (const key of keys) {
      if (!DB_REGEX.isValidFieldName(key)) {
        return new DatabaseError(
          "Invalid field name",
          DATABASE_ERROR_CODES.INVALID_FIELD_NAME,
        );
      }
    }
    return null;
  }

  /**
   * Build a WHERE clause from multiple filters, AND-combined.
   *
   * @description
   * Delegates to buildWhereClause for each filter and joins the resulting
   * conditions with AND. For a single filter the output is returned directly
   * without the AND join.
   *
   * @param filters - Array of filter conditions to combine
   * @param params - Mutable array collecting SQL parameter values
   * @param startIndex - The starting $N placeholder index
   * @returns A SQL WHERE clause string (e.g. ` WHERE "name" = $1 AND "age" > $2`)
   */
  private buildWhereClauseFromFilters<T extends object>(
    filters: Filter<T>[],
    params: unknown[],
    startIndex: number,
  ): string {
    if (filters.length === 0) return '';
    if (filters.length === 1) return this.buildWhereClause(filters[0], params, startIndex);

    const conditions: string[] = [];
    let currentIndex = startIndex;

    for (const filter of filters) {
      const paramsBefore = params.length;
      const clause = this.buildWhereClause(filter, params, currentIndex);
      // Strip " WHERE " prefix to get just the condition
      conditions.push(clause.replace(/^ WHERE /, ''));
      currentIndex += params.length - paramsBefore;
    }

    return ` WHERE ${conditions.join(' AND ')}`;
  }

  /**
   * Build a SQL WHERE clause fragment from a single filter.
   *
   * @description
   * Converts a filter (field + operator + value) into a parameterised SQL
   * fragment. Supports eq, ne, gt, gte, lt, lte, in, like, ilike, between,
   * isNull, and isNotNull operators. Values are appended to the params array
   * and referenced via $N placeholders. Throws DatabaseError for unsupported
   * operators or invalid value types.
   *
   * @param filter - A single filter condition (field, operator, value)
   * @param params - Mutable array collecting SQL parameter values
   * @param startIndex - The starting $N placeholder index
   * @returns A SQL WHERE clause string (e.g. ` WHERE "name" = $1`)
   * @throws {DatabaseError} When the operator is unsupported or the value type
   *                         is invalid for the operator
   */
  private buildWhereClause<T extends object, TParams extends object[]>(
    filter: Filter<T>,
    params: unknown[],
    startIndex: number,
  ): string {
    const { field, operator, value } = filter;
    let clause = "";

    switch (operator) {
      case "eq":
        clause = ` WHERE ${field} = $${startIndex}`;
        params.push(value);
        break;

      case "ne":
        clause = ` WHERE ${field} != $${startIndex}`;
        params.push(value);
        break;

      case "gt":
        clause = ` WHERE ${field} > $${startIndex}`;
        params.push(value);
        break;

      case "gte":
        clause = ` WHERE ${field} >= $${startIndex}`;
        params.push(value);
        break;

      case "lt":
        clause = ` WHERE ${field} < $${startIndex}`;
        params.push(value);
        break;

      case "lte":
        clause = ` WHERE ${field} <= $${startIndex}`;
        params.push(value);
        break;

      case "in": {
        if (Array.isArray(value)) {
          const arr = value as readonly TParams[];
          const placeholders = arr
            .map((_, i: number) => `$${startIndex + i}`)
            .join(", ");
          clause = ` WHERE ${field} IN (${placeholders})`;
          params.push(...arr);
        } else {
          throw new DatabaseError(
            `Operator "in" requires an array value.`,
            DATABASE_ERROR_CODES.INVALID_IN_OPERATOR,
          );
        }
        break;
      }

      case "like":
        clause = ` WHERE ${field} LIKE $${startIndex}`;
        params.push(value as TParams);
        break;

      case "ilike":
        clause = ` WHERE ${field} ILIKE $${startIndex}`;
        params.push(value as TParams);
        break;

      case "between": {
        if (Array.isArray(value)) {
          const [min, max] = value as [TParams[number], TParams[number]];
          clause = ` WHERE ${field} BETWEEN $${startIndex} AND $${startIndex + 1}`;
          params.push(min, max);
        } else {
          throw new DatabaseError(
            `Operator "between" requires a two-element array.`,
            DATABASE_ERROR_CODES.INVALID_BETWEEN_OPERATOR,
          );
        }
        break;
      }

      case "isNull":
        clause = ` WHERE ${field} IS NULL`;
        break;

      case "isNotNull":
        clause = ` WHERE ${field} IS NOT NULL`;
        break;

      default:
        throw new DatabaseError(
          `Unsupported operator: ${operator}`,
          DATABASE_ERROR_CODES.UNSUPPORTED_OPERATOR,
        );
    }

    return clause;
  }
}
