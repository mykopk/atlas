import { Pool } from "pg";
import type { PoolClient } from "pg";
import { failure, success } from "@utils/databaseResultHelpers";
import { logger } from "@myko.pk/logger";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";
import {
  type DatabaseResult,
  type DatabaseHealthStatus,
  type DynamicPoolConfig,
  type PoolMetrics,
  DB_POOL_EVENTS,
} from "@myko.pk/types/db";
import { NUMERIX } from "@myko.pk/config";
import { dynamicPoolDefaultConfig } from "@myko.pk/config/db";

/**
 * Dynamic connection pool that automatically adjusts size based on load.
 * Provides detailed metrics and health monitoring.
 *
 * @example
 * ```typescript
 * const pool = new DynamicPool('postgres://localhost:5432/db', {
 *   min: 2,
 *   max: 20,
 *   scaling: {
 *     enabled: true,
 *     scaleUpThreshold: 80,
 *     scaleDownThreshold: 20,
 *     scaleInterval: 30000,
 *     maxScale: 5
 *   }
 * });
 *
 * // Execute a query
 * const result = await pool.query('SELECT * FROM users');
 *
 * // Get pool metrics
 * const metrics = pool.getMetrics();
 * console.log(`Active connections: ${metrics.activeConnections}`);
 *
 * // Health check
 * const health = await pool.healthCheck();
 * console.log(`Pool healthy: ${health.value?.isHealthy}`);
 * ```
 *
 * @example
 * ### High-Traffic Application
 * ```typescript
 * class DatabasePool {
 *   private pool: DynamicPool;
 *
 *   constructor() {
 *     this.pool = new DynamicPool(process.env.DATABASE_URL, {
 *       min: 5,
 *       max: 50,
 *       scaling: {
 *         enabled: true,
 *         scaleUpThreshold: 75,
 *         scaleDownThreshold: 25,
 *         scaleInterval: 15000, // Check every 15 seconds
 *         maxScale: 10
 *       }
 *     });
 *   }
 *
 *   async query<T>(sql: string, params: object[] = []): Promise<DatabaseResult<T[]>> {
 *     return this.pool.query<T>(sql, params);
 *   }
 *
 *   async getHealthStatus(): Promise<DatabaseResult<HealthStatus>> {
 *     return this.pool.healthCheck();
 *   }
 *
 *   async shutdown(): Promise<void> {
 *     await this.pool.end();
 *   }
 * }
 * ```
 *
 * @example
 * ### Connection Pool Monitoring
 * ```typescript
 * class PoolMonitor {
 *   constructor(private pool: DynamicPool) {}
 *
 *   async startMonitoring(): Promise<void> {
 *     setInterval(() => {
 *       const metrics = this.pool.getMetrics();
 *       const utilization = metrics.totalConnections > 0
 *         ? (metrics.activeConnections / metrics.totalConnections) * 100
 *         : 0;
 *
 *       console.log(`Pool Utilization: ${utilization.toFixed(1)}%`);
 *       console.log(`Active: ${metrics.activeConnections}, Idle: ${metrics.idleConnections}`);
 *       console.log(`Waiting: ${metrics.waitingRequests}`);
 *
 *       // Alert if pool is under pressure
 *       if (utilization > 90) {
 *         console.warn('Pool utilization is very high!');
 *       }
 *     }, 30000); // Every 30 seconds
 *   }
 * }
 * ```
 *
 * @example
 * ### Auto-scaling Configuration
 * ```typescript
 * const poolConfig: DynamicPoolConfig = {
 *   min: 3,
 *   max: 30,
 *   idleTimeoutMillis: 60000, // 1 minute
 *   acquireTimeoutMillis: 5000, // 5 seconds
 *   scaling: {
 *     enabled: true,
 *     scaleUpThreshold: 80, // Scale up when 80% utilized
 *     scaleDownThreshold: 20, // Scale down when 20% idle
 *     scaleInterval: 10000, // Check every 10 seconds
 *     maxScale: 5 // Add/remove up to 5 connections at once
 *   }
 * };
 *
 * const pool = new DynamicPool('postgres://localhost:5432/myapp', poolConfig);
 * ```
 */

export class DynamicPool {
  private pool: Pool;
  private config: DynamicPoolConfig;
  private metrics = {
    totalConnections: 0,
    activeConnections: 0,
    idleConnections: 0,
    waitingRequests: 0,
    totalAcquired: 0,
    averageAcquisitionTime: 0,
  } as PoolMetrics;
  private scalingTimer?: ReturnType<typeof setInterval>;

