/**
 * @fileoverview Base Repository for @myko/atlas-client package
 *
 * This module provides the BaseRepository abstract class that serves as the foundation
 * for all domain-specific repositories in the @myko/atlas-client package. It provides type-safe
 * CRUD operations and consistent interface patterns.
 *
 */

import type {
  DatabaseResult,
  PaginatedResult,
  QueryOptions,
  Filter,
  DatabaseServiceInterface,
  CreateInput,
  OperationConfig,
  FindFirstOptions,
} from "@myko/types/db";
import { QueryBuilder } from "../builder/query/QueryBuilder";

/**
 * BASE REPOSITORY - Repository Layer Foundation
 *
 * Base repository providing common CRUD operations for domain entities.
 * All domain-specific repositories extend this class for type-safe database operations.
 *
 * **Application Flow Position:**
 * Service Layer → **Repository Layer** → DatabaseService → Adapter Chain
 *
 * **What this class provides:**
 * - Type-safe CRUD operations for domain entities
 * - Consistent interface across all repositories
 * - Delegation to DatabaseService with proper table mapping
 * - Foundation for domain-specific repository methods
 * - Default operation config (adapter, schema, etc.) that can be overridden per-query
 *
 * **Called by:** Service layer (UserService, OrderService, etc.)
 * **Calls:** DatabaseService methods (get, create, update, delete, etc.)
 * **Extended by:** Domain repositories (UserRepository, OrderRepository, etc.)
 *
 * @template T The entity type this repository manages
 *
 * @example
 * ### Creating a Domain Repository
 * ```typescript
 * interface User {
 *   id: string;
 *   name: string;
 *   email: string;
 *   createdAt: Date;
 * }
 *
 * class UserRepository extends BaseRepository<User> {
 *   constructor(db: DatabaseServiceInterface) {
 *     super(db, Tables.USERS);
 *   }
 *
 *   // Domain-specific methods
 *   async findByEmail(email: string) {
 *     return this.findOne({ field: 'email', operator: 'eq', value: email });
 *   }
 * }
 * ```
 *
 * @example
 * ### Repository with Default Adapter
 * ```typescript
 * // Analytics repository that always uses the 'analytics' adapter by default
 * class AnalyticsRepository extends BaseRepository<Event> {
 *   constructor(db: DatabaseServiceInterface) {
 *     super(db, 'events', { adapter: 'analytics', schema: 'analytics' });
 *   }
 * }
 *
 * // All queries use analytics adapter by default
 * await analyticsRepo.findById('event-123'); // Uses 'analytics' adapter
 *
 * // But can still override per-query
 * await analyticsRepo.findById('event-123', { adapter: 'primary' });
 * ```
 *
 * @example
 * ### Usage in Service Layer
 * ```typescript
 * class UserService {
 *   constructor(private userRepo: UserRepository) {}
 *
 *   async getUserById(id: string) {
 *     // Calls BaseRepository.findById() → DatabaseService.get()
 *     return this.userRepo.findById(id);
 *   }
 * }
 * ```
 */
export abstract class BaseRepository<T extends object> {
  /**
   * Default operation configuration applied to every query from this repository.
   * Can be overridden per-operation by passing an explicit `OperationConfig`.
   * Useful for setting a default adapter, schema, or other cross-cutting options
   * (e.g., automatically routing all queries through the `analytics` adapter).
   */
  protected readonly defaultConfig?: OperationConfig;

  /**
   * Fields that are allowed to be written (create/update).
   * If set, only these fields pass through `filterToWritableFields()`.
   * If neither writableFields nor readonlyFields is set, all fields are writable.
   *
   * @example
   * ```typescript
   * protected writableFields = new Set(['display_name', 'first_name', 'phone_number']);
   * ```
   */
  protected writableFields?: ReadonlySet<string>;

  /**
   * Fields that are system-managed and cannot be written.
   * If set, these fields are excluded by `filterToWritableFields()`.
   * Ignored if `writableFields` is set (explicit whitelist takes priority).
   *
   * @example
   * ```typescript
   * protected readonlyFields = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);
   * ```
   */
  protected readonlyFields?: ReadonlySet<string>;

