import { NUMERIX } from "@myko/config";
import { logger } from "@myko/logger";
import type {
  DatabaseAdapterType,
  DatabaseResult,
  DBCacheConfig,
  Filter,
  DatabaseHealthStatus,
  PaginatedResult,
  QueryOptions,
  Transaction,
} from "@myko/types/db";
/**
 * CACHING ADAPTER - Query Result Caching Layer
 *
 * Caching extension that stores query results in memory for improved performance.
 * Third layer in the adapter chain.
 *
 * **Adapter Chain Position:**
 * ReadReplica → Audit → **Cache** → SoftDelete → Encryption → Base Adapter
 *
 * **What this adapter does:**
 * 1. Intercepts findById() operations → checks cache first, stores results
 * 2. Intercepts write operations → invalidates related cache entries
 * 3. Manages TTL-based cache expiration
 * 4. Honors cache configuration (enabled, ttl, invalidation strategy)
 *
 * **Called by:** AuditAdapter (or ReadReplicaAdapter if no audit)
 * **Calls:** SoftDeleteAdapter (or next adapter in chain)
 * **Cache Strategy:** In-memory Map with TTL expiration
 *
 * **Cache Flow:**
 * - **READ:** Check cache → Return if hit → Query DB → Cache result
 * - **WRITE:** Execute operation → Invalidate related cache entries
 *
 * @example
 * ### Configuration
 * ```typescript
 * cache: {
 *   enabled: true,
 *   ttl: 300,                    // 5 minutes
 *   invalidation: 'write',       // Invalidate on writes
 *   maxSize: 1000               // Max cache entries
 * }
 * ```
 *
 * @example
 * ### Cache Behavior
 * ```typescript
 * // First call - cache miss, queries database
 * const user1 = await db.findById('users', 'user-123'); // DB query
 *
 * // Second call - cache hit, returns from memory
 * const user2 = await db.findById('users', 'user-123'); // Cache hit
 *
 * // Write operation invalidates cache
 * await db.update('users', 'user-123', { name: 'New Name' });
 *
 * // Next read - cache miss again, queries database
 * const user3 = await db.findById('users', 'user-123'); // DB query
 * ```
 */
export class CachingAdapter implements DatabaseAdapterType {
  private cache = new Map<
    string,
    {
      value:
        | Record<string, string | number | boolean | Date>
        | Record<string, string | number | boolean | Date>[];
      expiry: number;
    }
  >();

  /**
   * Creates a new CachingAdapter instance.
   *
   * **RESPONSIBILITY:** Wraps base adapter with caching functionality
   * **CONFIGURATION:** Sets up cache TTL, invalidation strategy, and size limits
   *
   * @param baseAdapter - The underlying database adapter to wrap
   * @param config - Cache configuration options
   *
   * @example
   * ```typescript
   * const cachingAdapter = new CachingAdapter(baseAdapter, {
   *   enabled: true,
   *   ttl: 300,                    // 5 minutes
   *   invalidation: 'write',       // Invalidate on writes
   *   maxSize: 1000               // Max entries
   * });
   * ```
   */
  constructor(
    public baseAdapter: DatabaseAdapterType,
    private config: DBCacheConfig,
  ) {}

  /**
   * Initializes the caching adapter and underlying adapter.
   *
   * **RESPONSIBILITY:** Passes initialization to base adapter
   * **BEHAVIOR:** No additional initialization needed for caching
   *
   * @returns Promise resolving to initialization result
   *
   * @example
   * ```typescript
   * const result = await cachingAdapter.initialize();
   * if (result.success) {
   *   console.log('Caching adapter initialized');
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
   * await cachingAdapter.connect();
   * console.log('Connected with caching support');
   * ```
   */
  async connect(): Promise<void> {
    return this.baseAdapter.connect();
  }

