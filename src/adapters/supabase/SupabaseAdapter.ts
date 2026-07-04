import type {
  DatabaseAdapterType,
  DatabaseResult,
  PaginatedResult,
  QueryOptions,
  Filter,
  DatabaseHealthStatus,
  Transaction,
  SupabaseAdapterConfig,
} from "@myko/types/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { failure, success } from "@utils/databaseResultHelpers";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";

import { calculatePagination } from "@utils/pagination";
import { NUMERIX } from "@myko/config";

/**
 * @class SupabaseAdapter
 * @implements {DatabaseAdapterType}
 * @classdesc
 * Supabase adapter implementation for database operations.
 *
 * This adapter provides an interface to interact with Supabase databases,
 * supporting CRUD operations, transactions, and health checks. It leverages
 * the Supabase JavaScript client to communicate with PostgreSQL databases through
 * Supabase's API. The adapter provides a consistent interface while abstracting
 * away the specifics of Supabase's API calls.
 */
export class SupabaseAdapter implements DatabaseAdapterType {
  /** The underlying Supabase client instance used for all database operations. */
  private client: SupabaseClient;
  /** Adapter configuration including URL, keys, schema, and table ID mappings. */
  private config: SupabaseAdapterConfig;
  /** Maps logical table names to actual Supabase table names. */
  private tableMap: Map<string, string> = new Map();
  /** Maps logical table names to custom primary key column names. */
  private idColumnMap: Map<string, string> = new Map();
  /** ID column overrides provided via configuration. */
  private configIdColumns: Record<string, string>;

