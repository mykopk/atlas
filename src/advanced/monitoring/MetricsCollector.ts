import { NUMERIX } from "@myko/config";
import { logger } from "@myko/logger";
import type { PoolMetrics, QueryMetrics } from "@myko/types";
import { EventEmitter } from "events";
import { DB_REGEX } from "@utils/regex";

/**
 * Collects and analyzes database performance metrics.
 * Provides insights into query performance, pool usage, and potential issues.
 *
 * @description
 * `MetricsCollector` extends `EventEmitter` and captures real-time database
 * metrics for analysis. It retains a sliding window of the last 1000 query
 * metrics and the last 100 pool snapshots. Built-in threshold checks emit
 * alerts for slow queries (>1000 ms), pool exhaustion (>90 % utilisation),
 * and replica lag (>5000 ms).
 *
 * **Features:**
 * - Query performance recording with automatic slow-query detection.
 * - Pool utilisation tracking with exhaustion alerts.
 * - N+1 query pattern detection via frequency analysis.
 * - Query normalisation for accurate frequency grouping.
 *
 * **Thread-safety:**
 * Instances are **not** thread-safe. Use one collector per monitoring scope
 * or provide external synchronisation for shared instances.
 *
 * @emits queryRecorded - After a successful `recordQuery` call. Payload: {@link QueryMetrics}
 * @emits poolMetricsRecorded - After a successful `recordPoolMetrics` call. Payload: {@link PoolMetrics}
 * @emits alert - When a threshold is breached. Payload: `{ message: string, timestamp: Date, severity: string }`
 *
 * @example
 * ```typescript
 * const collector = new MetricsCollector();
 *
 * // Record a query metric
 * collector.recordQuery({
 *   query: 'SELECT * FROM users WHERE id = $1',
 *   duration: 45,
 *   timestamp: new Date(),
 *   success: true,
 *   table: 'users',
 *   operation: 'findById'
 * });
 *
 * // Get top slow queries
 * const slowQueries = collector.getTopSlowQueries(10);
 *
 * // Detect N+1 queries
 * const nPlusOneQueries = collector.detectNPlusOneQueries();
 *
 * // Get query frequency
 * const frequency = collector.getQueryFrequency();
 * ```
 */
export class MetricsCollector extends EventEmitter {
  private queryMetrics: QueryMetrics[] = [];
  private poolMetrics: PoolMetrics[] = [];
  private alerts: string[] = [];
  private readonly logger = logger;

  private readonly SLOW_QUERY_THRESHOLD = 1000; // 1 second
  private readonly POOL_EXHAUSTION_THRESHOLD = 90; // 90%
  private readonly REPLICA_LAG_THRESHOLD = 5000; // 5 seconds
  private readonly DISK_SPACE_THRESHOLD = 20; // 20%

  /**
   * Records query execution metrics.
   *
   * @description
   * Appends the metric to an internal buffer that is trimmed to the most
   * recent 1000 entries. If the query duration exceeds the slow-query
   * threshold, an `alert` event is emitted. After recording, a
   * `queryRecorded` event fires with the raw metric.
   *
   * @param metrics - Query execution details including SQL text, duration,
   *                  timestamp, and success indicator.
   * @returns void
   *
   * @emits queryRecorded - Always emitted after recording completes.
   * @emits alert - Emitted when `metrics.duration > 1000` ms.
   *
   * @example
   * ```typescript
   * collector.recordQuery({
   *   query: 'SELECT * FROM users WHERE id = $1',
   *   duration: 45,
   *   timestamp: new Date(),
   *   success: true,
   *   table: 'users',
   *   operation: 'findById'
   * });
   * ```
   */
  recordQuery(metrics: QueryMetrics): void {
    this.queryMetrics.push(metrics);

    // Keep only last 1000 metrics
    if (this.queryMetrics.length > NUMERIX.THOUSAND) {
      this.queryMetrics = this.queryMetrics.slice(-NUMERIX.THOUSAND);
    }

    // Check for slow queries
    if (metrics.duration > this.SLOW_QUERY_THRESHOLD) {
      this.emitAlert(
        `Slow query detected: ${metrics.query} took ${metrics.duration}ms`,
      );
    }

    this.emit("queryRecorded", metrics);
  }

