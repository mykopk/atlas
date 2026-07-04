/**
 * @fileoverview Configuration Merger for @myko/atlas-client package
 *
 * This module provides the ConfigMerger utility class responsible for deep merging
 * database configurations. It handles merging global database service configuration
 * with per-operation overrides to create resolved configurations for the adapter chain.
 *
 * Part of the @myko/atlas-client package - a TypeScript database abstraction layer with
 * support for multiple adapters (Drizzle, Supabase, SQL), extensions (audit, encryption,
 * soft delete), and advanced features (caching, read replicas, multi-tenancy).
 */

import { NUMERIX } from "@myko/config";
import type {
  DatabaseServiceConfig,
  DBCacheConfig,
  DBEncryptionConfig,
  OperationConfig,
  ResolvedOperationConfig,
  SoftDeleteConfig,
  TimestampsConfig,
} from "@myko/types/db";

/**
 *  CONFIG MERGER - Configuration Resolution Engine
 *
 * Utility class for deep merging database configurations.
 * Handles merging global database service configuration with per-operation overrides
 *
 * Application Flow Position:**
 * DatabaseService → **ConfigMerger** → Resolved Config → Adapter Chain
 *
 * **What this class does:**
 * 1. Receives global config (from createDatabaseService) and operation config (from method calls)
 * 2. Deep merges nested objects (encryption, softDelete, cache, etc.)
 * 3. Operation config takes precedence over global config
 * 4. Returns resolved configuration for adapter chain
 *
 * **Called by:** DatabaseService methods (get, create, update, delete, etc.)
 * **Calls:** Internal merge methods for each config section
 * **Returns to:** DatabaseService for delegation to adapter chain
 *
 * **Merge Strategy:**
 * - Operation config overrides global config
 * - Nested objects are deep merged (not replaced)
 * - Arrays use replace strategy for fields, concat for others
 * - Undefined values in operation config fall back to global defaults
 *
 * @example
 * ### Configuration Merging Flow
 * ```typescript
 * // Global config (from createDatabaseService)
 * const globalConfig = {
 *   softDelete: { enabled: true, field: 'deletedAt' },
 *   cache: { enabled: true, ttl: 300 }
 * };
 *
 * // Operation config (from method call)
 * const operationConfig = {
 *   cache: { enabled: false },
 *   includeSoftDeleted: true
 * };
 *
 * // ConfigMerger.mergeConfigs() produces:
 * const resolved = {
 *   softDelete: { enabled: true, field: 'deletedAt' }, // From global
 *   cache: { enabled: false, ttl: 300 },               // Merged
 *   includeSoftDeleted: true,                          // From operation
 *   skipAudit: false                                   // Default
 * };
 * ```
 */
