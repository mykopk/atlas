/**
 * MockAdapter - In-Memory Database Adapter for Testing
 *
 * Provides a lightweight, in-memory database adapter that mimics
 * the behavior of real database adapters without requiring an actual
 * database connection. Perfect for unit tests and integration tests.
 *
 * @example
 * ```typescript
 * const db = await createDatabaseService({
 *   adapter: 'mock',
 *   config: {
 *     initialData: {
 *       users: [{ id: '1', name: 'Test User', email: 'test@example.com' }],
 *       campaigns: [{ id: '1', title: 'Test Campaign', creator_id: '1' }]
 *     },
 *     autoGenerateIds: true
 *   }
 * });
 * ```
 */

import type {
  DatabaseAdapterType,
  DatabaseResult,
  PaginatedResult,
  QueryOptions,
  Transaction,
  DatabaseHealthStatus,
  Filter,
  FindFirstOptions,
  DbMockAdapterConfig,
} from "@myko/types/db";

import { success, failure } from "../../utils/databaseResultHelpers";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import { calculatePagination } from "../../utils/pagination";

/** Default pagination limit when none is specified by the caller. */
const DEFAULT_PAGINATION_LIMIT = 50;
/** Base for generating random ID strings (radix 36 = alphanumeric). */
const RANDOM_STRING_BASE = 36;
/** Start index for substring extraction during ID generation. */
const ID_SUBSTRING_START = 2;
/** End index for substring extraction during ID generation. */
const ID_SUBSTRING_END = 9;
/** Expected length for between filter value arrays. */
const BETWEEN_VALUES_LENGTH = 2;

/** In-memory storage type mapping table names to records keyed by ID. */
type TableDataMap = Map<string, Record<string, unknown>>;

/** Function signature for filter operator handlers. */
type FilterOperatorHandler = (
  fieldValue: unknown,
  filterValue: unknown,
) => boolean;

/**
 * Maps filter operator names to their evaluation functions.
 *
 * @description
 * Lookup table containing handler functions for each supported filter operator.
 * Each handler takes a field value and filter value and returns whether the
 * record matches the condition. Supports eq, ne, gt, gte, lt, lte, in, like,
 * between, isNull, and isNotNull operators.
 */
const FILTER_OPERATORS: Record<string, FilterOperatorHandler> = {
  eq: (fieldValue, value) => fieldValue === value,
  ne: (fieldValue, value) => fieldValue !== value,
  gt: (fieldValue, value) => (fieldValue as number) > (value as number),
  gte: (fieldValue, value) => (fieldValue as number) >= (value as number),
  lt: (fieldValue, value) => (fieldValue as number) < (value as number),
  lte: (fieldValue, value) => (fieldValue as number) <= (value as number),
  in: (fieldValue, value) =>
    Array.isArray(value) && (value as unknown[]).includes(fieldValue),
  like: (fieldValue, value) =>
    String(fieldValue).toLowerCase().includes(String(value).toLowerCase()),
  between: (fieldValue, value) => {
    const betweenValues = value as [number, number];
    return (
      Array.isArray(betweenValues) &&
      betweenValues.length === BETWEEN_VALUES_LENGTH &&
      (fieldValue as number) >= betweenValues[0] &&
      (fieldValue as number) <= betweenValues[1]
    );
  },
  isNull: (fieldValue) => fieldValue === null || fieldValue === undefined,
  isNotNull: (fieldValue) => fieldValue !== null && fieldValue !== undefined,
};

/**
 * MockAdapter - In-memory database adapter for testing
 */
export class MockAdapter implements DatabaseAdapterType {
  /** In-memory table storage: map of table name to map of record ID to record data. */
  private data: Map<string, Map<string, Record<string, unknown>>> = new Map();
  /** Adapter configuration for mock behavior (latency, fail rate, initial data, etc.). */
  private config: DbMockAdapterConfig;
  /** Maps table names to custom primary key column names. */
  private tableIdColumns: Map<string, string> = new Map();
  /** Default database schema name. */
  private defaultSchema: string;
  /** Whether the adapter has been initialized. */
  private isInitialized = false;
  /** Current transaction nesting depth. */
  private transactionDepth = 0;
  /** Snapshot of data captured at the start of a transaction for rollback support. */
  private transactionData: Map<
    string,
    Map<string, Record<string, unknown>>
  > | null = null;

