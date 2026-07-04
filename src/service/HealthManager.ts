/**
 * @fileoverview Health Manager for @myko/atlas-client package
 *
 * This module provides the HealthManager class responsible for monitoring database
 * connection health, performing periodic health checks, and managing the lifecycle
 * of database connections. It provides a centralized way to track database status.
 *
 * Part of the @myko/atlas-client package - a TypeScript database abstraction layer with
 * support for multiple adapters (Drizzle, Supabase, SQL), extensions (audit, encryption,
 * soft delete), and advanced features (caching, read replicas, multi-tenancy).
 *
 */

import type {
  DatabaseAdapterType,
  DatabaseHealthStatus,
  DatabaseResult,
  HealthManagerConfig,
} from "@myko/types/db";
import { success, failure } from "@utils/databaseResultHelpers";
import { normalizeDetails } from "@utils/normalizeDetails";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";

/** Default number of consecutive failures before triggering failover */
const DEFAULT_FAILOVER_THRESHOLD = 3;

/**
 * 🌡️ HEALTH MANAGER - Database Health Monitoring
 *
 * Manages database health checks and monitoring functionality for all database adapters.
 * This class is responsible for performing health checks on the database connection,
 * storing the last known health status, and providing methods to quickly check
 * the current health state of the database.
 *
 * **Application Flow Position:**
 * DatabaseService → **HealthManager** → Adapter.healthCheck() → Database
 *
 * **What this class does:**
 * 1. Initializes database connections on startup
 * 2. Performs periodic health checks via adapter.healthCheck()
 * 3. Caches last known health status for quick access
 * 4. Normalizes health details across different adapters
 * 5. Manages connection lifecycle (connect/disconnect)
 *
 * **Called by:** DatabaseService.healthCheck(), application health endpoints
 * **Calls:** DatabaseAdapter.healthCheck(), DatabaseAdapter.connect/disconnect
 * **Used for:** Application health monitoring, load balancer health checks
 *
 * @example
 * ```typescript
 * // Create health manager with adapter
 * const healthManager = new HealthManager(drizzleAdapter);
 *
 * // Initialize connection and perform initial health check
 * await healthManager.init();
 *
 * // Perform health check
 * const healthResult = await healthManager.checkHealth();
 * if (healthResult.success) {
 *   console.log('Database is healthy:', healthResult.value);
 * }
 *
 * // Quick health status check (uses cached result)
 * const isHealthy = healthManager.isHealthy();
 *
 * // Get last known status without new check
 * const lastStatus = healthManager.getLastHealthStatus();
 *
 * // Cleanup on shutdown
 * await healthManager.shutdown();
 * ```
 *
 */
export class HealthManager {
  private lastHealthStatus: DatabaseHealthStatus | null = null;
  private initialized = false;
  private currentAdapter: DatabaseAdapterType;
  private primaryAdapter: DatabaseAdapterType;
  private backupAdapters: DatabaseAdapterType[];
  private consecutiveFailures = 0;
  private healthCheckInterval?: number;
  private failoverThreshold: number;
  private autoFailover: boolean;
  private healthCheckTimer?: globalThis.NodeJS.Timeout;

  /**
   * Create a HealthManager instance.
   *
   * Accepts either a single adapter (simple mode) or a full
   * HealthManagerConfig that enables automatic failover and
   * periodic health checks.
   *
   * @param config - A single DatabaseAdapterType or a HealthManagerConfig object
   */
  constructor(config: DatabaseAdapterType | HealthManagerConfig) {
    // Support both old (single adapter) and new (config) constructors
    if ("primary" in config) {
      this.primaryAdapter = config.primary;
      this.currentAdapter = config.primary;
      this.backupAdapters = config.backups ?? [];
      this.healthCheckInterval = config.healthCheckInterval;
      this.failoverThreshold =
        config.failoverThreshold ?? DEFAULT_FAILOVER_THRESHOLD;
      this.autoFailover = config.autoFailover ?? false;
    } else {
      this.primaryAdapter = config;
      this.currentAdapter = config;
      this.backupAdapters = [];
      this.failoverThreshold = DEFAULT_FAILOVER_THRESHOLD;
      this.autoFailover = false;
    }
  }