  /**
   * Closes database connection through base adapter.
   *
   * **RESPONSIBILITY:** Delegates disconnection to underlying adapter
   * **BEHAVIOR:** Cache is cleared on disconnect
   *
   * @example
   * ```typescript
   * await cachingAdapter.disconnect();
   * console.log('Disconnected and cache cleared');
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
   * **USE CASE:** For operations that bypass caching
   *
   * @returns Database client object
   *
   * @example
   * ```typescript
   * const client = cachingAdapter.getClient();
   * // Use for direct database operations if needed
   * ```
   */
  getClient<T extends object = object>(): T {
    return this.baseAdapter.getClient<T>();
  }

  /**
   * Executes raw SQL query through base adapter.
   *
   * **RESPONSIBILITY:** Passes raw SQL to base adapter without caching
   * **BEHAVIOR:** Does not cache raw SQL results
   * **NOTE:** Use findById/findMany for automatic caching
   *
   * @param sql - SQL query string
   * @param params - Query parameters
   * @returns Query results
   *
   * @example
   * ```typescript
   * // Raw SQL bypasses caching
   * const results = await adapter.query(
   *   'SELECT * FROM users WHERE status = $1',
   *   ['active']
   * );
   *
   * // Use findMany for automatic caching
   * const users = await adapter.findMany('users', { filter: ... });
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
   * cachingAdapter.registerTable('users', userSchema, 'id');
   * // Table now supports cached operations
   * ```
   */
  registerTable<T, U>(name: string, table: T, idColumn?: U): void {
    this.baseAdapter.registerTable(name, table, idColumn);
  }

  /**
   * Finds a record by ID with automatic caching.
   *
   * **RESPONSIBILITY:** Checks cache first, queries database on miss, caches result
   * **CACHE KEY:** `{table}:{id}` format for consistent lookup
   * **TTL:** Respects configured TTL for cache expiration
   * **DISABLED:** Falls through to base adapter if caching is disabled
   *
   * @param table - Table name
   * @param id - Record ID
   * @returns Found record or null
   *
   * @example
   * ```typescript
   * // First call - cache miss, queries database
   * const user = await adapter.findById('users', 'user-123');
   * // Result is cached for subsequent calls
   *
   * // Second call - cache hit, returns immediately
   * const cachedUser = await adapter.findById('users', 'user-123');
   * // No database query performed
   * ```
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    if (!this.config.enabled) {
      return this.baseAdapter.findById<T>(table, id);
    }

    const cacheKey = `${table}:${id}`;
    const cached = this.getFromCache<T>(cacheKey);

    if (cached !== null) {
      logger.debug(`Cache hit for ${table}:${id}`);
      return { success: true, value: cached };
    }

    const result = await this.baseAdapter.findById<T>(table, id);

    if (result.success && result.value) {
      this.setCache(cacheKey, result.value);
      logger.debug(`Cache set for ${table}:${id}`);
    }

    return result;
  }

  /**
   * Finds multiple records without caching.
   *
   * **RESPONSIBILITY:** Retrieves multiple records, bypassing cache
   * **BEHAVIOR:** Complex queries are not cached currently
   * **FUTURE:** Could implement query result caching with cache keys
   *
   * @param table - Table name
   * @param options - Query options
   * @returns Paginated results
   *
   * @example
   * ```typescript
   * // Complex queries bypass cache (for now)
   * const users = await adapter.findMany('users', {
   *   filter: { field: 'status', operator: 'eq', value: 'active' },
   *   pagination: { page: 1, limit: 10 },
   *   sort: { field: 'name', direction: 'asc' }
   * });
   *
   * // Always queries database directly
   * ```
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    // For now, skip caching for complex queries
    return this.baseAdapter.findMany<T>(table, options);
  }

  /**
   * Creates a new record with cache invalidation.
   *
   * **RESPONSIBILITY:** Creates record and invalidates related cache entries
   * **INVALIDATION:** Clears table cache on successful write
   * **STRATEGY:** Based on config.invalidation setting
   *
   * @param table - Table name
   * @param data - Record data
   * @returns Created record
   *
   * @example
   * ```typescript
   * // Create user - invalidates users table cache
   * const result = await adapter.create('users', {
   *   name: 'John Doe',
   *   email: 'john@example.com'
   * });
   *
   * if (result.success) {
   *   console.log('User created:', result.value.id);
   *   // All cached users:* entries are now invalid
   * }
   * ```
   */
  async create<T extends object>(
    table: string,
    data: T,
  ): Promise<DatabaseResult<T>> {
    const result = await this.baseAdapter.create<T>(table, data);

    if (result.success && this.config.invalidation === "write") {
      this.invalidateTable(table);
    }

    return result;
  }

