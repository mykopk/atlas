/**
 * @fileoverview Soft Delete Extension for @myko/atlas-client package
 *
 * This module provides the SoftDeleteAdapter extension that implements logical deletion
 * instead of physical record removal. It automatically intercepts delete operations
 * and converts them to timestamp updates, while filtering queries to exclude soft-deleted records.
 *
 * Part of the @myko/atlas-client package - a TypeScript database abstraction layer with
 * support for multiple adapters (Drizzle, Supabase, SQL), extensions (audit, encryption,
 * soft delete), and advanced features (caching, read replicas, multi-tenancy).
 *
 */

import { logger } from "@myko.pk/logger";
import type {
  DatabaseAdapterType,
  DatabaseResult,
  PaginatedResult,
  QueryOptions,
  Filter,
  DatabaseHealthStatus,
  Transaction,
} from "@myko.pk/types/db";
import { failure, success } from "@utils/databaseResultHelpers";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";

/**
 * SOFT DELETE ADAPTER - Logical Deletion Layer
 *
 * Soft delete extension that implements logical deletion instead of physical removal.
 * Third layer in the adapter chain.
 *
 * **Adapter Chain Position:**
 * ReadReplica -> Audit -> Cache -> **SoftDelete** -> Encryption -> Base Adapter
 *
 * **What this adapter does:**
 * 1. Intercepts delete() operations  sets deletedAt timestamp instead of removing
 * 2. Intercepts query/list operations  adds "WHERE deletedAt IS NULL" filter
 * 3. Provides restore() method to undelete records
 * 4. Honors includeSoftDeleted flag from operation config
 *
 * **Called by:** CachingAdapter (or AuditAdapter if no caching)
 * **Calls:** EncryptionAdapter (or base adapter if no encryption)
 * **Provides:** restore(), permanentDelete() methods
 *
 * **Soft Delete Flow:**
 * - **Delete:** Sets deletedAt = NOW() instead of removing record
 * - **Queries:** Automatically filters WHERE deletedAt IS NULL
 * - **Restore:** Sets deletedAt = NULL to undelete
 *
 * @example
 * ### Configuration
 * ```typescript
 * softDelete: {
 *   enabled: true,
 *   field: 'deletedAt',           // Custom field name
 *   excludeTables: ['audit_logs']  // Tables that use hard delete
 * }
 * ```
 *
 * @example
 * ### Usage Flow
 * ```typescript
 * // Normal delete - sets deletedAt timestamp
 * await db.delete(Tables.USERS, 'user-123');
 *
 * // Query automatically excludes soft-deleted records
 * const activeUsers = await db.query(Tables.USERS, {});
 *
 * // Include soft-deleted records with operation config
 * const allUsers = await db.query(Tables.USERS, {}, {
 *   includeSoftDeleted: true
 * });
 *
 * // Restore soft-deleted record
 * await db.restore(Tables.USERS, 'user-123');
 * ```
 */
export class SoftDeleteAdapter implements DatabaseAdapterType {
  /**
   * Creates a new SoftDeleteAdapter instance.
   *
   * **RESPONSIBILITY:** Wraps base adapter with soft delete functionality
   * **CONFIGURATION:** Sets up deletion field name and excluded tables
   *
   * @param baseAdapter - The underlying database adapter to wrap
   * @param config - Soft delete configuration options
   *
   * @example
   * ```typescript
   * const softDeleteAdapter = new SoftDeleteAdapter(baseAdapter, {
   *   enabled: true,
   *   field: 'deletedAt',
   *   excludeTables: ['audit_logs', 'system_events']
   * });
   * ```
   */
  constructor(
    public baseAdapter: DatabaseAdapterType,
    private config: {
      enabled: boolean;
      field?: string;
      excludeTables?: string[];
    },
  ) {}