  /**
   * Creates a new MockAdapter instance.
   *
   * @description
   * Initializes the adapter with optional configuration for latency simulation,
   * failure simulation, auto-generated IDs, initial seed data, and custom table
   * ID column mappings. Registers custom ID columns before populating initial
   * data so that ID resolution works correctly during data initialization.
   *
   * @param config - Partial configuration for mock adapter behavior
   */
  constructor(config: Partial<DbMockAdapterConfig> = {}) {
    this.config = {
      autoGenerateIds: true,
      latency: 0,
      failRate: 0,
      ...config,
    } as DbMockAdapterConfig;
    this.defaultSchema = config.schema ?? "public";

    // Register custom ID columns BEFORE initializing data
    if (config.tableIdColumns) {
      for (const [table, idColumn] of Object.entries(config.tableIdColumns)) {
        this.tableIdColumns.set(table, idColumn);
      }
    }

    // Initialize with provided data
    if (config.initialData) {
      this.initializeTableData(config.initialData);
    }
  }

  /**
   * Initializes the mock adapter.
   *
   * @description
   * Simulates latency and optionally fails based on the configured failRate.
   * Sets the initialized flag to true on success. Must be called before most
   * database operations to ensure the adapter is ready.
   *
   * @returns A DatabaseResult indicating success or simulated initialization failure
   */
  async initialize(): Promise<DatabaseResult<void>> {
    await this.simulateLatency();
    if (this.shouldFail()) {
      return failure(
        new DatabaseError(
          "Mock initialization failed",
          DATABASE_ERROR_CODES.INIT_FAILED,
        ),
      );
    }

    this.isInitialized = true;
    return success();
  }

  /**
   * Closes the adapter and clears all in-memory data.
   *
   * @description
   * Simulates latency, clears all table data, and resets the initialized flag.
   * After close(), the adapter must be re-initialized before further operations.
   *
   * @returns A DatabaseResult indicating success
   */
  async close(): Promise<DatabaseResult<void>> {
    await this.simulateLatency();
    this.data.clear();
    this.isInitialized = false;
    return success();
  }

  /**
   * Registers a table with the adapter.
   *
   * @description
   * Maps a logical table name and optionally associates a custom ID column.
   * Creates the table's data store if it does not already exist. This method
   * is idempotent — calling it multiple times for the same table is safe.
   *
   * @param name - The logical table name
   * @param table - Unused in mock adapter (reserved for interface compatibility)
   * @param idColumn - Optional custom primary key column name
   */
  registerTable<TTable = string, TIdColumn = string>(
    name: string,
    table?: TTable,
    idColumn?: TIdColumn,
  ): void {
    if (idColumn && typeof idColumn === "string") {
      this.tableIdColumns.set(name, idColumn);
    }

    // Ensure table exists
    if (!this.data.has(name)) {
      this.data.set(name, new Map());
    }
  }

