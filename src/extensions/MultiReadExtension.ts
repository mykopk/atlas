/**
 * MultiReadExtension - Read from primary + multiple read replicas
 *
 * Decorator that wraps the base adapter to distribute reads across
 * multiple read replicas using configurable load balancing strategies.
 * Supports automatic failover to primary on replica failure.
 *
 * @example
 * ```typescript
 * const db = await createDatabaseService({
 *   adapter: 'sql',
 *   config: { connectionString: process.env.DATABASE_URL },
 *
 *   multiRead: {
 *     enabled: true,
 *     adapters: [
 *       { adapter: 'sql', config: { connectionString: process.env.REPLICA1_URL } },
 *       { adapter: 'sql', config: { connectionString: process.env.REPLICA2_URL } }
 *     ],
 *     strategy: 'round-robin', // or 'random', 'fastest', 'least-conn'
 *     fallbackToPrimary: true,
 *     healthCheckInterval: 30000
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
  MultiReadConfig,
  ReplicaHealth,
} from "@myko/types/db";
import { DatabaseError } from "@myko/errors";
import { ERROR_CODES } from "@myko/errors";
import { failure } from "@utils/databaseResultHelpers";

/** Weight for existing average in EMA calculation */
const EMA_EXISTING_WEIGHT = 0.8;
/** Weight for new value in EMA calculation */
const EMA_NEW_WEIGHT = 0.2;

/**
 * MultiReadAdapter - Extension for multi-replica read distribution
 *
 * Decorates a base adapter to distribute read operations across multiple
 * read replicas. Writes always go to the primary adapter. Supports automatic
 * failover and health tracking.
 */
export class MultiReadAdapter implements DatabaseAdapterType {
  public baseAdapter: DatabaseAdapterType;
  private config: Required<MultiReadConfig>;
  private currentReadIndex = 0;
  private replicaHealth: Map<DatabaseAdapterType, ReplicaHealth> = new Map();
  private healthCheckTimer?: globalThis.NodeJS.Timeout;

