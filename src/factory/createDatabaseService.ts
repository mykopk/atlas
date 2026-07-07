/**
 * DATABASE SERVICE FACTORY - Main Entry Point
 *
 * This file is responsible for creating fully configured database services with extension chains.
 * It implements the decorator pattern to wrap base adapters with feature extensions.
 *
 * **RESPONSIBILITIES:**
 * 1. Config Validation - Ensures valid configuration before proceeding
 * 2. Base Adapter Creation - Creates core database adapters (Supabase/SQL/Mock)
 * 3. Adapter Chain Building - Wraps adapters with extensions in correct order
 * 4. Service Assembly - Creates final DatabaseService with all components
 * 5. Initialization - Establishes database connections and readiness
 *
 * **ADAPTER CHAIN ORDER:**
 * Base → Encryption → SoftDelete → Caching → Audit
 * (innermost to outermost - each wraps the previous)
 */

import { DatabaseService } from "../service/DatabaseService";
import { AdapterFactory } from "./AdapterFactory";
import { SoftDeleteAdapter } from "../extensions/SoftDeleteExtension";
import { AuditAdapter } from "../extensions/AuditExtension";
import { EncryptionAdapter } from "../extensions/EncryptionExtension";
import { CachingAdapter } from "../extensions/CachingAdapter";
import { ReadReplicaAdapter } from "../extensions/ReadReplicaAdapter";
import { MultiWriteAdapter } from "../extensions/MultiWriteExtension";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";
import { ADAPTER_TYPES, ADAPTERS } from "@myko.pk/types/db";
import type {
  DatabaseServiceInterface,
  DrizzleConfig,
  SqlConfig,
  SupabaseConfig,
  PrismaConfig,
  DatabaseAdapterType,
  DatabaseConfig,
  DatabaseServiceConfig,
} from "@myko.pk/types/db";

/**
 * ADAPTER CHAIN BUILDER - Decorator Pattern Implementation
 *
 * **RESPONSIBILITY:** Wraps base adapter with extension layers in correct order
 * **PATTERN:** Decorator - each adapter wraps the previous, adding functionality
 * **ORDER:** Base → Encryption → SoftDelete → Caching → Audit
 *
 * **WHY THIS ORDER:**
 * 1. Encryption (innermost) - Encrypts data before storage, decrypts after retrieval
 * 2. SoftDelete - Handles logical deletion, works on encrypted data
 * 3. Caching - Caches processed data (after encryption/soft-delete logic)
 * 4. Audit (outermost) - Logs final operations (after all data processing)
 *
 * @param baseAdapter - The core database adapter (Supabase/SQL/Mock)
 * @param config - Configuration specifying which extensions to enable
 * @returns Fully wrapped adapter with all enabled extensions
 *
 * @example
 * ```typescript
 * // Creates: AuditAdapter(CachingAdapter(EncryptionAdapter(SupabaseAdapter)))
 * const wrappedAdapter = buildAdapterChain(baseAdapter, {
 *   encryption: { enabled: true, key: 'secret', fields: { users: ['ssn'] } },
 *   softDelete: { enabled: true, field: 'deletedAt' },
 *   audit: { enabled: true, retentionDays: 90 }
 * });
 * ```
 */