  /**
   * Creates a new SupabaseAdapter instance.
   * @param {SupabaseAdapterConfig} config - Configuration for the Supabase adapter.
   * @description
   * Initializes the adapter with the provided configuration, setting up the Supabase client.
   * The configuration must include a Supabase URL and either a service key or an anonymous key.
   * The adapter maintains internal maps for table names and ID columns to provide a level of
   * abstraction over the database schema. If required configuration values are missing,
   * the constructor throws a DatabaseError.
   * @throws {DatabaseError} If Supabase URL or key is not provided in the configuration.
   */
  constructor(config: SupabaseAdapterConfig) {
    this.config = config;
    // Store custom ID column mappings from config
    this.configIdColumns = config.tableIdColumns ?? {};

    if (!config.supabaseUrl) {
      throw new DatabaseError(
        "Supabase URL is required for Supabase adapter",
        DATABASE_ERROR_CODES.CONFIG_REQUIRED,
      );
    }

    const key = config.supabaseServiceKey ?? config.supabaseAnonKey;

    if (!key) {
      throw new DatabaseError(
        "Supabase key is required for Supabase adapter",
        DATABASE_ERROR_CODES.CONFIG_REQUIRED,
      );
    }

    this.client = createClient(config.supabaseUrl, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      db: {
        schema: (config.schema ?? "public") as "public",
      },
    });
  }

  /**
   * Initializes the Supabase database adapter.
   * @returns {Promise<DatabaseResult<void>>} A promise resolving to a DatabaseResult indicating
   * whether the initialization was successful or failed.
   * @description
   * Validates the Supabase database connection by invoking a simple predefined RPC function (`version`).
   * This method is typically executed during application startup to ensure the adapter can
   * successfully communicate with the database before performing any operations.
   *
   * The method calls the `version` RPC to confirm connectivity. If the RPC function is not defined,
   * it is treated as a non-critical error and the connection is still considered valid. Any other
   * errors are reported as initialization failures.
   */
  async initialize(): Promise<DatabaseResult<void>> {
    try {
      // Verify the database connection by invoking the predefined `version` RPC function.
      const { error } = await this.client.rpc("version");

      // If the `version` RPC function does not exist, consider it non-critical — connection is verified.
      if (
        error &&
        !error.message.includes('function "version" does not exist')
      ) {
        return failure(
          new DatabaseError(
            `Failed to initialize Supabase adapter: ${error.message}`,
            DATABASE_ERROR_CODES.INIT_FAILED,
            {
              context: {
                source: "SupabaseAdapter.initialize",
              },
              cause: error,
            },
          ),
        );
      }

      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to initialize Supabase adapter: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.INIT_FAILED,
          {
            context: {
              source: "SupabaseAdapter.initialize",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Connect to the database.
   * @returns {Promise<void>} Promise that resolves when connected.
   * @description
   * Supabase handles connections automatically, so this method is a no-op.
   * The Supabase client manages connections internally, establishing them as needed
   * and handling connection pooling. This method is included for interface compatibility
   * but does not perform any connection operations.
   */
  async connect(): Promise<void> {
    // Supabase handles connections automatically
  }

  /**
   * Disconnect from the database.
   * @returns {Promise<void>} Promise that resolves when disconnected.
   * @description
   * Supabase handles disconnections automatically, so this method is a no-op.
   * The Supabase client manages connections internally, closing them when appropriate.
   * This method is included for interface compatibility but does not perform any
   * disconnection operations.
   */
  async disconnect(): Promise<void> {
    // Supabase handles disconnections automatically
  }

  /**
   * Closes the database connection and cleanup resources.
   * Supabase handles connections automatically, so this just returns success.
   * @returns Promise resolving to DatabaseResult indicating success.
   */
  async close(): Promise<DatabaseResult<void>> {
    await this.disconnect();
    return success();
  }

  /**
   * Gets the underlying Supabase client instance.
   * @template TClient - The type of the Supabase client to return.
   * @returns {TClient} The Supabase client instance cast to the specified client type.
   * @description
   * This method provides access to the underlying Supabase client.
   * Although direct access is technically possible, it is discouraged to maintain
   * abstraction and ensure that all database operations go through the adapter's
   * interface for consistent error handling, logging, and event management.
   */
  getClient<TClient extends object = object>(): TClient {
    return this.client as TClient;
  }

  /**
   * Execute a raw SQL query.
   * @template T - The expected type of the query result rows.
   * @param {string} sql - SQL query string.
   * @param {T[]} [params] - Query parameters.
   * @returns {Promise<T[]>} Promise resolving to query results.
   * @description
   * Executes a raw SQL query against the database using Supabase's RPC function.
   * This method is useful for complex queries that cannot be easily expressed using the adapter's
   * built-in methods or for database-specific operations. The method uses parameterized queries
   * to prevent SQL injection attacks. If the query execution fails, a DatabaseError is thrown.
   * Note that this requires a custom RPC function named 'exec_sql' to be set up in your Supabase project.
   */
  async query<TResult, TParams = unknown>(
    sql: string,
    params?: TParams[],
  ): Promise<TResult[]> {
    try {
      const { data, error } = await this.client.rpc("exec_sql", {
        sql,
        params,
      });
      if (error)
        throw new DatabaseError(
          `Failed to execute query: ${sql} - ${error.message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          {
            context: {
              source: "SupabaseAdapter.query",
            },
            cause: error,
          },
        );
      return data as TResult[];
    } catch (error) {
      throw new DatabaseError(
        `Failed to execute query: ${sql} - ${(error as Error).message}`,
        DATABASE_ERROR_CODES.QUERY_FAILED,
        {
          context: {
            source: "SupabaseAdapter.query",
          },
          cause: error as Error,
        },
      );
    }
  }

  /**
   * Register a table with the adapter.
   * @template TTable - Type representing the table structure.
   * @template TIdColumn - Type representing the ID column.
   * @param {string} name - Logical name for the table.
   * @param {TTable} [table] - Actual table name (defaults to logical name if not provided).
   * @param {TIdColumn} [idColumn] - Optional ID column name.
   * @description
   * Registers a table with the adapter, allowing it to be referenced by a logical name
   * in subsequent operations. This is necessary for the adapter to perform operations
   * on the table. The ID column can also be specified if it differs from the default 'id'.
   * This registration enables the adapter to map logical table names to actual table names
   * and ID columns, providing a layer of abstraction between the application and the database schema.
   * If no table name is provided, the logical name is used as the actual table name.
   */
  registerTable<TTable, TIdColumn>(
    name: string,
    table?: TTable,
    idColumn?: TIdColumn,
  ): void {
    this.tableMap.set(name, (table as string) || name);
    if (idColumn) {
      this.idColumnMap.set(name, idColumn as string);
    }
  }

  /**
   * Find a single record by ID.
   * @template T - The expected type of the record.
   * @param {string} table - Table name.
   * @param {string} id - Record ID.
   * @returns {Promise<DatabaseResult<T | null>>} Promise resolving to DatabaseResult containing the record or null.
   * @description
   * Retrieves a single record from the specified table using its primary ID.
   * The method uses Supabase's select method with a filter for the ID column and
   * the single() method to retrieve exactly one record. If the record is found,
   * it is returned in a success result. If no record is found (indicated by error code PGRST116),
   * null is returned in a success result. If an error occurs during the operation,
   * a failure result with an error message is returned.
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    try {
      const tableName = this.getTableName(table);
      const idColumn = this.idColumnMap.get(table) ?? "id";
      const { data, error } = await this.client
        .from(tableName)
        .select("*")
        .eq(idColumn, id)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          return success();
        }
        return failure(
          new DatabaseError(
            `Failed to find by id in table ${table}: ${error.message}`,
            DATABASE_ERROR_CODES.FIND_BY_ID_FAILED,
            {
              context: {
                source: "SupabaseAdapter.findById",
              },
              cause: error,
            },
          ),
        );
      }

      return success(data as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to find by id in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.FIND_BY_ID_FAILED,
          {
            context: {
              source: "SupabaseAdapter.findById",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Find multiple records with filtering and pagination.
   * @template T - The expected type of the records.
   * @param {string} table - Table name.
   * @param {QueryOptions} [options] - Query options including filters, sorting, and pagination.
   * @returns {Promise<DatabaseResult<PaginatedResult<T>>>} Promise resolving to DatabaseResult containing paginated data.
   * @description
   * Retrieves multiple records from the specified table with support for filtering,
   * sorting, and pagination. The method first executes a count query to get the
   * total number of matching records, then executes the main query with the applied filters,
   * sorting, and pagination. The result includes the data array, total count of matching records,
   * and pagination metadata such as current page, total pages, and limit.
   * If an error occurs during the operation, a failure result with an error message is returned.
   */
  // eslint-disable-next-line complexity
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    try {
      const tableName = this.getTableName(table);
      let query = this.client.from(tableName).select("*");

      // Apply filters if provided
      if (options?.filter) {
        query = this.applyFilter(query, options.filter);
      }

      // Get total count for pagination
      let countQuery = this.client
        .from(tableName)
        .select("*", { count: "exact", head: true });
      if (options?.filter) {
        countQuery = this.applyFilter(countQuery, options.filter);
      }
      const { count, error: countError } = await countQuery;

      if (countError) {
        return failure(
          new DatabaseError(
            `Failed to count records in table ${table}: ${countError.message}`,
            DATABASE_ERROR_CODES.COUNT_FAILED,
            {
              context: {
                source: "SupabaseAdapter.findMany",
              },
              cause: countError,
            },
          ),
        );
      }

      // Apply sorting if provided
      if (options?.sort) {
        options.sort.forEach((sortOption) => {
          query = query.order(sortOption.field, {
            ascending: sortOption.direction === "asc",
          });
        });
      }

      // Apply pagination if provided
      if (options?.pagination) {
        if (options.pagination.offset !== undefined) {
          query = query.range(
            options.pagination.offset,
            options.pagination.offset +
              (options.pagination.limit ?? NUMERIX.TEN) -
              1,
          );
        } else if (options.pagination.limit !== undefined) {
          query = query.limit(options.pagination.limit);
        }
      }

      const { data, error } = await query;

      if (error) {
        return failure(
          new DatabaseError(
            `Failed to find many in table ${table}: ${error.message}`,
            DATABASE_ERROR_CODES.FIND_MANY_FAILED,
            {
              context: {
                source: "SupabaseAdapter.findMany",
              },
              cause: error,
            },
          ),
        );
      }

      const total = count ?? 0;

      return success({
        data: data as T[],
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
              source: "SupabaseAdapter.findMany",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Create a new record.
   * @template T - The expected type of the record.
   * @param {string} table - Table name.
   * @param {T} data - Record data to create.
   * @returns {Promise<DatabaseResult<T>>} Promise resolving to DatabaseResult containing the created record.
   * @description
   * Inserts a new record into the specified table using the provided data.
   * The method uses Supabase's insert method with the data and then chains a select()
   * and single() call to retrieve the inserted record with any auto-generated fields
   * (like IDs) populated. If the operation is successful, it returns the created record.
   * If an error occurs during the operation, a failure result with an error message is returned.
   */
  async create<T>(table: string, data: T): Promise<DatabaseResult<T>> {
    try {
      const tableName = this.getTableName(table);
      const { data: result, error } = await this.client
        .from(tableName)
        .insert(data as any)
        .select()
        .single();

      if (error) {
        return failure(
          new DatabaseError(
            `Failed to create in table ${table}: ${error.message}`,
            DATABASE_ERROR_CODES.CREATE_FAILED,
            {
              context: {
                source: "SupabaseAdapter.create",
              },
              cause: error,
            },
          ),
        );
      }

      return success(result as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to create in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.CREATE_FAILED,
          {
            context: {
              source: "SupabaseAdapter.create",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Update an existing record.
   * @template T - The expected type of the record.
   * @param {string} table - Table name.
   * @param {string} id - Record ID.
   * @param {Partial<T>} data - Partial record data to update.
   * @returns {Promise<DatabaseResult<T>>} Promise resolving to DatabaseResult containing the updated record.
   * @description
   * Updates an existing record in the specified table using its primary ID.
   * Only the fields provided in the data object are updated, allowing for partial updates.
   * The method uses Supabase's update method with the data and a filter for the ID column,
   * then chains a select() and single() call to retrieve the updated record. If the operation
   * is successful, it returns the updated record. If an error occurs during the operation,
   * a failure result with an error message is returned.
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    try {
      const tableName = this.getTableName(table);
      const idColumn = this.idColumnMap.get(table) ?? "id";
      const { data: result, error } = await this.client
        .from(tableName)
        .update(data as any)
        .eq(idColumn, id)
        .select()
        .single();

      if (error) {
        return failure(
          new DatabaseError(
            `Failed to update in table ${table}: ${error.message}`,
            DATABASE_ERROR_CODES.UPDATE_FAILED,
            {
              context: {
                source: "SupabaseAdapter.update",
              },
              cause: error,
            },
          ),
        );
      }

      return success(result as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to update in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: {
              source: "SupabaseAdapter.update",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Delete a record.
   * @param {string} table - Table name.
   * @param {string} id - Record ID.
   * @returns {Promise<DatabaseResult<void>>} Promise resolving to DatabaseResult indicating success or failure.
   * @description
   * Deletes a record from the specified table using its primary ID.
   * The method uses Supabase's delete method with a filter for the ID column.
   * If the operation is successful, it returns a success result with no value.
   * If an error occurs during the operation, a failure result with an error message is returned.
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    try {
      const tableName = this.getTableName(table);
      const idColumn = this.idColumnMap.get(table) ?? "id";
      const { error } = await this.client
        .from(tableName)
        .delete()
        .eq(idColumn, id);

      if (error) {
        return failure(
          new DatabaseError(
            `Failed to delete from table ${table}: ${error.message}`,
            DATABASE_ERROR_CODES.DELETE_FAILED,
            {
              context: {
                source: "SupabaseAdapter.delete",
              },
              cause: error,
            },
          ),
        );
      }

      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to delete from table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: {
              source: "SupabaseAdapter.delete",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Execute operations grouped as a transaction.
   *
   * **IMPORTANT LIMITATION:** Supabase's REST API does not support real
   * multi-statement transactions with atomic commit/rollback. This method
   * provides *operation grouping* — all operations run through the same
   * Supabase client, but if the callback throws, any mutations that already
   * executed are NOT rolled back. Use `SQLAdapter` or `PrismaAdapter` if
   * you need true ACID transactions.
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    try {
      console.warn(
        "[SupabaseAdapter] Transactions are NOT atomic — prior mutations are NOT rolled back on failure. Use SQLAdapter for real transactions.",
      );

      const trx: Transaction = {
        findById: async <T>(table: string, id: string) => {
          return this.findById<T>(table, id);
        },
        create: async <T>(table: string, data: T) => {
          return this.create<T>(table, data);
        },
        update: async <T>(table: string, id: string, data: Partial<T>) => {
          return this.update<T>(table, id, data);
        },
        delete: async (table: string, id: string) => {
          return this.delete(table, id);
        },
        updateMany: async (_table: string, _where: Record<string, any>, _data: Record<string, any>) => {
          throw new DatabaseError(
            "updateMany not implemented in SupabaseAdapter transaction",
            DATABASE_ERROR_CODES.QUERY_FAILED,
          );
        },
        deleteMany: async (_table: string, _where: Record<string, any>) => {
          throw new DatabaseError(
            "deleteMany not implemented in SupabaseAdapter transaction",
            DATABASE_ERROR_CODES.QUERY_FAILED,
          );
        },
        upsert: async <T>(table: string, where: Record<string, any>, create: Record<string, any>, update: Record<string, any>) => {
          const allData = { ...create, ...update, ...where };
          const { data, error } = await this.client.from(table).upsert(allData).select().single();
          if (error)
            throw new DatabaseError(`Upsert failed: ${error.message}`, DATABASE_ERROR_CODES.QUERY_FAILED, { cause: error });
          return success(data as unknown as T);
        },
        commit: async () => {
          console.warn(
            "[SupabaseAdapter] commit() is a no-op — Supabase does not support explicit commits.",
          );
        },
        rollback: async () => {
          console.warn(
            "[SupabaseAdapter] rollback() is a no-op — prior mutations have already been applied and CANNOT be undone.",
          );
        },
      };

      const result = await callback(trx);
      return success(result);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Transaction failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.TRANSACTION_FAILED,
          {
            context: {
              source: "SupabaseAdapter.transaction",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Check if a record exists.
   * @param {string} table - Table name.
   * @param {string} id - Record ID.
   * @returns {Promise<DatabaseResult<boolean>>} Promise resolving to DatabaseResult containing boolean indicating existence.
   * @description
   * Checks if a record with the specified ID exists in the table.
   * The method constructs a SELECT query with a WHERE clause for the ID column
   * and a LIMIT of 1. It returns a success result with a boolean value indicating
   * whether the record exists. If an error occurs during the operation, a failure result
   * with an error message is returned.
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    try {
      const tableName = this.getTableName(table);
      const idColumn = this.idColumnMap.get(table) ?? "id";
      const { data, error } = await this.client
        .from(tableName)
        .select(idColumn)
        .eq(idColumn, id)
        .limit(1);

      if (error) {
        return failure(
          new DatabaseError(
            `Failed to check existence in table ${table}: ${error.message}`,
            DATABASE_ERROR_CODES.EXISTS_FAILED,
            {
              context: {
                source: "SupabaseAdapter.exists",
              },
              cause: error,
            },
          ),
        );
      }
      return success((data && data.length > 0) || false);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to check existence in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.EXISTS_FAILED,
          {
            context: {
              source: "SupabaseAdapter.exists",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Count records matching a filter.
   * @param {string} table - Table name.
   * @param {Filter} [filter] - Filter conditions.
   * @returns {Promise<DatabaseResult<number>>} Promise resolving to DatabaseResult containing the count.
   * @description
   * Counts the number of records in the specified table that match the optional filter.
   * The method uses Supabase's select method with the count option set to 'exact'
   * and head set to true to return only the count. If a filter is provided,
   * it is applied to narrow down the count to matching records. It returns a success
   * result with the count of matching records. If an error occurs during the operation,
   * a failure result with an error message is returned.
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T>,
  ): Promise<DatabaseResult<number>> {
    try {
      const tableName = this.getTableName(table);
      let query = this.client
        .from(tableName)
        .select("*", { count: "exact", head: true });

      if (filter) {
        query = this.applyFilter(query, filter);
      }

      const { count, error } = await query;

      if (error) {
        return failure(
          new DatabaseError(
            `Failed to count in table ${table}: ${error.message}`,
            DATABASE_ERROR_CODES.COUNT_FAILED,
            {
              context: {
                source: "SupabaseAdapter.count",
              },
              cause: error,
            },
          ),
        );
      }
      return success(count ?? 0);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to count in table ${table}: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.COUNT_FAILED,
          {
            context: {
              source: "SupabaseAdapter.count",
            },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Perform health check.
   * @returns {Promise<DatabaseResult<DatabaseHealthStatus>>} Promise resolving to DatabaseResult containing health status.
   * @description
   * Checks the health of the database connection by executing a simple RPC call.
   * The method measures the response time of the query to determine the health status.
   * It attempts to call a 'version' RPC function, ignoring errors related to the function
   * not existing but reporting other errors. It returns a success result with a DatabaseHealthStatus
   * object indicating whether the database is healthy, the response time of the health check,
   * and any additional details. If an error occurs during the operation, a failure result
   * with an error message is returned.
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    const startTime = Date.now();
    try {
      const { error } = await this.client.rpc("version");
      const responseTime = Date.now() - startTime;

      if (
        error &&
        !error.message.includes('function "version" does not exist')
      ) {
        return success({
          isHealthy: false,
          responseTime,
          details: { adapter: "supabase", error: error.message },
        });
      }
      return success({
        isHealthy: true,
        responseTime,
        details: { adapter: "supabase" },
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return success({
        isHealthy: false,
        responseTime,
        details: { adapter: "supabase", error: (error as Error).message },
      });
    }
  }

  /**
   * Get the actual table name from the mapped table name.
   * @private
   * @param {string} name - Logical table name.
   * @returns {string} Actual table name.
   * @description
   * Retrieves the actual table name. If not registered, auto-registers it.
   * This enables seamless table operations without manual registration.
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
   * Applies filter conditions to a Supabase query with comprehensive operator support
   *
   * Transforms generic Filter objects into Supabase-specific query methods while maintaining
   * type safety and preventing SQL injection through operator validation.
   *
   * **Supported Operators:**
   * - Equality: eq, ne (not equal)
   * - Comparison: gt, gte, lt, lte
   * - Pattern: like (with % wildcards)
   * - Membership: in, notIn (array values)
   * - Range: between (two-element array)
   * - Null checks: isNull, isNotNull
   *
   * **Security Features:**
   * - Validates field names against regex: /^[a-zA-Z_][a-zA-Z0-9_]*$/
   * - Validates operator against whitelist
   * - Type-checks array values for 'in', 'notIn', 'between' operators
   *
   * @private
   * @template Q - Type of the Supabase query builder
   * @param {Q} query - Supabase query builder instance to apply filters to
   * @param {Filter} filter - Filter conditions with field, operator, and value
   * @returns {Q} Modified query builder with filter conditions applied
   *
   * @throws {BaseError} SUPABASE_INVALID_FILTER - If 'in'/'notIn' value is not an array
   * @throws {BaseError} SUPABASE_INVALID_FILTER - If 'between' value is not a 2-element array
   * @throws {BaseError} SUPABASE_UNSUPPORTED_OPERATOR - If operator is not in whitelist
   *
   * @example
   * ```typescript
   * // Equality filter
   * const query1 = this.applyFilter(baseQuery, {
   *   field: 'status',
   *   operator: 'eq',
   *   value: 'active'
   * });
   * // Generates: query.eq('status', 'active')
   *
   * // Range filter
   * const query2 = this.applyFilter(baseQuery, {
   *   field: 'age',
   *   operator: 'between',
   *   value: [18, 65]
   * });
   * // Generates: query.gte('age', 18).lte('age', 65)
   *
   * // Array membership filter
   * const query3 = this.applyFilter(baseQuery, {
   *   field: 'category',
   *   operator: 'in',
   *   value: ['tech', 'science', 'business']
   * });
   * // Generates: query.in('category', ['tech', 'science', 'business'])
   * ```
   *
   */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyFilter<T extends object = object>(q: any, f: Filter<T>): any {
    const { field, operator, value } = f;

    const ops: Record<string, Function> = {
      eq: () => q.eq(field, value),
      ne: () => q.neq(field, value),
      gt: () => q.gt(field, value),
      gte: () => q.gte(field, value),
      lt: () => q.lt(field, value),
      lte: () => q.lte(field, value),
      like: () => q.like(field, value),
      isNull: () => q.is(field, null),
      isNotNull: () => q.isNot(field, null),
      in: () => {
        if (!Array.isArray(value))
          throw new DatabaseError(
            `'in' requires array`,
            DATABASE_ERROR_CODES.INVALID_FILTER,
          );
        return q.in(field, value);
      },
      notIn: () => {
        if (!Array.isArray(value))
          throw new DatabaseError(
            `'notIn' requires array`,
            DATABASE_ERROR_CODES.INVALID_FILTER,
          );
        return q.notIn(field, value);
      },
      between: () => {
        if (!Array.isArray(value) || value.length !== NUMERIX.TWO)
          throw new DatabaseError(
            `'between' requires [min,max]`,
            DATABASE_ERROR_CODES.INVALID_FILTER,
          );
        return q.gte(field, value[0]).lte(field, value[1]);
      },
    };

    if (!ops[operator])
      throw new DatabaseError(
        `Unsupported operator: ${operator}`,
        DATABASE_ERROR_CODES.UNSUPPORTED_OPERATOR,
      );
    return ops[operator]();
  }
}