  /**
   * Initializes the health manager by establishing database connection and performing initial health check
   *
   * Sets up the database connection and performs an initial health check to establish
   * baseline health status. This method should be called during application startup
   * to ensure the database is ready for operations.
   *
   * **Initialization Process:**
   * 1. Checks if already initialized (prevents double initialization)
   * 2. Calls adapter.connect() if available (establishes connection)
   * 3. Performs initial health check via checkHealth()
   * 4. Sets initialized flag to prevent re-initialization
   *
   * @returns {Promise<void>} Promise that resolves when initialization is complete
   *
   * @example
   * ```typescript
   * const healthManager = new HealthManager(adapter);
   *
   * // Initialize during application startup
   * await healthManager.init();
   * console.log('Health manager initialized');
   *
   * // Subsequent calls are no-ops
   * await healthManager.init(); // Does nothing, already initialized
   * ```
   *
   */
  async init(): Promise<void> {
    // Prevent double initialization
    if (this.initialized) return;

    // Establish database connection if adapter supports it
    if (typeof this.currentAdapter.initialize === "function") {
      await this.currentAdapter.initialize();
    }

    // Perform initial health check to establish baseline status
    await this.checkHealth();
    this.initialized = true;

    // Start periodic health checks if configured
    if (this.healthCheckInterval && this.healthCheckInterval > 0) {
      this.startPeriodicHealthChecks();
    }
  }

