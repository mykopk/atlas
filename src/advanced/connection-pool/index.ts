/**
 * @module connection-pool
 * @description Provides a dynamic database connection pool ({@link DynamicPool})
 * that automatically scales connection count based on load, tracks detailed
 * performance metrics (active/idle/waiting connections, acquisition times),
 * exposes health check endpoints, and supports graceful shutdown.
 */
export { DynamicPool } from "./DynamicPool";