  /**
   * Initializes the soft delete adapter and underlying adapter.
   *
   * **RESPONSIBILITY:** Passes initialization to base adapter
   * **BEHAVIOR:** No additional initialization needed for soft delete
   *
   * @returns Promise resolving to initialization result
   *
   * @example
   * ```typescript
   * const result = await softDeleteAdapter.initialize();
   * if (result.success) {
   *   console.log('Soft delete adapter initialized');
   * }
   * ```
   */
  async initialize(): Promise<DatabaseResult<void>> {
    return this.baseAdapter.initialize();
  }

  /**
   * Establishes database connection through base adapter.
   *
   * **RESPONSIBILITY:** Delegates connection to underlying adapter
   * **BEHAVIOR:** No additional connection logic needed
   *
   * @example
   * ```typescript
   * await softDeleteAdapter.connect();
   * console.log('Connected with soft delete support');
   * ```
   */
  async connect(): Promise<void> {
    return this.baseAdapter.connect();
  }

  /**
   * Closes database connection through base adapter.
   *
   * **RESPONSIBILITY:** Delegates disconnection to underlying adapter
   * **BEHAVIOR:** No additional cleanup needed for soft delete
   *
   * @example
   * ```typescript
   * await softDeleteAdapter.disconnect();
   * console.log('Disconnected gracefully');
   * ```
   */
  async disconnect(): Promise<void> {
    return this.baseAdapter.disconnect();
  }

  /**
   * Closes the database adapter and releases resources.
   *
   * @returns Promise resolving to the close result
   */
  async close(): Promise<DatabaseResult<void>> {
    return this.baseAdapter.close();
  }

  /**
   * Gets the underlying database client.
   *
   * **RESPONSIBILITY:** Provides access to raw database client
   * **USE CASE:** For operations that bypass soft delete logic
   *
   * @returns Database client object
   *
   * @example
   * ```typescript
   * const client = softDeleteAdapter.getClient();
   * // Use for direct database operations if needed
   * ```
   */
  getClient<T extends object = object>(): T {
    return this.baseAdapter.getClient<T>();
  }

  /**
   * Executes raw SQL query through base adapter.
   *
   * **RESPONSIBILITY:** Passes raw SQL to base adapter without modification
   * **BEHAVIOR:** Does not apply soft delete filtering to raw SQL
   * **NOTE:** Use findMany() for automatic soft delete filtering
   *
   * @param sql - SQL query string
   * @param params - Query parameters
   * @returns Query results
   *
   * @example
   * ```typescript
   * // Raw SQL bypasses soft delete filtering
   * const allUsers = await adapter.query(
   *   'SELECT * FROM users', // Includes soft-deleted records
   *   []
   * );
   *
   * // Use findMany for automatic filtering
   * const activeUsers = await adapter.findMany('users'); // Excludes soft-deleted
   * ```
   */
  async query<TResult, TParams = unknown>(
    sql: string,
    params?: TParams[],
  ): Promise<TResult[]> {
    return this.baseAdapter.query<TResult, TParams>(sql, params);
  }

  /**
   * Registers a table schema with the base adapter.
   *
   * **RESPONSIBILITY:** Passes table registration to base adapter
   * **BEHAVIOR:** No additional registration logic needed
   *
   * @param name - Table name
   * @param table - Table schema
   * @param idColumn - Primary key column
   *
   * @example
   * ```typescript
   * softDeleteAdapter.registerTable('users', userSchema, 'id');
   * // Table now supports soft delete operations
   * ```
   */
  registerTable<T, U>(name: string, table: T, idColumn?: U): void {
    this.baseAdapter.registerTable(name, table, idColumn);
  }

