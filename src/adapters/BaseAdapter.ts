import type { DatabaseAdapterType } from "@myko/types/db";

/**
 * Abstract base class for database adapters.
 *
 * @description
 * Provides shared table-registry bookkeeping (tableMap, idColumnMap,
 * registerTable, getTableName, getIdColumn) so that each concrete adapter
 * only needs to implement its own query-execution logic.
 *
 * Concrete subclasses must fulfill the DatabaseAdapterType contract:
 * lifecycle methods (initialize/connect/disconnect/close), CRUD operations
 * (findById/findMany/create/update/delete), raw query, transaction, exists,
 * count, healthCheck, and getClient.
 */
export abstract class BaseAdapter implements DatabaseAdapterType {
  protected tableMap: Map<string, string> = new Map();
  protected idColumnMap: Map<string, string> = new Map();
  protected configIdColumns: Record<string, string>;

  constructor(configIdColumns?: Record<string, string>) {
    this.configIdColumns = configIdColumns ?? {};
  }

  /**
   * Register a table and optional ID column for use with the adapter.
   *
   * @description
   * Maps a logical table name to its physical name and optionally registers
   * the primary-key column. If `table` is omitted the logical name is used
   * as the physical name. If `idColumn` is omitted the value is resolved
   * from config or falls back to "id" at query time.
   *
   * @param name - Logical name used to reference the table in subsequent calls
   * @param table - Physical table name (string) or typed table object
   * @param idColumn - Optional primary-key column name
   */
  registerTable<TTable, TIdColumn>(
    name: string,
    table?: TTable,
    idColumn?: TIdColumn,
  ): void {
    this.tableMap.set(name, (table as string) ?? name);
    if (idColumn !== undefined) {
      this.idColumnMap.set(name, idColumn as string);
    }
  }

  /**
   * Resolve a logical table name to its physical name, auto-registering if absent.
   *
   * @description
   * Looks up the internal table map. When no entry exists the table is
   * auto-registered with itself as the physical name and any config-provided
   * ID column is associated.
   *
   * @param name - Logical table name to resolve
   * @returns The physical table name
   */
  protected getTableName(name: string): string {
    let tableName = this.tableMap.get(name);
    if (!tableName) {
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
  protected getIdColumn(table: string): string {
    const fromRuntime = this.idColumnMap.get(table);
    if (fromRuntime) return fromRuntime;
    const fromConfig = this.configIdColumns[table];
    if (fromConfig) return fromConfig;
    return "id";
  }

  /**
   * Initialize the adapter (e.g. test connectivity, set up schema).
   *
   * @description
   * Should be called once during application startup. Subclasses should
   * perform any one-time setup such as verifying the connection pool or
   * applying schema search paths.
   */
  abstract initialize(): Promise<any>;

  /**
   * Establish a connection to the database.
   *
   * @description
   * Ensures the underlying pool or client is ready. May throw on failure.
   */
  abstract connect(): Promise<void>;

  /**
   * Gracefully shut down the database connection.
   *
   * @description
   * Releases all pool resources. Idempotent — safe to call multiple times.
   */
  abstract disconnect(): Promise<void>;

  /**
   * Alias for disconnect that returns a DatabaseResult.
   *
   * @description
   * Wraps the disconnect logic in a result-based return instead of throwing.
   */
  abstract close(): Promise<any>;

  /**
   * Return the underlying database client / driver instance.
   *
   * @template TClient - The type to cast the client to (defaults to object)
   * @returns The native driver client, cast as TClient
   */
  abstract getClient<T extends object = object>(): T;

  /**
   * Execute a raw SQL string against the database.
   *
   * @template TResult - The row shape returned by the query
   * @template TParams - The parameter value type (defaults to unknown)
   * @param sql - The SQL statement to execute
   * @param params - Optional parameterised values
   * @returns An array of result rows
   */
  abstract query<TResult, TParams = unknown>(sql: string, params?: TParams[]): Promise<TResult[]>;

  /**
   * Find a single record by its primary-key value.
   *
   * @param table - Logical or physical table name
   * @param id - The primary-key value to look up
   * @returns The found record, or null if not present
   */
  abstract findById<T>(table: string, id: string): Promise<any>;

  /**
   * Find multiple records with optional filtering, sorting and pagination.
   *
   * @param table - Logical or physical table name
   * @param options - Query options (filters, sort, pagination)
   * @returns A paginated result set
   */
  abstract findMany<T extends object>(table: string, options?: any): Promise<any>;

  /**
   * Create a new record in the given table.
   *
   * @param table - Logical or physical table name
   * @param data - The record data to insert
   * @returns The created record, including any server-generated fields
   */
  abstract create<T extends object>(table: string, data: T): Promise<any>;

  /**
   * Update an existing record by its primary-key value.
   *
   * @param table - Logical or physical table name
   * @param id - The primary-key value of the record to update
   * @param data - Partial record data containing only changed fields
   * @returns The updated record
   */
  abstract update<T>(table: string, id: string, data: Partial<T>): Promise<any>;

  /**
   * Delete a record by its primary-key value.
   *
   * @param table - Logical or physical table name
   * @param id - The primary-key value of the record to delete
   */
  abstract delete(table: string, id: string): Promise<any>;

  /**
   * Execute a callback within a database transaction.
   *
   * @param callback - Function receiving a transaction object that exposes
   *                   scoped findById / create / update / delete methods
   * @returns The value returned by the callback
   */
  abstract transaction<T>(callback: (trx: any) => Promise<T>): Promise<any>;

  /**
   * Check whether a record with the given primary-key value exists.
   *
   * @param table - Logical or physical table name
   * @param id - The primary-key value to check
   * @returns true if a matching record is found, false otherwise
   */
  abstract exists(table: string, id: string): Promise<any>;

  /**
   * Count records in a table, optionally filtered.
   *
   * @param table - Logical or physical table name
   * @param filter - Optional filter condition
   * @returns The number of matching records
   */
  abstract count<T extends object = object>(table: string, filter?: any): Promise<any>;

  /**
   * Perform a health check against the database.
   *
   * @description
   * Subclasses should execute a simple query (e.g. SELECT 1) and return
   * the measured response time and health status.
   *
   * @returns Health status with isHealthy flag, responseTime and details
   */
  abstract healthCheck(): Promise<any>;
}