export class ConfigMerger {
  /**
   * Merges global database configuration with operation-specific overrides
   *
   * This is the main entry point for configuration resolution in the DatabaseService.
   * It performs deep merging of nested configuration objects while preserving type safety
   * and applying proper precedence rules.
   *
   * **Merge Precedence (highest to lowest):**
   * 1. Operation-specific config (method-level overrides)
   * 2. Global service config (from createDatabaseService)
   * 3. Default values (built-in fallbacks)
   *
   * **Configuration Sections Merged:**
   * - softDelete: Logical deletion settings
   * - encryption: Field-level encryption settings
   * - cache: Caching behavior and TTL
   * - timestamps: Automatic timestamp management
   * - Operation flags: skipAudit, includeSoftDeleted, etc.
   *
   * @param {DatabaseServiceConfig} global - Global database service configuration from createDatabaseService()
   * @param {OperationConfig} [operation] - Optional operation-specific configuration overrides
   * @returns {ResolvedOperationConfig} Fully resolved configuration with all defaults applied
   *
   * @example
   * ```typescript
   * // In DatabaseService.get() method
   * const resolvedConfig = ConfigMerger.mergeConfigs(
   *   this.globalConfig,  // From createDatabaseService
   *   operationConfig     // From method parameter
   * );
   *
   * // Example global config
   * const globalConfig = {
   *   softDelete: { enabled: true, field: 'deletedAt' },
   *   encryption: { enabled: true, fields: { users: ['ssn'] } },
   *   cache: { enabled: true, ttl: 300 }
   * };
   *
   * // Example operation config (disable cache for this operation)
   * const operationConfig = {
   *   cache: { enabled: false },
   *   skipAudit: true
   * };
   *
   * // Resulting merged config
   * const result = {
   *   softDelete: { enabled: true, field: 'deletedAt' },     // From global
   *   encryption: { enabled: true, fields: { users: ['ssn'] } }, // From global
   *   cache: { enabled: false, ttl: 300 },                   // Merged (enabled overridden)
   *   timestamps: undefined,                                  // Not specified
   *   skipAudit: true,                                        // From operation
   *   includeSoftDeleted: false,                             // Default
   *   forceAdapter: undefined,                               // Not specified
   *   timeout: 30000                                         // Default
   * };
   * ```
   *
   */
  static mergeConfigs(
    global: DatabaseServiceConfig,
    operation?: OperationConfig,
  ): ResolvedOperationConfig {
    if (!operation) {
      return this.convertGlobalToResolved(global);
    }

    return {
      softDelete: this.mergeSoftDeleteConfig(
        global.softDelete,
        operation.softDelete,
      ),
      encryption: this.mergeEncryptionConfig(
        global.encryption,
        operation.encryption,
      ),
      cache: this.mergeCacheConfig(global.cache, operation.cache),
      timestamps: this.mergeTimestampsConfig(
        global.timestamps,
        operation.timestamps,
      ),
      skipAudit: operation.skipAudit ?? false,
      includeSoftDeleted: operation.includeSoftDeleted ?? false,
      forceAdapter: operation.forceAdapter,
      timeout: operation.timeout ?? NUMERIX.THIRTY_THOUSAND,
    };
  }

  /**
   * Merges soft delete configuration with operation-specific overrides
   *
   * Handles deep merging of soft delete settings, allowing operation-level
   * overrides while preserving base configuration values.
   *
   * @private
   * @param {SoftDeleteConfig} [base] - Base soft delete configuration from global config
   * @param {Partial<SoftDeleteConfig>} [override] - Operation-specific soft delete overrides
   * @returns {SoftDeleteConfig | undefined} Merged soft delete configuration or undefined if neither provided
   *
   * @example
   * ```typescript
   * // Base config: { enabled: true, field: 'deletedAt', excludeTables: ['logs'] }
   * // Override: { enabled: false }
   * // Result: { enabled: false, field: 'deletedAt', excludeTables: ['logs'] }
   * ```
   *
   */
  private static mergeSoftDeleteConfig(
    base?: SoftDeleteConfig,
    override?: Partial<SoftDeleteConfig>,
  ): SoftDeleteConfig | undefined {
    if (!base && !override) return undefined;
    if (!override) return { ...base } as SoftDeleteConfig | undefined;
    if (!base) return { ...override } as SoftDeleteConfig;

    return {
      enabled: override.enabled ?? base.enabled,
      field: override.field ?? base.field,
      excludeTables: override.excludeTables ?? base.excludeTables,
    };
  }

  /**
   * Merges encryption configuration with operation-specific overrides
   *
   * Handles deep merging of field-level encryption settings, allowing operation-level
   * overrides for encryption behavior while preserving base configuration.
   *
   * @private
   * @param {DBEncryptionConfig} [base] - Base encryption configuration from global config
   * @param {Partial<DBEncryptionConfig>} [override] - Operation-specific encryption overrides
   * @returns {DBEncryptionConfig | undefined} Merged encryption configuration or undefined if neither provided
   *
   * @example
   * ```typescript
   * // Base config: { enabled: true, key: 'base64key', fields: { users: ['ssn'] } }
   * // Override: { enabled: false }
   * // Result: { enabled: false, key: 'base64key', fields: { users: ['ssn'] } }
   * ```
   *
   */
  // eslint-disable-next-line complexity
  private static mergeEncryptionConfig(
    base?: DBEncryptionConfig,
    override?: Partial<DBEncryptionConfig>,
  ): DBEncryptionConfig | undefined {
    if (!base && !override) return undefined;
    if (!override) return { ...base } as DBEncryptionConfig | undefined;
    if (!base) return { ...override } as DBEncryptionConfig;

    return {
      enabled: override.enabled ?? base.enabled,
      key: override.key ?? base.key,
      fields: override.fields ?? base.fields,
      algorithm: override.algorithm ?? base.algorithm,
      useDatabaseNative: override.useDatabaseNative ?? base.useDatabaseNative,
    };
  }