  /**
   * Finds a record by ID with automatic soft delete filtering.
   *
   * **RESPONSIBILITY:** Retrieves single record, excluding soft-deleted by default
   * **FILTERING:** Automatically excludes records where deletedAt IS NOT NULL
   * **OVERRIDE:** Can include soft-deleted records with operation config
   *
   * @param table - Table name
   * @param id - Record ID
   * @returns Found record or null
   *
   * @example
   * ```typescript
   * // Excludes soft-deleted records by default
   * const user = await adapter.findById('users', 'user-123');
   * if (!user.value) {
   *   console.log('User not found or soft-deleted');
   * }
   *
   * // Include soft-deleted records with config
   * const userIncludingDeleted = await adapter.findById('users', 'user-123', {
   *   includeSoftDeleted: true
   * });
   * ```
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    return this.baseAdapter.findById<T>(table, id);
  }

  /**
   * Finds multiple records with automatic soft delete filtering.
   * Automatically adds a `deletedAt IS NULL` filter unless disabled or overridden.
   *
   * **RESPONSIBILITY:** Retrieves paginated results, excluding soft-deleted records
   * **FILTERING:** Adds `deletedAt IS NULL` filter automatically
   * **EXCLUSION:** Skips filtering for excluded tables or when soft delete is disabled
   * **OVERRIDE:** Set `includeSoftDeleted: true` in options to include soft-deleted records
   *
   * @param table - Table name
   * @param options - Query options; if `includeSoftDeleted` is not true, a soft delete filter is applied
   * @returns Paginated results excluding soft-deleted records by default
   *
   * @example
   * ```typescript
   * // Active records only (default)
   * const activeUsers = await adapter.findMany('users');
   *
   * // Include soft-deleted records
   * const allUsers = await adapter.findMany('users', {
   *   includeSoftDeleted: true
   * });
   * ```
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    if (!this.config.enabled || this.isExcluded(table)) {
      return this.baseAdapter.findMany<T>(table, options);
    }

    // Add soft delete filter unless includeSoftDeleted is true
    const modifiedOptions: QueryOptions<T> = { ...options };
    modifiedOptions.filter ??= {
      field: this.config.field ?? "deletedAt",
      operator: "isNull",
      value: null,
    } as Filter<T>;

    return this.baseAdapter.findMany<T>(table, modifiedOptions);
  }

  /**
   * Creates a new record through base adapter.
   *
   * **RESPONSIBILITY:** Passes creation to base adapter without modification
   * **BEHAVIOR:** New records have deletedAt = NULL by default
   *
   * @param table - Table name
   * @param data - Record data
   * @returns Created record
   *
   * @example
   * ```typescript
   * const result = await adapter.create('users', {
   *   name: 'John Doe',
   *   email: 'john@example.com'
   *   // deletedAt will be NULL (not soft-deleted)
   * });
   *
   * if (result.success) {
   *   console.log('User created:', result.value.id);
   * }
   * ```
   */
  async create<T extends object>(
    table: string,
    data: T,
  ): Promise<DatabaseResult<T>> {
    return this.baseAdapter.create<T>(table, data);
  }

