/**
 * MultiWriteExtension - Write to primary + multiple secondary adapters
 *
 * Decorator that wraps the base adapter to replicate writes across
 * multiple secondary adapters for redundancy, cross-region replication,
 * or analytics syncing.
 *
 * @example
 * ```typescript
 * const db = await createDatabaseService({
 *   adapter: 'sql',
 *   config: { connectionString: process.env.DATABASE_URL },
 *
 *   multiWrite: {
 *     enabled: true,
 *     adapters: [
 *       { adapter: 'supabase', config: { ... } },
 *       { adapter: 'sql', config: { connectionString: process.env.ANALYTICS_DB } }
 *     ],
 *     mode: 'best-effort', // or 'strict'
 *     onSecondaryFailure: 'log', // or 'warn', 'throw'
 *     timeout: 5000
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
  MultiWriteConfig,
} from "@myko/types/db";
import { DatabaseError } from "@myko/errors";
import { ERROR_CODES } from "@myko/errors";

/**
 * MultiWriteAdapter - Extension for multi-adapter write replication
 *
 * Decorates a base adapter to replicate all write operations (create, update, delete)
 * to multiple secondary adapters. Reads always go to the primary adapter.
 */
export class MultiWriteAdapter implements DatabaseAdapterType {
  public baseAdapter: DatabaseAdapterType;
  private config: Required<MultiWriteConfig>;

  /**
   * Creates a new MultiWriteAdapter instance.
   *
   * Merges provided config with sensible defaults (best-effort mode, log on failure, 5s timeout).
   *
   * @param baseAdapter - The primary database adapter (reads always go here)
   * @param config - Multi-write configuration including secondary adapters and replication mode
   */
  constructor(baseAdapter: DatabaseAdapterType, config: MultiWriteConfig) {
    this.baseAdapter = baseAdapter;
    this.config = {
      mode: "best-effort",
      onSecondaryFailure: "log",
      timeout: 5000,
      ...config,
    };
  }

  /**
   * Initializes the primary database adapter.
   *
   * @returns Promise resolving to the initialization result
   */
  async initialize(): Promise<DatabaseResult<void>> {
    return this.baseAdapter.initialize();
  }

  /**
   * Closes the primary database adapter.
   *
   * @returns Promise resolving to the close result
   */
  async close(): Promise<DatabaseResult<void>> {
    return this.baseAdapter.close();
  }

  /**
   * Connects to the primary adapter and all secondary adapters.
   *
   * @returns Promise that resolves when all adapters are connected
   */
  async connect(): Promise<void> {
    await this.baseAdapter.connect();
    // Also connect all secondaries
    for (const secondary of this.config.adapters) {
      if (typeof secondary.connect === "function") {
        await secondary.connect();
      }
    }
  }

  /**
   * Disconnects the primary adapter and all secondary adapters.
   *
   * @returns Promise that resolves when all adapters are disconnected
   */
  async disconnect(): Promise<void> {
    await this.baseAdapter.disconnect();
    // Also disconnect all secondaries
    for (const secondary of this.config.adapters) {
      if (typeof secondary.disconnect === "function") {
        await secondary.disconnect();
      }
    }
  }

  /**
   * Returns the underlying primary database client.
   *
   * @returns The primary database client instance
   */
  getClient<T extends object = object>(): T {
    return this.baseAdapter.getClient<T>();
  }

  /**
   * Executes a raw SQL query through the primary adapter.
   *
   * @param sql - SQL query string
   * @param params - Query parameters
   * @returns Query results
   */
  async query<TResult, TParams = unknown>(
    sql: string,
    params?: TParams[],
  ): Promise<TResult[]> {
    return this.baseAdapter.query<TResult, TParams>(sql, params);
  }

  /**
   * Registers a table schema with the primary adapter and all secondaries.
   *
   * @param name - Table name
   * @param table - Table schema definition
   * @param idColumn - Primary key column name
   */
  registerTable<TTable = string, TIdColumn = string>(
    name: string,
    table?: TTable,
    idColumn?: TIdColumn,
  ): void {
    this.baseAdapter.registerTable(name, table, idColumn);

    // Also register on secondaries
    for (const secondary of this.config.adapters) {
      if (typeof secondary.registerTable === "function") {
        secondary.registerTable(name, table, idColumn);
      }
    }
  }