  /**
   * Fields that must never be returned in query results (security).
   * If set, these fields are stripped from all read operations
   * (`findById`, `findMany`, `findOne`) via `stripSensitiveFields()`.
   *
   * NOTE: Only applies to top-level fields on results from BaseRepository CRUD methods.
   * - Raw SQL queries via `db.adapter.query()` are NOT covered — use
   *   explicit column lists (SELECT whitelists) for those.
   * - Nested data (e.g., JSONB `metadata` columns) is NOT recursively stripped.
   *   If metadata contains sensitive keys, handle those in the mapper's `toResponseDTO`.
   *
   * @example
   * ```typescript
   * protected sensitiveFields = new Set(['password_hash', 'reset_token', 'reset_token_expires_at']);
   * ```
   */
  protected sensitiveFields?: ReadonlySet<string>;

  /**
   * Keys to strip from JSONB/object fields recursively.
   * Applied after `sensitiveFields` stripping — scans all remaining
   * object/array values and removes matching keys at any depth.
   *
   * @example
   * ```typescript
   * protected sensitiveMetadataKeys = new Set(['api_key', 'secret_key', 'token', 'password']);
   * ```
   */
  protected sensitiveMetadataKeys?: ReadonlySet<string>;

  /**
   * Creates a new BaseRepository instance.
   *
   * @param db - Database service interface used to execute queries
   * @param tableName - Name of the database table this repository operates on
   * @param defaultConfig - Optional default operation configuration applied to every query
   *                        unless explicitly overridden per-operation
   */
  constructor(
    protected readonly db: DatabaseServiceInterface,
    protected readonly tableName: string,
    defaultConfig?: OperationConfig,
  ) {
    this.defaultConfig = defaultConfig;
  }

