import type {
  DatabaseAdapterType,
  DatabaseResult,
  QueryOptions,
  PaginatedResult,
  Transaction,
  Filter,
  DatabaseHealthStatus,
  ReadReplicaConfig,
} from "@myko/types/db";

/**
 * Read replica extension that routes read operations to replicas.
 * This is the outermost wrapper in the adapter chain.
 *
 * **Adapter Chain Position:**
 * **ReadReplica** → Audit → Cache → SoftDelete → Encryption → Base Adapter
 *
 * **What this adapter does:**
 * 1. Routes read operations (findById, findMany, exists, count) to replica adapters
 * 2. Routes write and mutation operations (create, update, delete, transaction) to the primary adapter
 * 3. Supports round-robin and random load balancing strategies for replica selection
 * 4. Falls through to the primary adapter when no replicas are configured
 *
 * **Called by:** DatabaseService (orchestrator)
 * **Calls:** The next adapter in the chain (AuditAdapter or the base adapter chain)
 */
export class ReadReplicaAdapter implements DatabaseAdapterType {
  private currentReplicaIndex = 0;

  /**
   * Creates a new ReadReplicaAdapter instance.
   *
   * @param primaryAdapter - The primary database adapter where writes are routed
   * @param config - Read replica configuration including replica adapters and strategy
   */
  constructor(
    private primaryAdapter: DatabaseAdapterType,
    private config: ReadReplicaConfig,
  ) {}

  /**
   * Initializes the primary database adapter.
   *
   * @returns Promise resolving to the initialization result
   */
  async initialize(): Promise<DatabaseResult<void>> {
    return this.primaryAdapter.initialize();
  }

  /**
   * Establishes the database connection through the primary adapter.
   *
   * @returns Promise that resolves when connected
   */
  async connect(): Promise<void> {
    return this.primaryAdapter.connect();
  }

  /**
   * Closes the database connection through the primary adapter.
   *
   * @returns Promise that resolves when disconnected
   */
  async disconnect(): Promise<void> {
    return this.primaryAdapter.disconnect();
  }

  /**
   * Closes the database adapter and releases resources.
   *
   * @returns Promise resolving to the close result
   */
  async close(): Promise<DatabaseResult<void>> {
    return this.primaryAdapter.close();
  }

  /**
   * Returns the underlying primary database client.
   *
   * @returns The primary database client instance
   */
  getClient<T extends object = object>(): T {
    return this.primaryAdapter.getClient<T>();
  }

  /**
   * Executes a raw SQL query through the primary adapter.
   * Raw queries are not routed to read replicas.
   *
   * @param sql - SQL query string
   * @param params - Query parameters
   * @returns Query results
   */
  async query<TResult, TParams = unknown>(
    sql: string,
    params?: TParams[],
  ): Promise<TResult[]> {
    return this.primaryAdapter.query<TResult, TParams>(sql, params);
  }

  /**
   * Registers a table schema with the primary adapter.
   *
   * @param name - Table name
   * @param table - Table schema definition
   * @param idColumn - Primary key column name
   */
  registerTable<T, U>(name: string, table: T, idColumn?: U): void {
    this.primaryAdapter.registerTable(name, table, idColumn);
  }

  /**
   * Finds a record by ID, routing to a read replica when available.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns The found record or null
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    // Route reads to replicas if available
    const adapter = this.getReadAdapter();
    return adapter.findById<T>(table, id);
  }

  /**
   * Finds multiple records, routing to a read replica when available.
   *
   * @param table - Table name
   * @param options - Query options including filters, pagination, and sorting
   * @returns Paginated query results
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    // Route reads to replicas if available
    const adapter = this.getReadAdapter();
    return adapter.findMany<T>(table, options);
  }

  /**
   * Creates a new record through the primary adapter.
   * Write operations always go to the primary.
   *
   * @param table - Table name
   * @param data - Record data
   * @returns The created record
   */
  async create<T extends object>(
    table: string,
    data: T,
  ): Promise<DatabaseResult<T>> {
    // Always route writes to primary
    return this.primaryAdapter.create<T>(table, data);
  }

  /**
   * Updates a record through the primary adapter.
   * Write operations always go to the primary.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @param data - Partial record data
   * @returns The updated record
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    // Always route writes to primary
    return this.primaryAdapter.update<T>(table, id, data);
  }

  /**
   * Deletes a record through the primary adapter.
   * Write operations always go to the primary.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns Deletion result
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    // Always route writes to primary
    return this.primaryAdapter.delete(table, id);
  }

  /**
   * Executes operations within a transaction on the primary adapter.
   * Transactions always go to the primary.
   *
   * @param callback - Async callback receiving the transaction object
   * @returns Promise resolving to the transaction result
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    // Always route transactions to primary
    return this.primaryAdapter.transaction(callback);
  }

  /**
   * Checks if a record exists, routing to a read replica when available.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns True if the record exists
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    // Route reads to replicas if available
    const adapter = this.getReadAdapter();
    return adapter.exists(table, id);
  }

  /**
   * Counts records matching the optional filter, routing to a read replica when available.
   *
   * @param table - Table name
   * @param filter - Optional filter conditions
   * @returns Record count
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T>,
  ): Promise<DatabaseResult<number>> {
    // Route reads to replicas if available
    const adapter = this.getReadAdapter();
    return adapter.count<T>(table, filter);
  }

  /**
   * Performs a health check against the primary database adapter.
   *
   * @returns Health status including connectivity and latency information
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    return this.primaryAdapter.healthCheck();
  }

  /**
   * Selects the appropriate adapter for read operations based on the configured strategy.
   * When replicas are enabled and available, routes to a replica using round-robin or random selection.
   * Falls through to the primary adapter when replicas are disabled or none are configured.
   */
  private getReadAdapter(): DatabaseAdapterType {
    if (!this.config.enabled || this.config.replicas.length === 0) {
      return this.primaryAdapter;
    }

    switch (this.config.strategy) {
      case "round-robin": {
        const replica = this.config.replicas[this.currentReplicaIndex];
        this.currentReplicaIndex =
          (this.currentReplicaIndex + 1) % this.config.replicas.length;
        return replica;
      }

      case "random": {
        const randomIndex = Math.floor(
          Math.random() * this.config.replicas.length,
        );
        return this.config.replicas[randomIndex];
      }

      default:
        // Default to first replica
        return this.config.replicas[0];
    }
  }
}