  /**
   * Merges cache configuration with operation-specific overrides
   * 
   * Handles deep merging of caching settings, allowing operation-level
   * overrides for cache behavior (enable/disable, TTL changes, etc.).
   * 
   * @private
   * @param {DBCacheConfig} [base] - Base cache configuration from global config
   * @param {Partial<DBCacheConfig>} [override] - Operation-specific cache overrides
   * @returns {DBCacheConfig | undefined} Merged cache configuration or undefined if neither provided
   * 
   * @example
   * ```typescript
   * // Base config: { enabled: true, ttl: 300, provider: 'redis' }
   * // Override: { enabled: false }
   * // Result: { enabled: false, ttl: 300, provider: 'redis' }
   * ```
   * 

   */
  // eslint-disable-next-line complexity
  private static mergeCacheConfig(
    base?: DBCacheConfig,
    override?: Partial<DBCacheConfig>,
  ): DBCacheConfig | undefined {
    if (!base && !override) return undefined;
    if (!override) return { ...base } as DBCacheConfig | undefined;
    if (!base) return { ...override } as DBCacheConfig;

    return {
      enabled: override.enabled ?? base.enabled,
      ttl: override.ttl ?? base.ttl,
      provider: override.provider ?? base.provider,
      invalidation: override.invalidation ?? base.invalidation,
    };
  }

  /**
   * Merges timestamps configuration with operation-specific overrides
   *
   * Handles deep merging of automatic timestamp settings, allowing operation-level
   * overrides for timestamp field names and auto-update behavior.
   *
   * @private
   * @param {TimestampsConfig} [base] - Base timestamps configuration from global config
   * @param {Partial<TimestampsConfig>} [override] - Operation-specific timestamp overrides
   * @returns {TimestampsConfig | undefined} Merged timestamps configuration or undefined if neither provided
   *
   * @example
   * ```typescript
   * // Base config: { enabled: true, createdAtField: 'createdAt', updatedAtField: 'updatedAt' }
   * // Override: { autoUpdate: false }
   * // Result: { enabled: true, createdAtField: 'createdAt', updatedAtField: 'updatedAt', autoUpdate: false }
   * ```
   */
  // eslint-disable-next-line complexity
  private static mergeTimestampsConfig(
    base?: TimestampsConfig,
    override?: Partial<TimestampsConfig>,
  ): TimestampsConfig | undefined {
    if (!base && !override) return undefined;
    if (!override) return { ...base } as TimestampsConfig | undefined;
    if (!base) return { ...override } as TimestampsConfig;

    return {
      enabled: override.enabled ?? base.enabled,
      createdAtField: override.createdAtField ?? base.createdAtField,
      updatedAtField: override.updatedAtField ?? base.updatedAtField,
      autoUpdate: override.autoUpdate ?? base.autoUpdate,
    };
  }

  /**
   * Converts global database service configuration to resolved operation configuration
   *
   * Used when no operation-specific overrides are provided. Applies default values
   * for operation-specific flags while preserving global configuration settings.
   *
   * @private
   * @param {DatabaseServiceConfig} global - Global database service configuration
   * @returns {ResolvedOperationConfig} Resolved configuration with defaults applied
   *
   * @example
   * ```typescript
   * // Global config: { softDelete: { enabled: true }, cache: { enabled: true, ttl: 300 } }
   * // Result: {
   * //   softDelete: { enabled: true },
   * //   cache: { enabled: true, ttl: 300 },
   * //   skipAudit: false,           // Default
   * //   includeSoftDeleted: false, // Default
   * //   timeout: 30000            // Default
   * // }
   * ```
   *
   */
  private static convertGlobalToResolved(
    global: DatabaseServiceConfig,
  ): ResolvedOperationConfig {
    return {
      softDelete: global?.softDelete ? { ...global.softDelete } : undefined,
      encryption: global?.encryption ? { ...global.encryption } : undefined,
      cache: global?.cache ? { ...global.cache } : undefined,
      timestamps: global?.timestamps ? { ...global.timestamps } : undefined,
      skipAudit: false,
      includeSoftDeleted: false,
      timeout: NUMERIX.THIRTY_THOUSAND,
    };
  }
}
