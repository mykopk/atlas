/**
 * @module @mykopk/atlas-client/advanced/monitoring
 *
 * Database monitoring infrastructure for Atlas clients.
 *
 * @description
 * Provides metrics collection and alert management for database operations.
 * - {@link MetricsCollector}: Collects query and pool metrics, detects slow queries
 *   and N+1 patterns, emits events on thresholds.
 * - {@link AlertManager}: Configurable rule-based alerting with automatic resolution,
 *   ships with defaults for pool exhaustion, slow queries, and replica lag.
 *
 * @example
 * ```typescript
 * import { MetricsCollector, AlertManager } from "@myko.pk/atlas-client/advanced/monitoring";
 *
 * const collector = new MetricsCollector();
 * const alerts = new AlertManager();
 *
 * collector.on("alert", (a) => alerts.evaluate(a));
 * collector.recordQuery({ query: "SELECT ...", duration: 1200, timestamp: new Date(), success: true });
 * ```
 */
export { MetricsCollector } from "./MetricsCollector";
export { AlertManager } from "./AlertManager";