  /**
   * Creates a new MultiReadAdapter instance.
   *
   * Initializes health tracking for all configured replicas and starts
   * periodic health checks. Merges provided config with sensible defaults
   * (round-robin strategy, 30s health check interval, 3 max failures).
   *
   * @param baseAdapter - The primary database adapter (writes always go here)
   * @param config - Multi-read configuration including replica adapters and strategy
   */
  constructor(baseAdapter: DatabaseAdapterType, config: MultiReadConfig) {
    this.baseAdapter = baseAdapter;
    this.config = {
      strategy: "round-robin",
      fallbackToPrimary: true,
      healthCheckInterval: 30000,
      maxFailures: 3,
      ...config,
    };

    // Initialize health tracking
    this.initializeHealthTracking();

    // Start health checks
    if (this.config.adapters.length > 0) {
      this.startHealthChecks();
    }
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
   * Closes the primary database adapter and stops health checks.
   *
   * @returns Promise resolving to the close result
   */
  async close(): Promise<DatabaseResult<void>> {
    this.stopHealthChecks();
    return this.baseAdapter.close();
  }

  /**
   * Connects to the primary adapter and all replica adapters.
   *
   * @returns Promise that resolves when all adapters are connected
   */
  async connect(): Promise<void> {
    await this.baseAdapter.connect();
    // Also connect all replicas
    for (const replica of this.config.adapters) {
      if (typeof replica.connect === "function") {
        await replica.connect();
      }
    }
  }

  /**
   * Disconnects the primary adapter and all replica adapters.
   *
   * @returns Promise that resolves when all adapters are disconnected
   */
  async disconnect(): Promise<void> {
    await this.baseAdapter.disconnect();
    // Also disconnect all replicas
    for (const replica of this.config.adapters) {
      if (typeof replica.disconnect === "function") {
        await replica.disconnect();
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
   * Read replicas are not used for raw SQL queries.
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
   * Registers a table schema with the primary adapter and all replicas.
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

    // Also register on replicas
    for (const replica of this.config.adapters) {
      if (typeof replica.registerTable === "function") {
        replica.registerTable(name, table, idColumn);
      }
    }
  }

  /**
   * Finds a record by ID using a read replica with load balancing.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns The found record or null
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    return this.readFromReplicas((adapter) => adapter.findById<T>(table, id));
  }

  /**
   * Finds multiple records using a read replica with load balancing.
   *
   * @param table - Table name
   * @param options - Query options including filters, pagination, and sorting
   * @returns Paginated query results
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    return this.readFromReplicas((adapter) =>
      adapter.findMany<T>(table, options),
    );
  }

  /**
   * Checks if a record exists using a read replica with load balancing.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns True if the record exists
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    return this.readFromReplicas((adapter) => adapter.exists(table, id));
  }

  /**
   * Counts records matching the optional filter using a read replica.
   *
   * @param table - Table name
   * @param filter - Optional filter conditions
   * @returns Record count
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T>,
  ): Promise<DatabaseResult<number>> {
    return this.readFromReplicas((adapter) => adapter.count<T>(table, filter));
  }

  /**
   * Creates a new record through the primary adapter.
   * Write operations always go to primary, never to replicas.
   *
   * @param table - Table name
   * @param data - Record data
   * @returns The created record
   */
  async create<T extends object>(
    table: string,
    data: T,
  ): Promise<DatabaseResult<T>> {
    return this.baseAdapter.create<T>(table, data);
  }

  /**
   * Updates a record through the primary adapter.
   * Write operations always go to primary, never to replicas.
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
    return this.baseAdapter.update<T>(table, id, data);
  }

  /**
   * Deletes a record through the primary adapter.
   * Write operations always go to primary, never to replicas.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns Deletion result
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    return this.baseAdapter.delete(table, id);
  }

  /**
   * Executes operations within a transaction on the primary adapter.
   * Transactions are only supported on the primary, not on replicas.
   *
   * @param callback - Async callback receiving the transaction object
   * @returns Promise resolving to the transaction result
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    // Transactions only on primary
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
   * Read from replica adapters using configured strategy
   */
  private async readFromReplicas<T>(
    fn: (adapter: DatabaseAdapterType) => Promise<DatabaseResult<T>>,
  ): Promise<DatabaseResult<T>> {
    const healthyReplicas = this.config.adapters.filter((adapter) =>
      this.isReplicaHealthy(adapter),
    );

    if (healthyReplicas.length === 0) {
      // No healthy replicas, fallback to primary
      if (this.config.fallbackToPrimary) {
        return fn(this.baseAdapter);
      }
      return failure(
        new DatabaseError(
          "No healthy read replicas available",
          ERROR_CODES.DB_CONNECTION_FAILED,
        ),
      );
    }

    // Select replica based on strategy
    const selectedReplica = this.selectReplica(healthyReplicas);
    const startTime = Date.now();

    try {
      const result = await fn(selectedReplica);

      // Update health metrics
      this.updateHealthMetrics(selectedReplica, true, Date.now() - startTime);

      if (result.success) {
        return result;
      }

      // Result failed, try fallback
      if (this.config.fallbackToPrimary) {
        this.updateHealthMetrics(
          selectedReplica,
          false,
          Date.now() - startTime,
        );
        return fn(this.baseAdapter);
      }

      return result;
    } catch (error) {
      // Replica failed, try fallback
      this.updateHealthMetrics(selectedReplica, false, Date.now() - startTime);

      if (this.config.fallbackToPrimary) {
        return fn(this.baseAdapter);
      }

      return failure(
        new DatabaseError(
          `Read from replica failed: ${(error as Error).message}`,
          ERROR_CODES.DB_QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Select a replica based on load balancing strategy
   */
  private selectReplica(replicas: DatabaseAdapterType[]): DatabaseAdapterType {
    switch (this.config.strategy) {
      case "round-robin":
        this.currentReadIndex = (this.currentReadIndex + 1) % replicas.length;
        return replicas[this.currentReadIndex];

      case "random":
        return replicas[Math.floor(Math.random() * replicas.length)];

      case "fastest":
        // Select replica with lowest avg response time
        return replicas.reduce((fastest, current) => {
          const fastestHealth = this.replicaHealth.get(fastest);
          const currentHealth = this.replicaHealth.get(current);
          if (!fastestHealth || !currentHealth) return fastest;
          return currentHealth.avgResponseTime < fastestHealth.avgResponseTime
            ? current
            : fastest;
        });

      case "least-conn":
        // For now, same as fastest (would need connection tracking)
        return this.selectReplica(
          replicas.filter((r) => this.isReplicaHealthy(r)),
        );

      default:
        return replicas[0];
    }
  }

  /**
   * Initialize health tracking for all replicas
   */
  private initializeHealthTracking(): void {
    for (const adapter of this.config.adapters) {
      this.replicaHealth.set(adapter, {
        adapter,
        isHealthy: true,
        failureCount: 0,
        lastChecked: Date.now(),
        avgResponseTime: 0,
      });
    }
  }

  /**
   * Update health metrics for a replica
   */
  private updateHealthMetrics(
    adapter: DatabaseAdapterType,
    success: boolean,
    responseTime: number,
  ): void {
    const health = this.replicaHealth.get(adapter);
    if (!health) return;

    if (success) {
      health.failureCount = 0;
      health.isHealthy = true;
      health.avgResponseTime =
        health.avgResponseTime * EMA_EXISTING_WEIGHT +
        responseTime * EMA_NEW_WEIGHT; // EMA
    } else {
      health.failureCount++;
      if (health.failureCount >= this.config.maxFailures) {
        health.isHealthy = false;
      }
    }

    health.lastChecked = Date.now();
  }

  /**
   * Check if replica is healthy
   */
  private isReplicaHealthy(adapter: DatabaseAdapterType): boolean {
    const health = this.replicaHealth.get(adapter);
    return health?.isHealthy ?? true;
  }

  /**
   * Start health check interval
   */
  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      for (const adapter of this.config.adapters) {
        const startTime = Date.now();
        try {
          const result = await adapter.healthCheck();
          const responseTime = Date.now() - startTime;

          this.updateHealthMetrics(adapter, result.success, responseTime);
        } catch {
          this.updateHealthMetrics(adapter, false, Date.now() - startTime);
        }
      }
    }, this.config.healthCheckInterval);
  }

  /**
   * Stop health checks
   */
  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Get health status of all replicas
   */
  getHealthStatus(): Record<string, ReplicaHealth> {
    const status: Record<string, ReplicaHealth> = {};
    let index = 0;

    for (const [, health] of this.replicaHealth.entries()) {
      status[`replica-${index++}`] = health;
    }

    return status;
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.stopHealthChecks();
    this.replicaHealth.clear();
  }
}
