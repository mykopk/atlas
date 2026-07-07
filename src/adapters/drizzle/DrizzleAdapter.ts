import { drizzle } from "drizzle-orm/node-postgres";
import { DefaultLogger } from "drizzle-orm";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import type {
  Column,
  ColumnBaseConfig,
  ColumnDataType,
  SQL,
  SQLWrapper,
} from "drizzle-orm";
import {
  eq,
  not,
  gte,
  gt,
  lte,
  lt,
  inArray,
  like,
  ilike,
  between,
  isNull,
  isNotNull,
  asc,
  desc,
  sql,
  and,
  or,
} from "drizzle-orm";
import type { PgTable, PgSelectBase } from "drizzle-orm/pg-core";
import { PgColumn } from "drizzle-orm/pg-core";
import { calculatePagination } from "@utils/pagination";
import type {
  DrizzleAdapterConfig,
  DatabaseAdapterType,
  DatabaseResult,
  PaginatedResult,
  QueryOptions,
  DatabaseHealthStatus,
  Filter,
  Transaction,
  SortOptions,
  FindFirstOptions,
  PoolMetrics,
} from "@myko.pk/types/db";
import { failure, success } from "@utils/databaseResultHelpers";
import { DatabaseError } from "@myko.pk/errors";
import { isNonEmptyString, isObject } from "@utils/typeGuards";
import { DATABASE_ERROR_CODES, type ErrorCodeValue } from "@myko.pk/errors";
import { DB_REGEX } from "@utils/regex";
import type { BuildWhereClauseOptions } from "@myko.pk/types/db";

/**
 * Minimum number of elements required in the value array for the BETWEEN operator.
 * A BETWEEN clause requires a lower and upper bound.
 */
const BETWEEN_MIN_ELEMENTS = 2;

/**
 * Drizzle ORM database adapter.
 *
 * @description
 * Implements the DatabaseAdapterType contract using Drizzle ORM on top of
 * node-postgres. Supports two modes of operation:
 *
 * **Typed mode** — Tables are registered as `PgTable` schema objects so that
 * Drizzle's type-safe query builder is used for all CRUD operations. This
 * mode provides compile-time column validation and auto-completion.
 *
 * **String mode** — Tables may be referenced by name alone. When a table is
 * not found in the typed registry (or is explicitly registered as a string),
 * the adapter falls back to raw SQL queries built with parameterised
 * placeholders. Useful for dynamic or untyped table access.
 *
 * The adapter auto-detects which mode to use per table based on how it was
 * registered. A typed call to `registerTable` stores the PgTable reference;
 * a string-only call (or a missing registration) triggers string-mode.
 */
export class DrizzleAdapter implements DatabaseAdapterType {
  static readonly adapterName = "drizzle";
  private db: ReturnType<typeof drizzle>;
  private pool: Pool;
  private config: DrizzleAdapterConfig;
  private tableMap: Map<string, PgTable> = new Map();
  private idColumnMap: Map<string, PgColumn> = new Map();
  private stringTableMap: Map<string, string> = new Map();
  private stringIdColumnMap: Map<string, string> = new Map();
  private configIdColumns: Record<string, string>;

  /**
   * Create a new DrizzleAdapter instance.
   *
   * @description
   * Initialises the PostgreSQL connection pool and wraps it with the Drizzle ORM.
   * Custom ID-column overrides from config are stored for use in string mode.
   *
   * @param config - Adapter configuration including connectionString, pool settings,
   *                 and optional tableIdColumns for non-standard primary keys
   */
  constructor(config: DrizzleAdapterConfig) {
    this.config = config;
    this.pool = new Pool({
      connectionString: config.connectionString,
      ...config.pool,
    });
    this.db = drizzle(this.pool, {
      logger: config.logging ? new DefaultLogger() : false,
    });
    this.configIdColumns = config.tableIdColumns ?? {};
  }

