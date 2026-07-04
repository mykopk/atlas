import { EventEmitter } from "events";
import { logger } from "@myko.pk/logger";
import { NUMERIX } from "@myko.pk/config";
import type { Alert, AlertRule, PoolMetrics, QueryMetrics } from "@myko.pk/types";
import { ALERT_RULE_ID, ALERT_SEVERITY, ALERT_SOURCE } from "@myko.pk/types";

/**
 * Manages database alerts with configurable rules and automatic resolution.
 * Provides real-time alerting for various database issues.
 *
 * @description
 * `AlertManager` extends `EventEmitter` and provides a complete alerting
 * framework for database operations. It ships with three default rules:
 * pool exhaustion (critical at >90 % utilisation), slow queries (warning
 * at >1000 ms), and replica lag (warning at >5000 ms). Custom rules can
 * be added via {@link addRule}.
 *
 * **Lifecycle:**
 * 1. Instantiate – default rules are registered in the constructor.
 * 2. Optionally add custom rules via {@link addRule}.
 * 3. Feed metrics via {@link evaluate} – matching rules fire alerts.
 * 4. Read active / all alerts via {@link getActiveAlerts} / {@link getAllAlerts}.
 * 5. Resolve alerts via {@link resolveAlert}.
 *
 * **Deduplication:** Only one active alert per rule `id` is kept. If the
 * same rule fires while its previous alert is still unresolved, the new
 * alert is silently dropped.
 *
 * **Thread-safety:** Instances are **not** guaranteed thread-safe. In a
 * concurrent environment, external synchronisation is required when the
 * same instance is shared across multiple async chains.
 *
 * @emits alert - When a rule condition is met. Payload: {@link Alert}
 * @emits alertResolved - When an alert is resolved. Payload: {@link Alert}
 *
 * @example
 * ```typescript
 * const alertManager = new AlertManager();
 *
 * // Add custom alert rule
 * alertManager.addRule({
 *   id: 'high-error-rate',
 *   condition: (metrics) => (metrics.errorRate as number) > 5,
 *   message: (metrics) => `High error rate: ${metrics.errorRate}%`,
 *   severity: 'error',
 *   source: 'database'
 * });
 *
 * // Evaluate metrics against rules
 * const metrics = { errorRate: 7.2, poolUtilization: 85 };
 * alertManager.evaluate(metrics);
 *
 * // Get active alerts
 * const activeAlerts = alertManager.getActiveAlerts();
 *
 * // Resolve an alert
 * alertManager.resolveAlert('alert-id');
 * ```
 */
export class AlertManager extends EventEmitter {
  private alerts: Map<string, Alert> = new Map();
  private alertRules: AlertRule[] = [];
  private readonly logger = logger;

  /**
   * Creates a new AlertManager instance and initialises default alert rules.
   *
   * @description
   * The constructor registers three built-in rules covering pool exhaustion,
   * slow queries, and replica lag. No external dependencies are required.
   */
  constructor() {
    super();
    this.setupDefaultRules();
  }

  /**
   * Sets up default alert rules for common database issues.
   *
   * @description
   * Called once from the constructor. Registers the following rules:
   * - **Pool exhaustion** – critical when utilisation exceeds 90 %.
   * - **Slow query** – warning when a single query exceeds 1000 ms.
   * - **Replica lag** – warning when lag exceeds 5000 ms.
   */
  private setupDefaultRules(): void {
    // Pool exhaustion alert
    this.addRule({
      id: ALERT_RULE_ID.POOL_EXHAUSTION,
      condition: (metrics) => {
        const poolMetrics = metrics.pool as PoolMetrics | undefined;
        if (!poolMetrics) return false;

        const utilizationRate =
          poolMetrics.totalConnections > 0
            ? (poolMetrics.activeConnections / poolMetrics.totalConnections) *
              NUMERIX.HUNDRED
            : 0;
        return utilizationRate > NUMERIX.NINETY;
      },
      message: (metrics) => {
        const poolMetrics = metrics.pool as PoolMetrics;
        const utilizationRate =
          poolMetrics.totalConnections > 0
            ? (poolMetrics.activeConnections / poolMetrics.totalConnections) *
              NUMERIX.HUNDRED
            : 0;
        return `Pool exhaustion: ${utilizationRate.toFixed(1)}% utilization`;
      },
      severity: ALERT_SEVERITY.CRITICAL,
      source: ALERT_SOURCE.POOL,
    });

    // Slow query alert - Fixed to always return boolean
    this.addRule({
      id: ALERT_RULE_ID.SLOW_QUERY,
      condition: (metrics) => {
        const queryMetrics = metrics.query as QueryMetrics | undefined;
        // Fixed: Explicitly return boolean instead of boolean | undefined
        return (
          queryMetrics !== undefined && queryMetrics.duration > NUMERIX.THOUSAND
        );
      },
      message: (metrics) => {
        const queryMetrics = metrics.query as QueryMetrics;
        return `Slow query: ${queryMetrics.query} took ${queryMetrics.duration}ms`;
      },
      severity: ALERT_SEVERITY.WARNING,
      source: ALERT_SOURCE.DATABASE,
    });

    // Replica lag alert - Fixed to always return boolean
    this.addRule({
      id: ALERT_RULE_ID.REPLICA_LAG,
      condition: (metrics) => {
        const replicaMetrics = metrics.replica as { lag: number } | undefined;
        // Fixed: Explicitly return boolean instead of boolean | undefined
        return (
          replicaMetrics !== undefined &&
          replicaMetrics.lag > NUMERIX.FIVE_THOUSAND
        );
      },
      message: (metrics) => {
        const replicaMetrics = metrics.replica as { lag: number };
        return `Replica lag: ${replicaMetrics.lag}ms`;
      },
      severity: ALERT_SEVERITY.WARNING,
      source: ALERT_SOURCE.REPLICA,
    });
  }