// eslint-disable-next-line complexity
function buildAdapterChain(
  baseAdapter: DatabaseAdapterType,
  config: DatabaseServiceConfig,
): DatabaseAdapterType {
  let adapter: DatabaseAdapterType = baseAdapter;

  // Layer 1: Encryption (innermost after base)
  // RESPONSIBILITY: Encrypts sensitive fields before storage, decrypts on retrieval
  // WHEN: Always applied first to ensure data is encrypted at rest
  if (config.encryption?.enabled) {
    adapter = new EncryptionAdapter(adapter, config.encryption);
  }

  // Layer 2: Soft Delete
  // RESPONSIBILITY: Converts DELETE operations to UPDATE (sets deletedAt), filters soft-deleted records
  // WHEN: Applied after encryption so deletion logic works on encrypted data
  if (config.softDelete?.enabled) {
    adapter = new SoftDeleteAdapter(adapter, config.softDelete);
  }

  // Layer 3: Caching
  // RESPONSIBILITY: Stores query results in memory/Redis, invalidates on writes
  // WHEN: Applied after data processing to cache final processed results
  if (config.cache?.enabled) {
    adapter = new CachingAdapter(adapter, config.cache);
  }

  // Layer 4: Audit
  // RESPONSIBILITY: Logs all database operations for compliance and tracking
  // WHEN: Applied late in chain to capture final operation details
  if (config.audit?.enabled) {
    adapter = new AuditAdapter(adapter, {
      ...config.audit,
      // Pass encrypted fields config so audit can log which fields are encrypted at rest
      encryptedFields: config.encryption?.enabled
        ? config.encryption.fields
        : undefined,
    });
  }

  // Layer 5: Multi-Write (writes are replicated to secondary adapters)
  // RESPONSIBILITY: Replicates all writes to secondary databases
  // WHEN: Applied after all data processing so secondaries get processed data
  if (config.multiWrite?.enabled && config.multiWrite.adapters.length > 0) {
    adapter = new MultiWriteAdapter(adapter, config.multiWrite);
  }

  // Layer 6: Read Replica (read operations are routed to replicas)
  // RESPONSIBILITY: Routes read queries to replica databases, writes go to primary
  // WHEN: Outermost — catches read operations before any other processing
  if (config.readReplica?.enabled && config.readReplica.replicas.length > 0) {
    adapter = new ReadReplicaAdapter(adapter, config.readReplica);
  }

  return adapter;
}

/**
 * CONFIG TRANSFORMER - Converts External to Internal Format
 *
 * **RESPONSIBILITY:** Transforms user-friendly config into internal adapter factory format
 * **WHY NEEDED:** External config is user-friendly, internal config is adapter-specific
 *
 * **TRANSFORMATIONS:**
 * - Maps adapter names to internal constants
 * - Extracts connection details from nested config
 * - Normalizes different config formats (connectionString vs url)
 * - Sets up adapter-specific options (pool, SSL, etc.)
 *
 * @param config - User-provided database service configuration
 * @returns Normalized configuration for AdapterFactory.create()
 */
function createAdapterConfig(config: DatabaseServiceConfig): DatabaseConfig {
  // Supabase Adapter Config - Supabase API integration
  if (config.adapter === ADAPTER_TYPES.SUPABASE) {
    const supabaseConfig = config.config as SupabaseConfig;
    return {
      adapter: ADAPTERS.SUPABASE,
      supabaseUrl: supabaseConfig.supabaseUrl, // Supabase project URL
      supabaseAnonKey: supabaseConfig.supabaseAnonKey, // Public API key
      supabaseServiceKey: supabaseConfig.supabaseServiceKey, // Service role key (admin)
      schema: supabaseConfig.schema, // Database schema
      tableIdColumns: supabaseConfig.tableIdColumns, // Custom ID column mappings
    };
  }

  // Mock Adapter Config - In-memory testing database
  if (config.adapter === ADAPTER_TYPES.MOCK) {
    return {
      adapter: ADAPTERS.MOCK,
      ...config.config, // Pass through all mock config options
    };
  }

  // Drizzle Adapter Config - PostgreSQL with Drizzle ORM
  if (config.adapter === ADAPTER_TYPES.DRIZZLE) {
    const drizzleConfig = config.config as DrizzleConfig;
    const userPool = drizzleConfig.pool;
    const pool = userPool
      ? {
          max: userPool.max,
          min: userPool.min,
          idleTimeoutMillis: userPool.idleTimeoutMs,
          connectionTimeoutMillis: userPool.acquireTimeoutMs,
        }
      : (drizzleConfig.poolSize ? { max: drizzleConfig.poolSize } : undefined);
    return {
      adapter: ADAPTERS.DRIZZLE,
      connectionString: drizzleConfig.connectionString ?? drizzleConfig.url,
      pool,
      tableIdColumns: drizzleConfig.tableIdColumns,
      logging: drizzleConfig.logging,
    };
  }

  // Prisma Adapter Config - Prisma ORM integration
  if (config.adapter === ADAPTER_TYPES.PRISMA) {
    const prismaConfig = config.config as PrismaConfig;
    return {
      adapter: ADAPTERS.PRISMA,
      client: prismaConfig.client,
      url: prismaConfig.url,
      prismaOptions: prismaConfig.prismaOptions,
      tableIdColumns: prismaConfig.tableIdColumns,
    };
  }

  // 🔧 Raw SQL Adapter Config - Direct SQL database connection
  const sqlConfig = config.config as SqlConfig;
  return {
    adapter: ADAPTERS.SQL,
    connectionString: sqlConfig.connectionString ?? sqlConfig.url, // Support both formats
    schema: sqlConfig.schema, // Default schema for all tables
    tableIdColumns: sqlConfig.tableIdColumns, // Custom ID column mappings
  };
}

