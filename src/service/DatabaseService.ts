import { DatabaseEventEmitter } from "./EventEmitter";
import { HealthManager } from "./HealthManager";
import { ConfigMerger } from "@utils/ConfigMerger";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";
import type {
  AuditContext,
  BatchUpdate,
  BatchUpsertItem,
  CreateInput,
  DatabaseAdapterType,
  DatabaseEvent,
  DatabaseEvents,
  DatabaseHealthStatus,
  DatabaseResult,
  DatabaseServiceConfig,
  DatabaseServiceInterface,
  Filter,
  FindFirstOptions,
  OperationConfig,
  PaginatedResult,
  QueryOptions,
  ServiceStatus,
  TableName,
  TransactionFn,
  UpdateInput,
} from "@myko.pk/types/db";
import { ADAPTERS } from "@myko.pk/types/db";
import { failure, success } from "@utils/databaseResultHelpers";

/**
 * Internal service layer that orchestrates all database operations.
 *
 * @description
 * DatabaseService implements DatabaseServiceInterface and serves as the
 * primary facade for CRUD, batch, query, transaction, and event operations.
 * It delegates to an underlying adapter (which may be wrapped in extension
 * decorators), fires lifecycle events, and merges global/per-operation config.
 *
 * Instances are created by {@link createDatabaseService} and should not be
 * instantiated directly outside the factory.
 *
 * @internal
 */
export class DatabaseService implements DatabaseServiceInterface {
  private readonly globalConfig: DatabaseServiceConfig;
  public readonly adapter: DatabaseAdapterType;
  private readonly eventHandlers: DatabaseEvents | undefined;
  private readonly eventEmitter: DatabaseEventEmitter;
  private readonly healthManager: HealthManager;
  private readonly startTime: Date;
  private auditContext: AuditContext = {};

  /**
   * Create a DatabaseService instance.
   *
   * @param config.adapter - The underlying database adapter (possibly decorated)
   * @param config.globalConfig - Global configuration merged with per-operation overrides
   * @param config.eventHandlers - Optional lifecycle event callbacks (onBeforeRead, etc.)
   */
  constructor(config: {
    adapter: DatabaseAdapterType;
    globalConfig: DatabaseServiceConfig;
    eventHandlers?: DatabaseEvents;
  }) {
    this.globalConfig = config.globalConfig;
    this.adapter = config.adapter;
    this.eventHandlers = config.eventHandlers;
    this.startTime = new Date();

    const adapterType =
      ((config.adapter?.constructor as any)?.adapterName as ADAPTERS) ??
      (config.adapter?.constructor?.name?.toLowerCase() as ADAPTERS) ??
      ADAPTERS.SQL;
    this.eventEmitter = new DatabaseEventEmitter(adapterType);
    this.healthManager = new HealthManager(config.adapter);

    console.log(`DatabaseService initialized with ${adapterType} adapter`);
  }

  /**
   * Resolve the final table name and apply per-operation overrides.
   *
   * Handles schema prefix replacement and registers custom ID columns
   * on the adapter for the duration of the operation.
   *
   * @param table - The logical table name, possibly schema-qualified
   * @param operationConfig - Optional per-operation config with schema/idColumn overrides
   * @returns The final table name string
   */
  private prepareTable(
    table: TableName,
    operationConfig?: OperationConfig,
  ): string {
    let finalTableName = table;

    // Handle schema override
    if (operationConfig?.schema) {
      // If table already has schema prefix, replace it
      const tableWithoutSchema = table.includes(".")
        ? table.split(".")[1]
        : table;
      finalTableName = `${operationConfig.schema}.${tableWithoutSchema}`;
    }

    // Handle custom ID column override
    if (operationConfig?.idColumn) {
      // Temporarily register the table with the custom ID column
      // This allows the adapter to use the correct ID column for this operation
      this.adapter.registerTable(
        finalTableName,
        finalTableName,
        operationConfig.idColumn,
      );
    }

    return finalTableName;
  }