  /**
   * Initialise the adapter by verifying the database connection pool.
   *
   * @description
   * Acquires a client from the pool and immediately releases it to confirm the
   * connection string and pool configuration are valid. Returns a DatabaseResult
   * rather than throwing.
   *
   * @returns A success result if the pool is reachable, or a failure result with
   *          INIT_FAILED error code
   */
  async initialize(): Promise<DatabaseResult<void>> {
    let client;
    try {
      client = await this.pool.connect();
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to initialize Drizzle adapter: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.INIT_FAILED,
          {
            context: {
              source: "DrizzleAdapter.initialize",
            },
            cause: error as Error,
          },
        ),
      );
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Establish a database connection.
   *
   * @description
   * Acquires and immediately releases a client from the pool to verify
   * connectivity. Throws a DatabaseError on failure rather than returning
   * a result object.
   *
   * @throws {DatabaseError} When the pool cannot provide a client
   */
  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.release();
    } catch (error) {
      throw new DatabaseError(
        `Failed to connect to database: ${(error as Error).message}`,
        DATABASE_ERROR_CODES.CONNECT_FAILED,
        {
          context: {
            source: "DrizzleAdapter.connect",
          },
          cause: error as Error,
        },
      );
    }
  }

  /**
   * Gracefully shut down the connection pool.
   *
   * @description
   * Closes all idle connections and waits for active queries to finish.
   * Throws a DatabaseError if the pool refuses to close.
   *
   * @throws {DatabaseError} When the pool fails to shut down
   */
  async disconnect(): Promise<void> {
    try {
      await this.pool.end();
    } catch (error) {
      throw new DatabaseError(
        `Failed to disconnect from database: ${(error as Error).message}`,
        DATABASE_ERROR_CODES.DISCONNECT_FAILED,
        {
          context: {
            source: "DrizzleAdapter.disconnect",
          },
          cause: error as Error,
        },
      );
    }
  }

  /**
   * Close the database connection, returning a DatabaseResult.
   *
   * @description
   * Delegates to disconnect() but catches errors and returns a failure
   * result instead of throwing. Useful for graceful shutdown paths that
   * prefer result-based error handling.
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
   * Return the underlying Drizzle ORM client instance.
   *
   * @template TClient - Type to cast the client to (defaults to object)
   * @returns The Drizzle database instance, cast to the requested type
   */
  getClient<TClient extends object = object>(): TClient {
    return this.db as TClient;
  }

  /**
   * Get connection pool metrics for observability.
   *
   * @description
   * Returns pool utilization data from the underlying pg.Pool.
   * Used by Prometheus metrics and health checks.
   *
   * @returns PoolMetrics object or null if pool is not available
   */
  getPoolMetrics(): PoolMetrics | null {
    if (!this.pool) return null;
    const active = this.pool.totalCount - this.pool.idleCount;
    return {
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      activeConnections: Math.max(0, active),
      waitingRequests: this.pool.waitingCount,
      totalAcquired: 0,
      totalReleased: 0,
      averageAcquisitionTime: 0,
    };
  }

  /**
   * Execute a raw SQL query against the database.
   *
   * @description
   * Bypasses the Drizzle query builder and runs a parameterised SQL string
   * directly via the pg pool. Validates that the SQL string is non-empty
   * before execution.
   *
   * @template TResult - The row shape returned
   * @template TParams - The SQL parameter type (default unknown)
   * @param sql - The SQL statement to execute
   * @param params - Optional parameterised values
   * @returns An array of result rows
   * @throws {DatabaseError} When the SQL string is empty or the query fails
   */
  async query<TResult, TParams = unknown>(
    sql: string,
    params?: TParams[],
  ): Promise<TResult[]> {
    try {
      if (!isNonEmptyString(sql)) {
        throw new DatabaseError(
          "Invalid SQL query",
          DATABASE_ERROR_CODES.INVALID_SQL,
        );
      }

      const result = await this.pool.query(sql, params);
      return result.rows as TResult[];
    } catch (error) {
      throw new DatabaseError(
        `Failed to execute query: ${(error as Error).message}`,
        DATABASE_ERROR_CODES.QUERY_FAILED,
        {
          context: {
            source: "DrizzleAdapter.query",
          },
          cause: error as Error,
        },
      );
    }
  }

  /**
   * Register a table with the adapter, choosing typed or string mode.
   *
   * @description
   * When `table` is a PgTable object the adapter uses Drizzle's typed query
   * builder for CRUD operations. When `table` is a plain string the adapter
   * falls back to raw parameterised SQL. An optional ID column can be provided
   * for either mode.
   *
   * @param name - Logical name used to reference the table
   * @param table - PgTable schema object (typed mode) or table name (string mode)
   * @param idColumn - Optional primary-key column (PgColumn for typed mode,
   *                   string for string mode)
   * @throws {DatabaseError} When the name is empty or registration fails
   */
  registerTable<TTable, TIdColumn>(
    name: string,
    table: TTable,
    idColumn?: TIdColumn,
  ): void {
    try {
      if (!isNonEmptyString(name)) {
        throw new DatabaseError(
          "Invalid table name",
          DATABASE_ERROR_CODES.INVALID_TABLE_NAME,
        );
      }

      if (typeof table === "string") {
        this.stringTableMap.set(name, table);
        if (idColumn && typeof idColumn === "string") {
          this.stringIdColumnMap.set(name, idColumn);
        }
      } else {
        this.tableMap.set(name, table as PgTable);
        if (idColumn) {
          this.idColumnMap.set(name, idColumn as TIdColumn as PgColumn);
        }
      }
    } catch (error) {
      throw new DatabaseError(
        `Failed to register table: ${(error as Error).message}`,
        DATABASE_ERROR_CODES.TABLE_REGISTRATION_FAILED,
        {
          context: {
            source: "DrizzleAdapter.registerTable",
          },
          cause: error as Error,
        },
      );
    }
  }

  /**
   * Internal helper: find a record by ID using raw SQL.
   *
   * @description
   * Used as a fallback when the table is in string mode. Constructs a
   * parameterised SELECT query with the resolved table and ID column names.
   *
   * @param table - Logical table name
   * @param id - The primary-key value
   * @returns The found record or null
   */
  private async rawSqlFindById<T>(
    table: string,
    id: string,
  ): Promise<T | null> {
    const tableName = this.getStringTableName(table);
    const idColumn = this.getStringIdColumn(table);
    const sqlQuery = `SELECT * FROM "${tableName}" WHERE "${idColumn}" = $1 LIMIT 1`;
    const result = await this.pool.query(sqlQuery, [id]);
    return (result.rows[0] as T) || null;
  }

  /**
   * Find a single record by its primary-key value.
   *
   * @description
   * In typed mode uses Drizzle's query builder with eq(idColumn, id).
   * In string mode executes raw parameterised SQL. If the table is not
   * registered in typed mode a USE_STRING_MODE signal triggers a string-mode
   * fallback.
   *
   * @template T - The expected record type
   * @param table - Logical or physical table name
   * @param id - The primary-key value
   * @returns A DatabaseResult containing the record or null if not found
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    try {
      if (this.isStringMode(table)) {
        return success(await this.rawSqlFindById<T>(table, id));
      }

      const tableObj = this.getTable(table);
      const idColumn = this.getIdColumn(table);
      const result = await this.db
        .select()
        .from(tableObj)
        .where(eq(idColumn, id))
        .limit(1);
      return success((result[0] as T) || null);
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        return this.handleStringModeFallback<T | null>(
          () => this.rawSqlFindById<T>(table, id),
          table,
          "DrizzleAdapter.findById",
          DATABASE_ERROR_CODES.FIND_BY_ID_FAILED,
        );
      }
      return failure(
        new DatabaseError(
          `Failed to find by id in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.FIND_BY_ID_FAILED,
          {
            context: { source: "DrizzleAdapter.findById" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Execute a string-mode operation and wrap its result or error.
   *
   * @description
   * Used internally when a typed-mode query throws USE_STRING_MODE and the
   * adapter needs to re-attempt the operation as raw SQL. The returned promise
   * is wrapped in a DatabaseResult so callers do not need separate catch logic.
   *
   * @param operation - Async function that performs the raw SQL operation
   * @param table - Logical table name (used for error context)
   * @param source - Source label for error context
   * @param errorCode - The DatabaseError code to use on failure
   * @returns A DatabaseResult containing the operation result
   */
  private async handleStringModeFallback<T>(
    operation: () => Promise<T>,
    table: string,
    source: string,
    errorCode: ErrorCodeValue,
  ): Promise<DatabaseResult<T>> {
    try {
      return success(await operation());
    } catch (sqlError) {
      return failure(
        new DatabaseError(
          `Failed operation on table ${table}: ${(sqlError as Error).message}`,
          errorCode,
          {
            context: { source },
            cause: sqlError as Error,
          },
        ),
      );
    }
  }

  /**
   * Find multiple records with filtering, sorting and pagination.
   *
   * @description
   * In typed mode uses Drizzle's query builder; in string mode delegates to
   * findManyRawSql. Supports single or multiple filters (combined with AND),
   * optional sort fields, and offset/limit pagination. A COUNT query is run
   * first to calculate total matching records.
   *
   * @template T - The expected record type
   * @param table - Logical or physical table name
   * @param options - Query options (filters, sort, pagination)
   * @returns A DatabaseResult containing paginated data, total count and pagination metadata
   */
  // eslint-disable-next-line complexity
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    try {
      if (this.isStringMode(table)) {
        return this.findManyRawSql<T>(table, options);
      }

      const tableObj = this.getTable(table);

      let query: PgSelectBase<
        string,
        Record<string, PgColumn>,
        "single",
        Record<string, "not-null">,
        false
      > = this.db.select().from(tableObj);

      if (options?.sort) {
        query = this.applySorting(query as never, options.sort, tableObj);
      }
      const combinedWhereClause = this.buildCombinedWhereClause(
        options,
        tableObj,
      );
      if (combinedWhereClause) {
        query = query.where(combinedWhereClause) as typeof query;
      }

      let countQuery = this.db
        .select({ count: sql<number>`count(*)::int`.as("count") })
        .from(tableObj);
      if (combinedWhereClause) {
        countQuery = countQuery.where(combinedWhereClause) as typeof countQuery;
      }

      const countResult = await countQuery;
      const total = Number(countResult[0].count);

      if (options?.pagination) {
        if (options.pagination.offset !== undefined) {
          query = query.offset(options.pagination.offset) as typeof query;
        }
        if (options.pagination.limit !== undefined) {
          query = query.limit(options.pagination.limit) as typeof query;
        }
      }

      const data = await query;
      return success({
        data: data as T[],
        total,
        pagination: calculatePagination(total, options?.pagination),
      });
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        return this.findManyRawSql<T>(table, options);
      }
      return failure(
        new DatabaseError(
          `Failed to find many in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.FIND_MANY_FAILED,
          {
            context: {
              source: "DrizzleAdapter.findMany",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Find the first record matching advanced options.
   *
   * @description
   * Converts FindFirstOptions to a QueryOptions-compatible filter array and
   * delegates to findMany with limit 1. In string mode uses raw SQL with
   * a parameterised WHERE clause.
   *
   * @template T - The expected record type
   * @param table - Logical or physical table name
   * @param options - FindFirst options (where, select, include)
   * @returns A DatabaseResult containing the first matching record or null
   */
  async findFirst<T extends object>(
    table: string,
    options?: FindFirstOptions<T>,
  ): Promise<DatabaseResult<T | null>> {
    try {
      const filters: Filter<T>[] = [];

      if (options?.where) {
        for (const [field, value] of Object.entries(options.where)) {
          if (value !== undefined && value !== null && typeof value === "object") {
            for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
              if (["gt", "gte", "lt", "lte", "eq", "ne"].includes(op)) {
                filters.push({ field, operator: op, value: val } as unknown as Filter<T>);
              }
            }
          } else {
            filters.push({ field, operator: "eq", value } as unknown as Filter<T>);
          }
        }
      }

      const manyResult = await this.findMany<T>(table, {
        filters: filters.length > 0 ? filters : undefined,
        pagination: { limit: 1, offset: 0 },
      });

      if (!manyResult.success) {
        return { success: false, value: null, error: manyResult.error };
      }

      return {
        success: true,
        value: manyResult.value?.data[0] ?? null,
        error: manyResult.error,
      };
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        const whereClauses: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 0;
        const tableName = this.getStringTableName(table);

        if (options?.where) {
          for (const [field, value] of Object.entries(options.where)) {
            if (value !== undefined && value !== null && typeof value === "object") {
              for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
                paramIndex++;
                let opSql: string;
                switch (op) {
                  case "gt": opSql = ">"; break;
                  case "gte": opSql = ">="; break;
                  case "lt": opSql = "<"; break;
                  case "lte": opSql = "<="; break;
                  case "eq": opSql = "="; break;
                  case "ne": opSql = "!="; break;
                  default: continue;
                }
                whereClauses.push(`"${field}" ${opSql} $${paramIndex}`);
                params.push(val);
              }
            } else {
              paramIndex++;
              whereClauses.push(`"${field}" = $${paramIndex}`);
              params.push(value);
            }
          }
        }

        const whereClause = whereClauses.length > 0
          ? ` WHERE ${whereClauses.join(" AND ")}`
          : "";

        const sqlQuery = `SELECT * FROM "${tableName}"${whereClause} LIMIT 1`;
        const result = await this.pool.query(sqlQuery, params);
        return success(result.rows[0] ?? null);
      }

      return failure(
        new DatabaseError(
          `Failed to find first in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          {
            context: { source: "DrizzleAdapter.findFirst" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Internal helper: find many records using raw parameterised SQL.
   *
   * @description
   * Builds SELECT / COUNT queries with WHERE, ORDER BY, LIMIT and OFFSET
   * clauses from the provided options. All values are passed as positional
   * parameters to prevent SQL injection.
   *
   * @template T - The expected record type
   * @param table - Logical table name
   * @param options - Query options (filters, sort, pagination)
   * @returns A DatabaseResult containing paginated data
   */
  // eslint-disable-next-line complexity
  private async findManyRawSql<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    try {
      const tableName = this.getStringTableName(table);
      const params: unknown[] = [];
      let whereClause = "";
      let paramIndex = 1;

      const clauses: string[] = [];

      if (options?.orFilters && options.orFilters.length > 0) {
        const orClauses: string[] = [];
        for (const group of options.orFilters) {
          if (group.length === 0) continue;
          const groupClauses: string[] = [];
          for (const f of group) {
            const clause = this.buildSqlWhereClause({
              field: f.field,
              operator: f.operator,
              value: f.value,
              params,
              startIndex: paramIndex,
            });
            groupClauses.push(clause.replace(/^\s*WHERE\s+/i, ""));
            paramIndex = params.length + 1;
          }
          if (groupClauses.length > 0) {
            if (groupClauses.length === 1) orClauses.push(groupClauses[0]);
            else orClauses.push(`(${groupClauses.join(" AND ")})`);
          }
        }
        if (orClauses.length > 0) {
          clauses.push(`(${orClauses.join(" OR ")})`);
        }
      } else {
        const activeFilters = options?.filters?.length
          ? options.filters
          : options?.filter
            ? [options.filter]
            : [];
        for (const f of activeFilters) {
          const clause = this.buildSqlWhereClause({
            field: f.field,
            operator: f.operator,
            value: f.value,
            params,
            startIndex: paramIndex,
          });
          clauses.push(clause.replace(/^\s*WHERE\s+/i, ""));
          paramIndex = params.length + 1;
        }
      }

      if (options?.rawConditions && options.rawConditions.length > 0) {
        for (const rc of options.rawConditions) {
          if (!rc.clause) continue;
          const renumbered = this.renumberRawClause(rc.clause, paramIndex);
          clauses.push(renumbered);
          params.push(...rc.params);
          paramIndex = params.length + 1;
        }
      }

      if (clauses.length > 0) {
        whereClause = ` WHERE ${clauses.join(" AND ")}`;
      }

      const countSql = `SELECT COUNT(*) as total FROM "${tableName}"${whereClause}`;
      const countResult = await this.pool.query(countSql, params);
      const total = Number.parseInt(countResult.rows[0].total);

      let orderClause = "";
      if (options?.sort?.length) {
        orderClause =
          " ORDER BY " +
          options.sort
            .map((s) => `"${s.field}" ${s.direction.toUpperCase()}`)
            .join(", ");
      }

      const queryParams = [...params];

      let limitClause = "";
      if (options?.pagination?.limit) {
        limitClause += ` LIMIT $${paramIndex++}`;
        queryParams.push(options.pagination.limit);
      }
      if (options?.pagination?.offset) {
        limitClause += ` OFFSET $${paramIndex++}`;
        queryParams.push(options.pagination.offset);
      }

      const sqlQuery = `SELECT * FROM "${tableName}"${whereClause}${orderClause}${limitClause}`;
      const result = await this.pool.query(sqlQuery, queryParams);

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
              source: "DrizzleAdapter.findManyRawSql",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Build a raw SQL WHERE clause fragment from a filter definition.
   *
   * @description
   * Converts a filter (field + operator + value) into a parameterised SQL
   * fragment. Supports eq, ne, gt, gte, lt, lte, in, like, ilike, between,
   * isNull, and isNotNull operators. Values are appended to the params array
   * and referenced via $N placeholders.
   *
   * @param options - Build options containing field, operator, value, params
   *                  array and the starting placeholder index
   * @returns A SQL WHERE clause string (e.g. ` WHERE "name" = $1`)
   */
  // eslint-disable-next-line complexity
  private buildSqlWhereClause(options: BuildWhereClauseOptions): string {
    const { field, operator, value, params, startIndex } = options;
    let clause = "";

    switch (operator) {
      case "eq":
        clause = ` WHERE "${field}" = $${startIndex}`;
        params.push(value);
        break;
      case "ne":
        clause = ` WHERE "${field}" != $${startIndex}`;
        params.push(value);
        break;
      case "gt":
        clause = ` WHERE "${field}" > $${startIndex}`;
        params.push(value);
        break;
      case "gte":
        clause = ` WHERE "${field}" >= $${startIndex}`;
        params.push(value);
        break;
      case "lt":
        clause = ` WHERE "${field}" < $${startIndex}`;
        params.push(value);
        break;
      case "lte":
        clause = ` WHERE "${field}" <= $${startIndex}`;
        params.push(value);
        break;
      case "in":
        if (Array.isArray(value)) {
          if (value.length === 0) {
            clause = " WHERE 1=0";
          } else {
            const placeholders = value
              .map((_, i) => `$${startIndex + i}`)
              .join(", ");
            clause = ` WHERE "${field}" IN (${placeholders})`;
            params.push(...value);
          }
        }
        break;
      case "like":
        clause = ` WHERE "${field}" LIKE $${startIndex}`;
        params.push(value);
        break;
      case "ilike":
        clause = ` WHERE "${field}" ILIKE $${startIndex}`;
        params.push(value);
        break;
      case "between":
        if (Array.isArray(value) && value.length >= BETWEEN_MIN_ELEMENTS) {
          clause = ` WHERE "${field}" BETWEEN $${startIndex} AND $${startIndex + 1}`;
          params.push(value[0], value[1]);
        }
        break;
      case "isNull":
        clause = ` WHERE "${field}" IS NULL`;
        break;
      case "isNotNull":
        clause = ` WHERE "${field}" IS NOT NULL`;
        break;
      default:
        break;
    }

    return clause;
  }

  /**
   * Create a new record.
   *
   * @description
   * In typed mode uses Drizzle's insert + returning. In string mode delegates
   * to createRawSql. If the table is not registered in typed mode a
   * USE_STRING_MODE signal triggers a string-mode fallback.
   *
   * @template T - The record data type
   * @param table - Logical or physical table name
   * @param data - The record data to insert
   * @returns A DatabaseResult containing the created record with server-generated fields
   */
  async create<T>(table: string, data: T): Promise<DatabaseResult<T>> {
    try {
      if (this.isStringMode(table)) {
        return this.createRawSql<T>(table, data);
      }

      const tableObj = this.getTable(table);
      const result = await this.db
        .insert(tableObj)
        .values(data as Record<string, T>)
        .returning();
      return success(result[0] as T);
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        return this.createRawSql<T>(table, data);
      }
      return failure(
        new DatabaseError(
          `Failed to create in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.CREATE_FAILED,
          {
            context: {
              source: "DrizzleAdapter.create",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Internal helper: create a record using raw parameterised SQL.
   *
   * @description
   * Constructs an INSERT INTO ... RETURNING * query with escaped column names
   * and positional value placeholders.
   *
   * @param table - Logical table name
   * @param data - The record data to insert
   * @returns A DatabaseResult containing the created record
   */
  private async createRawSql<T>(
    table: string,
    data: T,
  ): Promise<DatabaseResult<T>> {
    try {
      const tableName = this.getStringTableName(table);
      const keys = Object.keys(data as Record<string, unknown>);
      const values = Object.values(data as Record<string, unknown>);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
      const escapedKeys = keys.map((k) => `"${k}"`).join(", ");

      const sqlQuery = `INSERT INTO "${tableName}" (${escapedKeys}) VALUES (${placeholders}) RETURNING *`;
      const result = await this.pool.query(sqlQuery, values);

      return success(result.rows[0] as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to create in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.CREATE_FAILED,
          {
            context: {
              source: "DrizzleAdapter.createRawSql",
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
   * In typed mode uses Drizzle's update + where + returning. In string mode
   * delegates to updateRawSql. Partial updates are supported — only the
   * fields present in `data` are included in the SET clause.
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
      if (this.isStringMode(table)) {
        return this.updateRawSql<T>(table, id, data);
      }

      const tableObj = this.getTable(table);
      const idColumn = this.getIdColumn(table);
      const result = await this.db
        .update(tableObj)
        .set(data as Record<string, T>)
        .where(eq(idColumn, id))
        .returning();
      return success(result[0] as T);
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        return this.updateRawSql<T>(table, id, data);
      }
      return failure(
        new DatabaseError(
          `Failed to update in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: {
              source: "DrizzleAdapter.update",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Internal helper: update a record using raw parameterised SQL.
   *
   * @description
   * Constructs an UPDATE ... SET ... WHERE ... RETURNING * query with
   * positional placeholders for the SET values and the ID value.
   *
   * @param table - Logical table name
   * @param id - The primary-key value
   * @param data - Partial record data containing only changed fields
   * @returns A DatabaseResult containing the updated record
   */
  private async updateRawSql<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    try {
      const tableName = this.getStringTableName(table);
      const idColumn = this.getStringIdColumn(table);
      const keys = Object.keys(data as Record<string, unknown>);
      const values = Object.values(data as Record<string, unknown>);
      const setClause = keys.map((key, i) => `"${key}" = $${i + 1}`).join(", ");

      const sqlQuery = `UPDATE "${tableName}" SET ${setClause} WHERE "${idColumn}" = $${keys.length + 1} RETURNING *`;
      const result = await this.pool.query(sqlQuery, [...values, id]);

      return success(result.rows[0] as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to update in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: {
              source: "DrizzleAdapter.updateRawSql",
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
   * In typed mode uses Drizzle's delete + where. In string mode delegates
   * to deleteRawSql.
   *
   * @param table - Logical or physical table name
   * @param id - The primary-key value of the record to delete
   * @returns A DatabaseResult indicating success or failure
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    try {
      if (this.isStringMode(table)) {
        return this.deleteRawSql(table, id);
      }

      const tableObj = this.getTable(table);
      const idColumn = this.getIdColumn(table);
      await this.db.delete(tableObj).where(eq(idColumn, id));
      return success();
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        return this.deleteRawSql(table, id);
      }
      return failure(
        new DatabaseError(
          `Failed to delete from table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: {
              source: "DrizzleAdapter.delete",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Internal helper: delete a record using raw parameterised SQL.
   *
   * @description
   * Constructs a DELETE FROM ... WHERE ... query with a positional
   * placeholder for the ID value.
   *
   * @param table - Logical table name
   * @param id - The primary-key value
   * @returns A DatabaseResult indicating success or failure
   */
  private async deleteRawSql(
    table: string,
    id: string,
  ): Promise<DatabaseResult<void>> {
    try {
      const tableName = this.getStringTableName(table);
      const idColumn = this.getStringIdColumn(table);
      const sqlQuery = `DELETE FROM "${tableName}" WHERE "${idColumn}" = $1`;
      await this.pool.query(sqlQuery, [id]);
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to delete from table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: {
              source: "DrizzleAdapter.deleteRawSql",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Update multiple records matching a condition.
   *
   * @description
   * In typed mode uses Drizzle's update builder with AND-combined WHERE
   * conditions from the `where` object. In string mode builds a parameterised
   * UPDATE SQL statement. Supports USE_STRING_MODE fallback.
   *
   * @param table - Logical or physical table name
   * @param where - Conditions to match records (plain object of field-value pairs, AND-combined)
   * @param data - The data to apply to matching records
   * @returns A DatabaseResult containing the number of affected rows
   */
  async updateMany(
    table: string,
    where: Record<string, any>,
    data: Record<string, any>,
  ): Promise<DatabaseResult<number>> {
    try {
      if (this.isStringMode(table)) {
        const stringTable = this.getStringTableName(table);
        const keys = Object.keys(data);
        const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
        const whereKeys = Object.keys(where);
        const whereClause = whereKeys
          .map((k, i) => `"${k}" = $${keys.length + i + 1}`)
          .join(" AND ");
        const sqlQuery = `UPDATE "${stringTable}" SET ${setClause} WHERE ${whereClause}`;
        const result = await this.pool.query(sqlQuery, [
          ...Object.values(data),
          ...Object.values(where),
        ]);
        return success(result.rowCount ?? 0);
      }
      const tableObj = this.getTable(table);
      const whereConditions = Object.entries(where).map(([field, value]) => {
        const column = tableObj[field as keyof typeof tableObj] as PgColumn;
        return eq(column, value);
      });
      const combinedWhere =
        whereConditions.length === 1
          ? whereConditions[0]
          : and(...whereConditions);
      const result = await this.db
        .update(tableObj)
        .set(data)
        .where(combinedWhere);
      return success(result.rowCount ?? 0);
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        const stringTable = this.getStringTableName(table);
        const keys = Object.keys(data);
        const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
        const whereKeys = Object.keys(where);
        const whereClause = whereKeys
          .map((k, i) => `"${k}" = $${keys.length + i + 1}`)
          .join(" AND ");
        const sqlQuery = `UPDATE "${stringTable}" SET ${setClause} WHERE ${whereClause}`;
        const result = await this.pool.query(sqlQuery, [
          ...Object.values(data),
          ...Object.values(where),
        ]);
        return success(result.rowCount ?? 0);
      }
      return failure(
        new DatabaseError(
          `Failed to update many in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: { source: "DrizzleAdapter.updateMany" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Delete multiple records matching a condition.
   *
   * @description
   * In typed mode uses Drizzle's delete builder with AND-combined WHERE
   * conditions. In string mode builds a parameterised DELETE SQL statement.
   * Supports USE_STRING_MODE fallback.
   *
   * @param table - Logical or physical table name
   * @param where - Conditions to match records (plain object of field-value pairs, AND-combined)
   * @returns A DatabaseResult containing the number of affected rows
   */
  async deleteMany(
    table: string,
    where: Record<string, any>,
  ): Promise<DatabaseResult<number>> {
    try {
      if (this.isStringMode(table)) {
        const stringTable = this.getStringTableName(table);
        const whereKeys = Object.keys(where);
        const whereClause = whereKeys
          .map((k, i) => `"${k}" = $${i + 1}`)
          .join(" AND ");
        const sqlQuery = `DELETE FROM "${stringTable}" WHERE ${whereClause}`;
        const result = await this.pool.query(
          sqlQuery,
          Object.values(where),
        );
        return success(result.rowCount ?? 0);
      }
      const tableObj = this.getTable(table);
      const whereConditions = Object.entries(where).map(([field, value]) => {
        const column = tableObj[field as keyof typeof tableObj] as PgColumn;
        return eq(column, value);
      });
      const combinedWhere =
        whereConditions.length === 1
          ? whereConditions[0]
          : and(...whereConditions);
      const result = await this.db.delete(tableObj).where(combinedWhere);
      return success(result.rowCount ?? 0);
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        const stringTable = this.getStringTableName(table);
        const whereKeys = Object.keys(where);
        const whereClause = whereKeys
          .map((k, i) => `"${k}" = $${i + 1}`)
          .join(" AND ");
        const sqlQuery = `DELETE FROM "${stringTable}" WHERE ${whereClause}`;
        const result = await this.pool.query(
          sqlQuery,
          Object.values(where),
        );
        return success(result.rowCount ?? 0);
      }
      return failure(
        new DatabaseError(
          `Failed to delete many from table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: { source: "DrizzleAdapter.deleteMany" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Insert a record or update it if it already exists (upsert).
   *
   * @description
   * In typed mode uses Drizzle's onConflictDoUpdate. In string mode builds a
   * parameterised INSERT ... ON CONFLICT DO UPDATE SET ... RETURNING * query.
   * The first key of the `where` object is used as the conflict target column.
   * Supports USE_STRING_MODE fallback.
   *
   * @template T - The expected record type
   * @param table - Logical or physical table name
   * @param where - Condition to detect existing records (first key = conflict column)
   * @param create - Data for creating a new record
   * @param update - Data for updating an existing record
   * @returns A DatabaseResult containing the upserted record
   */
  async upsert<T>(
    table: string,
    where: Record<string, any>,
    create: Record<string, any>,
    update: Record<string, any>,
  ): Promise<DatabaseResult<T>> {
    try {
      if (this.isStringMode(table)) {
        const stringTable = this.getStringTableName(table);
        const keys = Object.keys(create);
        const columns = keys.map((k) => `"${k}"`).join(", ");
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const updateSet = Object.keys(update)
          .map((k, i) => `"${k}" = $${keys.length + i + 1}`)
          .join(", ");
        const conflictCol = Object.keys(where)[0] ?? "id";
        const sqlQuery = `INSERT INTO "${stringTable}" (${columns}) VALUES (${placeholders}) ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updateSet} RETURNING *`;
        const result = await this.pool.query(sqlQuery, [
          ...Object.values(create),
          ...Object.values(update),
        ]);
        return success(result.rows[0] as T);
      }
      const tableObj = this.getTable(table);
      const conflictColName = Object.keys(where)[0] ?? "id";
      const conflictColumn =
        tableObj[conflictColName as keyof typeof tableObj] as PgColumn;
      const result = await this.db
        .insert(tableObj)
        .values(create)
        .onConflictDoUpdate({ target: conflictColumn, set: update })
        .returning();
      return success(result[0] as T);
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        const stringTable = this.getStringTableName(table);
        const keys = Object.keys(create);
        const columns = keys.map((k) => `"${k}"`).join(", ");
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const updateSet = Object.keys(update)
          .map((k, i) => `"${k}" = $${keys.length + i + 1}`)
          .join(", ");
        const conflictCol = Object.keys(where)[0] ?? "id";
        const sqlQuery = `INSERT INTO "${stringTable}" (${columns}) VALUES (${placeholders}) ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updateSet} RETURNING *`;
        const result = await this.pool.query(sqlQuery, [
          ...Object.values(create),
          ...Object.values(update),
        ]);
        return success(result.rows[0] as T);
      }
      return failure(
        new DatabaseError(
          `Failed to upsert in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: { source: "DrizzleAdapter.upsert" },
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
   * Acquires a dedicated PoolClient, begins a transaction, and creates a
   * scoped Transaction object that mirrors the adapter's CRUD methods
   * (findById, create, update, delete, updateMany, deleteMany, upsert).
   * Both typed and string modes are supported within the transaction.
   * The transaction is automatically committed on success or rolled back
   * on error. The dedicated client is always released in the finally block.
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
      const trxDb = drizzle(client);

      const trx: Transaction = {
        findById: async <T>(table: string, id: string) => {
          if (this.isStringMode(table)) {
            const tableName = this.getStringTableName(table);
            const idColumn = this.getStringIdColumn(table);
            const sqlQuery = `SELECT * FROM "${tableName}" WHERE "${idColumn}" = $1 LIMIT 1`;
            const result = await client.query(sqlQuery, [id]);
            return success((result.rows[0] as T) || null);
          }
          const tableObj = this.getTable(table);
          const idColumn = this.getIdColumn(table);
          const result = await trxDb
            .select()
            .from(tableObj)
            .where(eq(idColumn, id))
            .limit(1);
          return success((result[0] as T) || null);
        },
        create: async <T>(table: string, data: T) => {
          if (this.isStringMode(table)) {
            const tableName = this.getStringTableName(table);
            const keys = Object.keys(data as Record<string, unknown>);
            const values = Object.values(data as Record<string, unknown>);
            const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
            const escapedKeys = keys.map((k) => `"${k}"`).join(", ");
            const sqlQuery = `INSERT INTO "${tableName}" (${escapedKeys}) VALUES (${placeholders}) RETURNING *`;
            const result = await client.query(sqlQuery, values);
            return success(result.rows[0] as T);
          }
          const tableObj = this.getTable(table);
          const result = await trxDb
            .insert(tableObj)
            .values(data as Record<string, T>)
            .returning();
          return success(result[0] as T);
        },
        update: async <T>(table: string, id: string, data: Partial<T>) => {
          if (this.isStringMode(table)) {
            const tableName = this.getStringTableName(table);
            const idColumn = this.getStringIdColumn(table);
            const keys = Object.keys(data as Record<string, unknown>);
            const values = Object.values(data as Record<string, unknown>);
            const setClause = keys
              .map((key, i) => `"${key}" = $${i + 1}`)
              .join(", ");
            const sqlQuery = `UPDATE "${tableName}" SET ${setClause} WHERE "${idColumn}" = $${keys.length + 1} RETURNING *`;
            const result = await client.query(sqlQuery, [...values, id]);
            return success(result.rows[0] as T);
          }
          const tableObj = this.getTable(table);
          const idColumn = this.getIdColumn(table);
          const result = await trxDb
            .update(tableObj)
            .set(data as Record<string, T>)
            .where(eq(idColumn, id))
            .returning();
          return success(result[0] as T);
        },
        delete: async (table: string, id: string) => {
          if (this.isStringMode(table)) {
            const tableName = this.getStringTableName(table);
            const idColumn = this.getStringIdColumn(table);
            const sqlQuery = `DELETE FROM "${tableName}" WHERE "${idColumn}" = $1`;
            await client.query(sqlQuery, [id]);
            return success();
          }
          const tableObj = this.getTable(table);
          const idColumn = this.getIdColumn(table);
          await trxDb.delete(tableObj).where(eq(idColumn, id));
          return success();
        },
        updateMany: async (t: string, where: Record<string, any>, data: Record<string, any>) => {
          if (this.isStringMode(t)) {
            const keys = Object.keys(data);
            const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
            const whereKeys = Object.keys(where);
            const whereClause = whereKeys
              .map((k, i) => `"${k}" = $${keys.length + i + 1}`)
              .join(" AND ");
            const sqlQuery = `UPDATE "${t}" SET ${setClause} WHERE ${whereClause}`;
            const result = await client.query(sqlQuery, [...Object.values(data), ...Object.values(where)]);
            return success(result.rowCount ?? 0);
          }
          const tableObj = this.getTable(t);
          const whereConditions = Object.entries(where).map(([field, value]) => {
            const column = tableObj[field as keyof typeof tableObj] as PgColumn;
            return eq(column, value);
          });
          const combinedWhere = whereConditions.length === 1
            ? whereConditions[0]
            : and(...whereConditions);
          const result = await trxDb.update(tableObj).set(data).where(combinedWhere);
          return success(result.rowCount ?? 0);
        },
        deleteMany: async (t: string, where: Record<string, any>) => {
          if (this.isStringMode(t)) {
            const whereKeys = Object.keys(where);
            const whereClause = whereKeys
              .map((k, i) => `"${k}" = $${i + 1}`)
              .join(" AND ");
            const sqlQuery = `DELETE FROM "${t}" WHERE ${whereClause}`;
            const result = await client.query(sqlQuery, Object.values(where));
            return success(result.rowCount ?? 0);
          }
          const tableObj = this.getTable(t);
          const whereConditions = Object.entries(where).map(([field, value]) => {
            const column = tableObj[field as keyof typeof tableObj] as PgColumn;
            return eq(column, value);
          });
          const combinedWhere = whereConditions.length === 1
            ? whereConditions[0]
            : and(...whereConditions);
          const result = await trxDb.delete(tableObj).where(combinedWhere);
          return success(result.rowCount ?? 0);
        },
        upsert: async <TX>(t: string, where: Record<string, any>, create: Record<string, any>, update: Record<string, any>) => {
          if (this.isStringMode(t)) {
            const keys = Object.keys(create);
            const columns = keys.map((k) => `"${k}"`).join(", ");
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
            const updateSet = Object.keys(update)
              .map((k, i) => `"${k}" = $${keys.length + i + 1}`)
              .join(", ");
            const conflictCol = Object.keys(where)[0] ?? "id";
            const sqlQuery = `INSERT INTO "${t}" (${columns}) VALUES (${placeholders}) ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updateSet} RETURNING *`;
            const result = await client.query(sqlQuery, [...Object.values(create), ...Object.values(update)]);
            return success(result.rows[0] as TX);
          }
          const tableObj = this.getTable(t);
          const conflictColName = Object.keys(where)[0] ?? "id";
          const conflictColumn = tableObj[conflictColName as keyof typeof tableObj] as PgColumn;
          const result = await trxDb
            .insert(tableObj)
            .values(create)
            .onConflictDoUpdate({ target: conflictColumn, set: update })
            .returning();
          return success(result[0] as TX);
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
              source: "DrizzleAdapter.transaction",
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
   * In typed mode uses Drizzle's select with eq and LIMIT 1. In string mode
   * executes a raw SELECT 1 query. Returns true if at least one matching row
   * is found.
   *
   * @param table - Logical or physical table name
   * @param id - The primary-key value to check
   * @returns A DatabaseResult containing true if the record exists
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    try {
      if (this.isStringMode(table)) {
        const tableName = this.getStringTableName(table);
        const idColumn = this.getStringIdColumn(table);
        const sqlQuery = `SELECT 1 FROM "${tableName}" WHERE "${idColumn}" = $1 LIMIT 1`;
        const result = await this.pool.query(sqlQuery, [id]);
        return success(result.rows.length > 0);
      }

      const tableObj = this.getTable(table);
      const idColumn = this.getIdColumn(table);
      const result = await this.db
        .select({ exists: sql`1` })
        .from(tableObj)
        .where(eq(idColumn, id))
        .limit(1);
      return success(!!result.length);
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        const tableName = this.getStringTableName(table);
        const idColumn = this.getStringIdColumn(table);
        const sqlQuery = `SELECT 1 FROM "${tableName}" WHERE "${idColumn}" = $1 LIMIT 1`;
        const result = await this.pool.query(sqlQuery, [id]);
        return success(result.rows.length > 0);
      }
      return failure(
        new DatabaseError(
          `Failed to check existence in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.EXISTS_FAILED,
          {
            context: {
              source: "DrizzleAdapter.exists",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Count records in a table, optionally filtered.
   *
   * @description
   * In typed mode uses Drizzle's select with count(*) and an optional WHERE
   * clause. In string mode delegates to countRawSql.
   *
   * @template T - The record type (used for filter typing)
   * @param table - Logical or physical table name
   * @param filter - Optional filter condition
   * @returns A DatabaseResult containing the count of matching records
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T> | Filter<T>[],
  ): Promise<DatabaseResult<number>> {
    try {
      if (this.isStringMode(table)) {
        return this.countRawSql(table, filter);
      }

      const tableObj = this.getTable(table);

      const baseQuery = this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(tableObj);

      let whereClause: SQL | undefined;
      if (Array.isArray(filter)) {
        const clauses = filter
          .map((f) => this.buildWhereClause(f, tableObj))
          .filter((c): c is SQL => c !== undefined);
        if (clauses.length === 1) whereClause = clauses[0];
        else if (clauses.length > 1) whereClause = and(...clauses);
      } else if (filter) {
        whereClause = this.buildWhereClause(filter, tableObj);
      }

      const query = whereClause ? baseQuery.where(whereClause) : baseQuery;

      const result = await query;
      const countValue = result.length > 0 ? result[0].count : 0;

      return success(Number(countValue));
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.message === "USE_STRING_MODE"
      ) {
        return this.countRawSql(table, filter);
      }
      return failure(
        new DatabaseError(
          `Failed to count in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.COUNT_FAILED,
          {
            context: {
              source: "DrizzleAdapter.count",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Internal helper: count records using raw parameterised SQL.
   *
   * @description
   * Constructs a SELECT COUNT(*) query with an optional WHERE clause derived
   * from the provided filter.
   *
   * @param table - Logical table name
   * @param filter - Optional filter condition
   * @returns A DatabaseResult containing the count
   */
  private async countRawSql<T extends object>(
    table: string,
    filter?: Filter<T> | Filter<T>[],
  ): Promise<DatabaseResult<number>> {
    try {
      const tableName = this.getStringTableName(table);
      const params: unknown[] = [];
      let whereClause = "";

      if (filter) {
        const filters = Array.isArray(filter) ? filter : [filter];
        const clauses: string[] = [];
        for (const f of filters) {
          const clause = this.buildSqlWhereClause({
            field: f.field,
            operator: f.operator,
            value: f.value,
            params,
            startIndex: params.length + 1,
          });
          if (clause) clauses.push(clause);
        }
        if (clauses.length > 0) {
          whereClause = " WHERE " + clauses.join(" AND ");
        }
      }

      const sqlQuery = `SELECT COUNT(*) as count FROM "${tableName}"${whereClause}`;
      const result = await this.pool.query(sqlQuery, params);
      const rowCount = Number.parseInt(result.rows[0].count);
      return success(Number(rowCount));
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to count in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.COUNT_FAILED,
          {
            context: {
              source: "DrizzleAdapter.countRawSql",
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
        details: { adapter: "drizzle" } as DatabaseHealthStatus["details"],
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return success({
        isHealthy: false,
        responseTime,
        details: {
          adapter: "drizzle",
          error: (error as Error).message,
        } as DatabaseHealthStatus["details"],
      });
    }
  }

  /**
   * Determine whether a table should use string mode.
   *
   * @description
   * Returns true if the table was registered as a string or was never
   * registered in the typed table map.
   *
   * @param name - Logical table name
   * @returns true if the table should use raw SQL mode
   */
  private isStringMode(name: string): boolean {
    return this.stringTableMap.has(name) || !this.tableMap.has(name);
  }

  /**
   * Retrieve the typed PgTable for a logical name.
   *
   * @description
   * Looks up the typed table map. If the table is not found and no string-mode
   * registration exists, it auto-registers the name as a string and throws
   * USE_STRING_MODE to trigger a fallback.
   *
   * @param name - Logical table name
   * @returns The PgTable schema object
   * @throws {DatabaseError} With USE_STRING_MODE message when the table is not
   *                         in typed mode, forcing a fallback to raw SQL
   */
  private getTable(name: string): PgTable {
    try {
      if (!isNonEmptyString(name)) {
        throw new DatabaseError(
          "Invalid table name",
          DATABASE_ERROR_CODES.INVALID_TABLE_NAME,
        );
      }

      const table = this.tableMap.get(name);
      if (!table) {
        if (!this.stringTableMap.has(name)) {
          this.stringTableMap.set(name, name);
        }
        throw new DatabaseError(
          "USE_STRING_MODE",
          DATABASE_ERROR_CODES.TABLE_NOT_REGISTERED,
        );
      }
      return table;
    } catch (error) {
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError(
            "Failed to get table",
            DATABASE_ERROR_CODES.GET_TABLE_FAILED,
          );
    }
  }

  /**
   * Resolve a logical table name to its physical name for string mode.
   *
   * @description
   * Looks up the string table map. If no entry exists, auto-registers the
   * logical name as its own physical name and associates any config-provided
   * ID column.
   *
   * @param name - Logical table name
   * @returns The physical table name
   */
  private getStringTableName(name: string): string {
    let tableName = this.stringTableMap.get(name);
    if (!tableName) {
      const customIdColumn = this.configIdColumns[name];
      if (customIdColumn) {
        this.stringIdColumnMap.set(name, customIdColumn);
      }
      this.stringTableMap.set(name, name);
      tableName = name;
    }
    return tableName;
  }

  /**
   * Resolve the ID column name for string mode.
   *
   * @description
   * Checks the string-mode ID column map first, then config-provided
   * columns, and finally falls back to "id".
   *
   * @param name - Logical table name
   * @returns The column name used as the primary key
   */
  private getStringIdColumn(name: string): string {
    const runtimeIdColumn = this.stringIdColumnMap.get(name);
    if (runtimeIdColumn) {
      return runtimeIdColumn;
    }

    const configIdColumn = this.configIdColumns[name];
    if (configIdColumn) {
      return configIdColumn;
    }

    return "id";
  }

  /**
   * Retrieve the typed PgColumn for a logical table's primary key.
   *
   * @description
   * Looks up the typed ID-column map. Throws if the column has not been
   * registered, which signals that the caller should fall back to string
   * mode.
   *
   * @param name - Logical table name
   * @returns The PgColumn representing the primary-key field
   * @throws {DatabaseError} When the ID column is not registered or the
   *                         table name is invalid
   */
  private getIdColumn(name: string): PgColumn {
    try {
      if (!isNonEmptyString(name)) {
        throw new DatabaseError(
          "Invalid table name",
          DATABASE_ERROR_CODES.INVALID_TABLE_NAME,
        );
      }

      const idColumn = this.idColumnMap.get(name);
      if (!idColumn) {
        throw new DatabaseError(
          "ID column is not registered with the adapter",
          DATABASE_ERROR_CODES.ID_COLUMN_NOT_REGISTERED,
        );
      }
      return idColumn;
    } catch (error) {
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError(
            "Failed to get ID column",
            DATABASE_ERROR_CODES.GET_ID_COLUMN_FAILED,
          );
    }
  }

  /**
   * Combine multiple filters into a single SQL WHERE clause.
   *
   * @description
   * Prefers the `filters` array (AND-combined) over the singular `filter`.
   * Returns undefined when no filters are present.
   *
   * @param options - Query options potentially containing filters or filter
   * @param table - The PgTable to resolve columns against
   * @returns A combined SQL clause or undefined
   */
  private buildCombinedWhereClause<T extends object>(
    options: QueryOptions<T> | undefined,
    table: PgTable,
  ): SQL | undefined {
    if (!options) return undefined;

    const allClauses: SQL[] = [];

    if (options.orFilters && options.orFilters.length > 0) {
      const orGroups: SQL[] = [];
      for (const group of options.orFilters) {
        if (group.length === 0) continue;
        const clauses = group
          .map((f) => this.buildWhereClause(f, table))
          .filter((c): c is SQL => c !== undefined);
        if (clauses.length === 0) continue;
        if (clauses.length === 1) orGroups.push(clauses[0]);
        else orGroups.push(and(...clauses) as SQL);
      }
      if (orGroups.length === 1) allClauses.push(orGroups[0]);
      else if (orGroups.length > 1) allClauses.push(or(...orGroups) as SQL);
    } else if (options.filters && options.filters.length > 0) {
      const clauses = options.filters
        .map((f) => this.buildWhereClause(f, table))
        .filter((c): c is SQL => c !== undefined);
      if (clauses.length > 0) {
        if (clauses.length === 1) allClauses.push(clauses[0]);
        else allClauses.push(and(...clauses) as SQL);
      }
    } else if (options.filter) {
      const clause = this.buildWhereClause(options.filter, table);
      if (clause) allClauses.push(clause);
    }

    if (options.rawConditions && options.rawConditions.length > 0) {
      for (const rc of options.rawConditions) {
        if (!rc.clause) continue;
        const clause = this.buildRawConditionClause(rc);
        if (clause) allClauses.push(clause);
      }
    }

    if (allClauses.length === 0) return undefined;
    if (allClauses.length === 1) return allClauses[0];
    return and(...allClauses);
  }

  private buildRawConditionClause(rc: {
    clause: string;
    params: unknown[];
  }): SQL {
    if (rc.params.length === 0) {
      return sql`${sql.raw(`(${rc.clause})`)}`;
    }
    const parts = rc.clause.split(/\$(\d+)/);
    const fragments: SQL[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        if (parts[i]) fragments.push(sql`${sql.raw(parts[i])}`);
      } else {
        const idx = parseInt(parts[i], 10) - 1;
        if (idx >= 0 && idx < rc.params.length) {
          fragments.push(sql`${rc.params[idx]}`);
        }
      }
    }
    if (fragments.length === 0) return sql`1=1`;
    if (fragments.length === 1) return sql`(${fragments[0]})`;
    let result = fragments[0];
    for (let i = 1; i < fragments.length; i++) {
      result = sql`${result}${fragments[i]}`;
    }
    return sql`(${result})`;
  }

  /**
   * Build a Drizzle SQL WHERE clause from a single filter.
   *
   * @description
   * Resolves the filter's field name to a PgColumn on the table and maps
   * the operator to the corresponding Drizzle comparator. Supports eq, ne,
   * gt, gte, lt, lte, in, notIn, like, ilike, between, isNull, isNotNull.
   * Validates field names and column existence before building.
   *
   * @param filter - A single filter condition (field, operator, value)
   * @param table - The PgTable to resolve columns against
   * @returns A Drizzle SQL clause or undefined if the filter is empty
   * @throws {DatabaseError} When the field name or column is invalid,
   *                         or the operator is unsupported
   */
  // eslint-disable-next-line complexity
  private buildWhereClause<T extends object>(
    filter: Filter<T>,
    table: PgTable,
  ): SQL | undefined {
    try {
      if (!isObject(filter)) {
        return undefined;
      }

      const { field, operator, value } = filter;

      if (!isNonEmptyString(field) || !DB_REGEX.isValidFieldName(field)) {
        throw new DatabaseError(
          "Invalid field name",
          DATABASE_ERROR_CODES.INVALID_FIELD_NAME,
        );
      }

      const column = table[field as keyof typeof table] as Column<
        ColumnBaseConfig<ColumnDataType, string>
      >;
      if (!column) {
        throw new DatabaseError(
          "Column does not exist in table",
          DATABASE_ERROR_CODES.COLUMN_NOT_EXISTS,
        );
      }

      switch (operator) {
        case "eq":
          return eq(column, value);
        case "ne":
          return not(eq(column, value));
        case "gt":
          return gt(column, value);
        case "gte":
          return gte(column, value);
        case "lt":
          return lt(column, value);
        case "lte":
          return lte(column, value);
        case "in":
          if (Array.isArray(value) && value.length === 0) {
            return sql`1=0`;
          }
          return inArray(column, value as unknown[]);
        case "notIn":
          if (Array.isArray(value) && value.length === 0) {
            return sql`1=1`;
          }
          return not(inArray(column, value as unknown[]));
        case "like":
          return like(column, value as string);
        case "ilike":
          return ilike(column, value as string);
        case "between":
          return between(
            column,
            (value as [unknown, unknown])[0],
            (value as [unknown, unknown])[1],
          );
        case "isNull":
          return isNull(column);
        case "isNotNull":
          return isNotNull(column);
        default:
          throw new DatabaseError(
            "Unsupported operator",
            DATABASE_ERROR_CODES.UNSUPPORTED_OPERATOR,
          );
      }
    } catch (error) {
      throw new DatabaseError(
        "Failed to build WHERE clause",
        DATABASE_ERROR_CODES.BUILD_WHERE_FAILED,
        {
          context: {
            source: "DrizzleAdapter.buildWhereClause",
          },
          cause: error as Error,
        },
      );
    }
  }

  private renumberRawClause(clause: string, startIndex: number): string {
    return clause.replace(/\$(\d+)/g, (_match, num) => {
      return `$${startIndex + parseInt(num, 10) - 1}`;
    });
  }

  /**
   * Apply sort options to a Drizzle query.
   *
   * @description
   * Iterates over the sort descriptors and calls orderBy with ascending or
   * descending column references. Validates that each sort field exists as
   * a PgColumn on the table.
   *
   * @param query - The Drizzle query to append ORDER BY clauses to
   * @param sort - Array of sort descriptors (field + direction)
   * @param table - The PgTable to resolve columns against
   * @returns The query with orderBy applied
   * @throws {DatabaseError} When a sort field does not exist as a column
   */
  private applySorting<
    T extends object,
    TQuery extends {
      orderBy: (...columns: (SQL | SQLWrapper | PgColumn)[]) => TQuery;
    },
    TTable extends PgTable,
  >(query: TQuery, sort: SortOptions<T>[], table: TTable): TQuery {
    return sort.reduce((q, { field, direction }) => {
      if (!Object.prototype.hasOwnProperty.call(table, field)) {
        throw new DatabaseError(
          `Column ${field} does not exist in table`,
          DATABASE_ERROR_CODES.COLUMN_NOT_EXISTS,
        );
      }

      const key = field as keyof TTable;
      const column = table[key];

      if (!(column instanceof PgColumn)) {
        throw new DatabaseError(
          `Field ${field} is not a valid column`,
          DATABASE_ERROR_CODES.INVALID_COLUMN,
        );
      }

      return direction === "asc"
        ? q.orderBy(asc(column))
        : q.orderBy(desc(column));
    }, query);
  }
}