  /**
   * Finds a single record by its primary key.
   *
   * @description
   * Retrieves a record from the in-memory store by ID. Simulates latency and
   * optionally fails based on configured failRate. Returns a shallow copy of
   * the record to prevent mutation of stored data.
   *
   * @param table - The logical table name
   * @param id - The primary key value
   * @returns The found record, or null if not found
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    await this.simulateLatency();
    if (this.shouldFail()) {
      return failure(
        new DatabaseError(
          "Mock findById failed",
          DATABASE_ERROR_CODES.FIND_BY_ID_FAILED,
        ),
      );
    }

    const tableData = this.getTableData(table);
    const record = tableData.get(id);

    return success(record ? ({ ...record } as T) : null);
  }

  /**
   * Applies query options (filter, sort) to a set of records.
   *
   * @description
   * Filters the provided records using the configured filter conditions (either
   * top-level AND filters or OR filter groups), then sorts them according to
   * the sort specification. Returns a new array of matching records.
   *
   * @param records - The records to filter and sort
   * @param options - Query options containing filters and sort criteria
   * @returns Filtered and sorted records
   */
  private applyQueryOptions<T extends object>(
    records: Record<string, unknown>[],
    options?: QueryOptions<T>,
  ): Record<string, unknown>[] {
    let result = records;
    if (options?.orFilters && options.orFilters.length > 0) {
      result = result.filter((record) =>
        options.orFilters!.some((group) =>
          group.every((f) => {
            const fieldValue = record[f.field];
            const handler = FILTER_OPERATORS[f.operator];
            return handler ? handler(fieldValue, f.value) : true;
          }),
        ),
      );
    } else if (options?.filters && options.filters.length > 0) {
      for (const filter of options.filters) {
        result = this.applyFilter(result, filter);
      }
    } else if (options?.filter) {
      result = this.applyFilter(result, options.filter);
    }
    if (options?.sort) {
      result = this.applySort(result, options.sort);
    }
    return result;
  }

  /**
   * Extracts pagination parameters with defaults from query options.
   *
   * @description
   * Returns the offset (defaulting to 0) and limit (defaulting to
   * DEFAULT_PAGINATION_LIMIT) from the provided query options.
   *
   * @param options - Query options possibly containing pagination settings
   * @returns An object with offset and limit values
   */
  private getPaginationParams<T extends object>(
    options?: QueryOptions<T>,
  ): {
    offset: number;
    limit: number;
  } {
    return {
      offset: options?.pagination?.offset ?? 0,
      limit: options?.pagination?.limit ?? DEFAULT_PAGINATION_LIMIT,
    };
  }

  /**
   * Applies pagination (offset and limit) to a record array.
   *
   * @description
   * Slices the record array to return only the records within the specified
   * range defined by offset and limit.
   *
   * @param records - The full record array
   * @param offset - Number of records to skip
   * @param limit - Maximum number of records to return
   * @returns The paginated subset of records
   */
  private applyPagination(
    records: Record<string, unknown>[],
    offset: number,
    limit: number,
  ): Record<string, unknown>[] {
    return records.slice(offset, offset + limit);
  }

  /**
   * Finds multiple records with filtering, sorting, and pagination.
   *
   * @description
   * Retrieves all records from a table, applies filters and sorting via
   * applyQueryOptions, then paginates the result. Returns a PaginatedResult
   * containing the data array, total count of matching records (before
   * pagination), and pagination metadata.
   *
   * @param table - The logical table name
   * @param options - Query options (filters, sort, pagination)
   * @returns A paginated result set with matching records and metadata
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    await this.simulateLatency();
    if (this.shouldFail()) {
      return failure(
        new DatabaseError(
          "Mock findMany failed",
          DATABASE_ERROR_CODES.FIND_MANY_FAILED,
        ),
      );
    }

    const tableData = this.getTableData(table);
    const allRecords = Array.from(tableData.values());
    const filteredRecords = this.applyQueryOptions(allRecords, options);
    const total = filteredRecords.length;
    const { offset, limit } = this.getPaginationParams(options);
    const paginatedRecords = this.applyPagination(
      filteredRecords,
      offset,
      limit,
    );

    return success({
      data: paginatedRecords as T[],
      total,
      pagination: calculatePagination(total, options?.pagination),
    });
  }

  /**
   * Creates a new record in the specified table.
   *
   * @description
   * Inserts a record into the in-memory store. Auto-generates an ID if the
   * record does not have one and autoGenerateIds is enabled. Adds created_at
   * and updated_at timestamps. Returns a failure if the record has no ID and
   * auto-generation is disabled.
   *
   * @param table - The logical table name
   * @param data - The record data to insert
   * @returns The created record with generated fields populated
   */
  async create<T>(table: string, data: T): Promise<DatabaseResult<T>> {
    await this.simulateLatency();
    if (this.shouldFail()) {
      return failure(
        new DatabaseError(
          "Mock create failed",
          DATABASE_ERROR_CODES.CREATE_FAILED,
        ),
      );
    }

    const tableData = this.getTableData(table);
    const idColumn = this.getIdColumn(table);
    const record = { ...(data as Record<string, unknown>) };

    // Generate ID if needed
    if (!record[idColumn] && this.config.autoGenerateIds) {
      record[idColumn] = this.generateId();
    }

    const id = record[idColumn];
    if (!id) {
      return failure(
        new DatabaseError(
          "Record must have an ID",
          DATABASE_ERROR_CODES.CREATE_FAILED,
        ),
      );
    }

    // Add timestamps
    const now = new Date().toISOString();
    record.created_at ??= now;
    record.updated_at ??= now;

    tableData.set(String(id), record);

    return success(record as T);
  }