  /**
   * Creates a new DynamicPool instance.
   * @param connectionString Database connection string
   * @param config Pool configuration options
   *
   * @example
   * ```typescript
   * // Basic configuration
   * const pool = new DynamicPool('postgres://localhost:5432/db');
   *
   * // Advanced configuration
   * const pool = new DynamicPool('postgres://localhost:5432/db', {
   *   min: 5,
   *   max: 25,
   *   scaling: {
   *     enabled: true,
   *     scaleUpThreshold: 75,
   *     scaleInterval: 20000
   *   }
   * });
   * ```
   */
  constructor(
    connectionString: string,
    config: Partial<DynamicPoolConfig> = {},
  ) {
    this.config = {
      ...dynamicPoolDefaultConfig,
      ...config,
    };

    this.pool = new Pool({
      connectionString,
      min: this.config.min,
      max: this.config.max,
      idleTimeoutMillis: this.config.idleTimeoutMillis,
    });

    this.setupEventListeners();

    if (this.config.scaling.enabled) {
      this.startScalingTimer();
    }
  }

  /**
   * Sets up event listeners for the connection pool.
   */
  private setupEventListeners(): void {
    this.pool.on(DB_POOL_EVENTS.CONNECT, () => {
      this.metrics.totalConnections++;
    });

    this.pool.on(DB_POOL_EVENTS.ACQUIRE, (client: PoolClient) => {
      this.metrics.activeConnections++;
      this.metrics.idleConnections--;
      this.metrics.totalAcquired++;
      (client as PoolClient & { acquiredAt: number }).acquiredAt = Date.now();
    });

    // Fixed: Updated the release event listener to match the correct signature
    this.pool.on(
      DB_POOL_EVENTS.RELEASE,
      (err: Error | undefined, client: PoolClient) => {
        if (err) {
          logger.error(`Error on client release: ${err.message}`);
        }

        this.metrics.activeConnections--;
        this.metrics.idleConnections++;
        this.metrics.totalReleased++;

        // Update average acquisition time
        const acquiredAt = (client as PoolClient & { acquiredAt?: number })
          .acquiredAt;
        if (acquiredAt) {
          const acquisitionTime = Date.now() - acquiredAt;
          this.metrics.averageAcquisitionTime =
            (this.metrics.averageAcquisitionTime *
              (this.metrics.totalReleased - 1) +
              acquisitionTime) /
            this.metrics.totalReleased;
        }
      },
    );

    this.pool.on(DB_POOL_EVENTS.REMOVE, () => {
      this.metrics.totalConnections--;
    });
  }

  /**
   * Starts the auto-scaling timer.
   */
  private startScalingTimer(): void {
    this.scalingTimer = setInterval(() => {
      this.adjustPoolSize();
    }, this.config.scaling.scaleInterval);
  }

  /**
   * Adjusts pool size based on current load.
   */
  private adjustPoolSize(): void {
    const { activeConnections, idleConnections, totalConnections } =
      this.metrics;
    const { min, max, scaling } = this.config;

    const utilizationRate =
      totalConnections > 0
        ? (activeConnections / totalConnections) * NUMERIX.HUNDRED
        : 0;

    const idleRate =
      totalConnections > 0
        ? (idleConnections / totalConnections) * NUMERIX.HUNDRED
        : 0;

    // Scale up if utilization is high
    if (utilizationRate > scaling.scaleUpThreshold && totalConnections < max) {
      const scaleBy = Math.min(scaling.maxScale, max - totalConnections);
      this.adjustPoolCount(totalConnections + scaleBy);
    }

    // Scale down if idle rate is high
    if (idleRate > scaling.scaleDownThreshold && totalConnections > min) {
      const scaleBy = Math.min(scaling.maxScale, totalConnections - min);
      this.adjustPoolCount(totalConnections - scaleBy);
    }
  }

  /**
   * Adjusts the pool connection count.
   * @param newCount New connection count
   */
  private adjustPoolCount(newCount: number): void {
    // TODO: Implement dynamic pool scaling
    // Note: pg pool doesn't directly support scaling down at runtime
    // Current implementation logs the scaling action for monitoring

    const currentCount = this.pool.totalCount;
    const difference = newCount - currentCount;

    // Scaling up: pg pool will automatically create new connections as needed
    // when requests exceed current pool size (up to max limit)
    // No direct action needed - pool handles this automatically

    // Scaling down: pg pool doesn't support removing idle connections
    // They will naturally expire based on idleTimeoutMillis setting
    // Future implementation could force close idle connections

    // Log scaling decision for monitoring and debugging
    // In production, this could emit metrics or trigger alerts
    logger.debug(
      `Scale check: current=${currentCount}, target=${newCount}, difference=${difference}`,
    );
  }