/**
 * CONFIG VALIDATOR - Ensures Configuration Integrity
 *
 * **RESPONSIBILITY:** Validates user configuration before processing
 * **PREVENTS:** Runtime errors from invalid/missing configuration
 * **THROWS:** Descriptive validation errors for debugging
 *
 * **VALIDATION CHECKS:**
 * 1. Config object exists
 * 2. Adapter type is specified
 * 3. Adapter configuration is provided
 *
 * @param config - User-provided configuration to validate
 * @throws {DatabaseError} When configuration is invalid or incomplete
 */
function validateConfig(config: DatabaseServiceConfig): void {
  // Check: Configuration object exists
  if (!config) {
    throw new DatabaseError(
      "Database configuration is required",
      DATABASE_ERROR_CODES.CONFIG_REQUIRED,
      {
        context: { source: "validateConfig" },
        cause: new Error("Database configuration is required"),
      },
    );
  }

  // Check: Adapter type specified (supabase/sql/mock)
  if (!config.adapter) {
    throw new DatabaseError(
      "Database adapter type is required",
      DATABASE_ERROR_CODES.CONFIG_REQUIRED,
      {
        context: { source: "validateConfig" },
        cause: new Error("Database adapter type is required"),
      },
    );
  }

  // Check: Adapter-specific configuration provided
  if (!config.config) {
    throw new DatabaseError(
      "Adapter configuration is required",
      DATABASE_ERROR_CODES.CONFIG_REQUIRED,
      {
        context: { source: "validateConfig" },
        cause: new Error("Adapter configuration is required"),
      },
    );
  }
}

/**
 * INITIALIZE WITH RETRY - Exponential backoff for transient DB failures
 *
 * **RESPONSIBILITY:** Retries adapter initialization on failure with exponential backoff.
 * Handles transient issues like DB restarts, network glitches, or pool exhaustion.
 *
 * @param adapter - The database adapter to initialize
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param baseDelayMs - Initial delay between retries in ms (default: 1000)
 * @returns A DatabaseResult indicating success or the last failure
 */
