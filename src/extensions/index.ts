/**
 * @fileoverview Database Extension Adapters — Advanced Database Functionality
 * @module @mykopk/atlas-client/extensions
 *
 * Provides a collection of extension adapters that enhance core database operations
 * with advanced features such as soft deletes, encryption, audit logging, caching,
 * and read replica support.
 *
 * These extensions implement the **Decorator Pattern**, wrapping base adapters
 * to transparently add behavior while maintaining full type safety and composability.
 *
 * ---
 *
 * **Extension Chain Architecture:**
 * ```
 * DatabaseService → Extension Chain → Base Adapter → Database
 *       ↓                ↓               ↓              ↓
 *   Operations      AuditAdapter    DrizzleAdapter   PostgreSQL
 *        ↓                ↓
 *   SoftDeleteAdapter   SQL Execution
 *        ↓
 *   EncryptionAdapter
 *        ↓
 *   CachingAdapter
 *        ↓
 *   ReadReplicaAdapter
 * ```
 *
 * ---
 *
 * **Available Extensions:**
 * - **SoftDeleteAdapter** → Logical deletion with restore capabilities
 * - **AuditAdapter** → Comprehensive audit logging with context tracking
 * - **EncryptionAdapter** → Field-level encryption for sensitive data
 * - **CachingAdapter** → Query result caching for high-performance reads
 * - **ReadReplicaAdapter** → Read/write splitting and replica load balancing
 *
 * ---
 *
 * **Extension Benefits:**
 * - **Composable** → Mix and match extensions as needed
 * - **Transparent** → No changes required in business logic
 * - **Configurable** → Fine-grained setup via unified configuration schema
 * - **Type-Safe** → Full TypeScript support with strict type definitions
 * - **Observable** → Integrates with monitoring and metrics systems
 *
 * ---
 *
 * @example
 * ```typescript
 * // Extensions are automatically configured via createDatabaseService
 * const service = await createDatabaseService({
 *   adapter: 'drizzle',
 *   connectionString: process.env.DATABASE_URL,
 *
 *   // Extension configurations
 *   softDelete: { enabled: true, field: 'deletedAt' },
 *   encryption: { enabled: true, key: process.env.ENCRYPTION_KEY },
 *   audit: { enabled: true, retentionDays: 90 },
 *   cache: { enabled: true, ttl: 300 },
 *   replica: { enabled: true, replicas: ['postgres://replica1', 'postgres://replica2'] }
 * });
 *
 * // All operations automatically use configured extensions
 * await service.create('users', userData); // → encrypted, audited
 * await service.delete('users', '123');    // → soft deleted, audited
 * const users = await service.findMany('users'); // → cached, routed to replica
 * ```
 */

/** Logical deletion with restore capabilities */
export { SoftDeleteAdapter } from "./SoftDeleteExtension";

/** Comprehensive audit logging with context tracking */
export { AuditAdapter } from "./AuditExtension";

/** Field-level encryption for sensitive data protection */
export { EncryptionAdapter } from "./EncryptionExtension";

/** Query result caching for improved performance */
export { CachingAdapter } from "./CachingAdapter";

/** Read/write splitting with replica load balancing and failover */
export { ReadReplicaAdapter } from "./ReadReplicaAdapter";

/** Write replication across primary + multiple secondary adapters */
export { MultiWriteAdapter } from "./MultiWriteExtension";

/** Read distribution across multiple read replicas with load balancing */
export { MultiReadAdapter } from "./MultiReadExtension";

/** Circuit breaker for database resilience with P99 latency tracking */
export { CircuitBreaker, CircuitState, CircuitBreakerError, withDbCircuitBreaker } from "./CircuitBreakerExtension";
export type { CircuitBreakerConfig, CircuitBreakerMetrics } from "./CircuitBreakerExtension";