  /**
   * Strip sensitive fields from a single record or array of records.
   * Returns the data unchanged if no sensitiveFields are declared.
   * Uses Omit-style stripping — deletes keys from a shallow copy.
   */
  protected stripSensitive<D extends T>(data: D): D;
  protected stripSensitive<D extends T>(data: D[]): D[];
  protected stripSensitive<D extends T>(data: D | D[]): D | D[] {
    if (!this.sensitiveFields && !this.sensitiveMetadataKeys) return data;

    const stripDeep = (value: unknown): unknown => {
      if (!this.sensitiveMetadataKeys) return value;
      if (value === null || value === undefined) return value;
      if (Array.isArray(value)) return value.map(stripDeep);
      if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (!this.sensitiveMetadataKeys.has(k)) {
            result[k] = typeof v === 'object' && v !== null ? stripDeep(v) : v;
          }
        }
        return result;
      }
      return value;
    };

    const strip = (record: D): D => {
      const copy = { ...record };

      // Strip top-level sensitive fields
      if (this.sensitiveFields) {
        for (const field of this.sensitiveFields) {
          delete copy[field as keyof D];
        }
      }

      // Strip sensitive keys from nested objects (JSONB columns)
      if (this.sensitiveMetadataKeys) {
        for (const [key, value] of Object.entries(copy)) {
          if (typeof value === 'object' && value !== null) {
            (copy as Record<string, unknown>)[key] = stripDeep(value);
          }
        }
      }

      return copy;
    };

    return Array.isArray(data) ? data.map(strip) : strip(data);
  }

  /**
   * Filter a data payload to only include writable fields.
   *
   * Behaviour:
   * - If `writableFields` is set → only those fields pass through (whitelist)
   * - Else if `readonlyFields` is set → those fields are excluded (blacklist)
   * - Else → all fields pass through (backwards compatible)
   *
   * Use before `update()` or `create()` when the input may contain
   * fields that don't exist on the table or are system-managed.
   */
  filterToWritableFields<D extends Record<string, unknown>>(data: D): Partial<D> {
    if (this.writableFields) {
      return Object.fromEntries(
        Object.entries(data).filter(([key]) => this.writableFields!.has(key))
      ) as Partial<D>;
    }

    if (this.readonlyFields) {
      return Object.fromEntries(
        Object.entries(data).filter(([key]) => !this.readonlyFields!.has(key))
      ) as Partial<D>;
    }

    return data;
  }

  /**
   * Create a fluent QueryBuilder for this repository
   *
   * Returns a type-safe, chainable query builder that can execute queries
   * directly against this repository.
   *
   * @returns QueryBuilder bound to this repository
   *
   * @example
   * ```typescript
   * // Fluent query with execute
   * const result = await userRepository.query()
   *   .where('status', 'eq', 'active')
   *   .orderByDesc('createdAt')
   *   .limit(20)
   *   .execute();
   *
   * // Get data directly
   * const users = await userRepository.query()
   *   .where('role', 'eq', 'admin')
   *   .getMany();
   *
   * // Get single record
   * const user = await userRepository.query()
   *   .where('email', 'eq', 'john@example.com')
   *   .getOne();
   *
   * // Complex queries
   * const orders = await orderRepository.query()
   *   .where('status', 'eq', 'pending')
   *   .andWhere('totalAmount', 'gte', 100)
   *   .orWhere('priority', 'eq', 'high')
   *   .whereIn('region', ['US', 'EU'])
   *   .orderBy('createdAt', 'desc')
   *   .paginate(1, 25)
   *   .execute();
   * ```
   */
  query(): QueryBuilder<T> {
    return QueryBuilder.forRepository<T>(this);
  }

  /**
   * Get the table name for this repository
   *
   * Useful for transaction operations where you need the table name
   * to execute raw queries within a transaction context.
   *
   * @returns The table name this repository operates on
   */
  getTableName(): string {
    return this.tableName;
  }

  /**
   * Merges default repository config with per-operation config
   * Per-operation config takes precedence over default config
   */
  private mergeConfig(
    operationConfig?: OperationConfig,
  ): OperationConfig | undefined {
    if (!this.defaultConfig && !operationConfig) {
      return undefined;
    }
    return {
      ...this.defaultConfig,
      ...operationConfig,
    };
  }

  /**
   * Find a single entity by its primary key ID
   *
   * @param {string} id - The primary key ID of the entity to retrieve
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<T | null>>} Promise resolving to the entity or null if not found
   *
   * @example
   * ```typescript
   * const result = await userRepository.findById('user-123');
   * if (result.success && result.value) {
   *   console.log('Found user:', result.value.name);
   * }
   *
   * // Use specific adapter for this query
   * const analyticsResult = await userRepository.findById('user-123', {
   *   adapter: 'analytics'
   * });
   * ```
   */
  async findById(
    id: string,
    config?: OperationConfig,
  ): Promise<DatabaseResult<T | null>> {
    const result = await this.db.get<T>(this.tableName, id, this.mergeConfig(config));
    if (result.success && result.value && this.sensitiveFields) {
      return { ...result, value: this.stripSensitive(result.value) };
    }
    return result;
  }

  /**
   * Find multiple entities with optional filtering, sorting, and pagination
   *
   * Accepts either QueryOptions object or a QueryBuilder instance.
   *
   * @param {QueryOptions<T> | QueryBuilder<T>} [options] - Query configuration or QueryBuilder
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<PaginatedResult<T>>>} Promise resolving to paginated results
   *
   * @example
   * ```typescript
   * // Using QueryOptions (traditional)
   * const result = await userRepository.findMany({
   *   filter: { field: 'status', operator: 'eq', value: 'active' },
   *   sort: [{ field: 'createdAt', direction: 'desc' }],
   *   pagination: { limit: 20, offset: 0 }
   * });
   *
   * // Using QueryBuilder
   * const query = QueryBuilder.create<User>()
   *   .where('status', 'eq', 'active')
   *   .orderByDesc('createdAt')
   *   .limit(20);
   * const result = await userRepository.findMany(query);
   *
   * // Query from analytics database
   * const analyticsResult = await userRepository.findMany({}, {
   *   adapter: 'analytics'
   * });
   * ```
   */
  async findMany(
    options?: QueryOptions<T> | QueryBuilder<T>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    // If options is a QueryBuilder, extract the QueryOptions
    const queryOptions =
      options instanceof QueryBuilder ? options.build() : options;
    const result = await this.db.list<T>(
      this.tableName,
      queryOptions,
      this.mergeConfig(config),
    );
    if (result.success && result.value && this.sensitiveFields) {
      return {
        ...result,
        value: {
          ...result.value,
          data: this.stripSensitive(result.value.data),
        },
      };
    }
    return result;
  }

  /**
   * Create a new entity in the database
   *
   * @param {CreateInput<T>} data - The entity data to create (id is auto-generated)
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<T>>} Promise resolving to the created entity
   *
   * @example
   * ```typescript
   * const result = await userRepository.create({
   *   name: 'John Doe',
   *   email: 'john@example.com'
   * });
   *
   * // Create in specific database/schema
   * const result = await userRepository.create({
   *   name: 'Jane Doe'
   * }, {
   *   adapter: 'secondary',
   *   schema: 'backoffice'
   * });
   * ```
   */
  async create(
    data: CreateInput<T>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<T>> {
    return this.db.create<T>(this.tableName, data, this.mergeConfig(config));
  }

  /**
   * Update an existing entity by ID
   *
   * @param {string} id - The primary key ID of the entity to update
   * @param {Partial<T>} data - Partial entity data containing fields to update
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<T>>} Promise resolving to the updated entity
   *
   * @example
   * ```typescript
   * const result = await userRepository.update('user-123', {
   *   email: 'newemail@example.com',
   *   updatedAt: new Date()
   * });
   *
   * // Update in specific adapter with custom ID column
   * const result = await userRepository.update('flag-key', {
   *   value: true
   * }, {
   *   adapter: 'config',
   *   idColumn: 'key'
   * });
   * ```
   */
  async update(
    id: string,
    data: Partial<T>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<T>> {
    return this.db.update<T>(
      this.tableName,
      id,
      data,
      this.mergeConfig(config),
    );
  }

  /**
   * Delete an entity by ID (hard delete)
   *
   * @param {string} id - The primary key ID of the entity to delete
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<void>>} Promise resolving when deletion is complete
   *
   * @warning This is a permanent operation that cannot be undone
   * @see {@link softDelete} For recoverable deletion
   *
   * @example
   * ```typescript
   * const result = await userRepository.delete('user-123');
   *
   * // Delete from specific adapter
   * const result = await userRepository.delete('user-123', {
   *   adapter: 'archive'
   * });
   * ```
   */
  async delete(
    id: string,
    config?: OperationConfig,
  ): Promise<DatabaseResult<void>> {
    return this.db.delete(this.tableName, id, this.mergeConfig(config));
  }

  /**
   * Count entities matching optional filter criteria
   *
   * Accepts either a Filter object or a QueryBuilder instance.
   *
   * @param {Filter<T> | QueryBuilder<T>} [filter] - Filter conditions or QueryBuilder
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<number>>} Promise resolving to the count
   *
   * @example
   * ```typescript
   * const totalResult = await userRepository.count();
   * const activeResult = await userRepository.count({
   *   field: 'status', operator: 'eq', value: 'active'
   * });
   *
   * // Using QueryBuilder
   * const query = QueryBuilder.create<User>()
   *   .where('status', 'eq', 'active')
   *   .andWhere('verified', 'eq', true);
   * const result = await userRepository.count(query);
   *
   * // Count in specific adapter
   * const archiveCount = await userRepository.count(undefined, {
   *   adapter: 'archive'
   * });
   * ```
   */
  async count(
    filter?: Filter<T> | Filter<T>[] | QueryBuilder<T>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<number>> {
    // If filter is a QueryBuilder, extract all filters for multi-condition support
    const filterOptions =
      filter instanceof QueryBuilder ? filter.toFilters() : filter;
    return this.db.count(
      this.tableName,
      filterOptions,
      this.mergeConfig(config),
    );
  }

  /**
   * Check if an entity exists by ID
   *
   * @param {string} id - The primary key ID to check
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<boolean>>} Promise resolving to existence status
   *
   * @example
   * ```typescript
   * const existsResult = await userRepository.exists('user-123');
   * if (existsResult.success && existsResult.value) {
   *   console.log('User exists');
   * }
   *
   * // Check existence in specific adapter
   * const existsInArchive = await userRepository.exists('user-123', {
   *   adapter: 'archive'
   * });
   * ```
   */
  async exists(
    id: string,
    config?: OperationConfig,
  ): Promise<DatabaseResult<boolean>> {
    const result = await this.db.get<T>(
      this.tableName,
      id,
      this.mergeConfig(config),
    );
    return {
      success: result.success,
      value: result.success && result.value !== null,
      error: result.error,
    };
  }

  /**
   * Find the first entity matching filter criteria
   *
   * Accepts either a Filter object or a QueryBuilder instance.
   *
   * @param {Filter<T> | QueryBuilder<T>} filter - Filter conditions or QueryBuilder
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<T | null>>} Promise resolving to first match or null
   *
   * @example
   * ```typescript
   * const result = await userRepository.findOne({
   *   field: 'email', operator: 'eq', value: 'john@example.com'
   * });
   *
   * // Using QueryBuilder
   * const query = QueryBuilder.create<User>()
   *   .where('email', 'eq', 'john@example.com')
   *   .andWhere('status', 'eq', 'active');
   * const result = await userRepository.findOne(query);
   *
   * // Find in specific adapter
   * const archivedUser = await userRepository.findOne({
   *   field: 'email', operator: 'eq', value: 'john@example.com'
   * }, {
   *   adapter: 'archive',
   *   includeSoftDeleted: true
   * });
   * ```
   */
  async findOne(
    filter: Filter<T> | QueryBuilder<T>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<T | null>> {
    if (filter instanceof QueryBuilder) {
      // Use findMany with limit:1 to support multi-filter queries
      const options = filter.limit(1).build();
      const result = await this.findMany(options, config);
      if (!result.success) {
        return { success: false, value: null, error: result.error };
      }
      return { success: true, value: result.value?.data[0] ?? null };
    }

    if (!filter) {
      return {
        success: false,
        value: null,
        error: new Error("findOne requires at least one filter condition"),
      };
    }

    const result = await this.db.findOne<T>(
      this.tableName,
      filter,
      this.mergeConfig(config),
    );
    if (result.success && result.value && this.sensitiveFields) {
      return { ...result, value: this.stripSensitive(result.value) };
    }
    return result;
  }

  /**
   * Find a single record by Prisma-style where conditions
   * Supports select (projection) and include (relation loading).
   *
   * @param {FindFirstOptions<T>} [options] - Where + select + include options
   * @param {OperationConfig} [config] - Optional per-operation configuration
   * @returns {Promise<DatabaseResult<T | null>>} Promise resolving to the first match or null
   */
  async findFirst(
    options?: FindFirstOptions<T>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<T | null>> {
    const result = await this.db.findFirst<T>(
      this.tableName,
      options,
      this.mergeConfig(config),
    );
    if (result.success && result.value && this.sensitiveFields) {
      return { ...result, value: this.stripSensitive(result.value) };
    }
    return result;
  }

  /**
   * Upsert a record (insert or update)
   *
   * @param {Record<string, any>} where - Unique identifier conditions
   * @param {Record<string, any>} create - Data to create if not exists
   * @param {Record<string, any>} update - Data to update if exists
   * @param {OperationConfig} [config] - Optional per-operation configuration
   * @returns {Promise<DatabaseResult<T>>} Promise resolving to the upserted record
   */
  async upsert(
    where: Record<string, any>,
    create: Record<string, any>,
    update: Record<string, any>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<T>> {
    const result = await this.db.upsert<T>(
      this.tableName,
      where,
      create,
      update,
      this.mergeConfig(config),
    );
    if (result.success && result.value && this.sensitiveFields) {
      return { ...result, value: this.stripSensitive(result.value) };
    }
    return result;
  }

  /**
   * Update multiple records matching where conditions
   *
   * @param {Record<string, any>} where - Filter conditions
   * @param {Record<string, any>} data - Fields to update
   * @param {OperationConfig} [config] - Optional per-operation configuration
   * @returns {Promise<DatabaseResult<number>>} Promise resolving to the count of updated records
   */
  async updateMany(
    where: Record<string, any>,
    data: Record<string, any>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<number>> {
    return this.db.updateMany(
      this.tableName,
      where,
      data,
      this.mergeConfig(config),
    );
  }

  /**
   * Delete multiple records matching where conditions
   *
   * @param {Record<string, any>} where - Filter conditions
   * @param {OperationConfig} [config] - Optional per-operation configuration
   * @returns {Promise<DatabaseResult<number>>} Promise resolving to the count of deleted records
   */
  async deleteMany(
    where: Record<string, any>,
    config?: OperationConfig,
  ): Promise<DatabaseResult<number>> {
    return this.db.deleteMany(
      this.tableName,
      where,
      this.mergeConfig(config),
    );
  }

  /**
   * Soft delete an entity by ID (recoverable deletion)
   *
   * @param {string} id - The primary key ID of the entity to soft delete
   * @param {OperationConfig} [config] - Optional per-operation configuration (adapter selection, schema override, etc.)
   * @returns {Promise<DatabaseResult<void>>} Promise resolving when soft deletion is complete
   *
   * @see {@link delete} For permanent deletion
   *
   * @example
   * ```typescript
   * const result = await userRepository.softDelete('user-123');
   * // User is hidden but can be recovered
   *
   * // Soft delete in specific adapter
   * const archivedUser = await userRepository.softDelete('user-123', {
   *   adapter: 'archive',
   *   includeSoftDeleted: true
   * });
   * ```
   */
  async softDelete(
    id: string,
    config?: OperationConfig,
  ): Promise<DatabaseResult<void>> {
    return this.db.softDelete(this.tableName, id, this.mergeConfig(config));
  }
}