async function initializeWithRetry(
  adapter: DatabaseAdapterType,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<{ success: boolean; error?: Error }> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await adapter.initialize();
    if (result.success) return { success: true };

    lastError = result.error ?? new Error("Unknown initialization error");
    if (attempt < maxRetries) {
      const delay = Math.min(baseDelayMs * 2 ** attempt, 10_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { success: false, error: lastError };
}

/**
 * MAIN FACTORY - Application Entry Point
 *
 * Creates a fully configured database service with extension chain.
 * This is the ONLY way applications should create database services.
 *
 * **Application Flow:**
 * 1. App calls createDatabaseService() at startup
 * 2. Factory validates config and creates base adapter (Supabase/SQL/Mock)
 * 3. Factory builds adapter chain: Base → Encryption → SoftDelete → Cache → Audit
 * 4. Factory creates DatabaseService with final wrapped adapter
 * 5. App uses returned DatabaseServiceInterface in repositories/services
 *
 * **What this function does:**
 * - Validates configuration using validateConfig()
 * - Creates base adapter via AdapterFactory.create()
 * - Builds decorator chain via buildAdapterChain()
 * - Initializes database connection
 * - Returns configured DatabaseService instance
 *
 * **Called by:** Application startup code (app.ts, main.ts)
 * **Calls:** validateConfig(), AdapterFactory.create(), buildAdapterChain(), DatabaseService constructor
 * **Returns to:** Application layer for injection into repositories
 *
 * @param config Complete database service configuration including adapter and extensions
 * @returns Promise resolving to configured DatabaseServiceInterface instance
 *
 * @throws {DatabaseError} When configuration is invalid or initialization fails
 *
 * @example
 * ### Basic Setup (app.ts)
 * ```typescript
 * import { createDatabaseService, Tables } from '@myko.pk/atlas-client';
 *
 * // Called once at application startup
 * const db = await createDatabaseService({
 *   adapter: 'supabase',
 *   config: { supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY }
 * });
 *
 * // Inject into services
 * const userService = new UserService(db);
 * ```
 *
 * @example
 * ### Production Configuration
 * ```typescript
 * const db = await createDatabaseService({
 *   adapter: 'supabase',
 *   config: {
 *     supabaseUrl: process.env.SUPABASE_URL,
 *     supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
 *     supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY
 *   },
 *
 *   // Extensions applied in order: Base → Encryption → SoftDelete → Cache → Audit
 *   encryption: {
 *     enabled: true,
 *     key: process.env.ENCRYPTION_KEY,
 *     fields: {
 *       [Tables.USERS]: ['ssn', 'taxId'],
 *       [Tables.PAYMENTS]: ['cardNumber', 'cvv']
 *     }
 *   },
 *
 *   softDelete: {
 *     enabled: true,
 *     field: 'deletedAt'
 *   },
 *
 *   audit: {
 *     enabled: true,
 *     retentionDays: 90,
 *     onAuditAfterWrite: async (event) => {
 *       await complianceService.recordAudit(event);
 *     }
 *   },
 *
 *   cache: {
 *     enabled: true,
 *     ttl: 300,
 *     invalidation: 'write'
 *   },
 *
 *   events: {
 *     onAfterWrite: async (event) => {
 *       await notificationService.send(event);
 *     }
 *   }
 * });
 * ```
 *
 * @example
 * @example
 * ### Testing Setup
 * ```typescript
 * // Use mock adapter for tests
 * const db = await createDatabaseService({
 *   adapter: 'mock',
 *   config: { logging: true }
 * });
 * ```
 */
export async function createDatabaseService(
  config: DatabaseServiceConfig,
): Promise<DatabaseServiceInterface> {
  try {
    // STEP 1: Validate Configuration
    // RESPONSIBILITY: Ensure config is complete and valid before proceeding
    validateConfig(config);

    // STEP 2: Create Base Adapter
    // RESPONSIBILITY: Transform config and create core database adapter (Supabase/SQL/Mock)
    const adapterConfig = createAdapterConfig(config); // Transform to internal format
    const baseAdapter = AdapterFactory.create(
      adapterConfig.adapter,
      adapterConfig,
    ); // Create adapter

    // STEP 3: Build Adapter Chain
    // RESPONSIBILITY: Wrap base adapter with enabled extensions in correct order
    const finalAdapter = buildAdapterChain(baseAdapter, config);

    // STEP 4: Create Database Service
    // RESPONSIBILITY: Assemble final service with wrapped adapter and configuration
    const service = new DatabaseService({
      adapter: finalAdapter, // Fully wrapped adapter chain
      globalConfig: config, // Original configuration for reference
      eventHandlers: config.events, // Event handlers for notifications
    });

    // STEP 5: Initialize Database Connection (with retry)
    // RESPONSIBILITY: Establish database connection and verify readiness.
    // Retries with exponential backoff for transient failures.
    const initResult = await initializeWithRetry(finalAdapter);
    if (!initResult.success) {
      throw new DatabaseError(
        `Failed to initialize adapter: ${initResult.error?.message ?? "Unknown error"}`,
        DATABASE_ERROR_CODES.INIT_FAILED,
        {
          context: { source: "createDatabaseService" },
          cause: initResult.error ?? new Error("Failed to initialize adapter"),
        },
      );
    }

    return service; // Return fully configured and initialized service
  } catch (error) {
    throw new DatabaseError(
      `Failed to create database service: ${(error as Error).message}`,
      DATABASE_ERROR_CODES.INIT_FAILED,
      {
        context: { source: "createDatabaseService" },
        cause: error as Error,
      },
    );
  }
}