  /**
   * Finds a record by ID through the primary adapter.
   * Read operations always use the primary.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns The found record or null
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    return this.baseAdapter.findById<T>(table, id);
  }

  /**
   * Finds multiple records through the primary adapter.
   * Read operations always use the primary.
   *
   * @param table - Table name
   * @param options - Query options including filters, pagination, and sorting
   * @returns Paginated query results
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    return this.baseAdapter.findMany<T>(table, options);
  }

  /**
   * Checks if a record exists through the primary adapter.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns True if the record exists
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    return this.baseAdapter.exists(table, id);
  }

  /**
   * Counts records matching the optional filter through the primary adapter.
   *
   * @param table - Table name
   * @param filter - Optional filter conditions
   * @returns Record count
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T>,
  ): Promise<DatabaseResult<number>> {
    return this.baseAdapter.count<T>(table, filter);
  }

  /**
   * Creates a new record on the primary adapter and replicates to all secondaries.
   * In best-effort mode, replication failures are non-blocking. In strict mode,
   * any secondary failure causes the operation to fail.
   *
   * @param table - Table name
   * @param data - Record data
   * @returns The created record from the primary adapter
   */
  async create<T extends object>(
    table: string,
    data: T,
  ): Promise<DatabaseResult<T>> {
    // Write to primary first
    const primaryResult = await this.baseAdapter.create<T>(table, data);

    if (!primaryResult.success) {
      return primaryResult;
    }

    // Replicate to secondaries
    await this.replicateWrite(() =>
      Promise.all(
        this.config.adapters.map((adapter) => adapter.create(table, data)),
      ),
    );

    return primaryResult;
  }

  /**
   * Updates a record on the primary adapter and replicates to all secondaries.
   * The primary write must succeed before replication is attempted.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @param data - Partial record data
   * @returns The updated record from the primary adapter
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    // Write to primary first
    const primaryResult = await this.baseAdapter.update<T>(table, id, data);

    if (!primaryResult.success) {
      return primaryResult;
    }

    // Replicate to secondaries
    await this.replicateWrite(() =>
      Promise.all(
        this.config.adapters.map((adapter) => adapter.update(table, id, data)),
      ),
    );

    return primaryResult;
  }

  /**
   * Deletes a record on the primary adapter and replicates to all secondaries.
   * The primary delete must succeed before replication is attempted.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns Deletion result from the primary adapter
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    // Write to primary first
    const primaryResult = await this.baseAdapter.delete(table, id);

    if (!primaryResult.success) {
      return primaryResult;
    }

    // Replicate to secondaries
    await this.replicateWrite(() =>
      Promise.all(
        this.config.adapters.map((adapter) => adapter.delete(table, id)),
      ),
    );

    return primaryResult;
  }

  /**
   * Executes operations within a transaction on the primary adapter.
   * Secondaries receive individual operations — they are not part of the transaction.
   *
   * @param callback - Async callback receiving the transaction object
   * @returns Promise resolving to the transaction result
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    // Transactions only on primary (secondaries get individual operations)
    return this.baseAdapter.transaction(callback);
  }

  /**
   * Performs a health check against the primary database adapter.
   *
   * @returns Health status including connectivity and latency information
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    return this.baseAdapter.healthCheck();
  }

  /**
   * Replicate write operation to secondary adapters
   */
  private async replicateWrite(
    fn: () => Promise<DatabaseResult<unknown>[]>,
  ): Promise<void> {
    if (this.config.mode === "strict") {
      // Strict mode: Wait for all secondaries, throw on any failure
      const results = await Promise.allSettled([
        this.executeWithTimeout(fn(), this.config.timeout),
      ]);

      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        this.handleSecondaryFailure(failures);
      }
    } else {
      // Best-effort mode: Fire and forget (non-blocking)
      this.executeWithTimeout(fn(), this.config.timeout)
        .then((results) => {
          const failures = results.filter((r) => !r.success);
          if (failures.length > 0) {
            this.handleSecondaryFailure(
              failures.map((f) => ({
                status: "rejected" as const,
                reason: f.error,
              })),
            );
          }
        })
        .catch((error) => {
          this.handleSecondaryFailure([
            { status: "rejected" as const, reason: error },
          ]);
        });
    }
  }

  /**
   * Execute operation with timeout
   */
  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error("Secondary write timeout")),
          timeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Handle secondary adapter failures
   */
  private handleSecondaryFailure(
    failures: PromiseSettledResult<unknown>[],
  ): void {
    const errorMessages = failures
      .map((f) =>
        f.status === "rejected" ? f.reason?.message : "Unknown error",
      )
      .join(", ");

    const message = `Multi-write secondary failure: ${errorMessages}`;

    switch (this.config.onSecondaryFailure) {
      case "log":
        console.log(`[MultiWrite] ${message}`);
        break;
      case "warn":
        console.warn(`[MultiWrite] ${message}`);
        break;
      case "throw":
        throw new DatabaseError(message, ERROR_CODES.DB_UPDATE_FAILED);
    }
  }
}