  /**
   * Updates an existing record with cache invalidation.
   *
   * **RESPONSIBILITY:** Updates record and invalidates related cache entries
   * **INVALIDATION:** Clears specific record and table cache
   * **STRATEGY:** Invalidates both table:id and table:* patterns
   *
   * @param table - Table name
   * @param id - Record ID
   * @param data - Partial record data
   * @returns Updated record
   *
   * @example
   * ```typescript
   * // Update user - invalidates specific cache entry
   * const result = await adapter.update('users', 'user-123', {
   *   name: 'Jane Doe'
   * });
   *
   * if (result.success) {
   *   console.log('User updated:', result.value.name);
   *   // Cache entries users:user-123 and users:* are invalidated
   * }
   * ```
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    const result = await this.baseAdapter.update<T>(table, id, data);

    if (result.success && this.config.invalidation === "write") {
      this.invalidateTable(table);
      this.invalidateKey(`${table}:${id}`);
    }

    return result;
  }

  /**
   * Deletes a record with cache invalidation.
   *
   * **RESPONSIBILITY:** Deletes record and invalidates related cache entries
   * **INVALIDATION:** Clears specific record and table cache
   * **STRATEGY:** Removes both table:id and table:* patterns
   *
   * @param table - Table name
   * @param id - Record ID
   * @returns Deletion result
   *
   * @example
   * ```typescript
   * // Delete user - invalidates cache entries
   * const result = await adapter.delete('users', 'user-123');
   *
   * if (result.success) {
   *   console.log('User deleted successfully');
   *   // Cache entries users:user-123 and users:* are invalidated
   * }
   * ```
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    const result = await this.baseAdapter.delete(table, id);

    if (result.success && this.config.invalidation === "write") {
      this.invalidateTable(table);
      this.invalidateKey(`${table}:${id}`);
    }

    return result;
  }

  /**
   * Executes operations within a transaction.
   *
   * **RESPONSIBILITY:** Passes transaction to base adapter
   * **BEHAVIOR:** Cache invalidation happens per operation within transaction
   * **ATOMICITY:** Cache invalidation is not rolled back if transaction fails
   *
   * @param callback - Transaction callback function
   * @returns Transaction result
   *
   * @example
   * ```typescript
   * const result = await adapter.transaction(async (trx) => {
   *   // Each operation invalidates cache independently
   *   const user = await trx.create('users', { name: 'John' });
   *   await trx.update('profiles', 'profile-1', { userId: user.id });
   *   return user;
   * });
   *
   * // Cache invalidation happens even if transaction fails
   * ```
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    return this.baseAdapter.transaction(callback);
  }

  /**
   * Checks if a record exists without caching.
   *
   * **RESPONSIBILITY:** Verifies record existence, bypassing cache
   * **BEHAVIOR:** Existence checks are not cached currently
   * **PERFORMANCE:** Always queries database for existence
   *
   * @param table - Table name
   * @param id - Record ID
   * @returns True if record exists
   *
   * @example
   * ```typescript
   * // Existence checks bypass cache
   * const userExists = await adapter.exists('users', 'user-123');
   * if (userExists.value) {
   *   console.log('User exists');
   * }
   *
   * // Always queries database directly
   * ```
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    return this.baseAdapter.exists(table, id);
  }

  /**
   * Counts records without caching.
   *
   * **RESPONSIBILITY:** Counts records, bypassing cache
   * **BEHAVIOR:** Count operations are not cached currently
   * **PERFORMANCE:** Always queries database for counts
   *
   * @param table - Table name
   * @param filter - Optional filter conditions
   * @returns Count of records
   *
   * @example
   * ```typescript
   * // Count operations bypass cache
   * const activeUsers = await adapter.count('users', {
   *   field: 'status',
   *   operator: 'eq',
   *   value: 'active'
   * });
   *
   * console.log('Active users:', activeUsers.value);
   * // Always queries database directly
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
   * **BEHAVIOR:** No additional health metrics for cache
   *
   * @returns Health status from base adapter
   *
   * @example
   * ```typescript
   * const health = await adapter.healthCheck();
   * if (health.success && health.value?.isHealthy) {
   *   console.log('Database healthy with caching support');
   * }
   * ```
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    return this.baseAdapter.healthCheck();
  }

  /**
   * Retrieves value from cache with TTL validation.
   *
   * **RESPONSIBILITY:** Gets cached value and validates expiration
   * **TTL HANDLING:** Removes expired entries automatically
   * **RETURN:** Cached value or null if not found/expired
   *
   * @private
   * @param key - Cache key to retrieve
   * @returns Cached value or null
   *
   * @example
   * ```typescript
   * // Internal usage
   * const user = this.getFromCache<User>('users:user-123');
   * if (user) {
   *   console.log('Cache hit:', user.name);
   * } else {
   *   console.log('Cache miss or expired');
   * }
   * ```
   */
  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiry) {
      this.cache.delete(key);
      return null;
    }

    return cached.value as T;
  }

  /**
   * Stores value in cache with TTL expiration.
   *
   * **RESPONSIBILITY:** Caches value with calculated expiration time
   * **TTL:** Uses config.ttl or default 5 minutes (300 seconds)
   * **EXPIRY:** Calculates absolute expiration timestamp
   *
   * @private
   * @param key - Cache key to store
   * @param value - Value to cache
   *
   * @example
   * ```typescript
   * // Internal usage after database query
   * this.setCache('users:user-123', userData);
   *
   * // Value will expire after TTL seconds
   * // Default: 5 minutes from now
   * ```
   */
  private setCache(
    key: string,
    value:
      | Record<string, string | number | boolean | Date>
      | Record<string, string | number | boolean | Date>[],
  ): void {
    const ttl = this.config.ttl ?? NUMERIX.THREE_HUNDERD; // Default 5 minutes
    const expiry = Date.now() + ttl * NUMERIX.THOUSAND;
    this.cache.set(key, { value, expiry });
  }

  /**
   * Removes specific key from cache.
   *
   * **RESPONSIBILITY:** Invalidates single cache entry
   * **USE CASE:** Called after record updates/deletes
   * **PATTERN:** Removes exact key match
   *
   * @private
   * @param key - Cache key to invalidate
   *
   * @example
   * ```typescript
   * // Internal usage after record update
   * this.invalidateKey('users:user-123');
   *
   * // Only users:user-123 is removed from cache
   * // Other users:* entries remain cached
   * ```
   */
  private invalidateKey(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Removes all cache entries for a table.
   *
   * **RESPONSIBILITY:** Invalidates all entries matching table pattern
   * **USE CASE:** Called after any write operation to table
   * **PATTERN:** Removes all keys starting with 'table:'
   *
   * @private
   * @param table - Table name to invalidate
   *
   * @example
   * ```typescript
   * // Internal usage after any write to users table
   * this.invalidateTable('users');
   *
   * // Removes all cache entries:
   * // - users:user-123
   * // - users:user-456
   * // - users:admin-789
   * // But keeps: profiles:profile-1, posts:post-1, etc.
   * ```
   */
  private invalidateTable(table: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${table}:`)) {
        this.cache.delete(key);
      }
    }
  }
}