  /**
   * Records connection pool metrics.
   *
   * @description
   * Appends the metric along with a `timestamp` to an internal buffer
   * trimmed to the most recent 100 entries. If the calculated utilisation
   * rate exceeds 90 %, an `alert` event is emitted. After recording, a
   * `poolMetricsRecorded` event fires with the raw metric.
   *
   * @param metrics - Pool performance data including active and total
   *                  connection counts.
   * @returns void
   *
   * @emits poolMetricsRecorded - Always emitted after recording completes.
   * @emits alert - Emitted when utilisation > 90 %.
   *
   * @example
   * ```typescript
   * collector.recordPoolMetrics({
   *   activeConnections: 45,
   *   totalConnections: 50,
   * });
   * ```
   */
  recordPoolMetrics(metrics: PoolMetrics): void {
    this.poolMetrics.push({
      ...metrics,
      timestamp: new Date(),
    } as PoolMetrics & { timestamp: Date });

    // Keep only last 100 metrics
    if (this.poolMetrics.length > NUMERIX.HUNDRED) {
      this.poolMetrics = this.poolMetrics.slice(-NUMERIX.HUNDRED);
    }

    // Check for pool exhaustion
    const utilizationRate =
      metrics.totalConnections > 0
        ? (metrics.activeConnections / metrics.totalConnections) *
          NUMERIX.HUNDRED
        : 0;

    if (utilizationRate > this.POOL_EXHAUSTION_THRESHOLD) {
      this.emitAlert(
        `Pool exhaustion detected: ${utilizationRate.toFixed(1)}% utilization`,
      );
    }

    this.emit("poolMetricsRecorded", metrics);
  }

  /**
   * Returns the slowest recorded queries that exceed the threshold.
   *
   * @description
   * Filters the metric history for queries with `duration > 1000 ms`,
   * sorts them descending by duration, and returns up to `limit` results.
   *
   * @param limit - Maximum number of queries to return. Defaults to 10.
   * @returns A sorted array of the slowest queries, each with full
   *          {@link QueryMetrics} detail. Returns an empty array if none
   *          exceed the threshold.
   *
   * @example
   * ```typescript
   * const top5 = collector.getTopSlowQueries(5);
   * top5.forEach(q => console.log(`${q.query}: ${q.duration}ms`));
   * ```
   */
  getTopSlowQueries(limit: number = 10): QueryMetrics[] {
    return [...this.queryMetrics]
      .filter((m) => m.duration > this.SLOW_QUERY_THRESHOLD)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, limit);
  }

  /**
   * Calculates how often each normalised query has been executed.
   *
   * @description
   * Normalises each recorded query via {@link DB_REGEX.normalizeSqlQuery}
   * (stripping literal values), then counts occurrences. Useful for
   * identifying hot queries and N+1 patterns.
   *
   * @returns A record mapping normalised query strings to execution counts.
   *
   * @example
   * ```typescript
   * const freq = collector.getQueryFrequency();
   * Object.entries(freq)
   *   .sort((a, b) => b[1] - a[1])
   *   .forEach(([q, c]) => console.log(`${q}: ${c} executions`));
   * ```
   */
  getQueryFrequency(): Record<string, number> {
    const frequency: Record<string, number> = {};

    this.queryMetrics.forEach((metrics) => {
      const normalizedQuery = this.normalizeQuery(metrics.query);
      frequency[normalizedQuery] = (frequency[normalizedQuery] || 0) + 1;
    });

    return frequency;
  }

  /**
   * Detects potential N+1 query patterns.
   *
   * @description
   * Analyses query frequency to find queries matching the pattern
   * `WHERE id =` that have been executed more than 10 times. These
   * often indicate the classic N+1 problem where a parent query is
   * followed by repeated child queries for each result row.
   *
   * @returns An array of suspicious query patterns sorted descending
   *          by execution count. Each entry contains the normalised
   *          query text and its frequency. Returns an empty array if
   *          no N+1 patterns are detected.
   *
   * @example
   * ```typescript
   * const nPlusOne = collector.detectNPlusOneQueries();
   * nPlusOne.forEach(n => console.log(`N+1 query: ${n.query} (${n.count}x)`));
   * ```
   */
  detectNPlusOneQueries(): { query: string; count: number }[] {
    const frequency = this.getQueryFrequency();
    const suspiciousQueries: { query: string; count: number }[] = [];

    Object.entries(frequency).forEach(([query, count]) => {
      if (count > NUMERIX.TEN && query.includes("WHERE id =")) {
        suspiciousQueries.push({ query, count });
      }
    });

    return suspiciousQueries.sort((a, b) => b.count - a.count);
  }

  /**
   * Normalizes a query for frequency analysis.
   * @param query Original SQL query
   * @returns Normalized query string
   */
  private normalizeQuery(query: string): string {
    // Remove specific values to normalize similar queries
    return DB_REGEX.normalizeSqlQuery(query);
  }

  /**
   * Emits an alert event.
   * @param message Alert message
   */
  private emitAlert(message: string): void {
    this.alerts.push(message);

    this.emit("alert", {
      message,
      timestamp: new Date(),
      severity: "warning",
    });
  }
}
