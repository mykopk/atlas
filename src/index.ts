/**
 * @packageDocumentation
 * @module @mykopk/atlas-client
 *
 * @description
 * Central barrel file for the @myko/atlas-client package.
 * Re-exports all public APIs including the DatabaseService,
 * createDatabaseService factory, AdapterFactory, event system,
 * HealthManager, all adapters (Drizzle, Supabase, SQL, Mock, Prisma),
 * extensions (SoftDelete, Audit, Encryption, Caching, ReadReplica,
 * MultiWrite, MultiRead), utilities, builders, security modules,
 * migrations, seeds, and NestJS integration.
 *
 * Consumers should import from this entry point:
 * ```typescript
 * import { DatabaseService, createDatabaseService } from '@myko.pk/atlas-client';
 * ```
 */
// Core exports
export { DatabaseService } from "./service/DatabaseService";
export { createDatabaseService } from "./factory/createDatabaseService";

// Type re-exports for config files (JSDoc support)
export type { DatabaseServiceConfig, DatabaseServiceInterface } from "@myko.pk/types/db";

// Factory exports
export { AdapterFactory } from "./factory/AdapterFactory";

// Service exports
export { DatabaseEventEmitter } from "./service/EventEmitter";
export { HealthManager } from "./service/HealthManager";

// Repository exports
export { BaseRepository } from "./repository/BaseRepository";

// Adapter exports
export { DrizzleAdapter } from "./adapters/drizzle/DrizzleAdapter";
export { SupabaseAdapter } from "./adapters/supabase/SupabaseAdapter";
export { SQLAdapter } from "./adapters/sql/SQLAdapter";
export { MockAdapter } from "./adapters/mock/MockAdapter";
export { PrismaAdapter } from "./adapters/prisma/PrismaAdapter";

// Extension exports
export { SoftDeleteAdapter } from "./extensions/SoftDeleteExtension";
export { AuditAdapter } from "./extensions/AuditExtension";
export { EncryptionAdapter } from "./extensions/EncryptionExtension";
export { CachingAdapter } from "./extensions/CachingAdapter";
export { ReadReplicaAdapter } from "./extensions/ReadReplicaAdapter";
export { MultiWriteAdapter } from "./extensions/MultiWriteExtension";
export { MultiReadAdapter } from "./extensions/MultiReadExtension";

export { CircuitBreaker, CircuitState, CircuitBreakerError, withDbCircuitBreaker } from "./extensions/CircuitBreakerExtension";
export type { CircuitBreakerConfig, CircuitBreakerMetrics } from "./extensions/CircuitBreakerExtension";

// Utility exports
export { ConfigMerger } from "./utils/ConfigMerger";
export { escapeIlike } from "./utils/sql";

// Advanced Features exports
export * from "./advanced";

// Builder exports
export * from "./builder/query";

// Security exports
export * from "./security";

// Migrations exports
export * from "./migrations";

// Seeds exports
export * from "./seeds";

// NestJS integration
export * from "./nestjs";