  /**
   * Retrieve a single record by its ID.
   *
   * Fires before-read and after-read events if configured.
   *
   * @typeParam T - Shape of the returned record
   * @param table - Target table name
   * @param id - Record ID
   * @param operationConfig - Optional per-operation overrides for schema/idColumn
   * @returns The found record or null wrapped in a DatabaseResult
   */
  async get<T extends object>(
    table: TableName,
    id: string,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T | null>> {
    // Merge configs - operation config takes precedence
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    // Prepare table with schema and ID column overrides
    const finalTable = this.prepareTable(table, operationConfig);

    try {
      // Fire before-read event if configured
      if (this.eventHandlers?.onBeforeRead) {
        await this.eventHandlers.onBeforeRead({
          type: "beforeRead",
          operation: "READ",
          table,
          timestamp: new Date(),
        });
      }

      // Delegate to adapter with resolved config
      const result = await this.adapter.findById<T>(finalTable, id);

      // Fire after-read event if configured and successful
      if (result.success && this.eventHandlers?.onAfterRead) {
        await this.eventHandlers.onAfterRead({
          type: "afterRead",
          operation: "READ",
          table,
          result: (result.value ?? {}) as Record<
            string,
            string | number | boolean | Date
          >,
          duration: 0, // TODO: Track duration
          timestamp: new Date(),
        });
      }

      return result;
    } catch (error) {
      return failure(
        new DatabaseError(
          `Get operation failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          {
            context: { source: "get" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * List records with optional filtering, sorting, and pagination.
   *
   * Merges operation config with global config before delegating to the
   * adapter. Fires before-read and after-read lifecycle events.
   *
   * @typeParam T - Shape of the returned records
   * @param table - Target table name
   * @param options - Query options including filter, sort, pagination
   * @param operationConfig - Optional per-operation config overrides
   * @returns A paginated result set wrapped in a DatabaseResult
   */
  async list<T extends object>(
    table: TableName,
    options?: QueryOptions<T>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    // Prepare table with schema and ID column overrides
    const finalTable = this.prepareTable(table, operationConfig);

    if (this.eventHandlers?.onBeforeRead) {
      await this.eventHandlers.onBeforeRead({
        type: "beforeRead",
        operation: "READ",
        table,
        timestamp: new Date(),
      });
    }

    const result = await this.adapter.findMany<T>(finalTable, options);

    if (result.success && this.eventHandlers?.onAfterRead) {
      await this.eventHandlers.onAfterRead({
        type: "afterRead",
        operation: "READ",
        table,
        result: (result.value ?? {}) as Record<
          string,
          string | number | boolean | Date
        >,
        duration: 0,
        timestamp: new Date(),
      });
    }

    return result;
  }

  /**
   * Create a new record.
   *
   * Fires before-write and after-write lifecycle events.
   *
   * @typeParam T - Shape of the created record
   * @param table - Target table name
   * @param input - The data to insert
   * @param operationConfig - Optional per-operation config overrides
   * @returns The created record wrapped in a DatabaseResult
   */
  async create<T extends object>(
    table: TableName,
    input: CreateInput<T>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    // Prepare table with schema and ID column overrides
    const finalTable = this.prepareTable(table, operationConfig);

    if (this.eventHandlers?.onBeforeWrite) {
      await this.eventHandlers.onBeforeWrite({
        type: "beforeWrite",
        operation: "CREATE",
        table,
        data: input as Record<string, string | number | boolean | Date>,
        timestamp: new Date(),
      });
    }

    const result = await this.adapter.create<T>(finalTable, input as T);

    if (result.success && this.eventHandlers?.onAfterWrite) {
      await this.eventHandlers.onAfterWrite({
        type: "afterWrite",
        operation: "CREATE",
        table,
        result: result.value as Record<
          string,
          string | number | boolean | Date
        >,
        duration: 0,
        timestamp: new Date(),
      });
    }

    return result;
  }

  /**
   * Update an existing record by ID.
   *
   * Fires before-write and after-write lifecycle events.
   *
   * @typeParam T - Shape of the updated record
   * @param table - Target table name
   * @param id - Record ID
   * @param input - Partial data to update
   * @param operationConfig - Optional per-operation config overrides
   * @returns The updated record wrapped in a DatabaseResult
   */
  async update<T extends object>(
    table: TableName,
    id: string,
    input: UpdateInput<T>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    // Prepare table with schema and ID column overrides
    const finalTable = this.prepareTable(table, operationConfig);

    if (this.eventHandlers?.onBeforeWrite) {
      await this.eventHandlers.onBeforeWrite({
        type: "beforeWrite",
        operation: "UPDATE",
        table,
        data: input as Record<string, string | number | boolean | Date>,
        timestamp: new Date(),
      });
    }

    const result = await this.adapter.update<T>(
      finalTable,
      id,
      input as Partial<T>,
    );

    if (result.success && this.eventHandlers?.onAfterWrite) {
      await this.eventHandlers.onAfterWrite({
        type: "afterWrite",
        operation: "UPDATE",
        table,
        result: result.value as Record<
          string,
          string | number | boolean | Date
        >,
        duration: 0,
        timestamp: new Date(),
      });
    }

    return result;
  }

  /**
   * Delete a record by ID.
   *
   * Fires before-write and after-write lifecycle events.
   *
   * @param table - Target table name
   * @param id - Record ID
   * @param operationConfig - Optional per-operation config overrides
   * @returns Void wrapped in a DatabaseResult
   */
  async delete(
    table: TableName,
    id: string,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<void>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    // Prepare table with schema and ID column overrides
    const finalTable = this.prepareTable(table, operationConfig);

    if (this.eventHandlers?.onBeforeWrite) {
      await this.eventHandlers.onBeforeWrite({
        type: "beforeWrite",
        operation: "DELETE",
        table,
        data: { id },
        timestamp: new Date(),
      });
    }

    const result = await this.adapter.delete(finalTable, id);

    if (result.success && this.eventHandlers?.onAfterWrite) {
      await this.eventHandlers.onAfterWrite({
        type: "afterWrite",
        operation: "DELETE",
        table,
        result: {},
        duration: 0,
        timestamp: new Date(),
      });
    }

    return result;
  }

  // Batch Operations
  /**
   * Create multiple records in a single transaction.
   *
   * Wraps individual creates in a transaction so that all succeed
   * or all are rolled back.
   *
   * @typeParam T - Shape of the created records
   * @param table - Target table name
   * @param inputs - Array of data to insert
   * @param operationConfig - Optional per-operation config overrides
   * @returns Array of created records wrapped in a DatabaseResult
   */
  async batchCreate<T extends object>(
    table: TableName,
    inputs: CreateInput<T>[],
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T[]>> {
    const txResult = await this.adapter.transaction<T[]>((trx) =>
      Promise.all(
        inputs.map((input) =>
          trx
            .create<T>(table, input as T)
            .then((r) => {
              if (!r.success) throw r.error ?? new Error("batchCreate item failed");
              return r.value as T;
            }),
        ),
      ),
    );
    if (!txResult.success) {
      return failure(
        txResult.error ??
          new DatabaseError("Batch create failed", DATABASE_ERROR_CODES.CREATE_FAILED),
      );
    }
    return success(txResult.value!);
  }

  /**
   * Update multiple records by ID in a single transaction.
   *
   * @typeParam T - Shape of the updated records
   * @param table - Target table name
   * @param updates - Array of { id, data } pairs
   * @param operationConfig - Optional per-operation config overrides
   * @returns Array of updated records wrapped in a DatabaseResult
   */
  async batchUpdate<T extends object>(
    table: TableName,
    updates: BatchUpdate<T>[],
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T[]>> {
    const txResult = await this.adapter.transaction<T[]>((trx) =>
      Promise.all(
        updates.map((u) =>
          trx
            .update<T>(table, u.id, u.data as Partial<T>)
            .then((r) => {
              if (!r.success) throw r.error ?? new Error("batchUpdate item failed");
              return r.value as T;
            }),
        ),
      ),
    );
    if (!txResult.success) {
      return failure(
        txResult.error ??
          new DatabaseError("Batch update failed", DATABASE_ERROR_CODES.UPDATE_FAILED),
      );
    }
    return success(txResult.value!);
  }

  /**
   * Delete multiple records by ID in a single transaction.
   *
   * @param table - Target table name
   * @param ids - Array of record IDs to delete
   * @param operationConfig - Optional per-operation config overrides
   * @returns Void wrapped in a DatabaseResult
   */
  async batchDelete(
    table: TableName,
    ids: string[],
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<void>> {
    const txResult = await this.adapter.transaction<void>((trx) =>
      Promise.all(
        ids.map((id) =>
          trx.delete(table, id).then((r) => {
            if (!r.success) throw r.error ?? new Error("batchDelete item failed");
          }),
        ),
      ).then(() => undefined),
    );
    if (!txResult.success) {
      return failure(
        txResult.error ??
          new DatabaseError("Batch delete failed", DATABASE_ERROR_CODES.DELETE_FAILED),
      );
    }
    return success();
  }

  /**
   * Upsert multiple records in a single transaction.
   *
   * Each item specifies a where clause to find existing records,
   * data to create if not found, and data to update if found.
   *
   * @typeParam T - Shape of the upserted records
   * @param table - Target table name
   * @param items - Array of upsert definitions
   * @param operationConfig - Optional per-operation config overrides
   * @returns Array of upserted records wrapped in a DatabaseResult
   */
  async batchUpsert<T extends object>(
    table: TableName,
    items: BatchUpsertItem[],
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T[]>> {
    const txResult = await this.adapter.transaction<T[]>((trx) =>
      Promise.all(
        items.map((item) =>
          trx
            .upsert<T>(table, item.where, item.create, item.update)
            .then((r) => {
              if (!r.success) throw r.error ?? new Error("batchUpsert item failed");
              return r.value as T;
            }),
        ),
      ),
    );
    if (!txResult.success) {
      return failure(
        txResult.error ??
          new DatabaseError("Batch upsert failed", DATABASE_ERROR_CODES.CREATE_FAILED),
      );
    }
    return success(txResult.value!);
  }

  // Query Operations
  /**
   * Alias for {@link list}. Query records with full filtering and pagination.
   *
   * @typeParam T - Shape of the returned records
   * @param table - Target table name
   * @param query - Query options (filter, sort, pagination)
   * @param operationConfig - Optional per-operation config overrides
   * @returns A paginated result set wrapped in a DatabaseResult
   */
  async query<T extends object>(
    table: TableName,
    query: QueryOptions<T>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    return this.list<T>(table, query, operationConfig);
  }

  /**
   * Count records matching an optional filter.
   *
   * @typeParam T - Type used for filter shape inference
   * @param table - Target table name
   * @param filter - Optional filter condition(s)
   * @param operationConfig - Optional per-operation config overrides
   * @returns The record count wrapped in a DatabaseResult
   */
  async count<T extends object = object>(
    table: TableName,
    filter?: Filter<T> | Filter<T>[],
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<number>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);
    const finalTable = this.prepareTable(table, operationConfig);
    return this.adapter.count(finalTable, filter);
  }

  // Transactions
  /**
   * Execute a function within a database transaction.
   *
   * @typeParam T - Return type of the transaction function
   * @param fn - Function receiving a transaction-scoped adapter
   * @returns The function result wrapped in a DatabaseResult
   */
  async transaction<T>(fn: TransactionFn<T>): Promise<DatabaseResult<T>> {
    return this.adapter.transaction(fn);
  }

  // Audit Context
  /**
   * Set (or merge) audit context metadata for subsequent operations.
   *
   * @param context - Key-value pairs to attach as audit context
   * @returns Void wrapped in a DatabaseResult
   */
  async setAuditContext(context: AuditContext): Promise<DatabaseResult<void>> {
    this.auditContext = { ...this.auditContext, ...context };
    return success();
  }

  // Event System
  /**
   * Subscribe to a database event type.
   *
   * @typeParam T - The event type string literal
   * @param event - The event type to subscribe to
   * @param handler - Callback invoked when the event is emitted
   */
  on<T extends DatabaseEvent["type"]>(
    event: T,
    handler: (
      event: Extract<DatabaseEvent, { type: T }>,
    ) => void | Promise<void>,
  ): void {
    this.eventEmitter.on(event, handler);
  }

  /**
   * Unsubscribe a previously registered event handler.
   *
   * @typeParam T - The event type string literal
   * @param event - The event type to unsubscribe from
   * @param handler - The handler previously passed to {@link on}
   */
  off<T extends DatabaseEvent["type"]>(
    event: T,
    handler: (
      event: Extract<DatabaseEvent, { type: T }>,
    ) => void | Promise<void>,
  ): void {
    this.eventEmitter.off(event, handler);
  }

  // Health & Status
  /**
   * Perform a health check against the database adapter.
   *
   * @returns The current health status wrapped in a DatabaseResult
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    return this.healthManager.checkHealth();
  }

  /**
   * Get a summary of the current service status.
   *
   * Includes adapter name, uptime, and last health check timestamp.
   *
   * @returns ServiceStatus object
   */
  getStatus(): ServiceStatus {
    const uptime = Date.now() - this.startTime.getTime();
    return {
      isHealthy: true, // TODO: Get actual health status
      adapter: this.adapter.constructor.name,
      uptime,
      lastHealthCheck: new Date(),
    };
  }

  // Legacy methods for backward compatibility
  /**
   * Legacy alias for {@link get}. Retrieve a record by ID.
   *
   * @deprecated Use get() instead
   * @typeParam T - Shape of the returned record
   * @param table - Target table name
   * @param id - Record ID
   * @returns The found record or null wrapped in a DatabaseResult
   */
  async findById<T extends object>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    return this.get<T>(table, id);
  }

  /**
   * Legacy alias for {@link list}. Retrieve multiple records with options.
   *
   * @deprecated Use list() instead
   * @typeParam T - Shape of the returned records
   * @param table - Target table name
   * @param options - Query options
   * @returns A paginated result set wrapped in a DatabaseResult
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    return this.list<T>(table, options);
  }

  /**
   * Initialize the service. Currently a no-op returning success.
   *
   * @returns Void wrapped in a successful DatabaseResult
   */
  async initialize(): Promise<DatabaseResult<void>> {
    return success();
  }

  /**
   * Register or override a table name and optional ID column with the adapter.
   *
   * Useful for mapping logical table names to physical names
   * and configuring custom ID columns.
   *
   * @param name - Logical or physical table name
   * @param table - Optional physical table name (defaults to name)
   * @param idColumn - Optional custom ID column name
   */
  registerTable<TTable = string, TIdColumn = string>(
    name: string,
    table?: TTable,
    idColumn?: TIdColumn,
  ): void {
    // Delegate to the adapter's registerTable method
    if (this.adapter && typeof this.adapter.registerTable === "function") {
      // For SQL adapter: if table is not provided, use name as table name
      const tableValue = table ?? name;
      this.adapter.registerTable(name, tableValue, idColumn);
    }
  }

  /**
   * Check whether a record with the given ID exists.
   *
   * @param table - Target table name
   * @param id - Record ID
   * @returns Boolean wrapped in a DatabaseResult
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    const result = await this.get(table, id);
    return success(result.success && result.value !== null);
  }

  /**
   * Fire the onBeforeRead lifecycle event if a handler is configured.
   *
   * @param table - The table involved in the read operation
   */
  private async fireBeforeReadEvent(table: TableName): Promise<void> {
    if (this.eventHandlers?.onBeforeRead) {
      await this.eventHandlers.onBeforeRead({
        type: "beforeRead",
        operation: "READ",
        table,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Fire the onAfterRead lifecycle event if a handler is configured.
   *
   * @typeParam T - Shape of the record
   * @param table - The table involved in the read operation
   * @param record - The record returned by the read (may be null)
   */
  private async fireAfterReadEvent<T>(
    table: TableName,
    record: T | null,
  ): Promise<void> {
    if (this.eventHandlers?.onAfterRead) {
      await this.eventHandlers.onAfterRead({
        type: "afterRead",
        operation: "READ",
        table,
        result:
          (record as Record<string, string | number | boolean | Date>) ?? {},
        duration: 0,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Find the first record matching a filter.
   *
   * Equivalent to calling list with limit 1 and returning the first item.
   *
   * @typeParam T - Shape of the returned record
   * @param table - Target table name
   * @param filter - Filter condition(s)
   * @param operationConfig - Optional per-operation config overrides
   * @returns The first matching record or null wrapped in a DatabaseResult
   */
  async findOne<T extends object>(
    table: TableName,
    filter: Filter<T>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T | null>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    // Prepare table with schema and ID column overrides
    const finalTable = this.prepareTable(table, operationConfig);

    try {
      await this.fireBeforeReadEvent(table);

      const result = await this.adapter.findMany<T>(finalTable, {
        filter,
        pagination: { limit: 1, offset: 0 },
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }

      const firstRecord = result.value?.data[0] ?? null;
      await this.fireAfterReadEvent(table, firstRecord);

      return { success: true, value: firstRecord };
    } catch (error) {
      return failure(
        new DatabaseError(
          `Find one operation failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          {
            context: { source: "findOne" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Find the first record matching advanced options.
   *
   * Delegates to the adapter's findFirst implementation if available.
   *
   * @typeParam T - Shape of the returned record
   * @param table - Target table name
   * @param options - FindFirst options (filter, order, etc.)
   * @param operationConfig - Optional per-operation config overrides
   * @returns The first matching record or null wrapped in a DatabaseResult
   */
  async findFirst<T extends object>(
    table: TableName,
    options?: FindFirstOptions<T>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T | null>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    const finalTable = this.prepareTable(table, operationConfig);

    try {
      await this.fireBeforeReadEvent(table);

      const result = await this.adapter.findFirst!<T>(finalTable, options);

      if (result.success) {
        await this.fireAfterReadEvent(table, result.value ?? null);
      }

      return result;
    } catch (error) {
      return failure(
        new DatabaseError(
          `FindFirst operation failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          {
            context: { source: "findFirst" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Insert a record or update it if it already exists.
   *
   * @typeParam T - Shape of the upserted record
   * @param table - Target table name
   * @param where - Condition to match an existing record
   * @param create - Data for creating a new record
   * @param update - Data for updating an existing record
   * @param operationConfig - Optional per-operation config overrides
   * @returns The upserted record wrapped in a DatabaseResult
   */
  async upsert<T extends object>(
    table: TableName,
    where: Record<string, any>,
    create: Record<string, any>,
    update: Record<string, any>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<T>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    const finalTable = this.prepareTable(table, operationConfig);

    try {
      if (this.eventHandlers?.onBeforeWrite) {
        await this.eventHandlers.onBeforeWrite({
          type: "beforeWrite",
          operation: "UPDATE",
          table,
          data: create as Record<string, string | number | boolean | Date>,
          timestamp: new Date(),
        });
      }

      const result = await this.adapter.upsert!<T>(finalTable, where, create, update);

      if (result.success && this.eventHandlers?.onAfterWrite) {
        await this.eventHandlers.onAfterWrite({
          type: "afterWrite",
          operation: "UPDATE",
          table,
          result: result.value as Record<
            string,
            string | number | boolean | Date
          >,
          duration: 0,
          timestamp: new Date(),
        });
      }

      return result;
    } catch (error) {
      return failure(
        new DatabaseError(
          `Upsert operation failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: { source: "upsert" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Update multiple records matching a condition.
   *
   * @param table - Target table name
   * @param where - Condition to match records
   * @param data - The data to apply to matching records
   * @param operationConfig - Optional per-operation config overrides
   * @returns The number of affected records wrapped in a DatabaseResult
   */
  async updateMany(
    table: TableName,
    where: Record<string, any>,
    data: Record<string, any>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<number>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    const finalTable = this.prepareTable(table, operationConfig);

    try {
      if (this.eventHandlers?.onBeforeWrite) {
        await this.eventHandlers.onBeforeWrite({
          type: "beforeWrite",
          operation: "UPDATE",
          table,
          data: data as Record<string, string | number | boolean | Date>,
          timestamp: new Date(),
        });
      }

      const result = await this.adapter.updateMany!(finalTable, where, data);

      if (result.success && this.eventHandlers?.onAfterWrite) {
        await this.eventHandlers.onAfterWrite({
          type: "afterWrite",
          operation: "UPDATE",
          table,
          result: { count: result.value ?? 0 },
          duration: 0,
          timestamp: new Date(),
        });
      }

      return result;
    } catch (error) {
      return failure(
        new DatabaseError(
          `UpdateMany operation failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: { source: "updateMany" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Delete multiple records matching a condition.
   *
   * @param table - Target table name
   * @param where - Condition to match records
   * @param operationConfig - Optional per-operation config overrides
   * @returns The number of affected records wrapped in a DatabaseResult
   */
  async deleteMany(
    table: TableName,
    where: Record<string, any>,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<number>> {
    const _mergedConfig = ConfigMerger.mergeConfigs(this.globalConfig, operationConfig);

    const finalTable = this.prepareTable(table, operationConfig);

    try {
      if (this.eventHandlers?.onBeforeWrite) {
        await this.eventHandlers.onBeforeWrite({
          type: "beforeWrite",
          operation: "DELETE",
          table,
          data: where as Record<string, string | number | boolean | Date>,
          timestamp: new Date(),
        });
      }

      const result = await this.adapter.deleteMany!(finalTable, where);

      if (result.success && this.eventHandlers?.onAfterWrite) {
        await this.eventHandlers.onAfterWrite({
          type: "afterWrite",
          operation: "DELETE",
          table,
          result: { count: result.value ?? 0 },
          duration: 0,
          timestamp: new Date(),
        });
      }

      return result;
    } catch (error) {
      return failure(
        new DatabaseError(
          `DeleteMany operation failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: { source: "deleteMany" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Soft-delete a record by ID (marks as deleted without removing).
   *
   * Delegates to delete() — the SoftDeleteAdapter in the adapter chain
   * intercepts the call and sets the deletedAt field instead.
   *
   * @param table - Target table name
   * @param id - Record ID
   * @param operationConfig - Optional per-operation config overrides
   * @returns Void wrapped in a DatabaseResult
   */
  async softDelete(
    table: TableName,
    id: string,
    operationConfig?: OperationConfig,
  ): Promise<DatabaseResult<void>> {
    // Delegate to delete() — the SoftDeleteAdapter in the adapter chain
    // intercepts the call and converts it to a soft delete (sets deletedAt).
    // This avoids duplicating the soft-delete logic here.
    return this.delete(table, id, operationConfig);
  }

  /**
   * Get the underlying DatabaseEventEmitter for direct event subscription.
   *
   * @returns The DatabaseEventEmitter instance
   */
  get events(): DatabaseEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Close the database connection and release resources.
   *
   * Delegates to the adapter's close method if available.
   *
   * @returns Void wrapped in a DatabaseResult
   */
  async close(): Promise<DatabaseResult<void>> {
    try {
      if (this.adapter.close) {
        return await this.adapter.close();
      }
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to close database connection: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DISCONNECT_FAILED,
          {
            context: { source: "close" },
            cause: error as Error,
          },
        ),
      );
    }
  }
}