  /**
   * Updates an existing record identified by its primary key.
   *
   * @description
   * Finds the record by ID and applies the partial update. Automatically sets
   * updated_at to the current timestamp. Returns a failure if the record is
   * not found.
   *
   * @param table - The logical table name
   * @param id - The primary key value of the record to update
   * @param data - Partial data to apply to the record
   * @returns The updated record
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    await this.simulateLatency();
    if (this.shouldFail()) {
      return failure(
        new DatabaseError(
          "Mock update failed",
          DATABASE_ERROR_CODES.UPDATE_FAILED,
        ),
      );
    }

    const tableData = this.getTableData(table);
    const existing = tableData.get(id);

    if (!existing) {
      return failure(
        new DatabaseError(
          "Record not found",
          DATABASE_ERROR_CODES.RECORD_NOT_FOUND,
        ),
      );
    }

    const updated = {
      ...existing,
      ...data,
      updated_at: new Date().toISOString(),
    };

    tableData.set(id, updated);

    return success(updated as T);
  }

  /**
   * Deletes a record by its primary key.
   *
   * @description
   * Removes the record from the in-memory store. Returns a failure if no record
   * with the given ID exists.
   *
   * @param table - The logical table name
   * @param id - The primary key value of the record to delete
   * @returns Void on success
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    await this.simulateLatency();
    if (this.shouldFail()) {
      return failure(
        new DatabaseError(
          "Mock delete failed",
          DATABASE_ERROR_CODES.DELETE_FAILED,
        ),
      );
    }

    const tableData = this.getTableData(table);
    const existed = tableData.delete(id);

    if (!existed) {
      return failure(
        new DatabaseError(
          "Record not found",
          DATABASE_ERROR_CODES.RECORD_NOT_FOUND,
        ),
      );
    }

    return success();
  }

  /**
   * Executes operations within a simulated transaction.
   *
   * @description
   * Creates a snapshot of the current data before executing the callback. If
   * the callback throws, the data is rolled back to the snapshot. If it
   * succeeds, changes are committed (made permanent). Unlike real databases,
   * this provides snapshot-isolation semantics within the in-memory store.
   * The transaction object exposes findById, create, update, delete, updateMany,
   * deleteMany, and upsert methods.
   *
   * @param callback - Function receiving a Transaction object for transactional operations
   * @returns The callback's return value wrapped in a DatabaseResult
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    await this.simulateLatency();

    // Create a snapshot of current data
    const snapshot = new Map<string, TableDataMap>();
    for (const [table, tableData] of this.data.entries()) {
      snapshot.set(table, new Map(tableData));
    }

    this.transactionDepth++;
    this.transactionData = snapshot;

    try {
      const trx: Transaction = {
        findById: async <T>(table: string, id: string) =>
          this.findById<T>(table, id),
        create: async <T>(table: string, data: T) =>
          this.create<T>(table, data),
        update: async <T>(table: string, id: string, data: Partial<T>) =>
          this.update<T>(table, id, data),
        delete: async (table: string, id: string) => this.delete(table, id),
        updateMany: async (table: string, where: Record<string, any>, data: Record<string, any>) =>
          this.updateMany(table, where, data),
        deleteMany: async (table: string, where: Record<string, any>) =>
          this.deleteMany(table, where),
        upsert: async <T>(table: string, where: Record<string, any>, create: Record<string, any>, update: Record<string, any>) => {
          const tableData = this.getTableData(table);
          const records = Array.from(tableData.values());
          const existing = records.find((record) =>
            Object.entries(where).every(([key, value]) => record[key] === value),
          );
          if (existing) {
            const idColumn = this.getIdColumn(table);
            const id = existing[idColumn];
            if (id) {
              const updated = { ...existing, ...update, updated_at: new Date().toISOString() };
              tableData.set(String(id), updated);
              return success(updated as T);
            }
          }
          const newId = String(tableData.size + 1);
          const newRecord = { id: newId, ...create, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          tableData.set(newId, newRecord);
          return success(newRecord as T);
        },
        commit: async () => {
          /* no-op, auto-committed */
        },
        rollback: async () => {
          // Restore snapshot
          this.data = snapshot;
        },
      };

      const result = await callback(trx);

      // Transaction succeeded - commit is implicit
      this.transactionDepth--;
      this.transactionData = null;

      return success(result);
    } catch (error) {
      // Rollback on error
      this.data = snapshot;
      this.transactionDepth--;
      this.transactionData = null;

      return failure(
        new DatabaseError(
          `Transaction failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.TRANSACTION_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Checks whether a record with the given primary key exists.
   *
   * @description
   * Directly checks the in-memory map for the presence of the given ID.
   *
   * @param table - The logical table name
   * @param id - The primary key value to check
   * @returns True if a matching record exists, false otherwise
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    await this.simulateLatency();
    const tableData = this.getTableData(table);
    return success(tableData.has(id));
  }

  /**
   * Counts records matching the optional filter criteria.
   *
   * @description
   * Retrieves all records from the table and applies the provided filter(s).
   * Supports both single filters and arrays of AND-combined filters. Returns
   * the count of matching records.
   *
   * @param table - The logical table name
   * @param filter - Optional filter or array of filters to scope the count
   * @returns The count of matching records
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T> | Filter<T>[],
  ): Promise<DatabaseResult<number>> {
    await this.simulateLatency();
    const tableData = this.getTableData(table);
    let records = Array.from(tableData.values());

    if (Array.isArray(filter)) {
      for (const f of filter) {
        records = this.applyFilter(records, f);
      }
    } else if (filter) {
      records = this.applyFilter(records, filter);
    }

    return success(records.length);
  }

  /**
   * Finds the first record matching the given criteria.
   *
   * @description
   * Searches the in-memory store for the first record matching the optional
   * where clause. If no where clause is provided, returns the first record in
   * the table. Supports field projections via the select option, returning
   * only the requested fields.
   *
   * @param table - The logical table name
   * @param options - Optional criteria (where, select)
   * @returns The first matching record, or null if none found
   */
  async findFirst<T extends object>(
    table: string,
    options?: FindFirstOptions<T>,
  ): Promise<DatabaseResult<T | null>> {
    await this.simulateLatency();
    const tableData = this.getTableData(table);
    if (!options?.where || Object.keys(options.where).length === 0) {
      const records = Array.from(tableData.values());
      return success((records[0] as T) ?? null);
    }

    const records = Array.from(tableData.values());
    const match = records.find((record) =>
      Object.entries(options.where!).every(([key, value]) => record[key] === value),
    );

    if (options?.select) {
      // Simplified select: only return requested fields
      if (match) {
        const selected = {} as Record<string, unknown>;
        for (const key of Object.keys(options.select)) {
          if (key in match) {
            selected[key] = match[key];
          }
        }
        return success(selected as T);
      }
    }

    return success(match ? ({ ...match } as T) : null);
  }

  /**
   * Creates or updates a record based on whether it already exists.
   *
   * @description
   * Searches for an existing record matching the where clause. If found, applies
   * the update data. If not found, creates a new record using the create data.
   *
   * @param table - The logical table name
   * @param where - Criteria to identify an existing record
   * @param create - Data used when creating a new record
   * @param update - Data used when updating an existing record
   * @returns The created or updated record
   */
  async upsert<T extends object>(
    table: string,
    where: Record<string, any>,
    create: Record<string, any>,
    update: Record<string, any>,
  ): Promise<DatabaseResult<T>> {
    await this.simulateLatency();
    const tableData = this.getTableData(table);

    // Find existing record by where conditions
    const records = Array.from(tableData.values());
    const existing = records.find((record) =>
      Object.entries(where).every(([key, value]) => record[key] === value),
    );

    if (existing) {
      const idColumn = this.getIdColumn(table);
      const id = existing[idColumn];
      if (id) {
        const updated = {
          ...existing,
          ...update,
          updated_at: new Date().toISOString(),
        };
        tableData.set(String(id), updated);
        return success(updated as T);
      }
    }

    // Create new
    const result = await this.create<T>(table, create as T);
    return result as DatabaseResult<T>;
  }

  /**
   * Updates multiple records matching the given criteria.
   *
   * @description
   * Iterates over all records in the table and applies the update data to those
   * matching the where clause. Returns the count of updated records.
   *
   * @param table - The logical table name
   * @param where - Criteria identifying records to update
   * @param data - Partial data to apply to matching records
   * @returns The number of records updated
   */
  async updateMany(
    table: string,
    where: Record<string, any>,
    data: Record<string, any>,
  ): Promise<DatabaseResult<number>> {
    await this.simulateLatency();
    const tableData = this.getTableData(table);
    let count = 0;

    for (const [id, record] of tableData.entries()) {
      const matches = Object.entries(where).every(
        ([key, value]) => record[key] === value,
      );
      if (matches) {
        tableData.set(id, {
          ...record,
          ...data,
          updated_at: new Date().toISOString(),
        });
        count++;
      }
    }

    return success(count);
  }

  /**
   * Deletes multiple records matching the given criteria.
   *
   * @description
   * Iterates over all records in the table, collecting IDs of matching records,
   * then deletes them all. Returns the count of deleted records.
   *
   * @param table - The logical table name
   * @param where - Criteria identifying records to delete
   * @returns The number of records deleted
   */
  async deleteMany(
    table: string,
    where: Record<string, any>,
  ): Promise<DatabaseResult<number>> {
    await this.simulateLatency();
    const tableData = this.getTableData(table);
    const idsToDelete: string[] = [];

    for (const [id, record] of tableData.entries()) {
      const matches = Object.entries(where).every(
        ([key, value]) => record[key] === value,
      );
      if (matches) {
        idsToDelete.push(id);
      }
    }

    let count = 0;
    for (const id of idsToDelete) {
      tableData.delete(id);
      count++;
    }

    return success(count);
  }

  /**
   * Performs a simulated health check.
   *
   * @description
   * Returns a health status based on the adapter's initialized state. Reports
   * the total number of tables and records across all tables as additional
   * details. Simulates latency if configured.
   *
   * @returns Health status including healthy flag, simulated response time, and table statistics
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    await this.simulateLatency();

    return success({
      isHealthy: this.isInitialized,
      responseTime: this.config.latency ?? 0,
      details: {
        adapter: "mock",
        tables: this.data.size,
        totalRecords: Array.from(this.data.values()).reduce(
          (sum, table) => sum + table.size,
          0,
        ),
      } as DatabaseHealthStatus["details"],
    });
  }

  // DatabaseAdapterType required methods

  /**
   * Simulates establishing a database connection.
   *
   * @description
   * The mock adapter does not require an actual connection, so this method
   * only simulates the configured latency before returning.
   */
  async connect(): Promise<void> {
    await this.simulateLatency();
    // Mock adapter doesn't need actual connection
  }

  /**
   * Simulates closing the database connection.
   *
   * @description
   * Delegates to close() to clear all in-memory data and reset state.
   */
  async disconnect(): Promise<void> {
    await this.close();
  }

  /**
   * Returns a mock client object for interface compatibility.
   *
   * @description
   * Provides a descriptive object identifying the adapter as "mock" and exposing
   * the internal data store and configuration. Useful for test inspection.
   *
   * @returns A mock client object cast to the specified type
   */
  getClient<T extends object = object>(): T {
    return {
      type: "mock",
      data: this.data,
      config: this.config,
    } as T;
  }

  /**
   * Stub for raw SQL queries.
   *
   * @description
   * The mock adapter does not execute real SQL. This method exists for interface
   * compatibility and always returns an empty array.
   *
   * @returns An empty array
   */
  // eslint-disable-next-line no-unused-vars
  async query<TResult, TParams = unknown>(_sql: string, _params?: TParams[]): Promise<TResult[]> {
    await this.simulateLatency();
    // Mock adapter doesn't execute real SQL — stub for interface compatibility
    return [] as TResult[];
  }

  // Utility methods

  /**
   * Resolves the fully-qualified table name, prepending the schema if needed.
   *
   * @description
   * If the table name already contains a schema prefix (contains "."), returns
   * it as-is. For the "public" schema, returns the bare table name. For other
   * schemas, prepends the schema name with a dot separator.
   *
   * @param table - The logical or qualified table name
   * @param schema - Optional schema override (defaults to this.defaultSchema)
   * @returns The fully-qualified table name
   */
  private getQualifiedTableName(table: string, schema?: string): string {
    const targetSchema = schema ?? this.defaultSchema;

    // If table already has schema prefix (e.g., "tenant_acme.users"), use as-is
    if (table.includes(".")) {
      return table;
    }

    // For 'public' schema or non-qualified tables, return table name as-is for simplicity
    // This maintains backwards compatibility with existing tests
    if (targetSchema === "public") {
      return table;
    }

    // Apply schema prefix for non-public schemas
    return `${targetSchema}.${table}`;
  }

  /**
   * Populates the in-memory store with initial seed data.
   *
   * @description
   * Iterates over each table in the initial data object, creates a new record
   * map keyed by each record's ID, and stores it in the data store using the
   * fully-qualified table name.
   *
   * @param initialData - Record mapping table names to arrays of record data
   */
  private initializeTableData(
    initialData: Record<string, Record<string, unknown>[]>,
  ): void {
    for (const [table, records] of Object.entries(initialData)) {
      const tableData = new Map<string, Record<string, unknown>>();
      const idColumn = this.getIdColumn(table);

      for (const record of records) {
        const id = record[idColumn];
        if (id) {
          tableData.set(String(id), { ...record });
        }
      }

      this.data.set(this.getQualifiedTableName(table), tableData);
    }
  }

  /**
   * Retrieves or creates the in-memory data map for the given table.
   *
   * @description
   * Resolves the table name with schema qualification, then returns the existing
   * data map or creates a new empty one if the table has not been registered yet.
   *
   * @param table - The logical table name
   * @returns The table's in-memory record map
   */
  private getTableData(table: string): TableDataMap {
    // Handle schema-qualified table names
    const qualifiedTable = this.getQualifiedTableName(table);

    if (!this.data.has(qualifiedTable)) {
      this.data.set(qualifiedTable, new Map());
    }
    return this.data.get(qualifiedTable)!;
  }

  /**
   * Resolves the ID column name for the given table.
   *
   * @description
   * Strips any schema prefix from the table name before looking up the custom ID
   * column. Falls back to "id" if no custom column is registered.
   *
   * @param table - The logical table name (may include schema prefix)
   * @returns The resolved ID column name
   */
  private getIdColumn(table: string): string {
    // Strip schema prefix if present to get base table name for ID column lookup
    const baseTable = table.includes(".") ? table.split(".")[1] : table;
    return this.tableIdColumns.get(baseTable) ?? "id";
  }

  /**
   * Generates a unique mock ID string.
   *
   * @description
   * Creates an ID in the format "mock-<timestamp>-<random string>". The random
   * portion is a base-36 substring of Math.random().
   *
   * @returns A unique mock ID string
   */
  private generateId(): string {
    return `mock-${Date.now()}-${Math.random().toString(RANDOM_STRING_BASE).substring(ID_SUBSTRING_START, ID_SUBSTRING_END)}`;
  }

  /**
   * Simulates network/database latency if configured.
   *
   * @description
   * If config.latency is set to a positive value, waits for that many
   * milliseconds before resolving. Used to simulate real database response times.
   */
  private async simulateLatency(): Promise<void> {
    if (this.config.latency && this.config.latency > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latency));
    }
  }

  /**
   * Determines whether the current operation should simulate a failure.
   *
   * @description
   * If config.failRate is set to a positive value, returns true with a
   * probability equal to that rate. Used to test error handling paths.
   *
   * @returns True if the operation should fail
   */
  private shouldFail(): boolean {
    if (!this.config.failRate || this.config.failRate <= 0) return false;
    return Math.random() < this.config.failRate;
  }

  /**
   * Applies a single filter to an array of records.
   *
   * @description
   * Filters the record array using the handler function corresponding to the
   * filter's operator. Records for which the handler returns true are kept.
   *
   * @param records - The records to filter
   * @param filter - The filter definition (field, operator, value)
   * @returns The filtered record array
   */
  private applyFilter<T extends object>(
    records: Record<string, unknown>[],
    filter: Filter<T>,
  ): Record<string, unknown>[] {
    const { field, operator, value } = filter;
    const handler = FILTER_OPERATORS[operator];

    return records.filter((record: Record<string, unknown>) => {
      const fieldValue = record[field];
      return handler ? handler(fieldValue, value) : true;
    });
  }

  /**
   * Applies multi-field sorting to an array of records.
   *
   * @description
   * Sorts the record array using the provided sort specifications. Each sort
   * entry specifies a field and direction ("asc" or "desc"). Multi-field sorts
   * are applied in order, with tie-breaking falling through to subsequent fields.
   *
   * @param records - The records to sort
   * @param sort - Array of sort specifications (field and direction)
   * @returns The sorted record array
   */
  private applySort(
    records: Record<string, unknown>[],
    sort: Array<{ field: string; direction: "asc" | "desc" }>,
  ): Record<string, unknown>[] {
    return records.sort((a, b) => {
      for (const { field, direction } of sort) {
        const aVal = a[field];
        const bVal = b[field];

        if (aVal === bVal) continue;

        const comparison =
          (aVal as string | number) < (bVal as string | number) ? -1 : 1;
        return direction === "asc" ? comparison : -comparison;
      }
      return 0;
    });
  }

  /**
   * Test utility: Clears all in-memory data.
   *
   * @description
   * Removes all tables and records from the adapter. Useful for resetting state
   * between test cases.
   */
  clearAll(): void {
    this.data.clear();
  }

  /**
   * Test utility: Returns a snapshot of the current in-memory data.
   *
   * @description
   * If a table name is provided, returns the records for that table as an array.
   * If no table is specified, returns all tables mapped to their record arrays.
   * Useful for test assertions and debugging.
   *
   * @param table - Optional table name to filter results
   * @returns Records for the specified table, or all tables if no table given
   */
  getData(
    table?: string,
  ): Record<string, unknown>[] | Record<string, Record<string, unknown>[]> {
    if (table) {
      return Array.from(this.getTableData(table).values());
    }

    const result: Record<string, Record<string, unknown>[]> = {};
    for (const [tableName, tableData] of this.data.entries()) {
      result[tableName] = Array.from(tableData.values());
    }
    return result;
  }

  /**
   * Test utility: Directly sets the data for a table.
   *
   * @description
   * Replaces all records in the specified table with the provided array. Each
   * record must have an ID value in the table's configured ID column. Useful
   * for setting up test fixtures without going through the create API.
   *
   * @param table - The logical table name
   * @param records - Array of records to set
   */
  setData(table: string, records: Record<string, unknown>[]): void {
    const tableData = new Map<string, Record<string, unknown>>();
    const idColumn = this.getIdColumn(table);

    for (const record of records) {
      const id = record[idColumn];
      if (id) {
        tableData.set(String(id), { ...record });
      }
    }

    this.data.set(table, tableData);
  }
}