  /**
   * Performs a comprehensive health check on the database connection
   *
   * Executes a health check via the database adapter and normalizes the results
   * into a standardized health status format. Measures response time and handles
   * both successful and failed health checks gracefully.
   *
   * **Health Check Process:**
   * 1. Records start time for response time measurement
   * 2. Calls adapter.healthCheck() to test database connectivity
   * 3. Normalizes adapter-specific response into standard format
   * 4. Caches result as lastHealthStatus for quick access
   * 5. Returns standardized DatabaseResult with health information
   *
   * **Health Status Fields:**
   * - isHealthy: Boolean indicating if database is operational
   * - responseTime: Time in milliseconds for health check to complete
   * - details: Normalized adapter-specific details (connection info, errors, etc.)
   *
   * @returns {Promise<DatabaseResult<DatabaseHealthStatus>>} Promise resolving to health status result
   *
   * @example
   * ```typescript
   * // Perform health check
   * const healthResult = await healthManager.checkHealth();
   *
   * if (healthResult.success) {
   *   const status = healthResult.value;
   *   console.log(`Database healthy: ${status.isHealthy}`);
   *   console.log(`Response time: ${status.responseTime}ms`);
   *   console.log('Details:', status.details);
   * } else {
   *   console.error('Health check failed:', healthResult.error.message);
   * }
   *
   * // Example healthy response:
   * // {
   * //   success: true,
   * //   value: {
   * //     isHealthy: true,
   * //     responseTime: 45,
   * //     details: { adapter: "drizzle", connections: "5" }
   * //   }
   * // }
   *
   * // Example unhealthy response:
   * // {
   * //   success: true,
   * //   value: {
   * //     isHealthy: false,
   * //     responseTime: 5000,
   * //     details: { error: "Connection timeout" }
   * //   }
   * // }
   * ```
   *
   */
  /**
   * Handle health check result and update internal failover state.
   *
   * Resets the consecutive failure counter on success; increments it
   * on failure and triggers automatic failover if the threshold is met.
   *
   * @param isSuccess - Whether the health check succeeded
   */
  private async handleHealthResult(isSuccess: boolean): Promise<void> {
    if (isSuccess) {
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures++;
    if (
      this.autoFailover &&
      this.consecutiveFailures >= this.failoverThreshold
    ) {
      await this.performFailover();
    }
  }

  /**
   * Build a normalized DatabaseHealthStatus from a health check result.
   *
   * @param result - The raw result from the adapter health check
   * @param responseTime - Measured response time in milliseconds
   * @returns A normalized health status object
   */
  private createHealthStatus(
    result: DatabaseResult<DatabaseHealthStatus>,
    responseTime: number,
  ): DatabaseHealthStatus {
    return {
      isHealthy: result.success,
      responseTime,
      details: result.success
        ? normalizeDetails(result.value)
        : { error: result.error?.message ?? "Unknown error" },
    };
  }

  /**
   * Perform a health check against the current database adapter.
   *
   * Measures response time, normalises the adapter-specific result
   * into a standard DatabaseHealthStatus, and caches the status for
   * later retrieval via getLastHealthStatus / isHealthy.
   *
   * @returns The current health status wrapped in a DatabaseResult
   */
  async checkHealth(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    const startTime = Date.now();

    try {
      const result = await this.currentAdapter.healthCheck();
      const responseTime = Date.now() - startTime;

      const status = this.createHealthStatus(result, responseTime);
      this.lastHealthStatus = status;

      await this.handleHealthResult(result.success);

      return success(status);
    } catch (error) {
      const status: DatabaseHealthStatus = {
        isHealthy: false,
        responseTime: Date.now() - startTime,
        details: { error: (error as Error).message },
      };

      this.lastHealthStatus = status;
      await this.handleHealthResult(false);

      return failure(
        new DatabaseError(
          `Health check failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.FETCH_FAILED,
          {
            context: { source: "checkHealth" },
            cause: error as Error,
          },
        ),
      );
    }
  }
  /**
   * Get the last known health status
   */
  getLastHealthStatus(): DatabaseHealthStatus | null {
    return this.lastHealthStatus;
  }

  /**
   * Check if the database is currently healthy
   */
  isHealthy(): boolean {
    return this.lastHealthStatus?.isHealthy ?? false;
  }

  /**
   * Get the current active adapter
   */
  getCurrentAdapter(): DatabaseAdapterType {
    return this.currentAdapter;
  }

  /**
   * Attempt to initialize and verify the health of a backup adapter.
   *
   * @param backup - The backup adapter to test
   * @returns True if the backup is healthy and ready for use
   */
  private async tryBackupAdapter(
    backup: DatabaseAdapterType,
  ): Promise<boolean> {
    if (typeof backup.initialize === "function") {
      const initResult = await backup.initialize();
      if (!initResult.success) return false;
    }

    const healthResult = await backup.healthCheck();
    return healthResult.success && (healthResult.value?.isHealthy ?? false);
  }

  /**
   * Switch the active connection to a backup adapter.
   *
   * Closes the current adapter, assigns the backup as the current
   * adapter, and resets the consecutive failure counter.
   *
   * @param backup - The backup adapter to switch to
   */
  private async switchToBackup(backup: DatabaseAdapterType): Promise<void> {
    await this.currentAdapter.close();
    this.currentAdapter = backup;
    this.consecutiveFailures = 0;
    console.log("[HealthManager] Failover successful to backup adapter");
  }

  /**
   * Iterate through backup adapters and switch to the first healthy one.
   *
   * Logs a warning if no backups are configured, and an error if all
   * backup adapters are found to be unhealthy.
   */
  private async performFailover(): Promise<void> {
    if (this.backupAdapters.length === 0) {
      console.warn("[HealthManager] No backup adapters available for failover");
      return;
    }

    for (const backup of this.backupAdapters) {
      try {
        const isHealthy = await this.tryBackupAdapter(backup);
        if (isHealthy) {
          await this.switchToBackup(backup);
          return;
        }
      } catch (error) {
        console.error(
          "[HealthManager] Backup adapter health check failed:",
          error,
        );
      }
    }

    console.error(
      "[HealthManager] All backup adapters failed, staying with current adapter",
    );
  }

  /**
   * Start a recurring interval that performs health checks automatically.
   *
   * Uses the configured healthCheckInterval value. If a timer is already
   * running, this is a no-op.
   */
  private startPeriodicHealthChecks(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      await this.checkHealth();
    }, this.healthCheckInterval);
  }

  /**
   * Stop the recurring health check interval if it is running.
   */
  private stopPeriodicHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Gracefully shut down the health manager
   */
  async shutdown(): Promise<void> {
    this.stopPeriodicHealthChecks();

    await this.currentAdapter.close();

    this.initialized = false;
    this.lastHealthStatus = null;
  }
}