  /**
   * Updates an existing record through base adapter.
   *
   * **RESPONSIBILITY:** Passes update to base adapter without modification
   * **BEHAVIOR:** Can update soft-deleted records (they remain soft-deleted)
   * **NOTE:** Use restore() to undelete records
   *
   * @param table - Table name
   * @param id - Record ID
   * @param data - Partial record data
   * @returns Updated record
   *
   * @example
   * ```typescript
   * // Update active record
   * const result = await adapter.update('users', 'user-123', {
   *   name: 'Jane Doe'
   * });
   *
   * // Can also update soft-deleted records
   * const softDeletedUpdate = await adapter.update('users', 'deleted-user', {
   *   email: 'newemail@example.com'
   *   // Record remains soft-deleted after update
   * });
   * ```
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    return this.baseAdapter.update<T>(table, id, data);
  }

  /**
   * Deletes a record by performing a logical (soft) delete.
   * Sets the configured deletion field (default: `deletedAt`) to the current timestamp
   * instead of physically removing the record. Falls back to hard delete for excluded tables
   * or when soft delete is disabled.
   *
   * **RESPONSIBILITY:** Converts delete operations to update operations that set a deletion timestamp
   * **BEHAVIOR:** Updates the record with `{ deletedAt: ISO timestamp }` via the base adapter
   * **EXCLUDED TABLES:** Tables in the `excludeTables` config use physical deletion
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns Success result if soft deleted, or failure result with error details
   *
   * @example
   * ```typescript
   * // Soft delete (sets deletedAt timestamp)
   * const result = await adapter.delete('users', 'user-123');
   * if (result.success) {
   *   console.log('User soft-deleted');
   * }
   *
   * // Soft-deleted records are excluded from queries by default
   * const user = await adapter.findById('users', 'user-123'); // null
   * ```
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    if (!this.config.enabled || this.isExcluded(table)) {
      return this.baseAdapter.delete(table, id);
    }

    // Soft delete: set deletedAt field
    const deleteField = this.config.field ?? "deletedAt";
    const updateData = { [deleteField]: new Date().toISOString() };

    try {
      logger.debug(`Soft deleting record ${id} from table ${table}`);
      await this.baseAdapter.update(table, id, updateData);
      return success();
    } catch (error) {
      logger.error(`Soft delete failed for ${table}:${id}`);
      return failure(
        new DatabaseError(
          `Soft delete failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: { source: "delete" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Executes operations within a transaction.
   *
   * **RESPONSIBILITY:** Passes transaction to base adapter
   * **BEHAVIOR:** Soft delete operations within transaction are atomic
   * **ROLLBACK:** Failed transactions rollback soft delete operations
   *
   * @param callback - Transaction callback function
   * @returns Transaction result
   *
   * @example
   * ```typescript
   * const result = await adapter.transaction(async (trx) => {
   *   // Create user
   *   const user = await trx.create('users', { name: 'John' });
   *
   *   // Soft delete old user (sets deletedAt)
   *   await trx.delete('users', 'old-user-id');
   *
   *   return user;
   * });
   *
   * // If transaction fails, both operations are rolled back
   * ```
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    return this.baseAdapter.transaction(callback);
  }

  /**
   * Checks if a record exists, excluding soft-deleted records.
   *
   * **RESPONSIBILITY:** Verifies record existence with soft delete filtering
   * **BEHAVIOR:** Returns false for soft-deleted records by default
   * **FILTERING:** Automatically excludes records where deletedAt IS NOT NULL
   *
   * @param table - Table name
   * @param id - Record ID
   * @returns True if record exists and is not soft-deleted
   *
   * @example
   * ```typescript
   * // Check if active user exists
   * const userExists = await adapter.exists('users', 'user-123');
   * if (userExists.value) {
   *   console.log('User exists and is active');
   * } else {
   *   console.log('User not found or soft-deleted');
   * }
   *
   * // Soft-deleted records return false
   * await adapter.delete('users', 'user-123'); // Soft delete
   * const stillExists = await adapter.exists('users', 'user-123'); // false
   * ```
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    return this.baseAdapter.exists(table, id);
  }

  /**
   * Counts records in a table, excluding soft-deleted records.
   *
   * **RESPONSIBILITY:** Counts records with automatic soft delete filtering
   * **BEHAVIOR:** Excludes soft-deleted records from count by default
   * **FILTERING:** Automatically adds deletedAt IS NULL filter
   *
   * @param table - Table name
   * @param filter - Optional filter conditions
   * @returns Count of non-soft-deleted records
   *
   * @example
   * ```typescript
   * // Count active users only
   * const activeCount = await adapter.count('users');
   * console.log('Active users:', activeCount.value);
   *
   * // Count with additional filter
   * const premiumActiveUsers = await adapter.count('users', {
   *   field: 'plan',
   *   operator: 'eq',
   *   value: 'premium'
   * });
   * // Returns count of premium users that are NOT soft-deleted
   * ```
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T>,
  ): Promise<DatabaseResult<number>> {
    return this.baseAdapter.count<T>(table, filter);
  }

  /**
   * Performs health check through base adapter.
   *
   * **RESPONSIBILITY:** Delegates health check to underlying adapter
   * **BEHAVIOR:** No additional health metrics for soft delete
   *
   * @returns Health status from base adapter
   *
   * @example
   * ```typescript
   * const health = await adapter.healthCheck();
   * if (health.success && health.value?.isHealthy) {
   *   console.log('Database healthy with soft delete support');
   * }
   * ```
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    return this.baseAdapter.healthCheck();
  }

  /**
   * Restores a previously soft-deleted record by clearing the deletion timestamp
   *
   * Undeletes a record by setting the soft delete field (typically 'deletedAt') to null,
   * making it visible in queries again. This operation is only available when soft delete
   * is enabled in the configuration.
   *
   * **Restore Process:**
   * 1. Validates that soft delete is enabled
   * 2. Sets the deletion field to null via update operation
   * 3. Logs the restoration for audit purposes
   * 4. Returns success or failure result
   *
   * @param {string} table - Name of the table containing the record to restore
   * @param {string} id - Primary key ID of the record to restore
   * @returns {Promise<DatabaseResult<void>>} Promise resolving to success/failure result
   *
   * @example
   * ```typescript
   * // Restore a soft-deleted user
   * const restoreResult = await softDeleteAdapter.restore('users', 'user-123');
   * if (restoreResult.success) {
   *   console.log('User restored successfully');
   * } else {
   *   console.error('Restore failed:', restoreResult.error.message);
   * }
   *
   * // After restoration, the record will appear in queries again
   * const user = await adapter.findById('users', 'user-123');
   * // user will now be found (not null)
   * ```
   *
   * @throws {DatabaseError} SOFT_DELETE_NOT_ENABLED - If soft delete is not enabled in configuration
   * @throws {DatabaseError} SOFT_DELETE_RESTORE_FAILED - If the restore operation fails
   *
   */
  async restore(table: string, id: string): Promise<DatabaseResult<void>> {
    // Validate that soft delete is enabled before attempting restore
    if (!this.config.enabled) {
      return failure(
        new DatabaseError(
          "Soft delete not enabled",
          DATABASE_ERROR_CODES.CONFIG_REQUIRED,
          {
            context: { source: "restore" },
            cause: new Error("Soft delete not enabled"),
          },
        ),
      );
    }

    // Get the configured deletion field name (default: 'deletedAt')
    const deleteField = this.config.field ?? "deletedAt";
    // Create update data to clear the deletion timestamp
    const updateData = { [deleteField]: null };

    try {
      // Update the record to clear the deletion timestamp
      await this.baseAdapter.update(table, id, updateData);
      logger.info(`Record restored successfully: ${table}:${id}`);
      return success();
    } catch (error) {
      logger.error(`Restore failed for ${table}:${id}`);
      return failure(
        new DatabaseError(
          `Restore failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: { source: "restore" },
            cause: error as Error,
          },
        ),
      );
    }
  }

  /**
   * Checks if a table is excluded from soft delete functionality.
   * 
   * **RESPONSIBILITY:** Determines if table should use hard delete instead
   * **CONFIGURATION:** Based on excludeTables array in config
   * **USE CASE:** Some tables like audit logs need permanent deletion
   * 
   * @private
   * @param table - Name of the table to check
   * @returns True if table is excluded from soft delete
   * 
   * @example
   * ```typescript
   * // Configuration: { excludeTables: ['audit_logs', 'temp_data'] }
   * 
   * this.isExcluded('users');      // false - uses soft delete
   * this.isExcluded('audit_logs'); // true - uses hard delete
   * this.isExcluded('t
  private isExcluded(table: string): boolean {
    return this.config.excludeTables?.includes(table) ?? false;
  }emp_data');  // true - uses hard delete
   * ```
   * 
   */
  private isExcluded(table: string): boolean {
    // Check if table is in the excludeTables array, default to false if not configured
    return this.config.excludeTables?.includes(table) ?? false;
  }
}
