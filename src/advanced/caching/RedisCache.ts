import { Redis } from "ioredis";
import { failure, success } from "@utils/databaseResultHelpers";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import type { DatabaseResult } from "@myko/types/db";
import { NUMERIX } from "@myko/config";

/**
 * Redis-based caching service for database query results.
 * Provides automatic serialization/deserialization, TTL management, and pattern-based invalidation.
 *
 * @example
 * ### Basic Usage
 * ```typescript
 * const cache = new RedisCache({
 *   url: 'redis://localhost:6379',
 *   defaultTTL: 3600 // 1 hour
 * });
 *
 * // Set a value
 * await cache.set('user:123', { id: 123, name: 'John' });
 *
 * // Get a value
 * const result = await cache.get('user:123');
 * if (result.success) {
 *   console.log(result.value); // { id: 123, name: 'John' }
 * }
 *
 * // Delete a value
 * await cache.del('user:123');
 * ```
 *
 * @example
 * ### User Profile Caching
 * ```typescript
 * class UserProfileCache {
 *   constructor(private cache: RedisCache) {}
 *
 *   async getUserProfile(userId: string): Promise<DatabaseResult<UserProfile>> {
 *     const cacheKey = `profile:${userId}`;
 *
 *     // Try cache first
 *     const cached = await this.cache.get<UserProfile>(cacheKey);
 *     if (cached.success && cached.value) {
 *       return cached;
 *     }
 *
 *     // Fetch from database
 *     const profile = await this.db.findById('profiles', userId);
 *
 *     // Cache the result
 *     if (profile.success) {
 *       await this.cache.set(cacheKey, profile.value, 1800); // 30 minutes
 *     }
 *
 *     return profile;
 *   }
 *
 *   async updateUserProfile(userId: string, data: Partial<UserProfile>): Promise<DatabaseResult<UserProfile>> {
 *     const updated = await this.db.update('profiles', userId, data);
 *
 *     // Invalidate cache on successful update
 *     if (updated.success) {
 *       await this.cache.del(`profile:${userId}`);
 *       // Also invalidate related caches
 *       await this.cache.invalidatePattern(`user:${userId}:*`);
 *     }
 *
 *     return updated;
 *   }
 * }
 * ```
 *
 * @example
 * ### Product Catalog Caching
 * ```typescript
 * class ProductCatalogCache {
 *   constructor(private cache: RedisCache) {}
 *
 *   async getProductsByCategory(categoryId: string): Promise<DatabaseResult<Product[]>> {
 *     const cacheKey = `products:category:${categoryId}`;
 *
 *     const cached = await this.cache.get<Product[]>(cacheKey);
 *     if (cached.success && cached.value) {
 *       return cached;
 *     }
 *
 *     const products = await this.db.findMany('products', {
 *       filter: { field: 'categoryId', operator: 'eq', value: categoryId }
 *     });
 *
 *     // Cache product lists longer (2 hours) as they change less frequently
 *     if (products.success) {
 *       await this.cache.set(cacheKey, products.value, 7200);
 *     }
 *
 *     return products;
 *   }
 *
 *   async updateProductStock(productId: string, quantity: number): Promise<DatabaseResult<void>> {
 *     await this.db.update('inventory', productId, { quantity });
 *
 *     // Invalidate product cache and related caches
 *     await this.cache.del(`product:${productId}`);
 *     await this.cache.invalidatePattern(`products:category:*`);
 *     await this.cache.invalidatePattern(`inventory:low-stock`);
 *   }
 * }
 * ```
 *
 * @example
 * ### Multi-tenant Caching
 * ```typescript
 * class MultiTenantCache {
 *   constructor(private cache: RedisCache) {}
 *
 *   async getTenantConfig(tenantId: string): Promise<DatabaseResult<TenantConfig>> {
 *     const cacheKey = `tenant:${tenantId}:config`;
 *
 *     const cached = await this.cache.get<TenantConfig>(cacheKey);
 *     if (cached.success && cached.value) {
 *       return cached;
 *     }
 *
 *     const config = await this.db.findById('tenant_configs', tenantId);
 *
 *     // Cache configs longer (4 hours) as they rarely change
 *     if (config.success) {
 *       await this.cache.set(cacheKey, config.value, 14400);
 *     }
 *
 *     return config;
 *   }
 *
 *   async updateTenantSettings(tenantId: string): Promise<DatabaseResult<void>> {
 *     await this.db.update('tenant_settings', tenantId, { updatedAt: new Date() });
 *
 *     // Invalidate all tenant-related caches
 *     await this.cache.invalidatePattern(`tenant:${tenantId}:*`);
 *   }
 * }
 * ```
 *
 * @example
 * ### Analytics Data Caching
 * ```typescript
 * class AnalyticsCache {
 *   constructor(private cache: RedisCache) {}
 *
 *   async getDailyStats(date: string): Promise<DatabaseResult<DailyStats>> {
 *     const cacheKey = `analytics:daily:${date}`;
 *
 *     const cached = await this.cache.get<DailyStats>(cacheKey);
 *     if (cached.success && cached.value) {
 *       return cached;
 *     }
 *
 *     // Analytics queries are expensive, cache them longer
 *     const stats = await this.db.findById('daily_stats', date);
 *
 *     if (stats.success) {
 *       // Cache for 6 hours as analytics data doesn't change frequently
 *       await this.cache.set(cacheKey, stats.value, 21600);
 *     }
 *
 *     return stats;
 *   }
 *
 *   async recordMetric(metric: MetricData): Promise<DatabaseResult<void>> {
 *     await this.db.create('metrics', metric);
 *
 *     // Invalidate aggregated analytics caches
 *     await this.cache.invalidatePattern('analytics:aggregated:*');
 *     await this.cache.invalidatePattern('analytics:dashboard:*');
 *   }
 * }
 * ```
 *
 * @example
 * ### Session Management
 * ```typescript
 * class SessionCache {
 *   constructor(private cache: RedisCache) {}
 *
 *   async getUserSession(sessionId: string): Promise<DatabaseResult<Session>> {
 *     const cacheKey = `session:${sessionId}`;
 *
 *     // Sessions are accessed frequently, cache them but with short TTL
 *     const cached = await this.cache.get<Session>(cacheKey);
 *     if (cached.success && cached.value) {
 *       return cached;
 *     }
 *
 *     const session = await this.db.findById('sessions', sessionId);
 *
 *     if (session.success) {
 *       // Cache sessions for 15 minutes
 *       await this.cache.set(cacheKey, session.value, 900);
 *     }
 *
 *     return session;
 *   }
 *
 *   async invalidateUserSessions(userId: string): Promise<DatabaseResult<void>> {
 *     // Invalidate all sessions for a user (e.g., on logout or password change)
 *     await this.cache.invalidatePattern(`session:user:${userId}:*`);
 *   }
 * }
 * ```
 */
