/**
 * @module advanced
 * @description Aggregates and re-exports all advanced database features including
 * read-replica support, query result caching, connection pooling with auto-scaling,
 * monitoring, backup/restore utilities, multi-tenancy support, and sharding utilities.
 * Each feature is independently importable from its respective submodule.
 */
export * from "./read-replica";

// Query Result Caching
export * from "./caching";

// Advanced Connection Pooling
export * from "./connection-pool";

// Advanced Monitoring
export * from "./monitoring";

// Database Backup Utilities
export * from "./backup";

// Multi-Tenancy Support
export * from "./multi-tenancy";

// Database Sharding Preparation
export * from "./sharding";