  /**
   * Registers a custom alert rule.
   *
   * @description
   * Appends the provided rule to the internal evaluation list. The rule is
   * evaluated on every subsequent {@link evaluate} call. Rules are **not**
   * deduplicated by ID, so the same rule may be registered multiple times.
   *
   * @param rule - Alert rule definition. Must supply `id`, `condition`,
   *               `message`, `severity`, and `source`.
   * @returns void
   *
   * @example
   * ```typescript
   * alertManager.addRule({
   *   id: 'cpu-threshold',
   *   condition: (m) => (m.cpu as number) > 80,
   *   message: (m) => `CPU at ${m.cpu}%`,
   *   severity: 'warning',
   *   source: 'system'
   * });
   * ```
   */
  addRule(rule: AlertRule): void {
    this.alertRules.push(rule);
  }

  /**
   * Evaluates a metrics snapshot against all registered alert rules.
   *
   * @description
   * Iterates over every registered rule and invokes its `condition` with
   * the supplied metrics. If a condition returns `true`, an alert is
   * triggered via {@link triggerAlert} (which deduplicates by rule ID).
   *
   * @param metrics - Arbitrary object keyed by category (e.g. `pool`,
   *                  `query`, `replica`). The expected shape is defined
   *                  implicitly by the registered rule conditions.
   * @returns void
   *
   * @example
   * ```typescript
   * alertManager.evaluate({
   *   pool: { activeConnections: 45, totalConnections: 50 },
   *   query: { duration: 2000, query: 'SELECT * FROM t' }
   * });
   * ```
   */
  evaluate(metrics: Record<string, object>): void {
    this.alertRules.forEach((rule) => {
      if (rule.condition(metrics)) {
        this.triggerAlert(rule, metrics);
      }
    });
  }

  /**
   * Triggers an alert based on a rule.
   * @param rule Alert rule that was triggered
   * @param metrics Current metrics
   */
  private triggerAlert(rule: AlertRule, metrics: Record<string, object>): void {
    const alertId = `${rule.id}-${Date.now()}`;

    // Check if similar alert is already active
    const existingAlert = Array.from(this.alerts.values()).find(
      (alert) => !alert.resolved && alert.id.startsWith(rule.id),
    );

    if (existingAlert) {
      return; // Don't duplicate active alerts
    }

    const alert: Alert = {
      id: alertId,
      message: rule.message(metrics),
      severity: rule.severity,
      timestamp: new Date(),
      resolved: false,
      source: rule.source,
    };

    this.alerts.set(alertId, alert);
    this.emit("alert", alert);

    // Database alert handled - using DatabaseError for proper error handling
  }

  /**
   * Resolves an active alert by its ID.
   *
   * @description
   * Sets the alert's `resolved` flag to `true`, records a resolution
   * timestamp, and emits the `alertResolved` event. If the alert is
   * already resolved or does not exist, this is a no-op.
   *
   * @param alertId - Unique identifier of the alert to resolve. Must
   *                  match a key in the internal alerts map.
   * @returns void
   *
   * @example
   * ```typescript
   * alertManager.resolveAlert('pool-exhaustion-1712345678901');
   * ```
   */
  resolveAlert(alertId: string): void {
    const alert = this.alerts.get(alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      this.emit("alertResolved", alert);
    }
  }

  /**
   * Returns all currently active (unresolved) alerts.
   *
   * @returns A fresh array containing every unresolved alert.
   *
   * @example
   * ```typescript
   * const active = alertManager.getActiveAlerts();
   * active.forEach(a => console.log(a.message));
   * ```
   */
  getActiveAlerts(): Alert[] {
    return Array.from(this.alerts.values()).filter((alert) => !alert.resolved);
  }

  /**
   * Returns all alerts (both active and resolved).
   *
   * @returns A fresh array of every recorded alert in insertion order.
   *
   * @example
   * ```typescript
   * const all = alertManager.getAllAlerts();
   * console.log(`Total alerts recorded: ${all.length}`);
   * ```
   */
  getAllAlerts(): Alert[] {
    return Array.from(this.alerts.values());
  }
}