export class RedisCache {
  private redis: Redis;
  private defaultTTL: number;
  // Using shared logger instance from @myko/logger

  /**
   * Creates a new RedisCache instance.
   * @param config Redis configuration
   *
   * @example
   * ```typescript
   * // Basic configuration
   * const cache = new RedisCache({
   *   url: 'redis://localhost:6379'
   * });
   *
   * // With custom default TTL
   * const cacheWithCustomTTL = new RedisCache({
   *   url: 'redis://localhost:6379',
   *   defaultTTL: 1800 // 30 minutes
   * });
   *
   * // Production configuration with options
   * const productionCache = new RedisCache({
   *   url: 'redis://redis-cluster.example.com:6379',
   *   defaultTTL: 3600,
   *   // Additional Redis options can be passed here
   * });
   * ```
   */
  constructor(config: { url: string; defaultTTL?: number }) {
    this.redis = new Redis(config.url);
    this.defaultTTL = config.defaultTTL ?? NUMERIX.THIRTY_SIX_HUNDERD;
  }

  /**
   * Retrieves a value from cache by key.
   * Automatically handles JSON deserialization.
   *
   * @param key Cache key
   * @returns DatabaseResult containing cached value or null if not found
   *
   * @example
   * ```typescript
   * // Get user profile
   * const result = await cache.get<UserProfile>('profile:123');
   * if (result.success && result.value) {
   *   console.log('User:', result.value.name);
   * } else {
   *   console.log('Profile not found or cache error');
   * }
   *
   * // Get product list
   * const products = await cache.get<Product[]>('products:featured');
   * if (products.success && products.value) {
   *   products.value.forEach(product => {
   *     console.log(product.name, product.price);
   *   });
   * }
   * ```
   */
  async get<T extends object>(key: string): Promise<DatabaseResult<T | null>> {
    try {
      const value = await this.redis.get(key);
      if (!value) {
        return success();
      }

      const parsed = JSON.parse(value);
      // Validate that parsed value is an object
      if (parsed && typeof parsed === "object") {
        return success(parsed as T);
      }

      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          "Cache get failed",
          DATABASE_ERROR_CODES.CACHE_GET_FAILED,
          { context: { source: "RedisCache.get", key, cause: error } },
        ),
      );
    }
  }

  /**
   * Sets a value in cache with optional TTL.
   * Automatically handles JSON serialization.
   *
   * @param key Cache key
   * @param value Value to cache
   * @param ttl Time to live in seconds (uses default if not specified)
   * @returns DatabaseResult indicating operation success
   *
   * @example
   * ```typescript
   * // Cache with default TTL
   * await cache.set('user:123', { id: 123, name: 'John' });
   *
   * // Cache with custom TTL (5 minutes)
   * await cache.set('session:abc123', sessionData, 300);
   *
   * // Cache with long TTL for static data
   * await cache.set('config:app-settings', appSettings, 86400); // 24 hours
   *
   * // Cache with short TTL for frequently changing data
   * await cache.set('metrics:realtime', realtimeData, 60); // 1 minute
   * ```
   */
  async set<T extends object>(
    key: string,
    value: T,
    ttl?: number,
  ): Promise<DatabaseResult<null>> {
    try {
      const ttlValue = ttl ?? this.defaultTTL;
      await this.redis.set(key, JSON.stringify(value), "EX", ttlValue);
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          "Cache set failed",
          DATABASE_ERROR_CODES.CACHE_SET_FAILED,
          { context: { source: "RedisCache.set", key, cause: error } },
        ),
      );
    }
  }

  /**
   * Deletes a value from cache.
   *
   * @param key Cache key
   * @returns DatabaseResult indicating operation success
   *
   * @example
   * ```typescript
   * // Delete specific cache entry
   * await cache.del('user:123');
   *
   * // Delete session on logout
   * await cache.del(`session:${sessionId}`);
   *
   * // Delete cached configuration
   * await cache.del('config:feature-flags');
   * ```
   */
  async del(key: string): Promise<DatabaseResult<null>> {
    try {
      await this.redis.del(key);
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          "Cache delete failed",
          DATABASE_ERROR_CODES.CACHE_DELETE_FAILED,
          {
            context: {
              source: "RedisCache.del",
              key,
              cause: error,
            },
          },
        ),
      );
    }
  }

  /**
   * Invalidates all cache entries matching a pattern.
   * Useful for clearing related cache entries when data changes.
   *
   * @param pattern Redis key pattern (e.g., 'users:*')
   * @returns DatabaseResult indicating operation success
   *
   * @example
   * ```typescript
   * // Invalidate all user-related caches
   * await cache.invalidatePattern('users:*');
   *
   * // Invalidate all caches for a specific category
   * await cache.invalidatePattern('products:category:electronics:*');
   *
   * // Invalidate all session caches
   * await cache.invalidatePattern('session:*');
   *
   * // Invalidate all caches for a tenant
   * await cache.invalidatePattern(`tenant:${tenantId}:*`);
   *
   * // Invalidate all analytics caches
   * await cache.invalidatePattern('analytics:*');
   * ```
   */
  async invalidatePattern(pattern: string): Promise<DatabaseResult<null>> {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          "Cache invalidate failed",
          DATABASE_ERROR_CODES.CACHE_INVALIDATE_FAILED,
          {
            context: {
              source: "RedisCache.invalidatePattern",
              pattern,
              cause: error,
            },
          },
        ),
      );
    }
  }

  /**
   * Generates a cache key for database queries.
   * Creates consistent, URL-safe keys that include table, operation, and parameters.
   *
   * @param table Database table name
   * @param operation Database operation type
   * @param params Query parameters object
   * @returns Generated cache key
   *
   * @example
   * ```typescript
   * // Simple key generation
   * const key = cache.generateKey('users', 'findById', { id: '123' });
   * // Returns: 'db:users:findById:eyJpYXJhbTAiOiIxMjMifQ=='
   *
   * // Complex query key
   * const complexKey = cache.generateKey('products', 'findMany', {
   *   filter: { field: 'category', operator: 'eq', value: 'electronics' },
   *   sort: [{ field: 'price', direction: 'asc' }],
   *   pagination: { limit: 20, offset: 0 }
   * });
   *
   * // User-specific key
   * const userKey = cache.generateKey('orders', 'findMany', {
   *   filter: { field: 'userId', operator: 'eq', value: '123' }
   * });
   * ```
   */
  generateKey(
    table: string,
    operation: string,
    params: Record<string, string | number | boolean | null>,
  ): string {
    const paramsStr = JSON.stringify(params || {});
    return `db:${table}:${operation}:${Buffer.from(paramsStr).toString("base64")}`;
  }

  /**
   * Performs a health check on the Redis connection.
   * Useful for monitoring and ensuring cache availability.
   *
   * @returns DatabaseResult with boolean indicating if Redis is healthy
   *
   * @example
   * ```typescript
   * // Check Redis health
   * const health = await cache.healthCheck();
   * if (health.success && health.value) {
   *   console.log('Redis is healthy');
   * } else {
   *   console.log('Redis health check failed:', health.error?.message);
   *   // Implement fallback logic or alerting
   * }
   *
   * // Use in health check endpoint
   * app.get('/health', async (req, res) => {
   *   const dbHealth = await db.healthCheck();
   *   const cacheHealth = await cache.healthCheck();
   *
   *   res.json({
   *     database: dbHealth.success && dbHealth.value,
   *     cache: cacheHealth.success && cacheHealth.value,
   *     timestamp: new Date()
   *   });
   * });
   * ```
   */
  async healthCheck(): Promise<DatabaseResult<boolean>> {
    try {
      await this.redis.ping();
      return success(true);
    } catch (error) {
      return failure(
        new DatabaseError(
          "Redis health check failed",
          DATABASE_ERROR_CODES.CACHE_HEALTH_CHECK_FAILED,
          {
            context: {
              source: "RedisCache.healthCheck",
              cause: error,
            },
          },
        ),
      );
    }
  }

  /**
   * Closes the Redis connection gracefully.
   * Should be called during application shutdown.
   *
   * @example
   * ```typescript
   * // In your application shutdown logic
   * async function shutdown() {
   *   console.log('Shutting down cache...');
   *   await cache.close();
   *   console.log('Cache connection closed');
   *
   *   // Close other connections...
   *   process.exit(0);
   * }
   *
   * // Handle graceful shutdown
   * process.on('SIGTERM', shutdown);
   * process.on('SIGINT', shutdown);
   * ```
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