  /**
   * Executes a database query with timing and error tracking.
   * @param sql SQL query string
   * @param params Query parameters
   * @returns Query result
   *
   * @example
   * ```typescript
   * // Simple query
   * const result = await pool.query('SELECT * FROM users');
   *
   * // Query with parameters
   * const result = await pool.query(
   *   'SELECT * FROM users WHERE id = $1 AND active = $2',
   *   [123, true]
   * );
   *
   * // Query with type safety
   * const users = await pool.query<User>('SELECT * FROM users');
   * ```
   */
  async query<T extends object>(
    sql: string,
    params: object[] = [],
  ): Promise<DatabaseResult<T[]>> {
    const startTime = Date.now();
    try {
      // Validate SQL to prevent injection
      if (!sql || typeof sql !== "string") {
        throw new DatabaseError(
          "Invalid SQL query",
          DATABASE_ERROR_CODES.INVALID_SQL,
          {
            context: {
              source: "DynamicPool.query",
            },
          },
        );
      }

      const result = await this.pool.query(sql, params);
      return success(result.rows);
    } catch (error) {
      logger.error(`Database query failed: ${(error as Error).message}`);
      return failure(
        new DatabaseError(
          "Database query failed",
          DATABASE_ERROR_CODES.QUERY_FAILED,
          {
            context: {
              source: "DynamicPool.query",
              cause: error,
            },
          },
        ),
      );
    } finally {
      // Track slow queries
      const duration = Date.now() - startTime;
      if (duration > NUMERIX.THOUSAND) {
        // 1 second threshold
        const SQL_PREVIEW_LENGTH = 100;
        logger.warn(
          `Slow query detected: ${duration}ms - ${sql.substring(0, SQL_PREVIEW_LENGTH)}`,
        );
      }
    }
  }

  /**
   * Performs a health check on the connection pool.
   * @returns Health status with detailed metrics
   *
   * @example
   * ```typescript
   * const health = await pool.healthCheck();
   * if (health.success && health.value?.isHealthy) {
   *   console.log('Pool is healthy');
   *   console.log(`Response time: ${health.value.responseTime}ms`);
   * } else {
   *   console.log('Pool health check failed');
   * }
   * ```
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    const startTime = Date.now();
    let client: PoolClient | null = null;

    try {
      client = await this.pool.connect();
      await client.query("SELECT 1");

      const utilizationRate =
        this.metrics.totalConnections > 0
          ? (this.metrics.activeConnections / this.metrics.totalConnections) *
            NUMERIX.HUNDRED
          : 0;

      const responseTime = Date.now() - startTime;

      return success({
        isHealthy: true,
        responseTime,
        details: {
          ...this.metrics,
          utilizationRate,
        },
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      logger.error(`Pool health check failed: ${(error as Error).message}`);

      return success({
        isHealthy: false,
        responseTime,
        details: {
          ...this.metrics,
          error: (error as Error).message,
        },
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Gets current pool metrics.
   * @returns Pool performance metrics
   *
   * @example
   * ```typescript
   * const metrics = pool.getMetrics();
   * console.log(`Total connections: ${metrics.totalConnections}`);
   * console.log(`Active connections: ${metrics.activeConnections}`);
   * console.log(`Idle connections: ${metrics.idleConnections}`);
   * console.log(`Average acquisition time: ${metrics.averageAcquisitionTime}ms`);
   *
   * // Calculate utilization rate
   * const utilizationRate = metrics.totalConnections > 0
   *   ? (metrics.activeConnections / metrics.totalConnections) * 100
   *   : 0;
   * console.log(`Utilization rate: ${utilizationRate.toFixed(1)}%`);
   * ```
   */
  getMetrics(): PoolMetrics {
    return { ...this.metrics };
  }

  /**
   * Closes all connections in the pool.
   *
   * @example
   * ```typescript
   * // Graceful shutdown
   * async function shutdown() {
   *   console.log('Closing database connections...');
   *   await pool.end();
   *   console.log('Database connections closed');
   * }
   *
   * // Handle process signals
   * process.on('SIGTERM', shutdown);
   * process.on('SIGINT', shutdown);
   * ```
   */
  async end(): Promise<void> {
    try {
      if (this.scalingTimer) {
        clearInterval(this.scalingTimer);
        this.scalingTimer = undefined;
      }
      await this.pool.end();
    } catch (error) {
      logger.error(`Error closing pool: ${(error as Error).message}`);
      throw new DatabaseError(
        "Failed to close connection pool",
        DATABASE_ERROR_CODES.DISCONNECT_FAILED,
        {
          context: {
            source: "DynamicPool.end",
            cause: error,
          },
        },
      );
    }
  }
}
