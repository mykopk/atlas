import type { RedisCache } from "./RedisCache";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import type { CacheEvictOptions } from "@myko/types";
import { DB_REGEX } from "@utils/regex";
import { isString } from "@utils/typeGuards";

/**
 * Decorator that evicts cache entries when a method is called.
 * Useful for keeping cache in sync with database changes.
 *
 * @example
 * ### Basic User Update
 * ```typescript
 * class UserService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @CacheEvict({ key: 'user:123' })
 *   async updateUser(id: string, data: Partial<User>): Promise<DatabaseResult<User>> {
 *     // When user is updated, evict their specific cache entry
 *     // This ensures next read gets fresh data
 *     return this.db.update('users', id, data);
 *   }
 * }
 * ```
 *
 * @example
 * ### User Deletion with Pattern Eviction
 * ```typescript
 * class UserService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @CacheEvict({ pattern: 'users:*' })
 *   async deleteUser(id: string): Promise<DatabaseResult<void>> {
 *     // When user is deleted, evict ALL user-related cache entries
 *     // This includes user lists, profiles, permissions, etc.
 *     return this.db.delete('users', id);
 *   }
 * }
 * ```
 *
 * @example
 * ### Product Management with Multiple Eviction Strategies
 * ```typescript
 * class ProductService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @CacheEvict({ key: (id: string) => `product:${id}` })
 *   async updateProduct(id: string, data: Partial<Product>): Promise<DatabaseResult<Product>> {
 *     // Evict specific product cache
 *     return this.db.update('products', id, data);
 *   }
 *
 *   @CacheEvict({ pattern: 'products:category:*' })
 *   async updateProductCategory(categoryId: string): Promise<DatabaseResult<void>> {
 *     // When category is updated, evict all products in that category
 *     return this.db.update('categories', categoryId, { updatedAt: new Date() });
 *   }
 *
 *   @CacheEvict({ pattern: 'products:featured' })
 *   async updateFeaturedProducts(): Promise<DatabaseResult<void>> {
 *     // Evict featured products cache when featured list changes
 *     return this.db.query('REFRESH MATERIALIZED VIEW featured_products');
 *   }
 * }
 * ```
 *
 * @example
 * ### Cache Invalidation on Data Changes
 * ```typescript
 * class OrderService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @CacheEvict({ pattern: 'orders:user:*' })
 *   async createOrder(userId: string, orderData: CreateOrderDto): Promise<DatabaseResult<Order>> {
 *     // When new order is created, evict user's order history cache
 *     return this.db.create('orders', { ...orderData, userId });
 *   }
 *
 *   @CacheEvict({ pattern: 'orders:stats:*' })
 *   async updateOrderStatus(orderId: string, status: string): Promise<DatabaseResult<void>> {
 *     // When order status changes, evict order statistics cache
 *     return this.db.update('orders', orderId, { status });
 *   }
 *
 *   @CacheEvict({ allEntries: true })
 *   async resetOrderData(): Promise<DatabaseResult<void>> {
 *     // Clear all order-related cache during data reset
 *     return this.db.query('TRUNCATE orders CASCADE');
 *   }
 * }
 * ```
 *
 * @example
 * ### Profile Management with Related Cache Eviction
 * ```typescript
 * class ProfileService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @CacheEvict({ key: (userId: string) => `profile:${userId}` })
 *   async updateProfile(userId: string, data: Partial<Profile>): Promise<DatabaseResult<Profile>> {
 *     // Evict user profile cache
 *     return this.db.update('profiles', userId, data);
 *   }
 *
 *   @CacheEvict({ pattern: 'profile:preferences:*' })
 *   async updatePreferences(userId: string, preferences: UserPreferences): Promise<DatabaseResult<void>> {
 *     // Evict user preferences cache
 *     return this.db.update('user_preferences', userId, preferences);
 *   }
 *
 *   @CacheEvict({ pattern: 'profile:activity:*' })
 *   async logUserActivity(userId: string, activity: UserActivity): Promise<DatabaseResult<void>> {
 *     // Evict user activity timeline cache
 *     return this.db.create('user_activities', { userId, ...activity });
 *   }
 * }
 * ```
 *
 * @example
 * ### E-commerce Inventory Management
 * ```typescript
 * class InventoryService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @CacheEvict({ key: (productId: string) => `inventory:${productId}` })
 *   async updateInventory(productId: string, quantity: number): Promise<DatabaseResult<void>> {
 *     // Evict specific product inventory cache
 *     return this.db.update('inventory', productId, { quantity });
 *   }
 *
 *   @CacheEvict({ pattern: 'inventory:category:*' })
 *   async updateCategoryInventory(categoryId: string): Promise<DatabaseResult<void>> {
 *     // Evict all inventory in category when category stock changes
 *     return this.db.query('UPDATE inventory SET needs_restock = true WHERE category_id = $1', [categoryId]);
 *   }
 *
 *   @CacheEvict({ pattern: 'inventory:low-stock' })
 *   async checkLowStockProducts(): Promise<DatabaseResult<Product[]>> {
 *     // Evict low stock cache when checking (data may have changed)
 *     return this.db.findMany('products', {
 *       filter: { field: 'stock', operator: 'lt', value: 10 }
 *     });
 *   }
 * }
 * ```
 *
 * @example
 * ### Content Management System
 * ```typescript
 * class ContentService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @CacheEvict({ key: (contentId: string) => `content:${contentId}` })
 *   async updateContent(contentId: string, data: Partial<Content>): Promise<DatabaseResult<Content>> {
 *     // Evict specific content cache
 *     return this.db.update('contents', contentId, data);
 *   }
 *
 *   @CacheEvict({ pattern: 'content:author:*' })
 *   async updateAuthorProfile(authorId: string): Promise<DatabaseResult<void>> {
 *     // Evict all content by this author when profile changes
 *     return this.db.update('authors', authorId, { updatedAt: new Date() });
 *   }
 *
 *   @CacheEvict({ pattern: 'content:published:*' })
 *   async publishContent(contentId: string): Promise<DatabaseResult<void>> {
 *     // Evict published content cache when new content is published
 *     return this.db.update('contents', contentId, { status: 'published' });
 *   }
 *
 *   @CacheEvict({ pattern: 'content:tag:*' })
 *   async updateContentTags(contentId: string, tags: string[]): Promise<DatabaseResult<void>> {
 *     // Evict tag-based content caches when tags change
 *     return this.db.update('content_tags', contentId, { tags });
 *   }
 * }
 * ```
 *
 * @example
 * ### Dynamic Cache Key Generation
 * ```typescript
 * class CacheService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @CacheEvict({ key: (userId: string, resourceId: string) => `user:${userId}:resource:${resourceId}` })
 *   async updateUserResource(userId: string, resourceId: string, data: object): Promise<DatabaseResult<void>> {
 *     // Evict specific user resource cache
 *     return this.db.update('user_resources', { userId, resourceId, data });
 *   }
 *
 *   @CacheEvict({ pattern: (tenantId: string) => `tenant:${tenantId}:*` })
 *   async updateTenantSettings(tenantId: string): Promise<DatabaseResult<void>> {
 *     // Evict all tenant-specific cache entries
 *     return this.db.update('tenants', tenantId, { settings: { updatedAt: new Date() } });
 *   }
 * }
 * ```
 */
function validateMethodArgs(args: [string, ...Array<string>]): void {
  if (!args || args.length === 0) {
    throw new DatabaseError(
      "Method arguments are required",
      DATABASE_ERROR_CODES.INVALID_PARAMETERS,
      {
        context: {
          source: "CacheEvict.validateMethodArgs",
        },
      },
    );
  }
}

function validateMethodResult(result: object): void {
  if (!result || typeof result !== "object") {
    throw new DatabaseError(
      "Method result must be an object",
      DATABASE_ERROR_CODES.INVALID_RESULT,
      {
        context: { source: "CacheEvict.validateMethodResult" },
      },
    );
  }
}

async function handleCacheInvalidation(
  cache: RedisCache | undefined,
  options: CacheEvictOptions,
  args: [string, ...Array<string>],
  result: object | undefined,
): Promise<void> {
  if (
    cache &&
    result &&
    typeof result === "object" &&
    "success" in result &&
    result.success
  ) {
    try {
      await invalidateCache(cache, options, args);
    } catch (cacheError) {
      console.error("Cache invalidation failed:", cacheError);
    }
  }
}

/**
 * Method decorator that automatically evicts cache entries when the decorated
 * method completes successfully. Supports eviction by specific key, glob pattern,
 * complete cache flush, or dynamic key generation from method arguments.
 *
 * @description
 * The decorated method's class **must** have a `cache` property of type `RedisCache`.
 * Eviction **only** fires when the method returns a successful `DatabaseResult`
 * (i.e. `{ success: true }`). This prevents cache invalidation on errors.
 *
 * Eviction strategies (checked in order):
 * - `allEntries: true` — flushes all `db:*` keys.
 * - `pattern` — evicts all keys matching a glob pattern (e.g. `users:*`).
 * - `key` — evicts a single key (static string or a function receiving args).
 * - Fallback — evicts by table name extracted from the first method argument.
 *
 * @param options - Cache eviction options. At least one of `key`, `pattern`,
 *                  or `allEntries` should be specified for explicit control.
 *                  If none are provided, the first method argument is used as
 *                  a table name to evict `db:<table>:*`.
 * @returns A `MethodDecorator` wrapping the original method with post-invocation
 *          cache invalidation.
 *
 * @throws {DatabaseError} If applied to a non-function property on the prototype.
 *
 * @example
 * ```typescript
 * class UserService {
 *   cache: RedisCache;
 *
 *   @CacheEvict({ key: (id: string) => `user:${id}` })
 *   async updateUser(id: string, data: Partial<User>): Promise<DatabaseResult<User>> {
 *     return this.db.update('users', id, data);
 *   }
 * }
 * ```
 */
export function CacheEvict(options: CacheEvictOptions = {}): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value;

    if (!originalMethod || typeof originalMethod !== "function") {
      throw new DatabaseError(
        "CacheEvict decorator can only be applied to methods",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: {
            source: "CacheEvict.decorator",
          },
        },
      );
    }

    descriptor.value = async function (
      this: { cache?: RedisCache },
      ...args: [string, ...Array<string>]
    ): Promise<object> {
      validateMethodArgs(args);

      let result;
      try {
        result = await originalMethod.apply(this, args);
        validateMethodResult(result);
        return result;
      } finally {
        await handleCacheInvalidation(this.cache, options, args, result);
      }
    };

    return descriptor;
  };
}

/**
 * Invalidates cache based on provided options.
 *
 * @param cache Redis cache instance
 * @param options Cache eviction options
 * @param args Method arguments
 *
 * @example
 * ### Evict Specific Key
 * ```typescript
 * // Evict a specific user cache entry
 * await invalidateCache(cache, { key: 'user:123' }, ['users', '123']);
 * ```
 *
 * @example
 * ### Evict by Pattern
 * ```typescript
 * // Evict all user-related cache entries
 * await invalidateCache(cache, { pattern: 'users:*' }, ['users']);
 *
 * // Evict all products in a category
 * await invalidateCache(cache, { pattern: 'products:category:electronics:*' }, ['products']);
 * ```
 *
 * @example
 * ### Evict All Entries
 * ```typescript
 * // Clear the entire cache (use carefully!)
 * await invalidateCache(cache, { allEntries: true }, []);
 * ```
 *
 * @example
 * ### Default Table-based Eviction
 * ```typescript
 * // Evict all cache entries for 'orders' table
 * await invalidateCache(cache, {}, ['orders', '123']);
 * // Results in evicting 'db:orders:*'
 * ```
 *
 * @example
 * ### Complex Eviction Strategy
 * ```typescript
 * class CacheManager {
 *   async onUserUpdate(userId: string): Promise<void> {
 *     // Evict user profile
 *     await invalidateCache(cache, { key: `profile:${userId}` }, []);
 *
 *     // Evict user's order history
 *     await invalidateCache(cache, { pattern: `orders:user:${userId}:*` }, []);
 *
 *     // Evict user permissions
 *     await invalidateCache(cache, { pattern: `permissions:user:${userId}:*` }, []);
 *   }
 *
 *   async onProductUpdate(productId: string): Promise<void> {
 *     // Evict product details
 *     await invalidateCache(cache, { key: `product:${productId}` }, []);
 *
 *     // Evict product category listings
 *     await invalidateCache(cache, { pattern: `products:category:*` }, []);
 *
 *     // Evict related product recommendations
 *     await invalidateCache(cache, { pattern: `recommendations:product:${productId}:*` }, []);
 *   }
 * }
 * ```
 *
 * @example
 * ### Bulk Operations
 * ```typescript
 * class BulkCacheManager {
 *   async onCategoryUpdate(categoryId: string): Promise<void> {
 *     const evictionStrategies = [
 *       { pattern: `products:category:${categoryId}:*` },
 *       { pattern: `category:${categoryId}:*` },
 *       { pattern: `search:category:${categoryId}:*` }
 *     ];
 *
 *     // Execute all eviction strategies in parallel
 *     await Promise.all(
 *       evictionStrategies.map(strategy =>
 *         invalidateCache(cache, strategy, ['products'])
 *       )
 *     );
 *   }
 *
 *   async onTenantUpdate(tenantId: string): Promise<void> {
 *     // Evict all tenant-related cache entries
 *     await invalidateCache(cache, { pattern: `tenant:${tenantId}:*` }, ['tenants']);
 *
 *     // Evict all user sessions for this tenant
 *     await invalidateCache(cache, { pattern: `sessions:tenant:${tenantId}:*` }, []);
 *
 *     // Evict tenant-specific reports
 *     await invalidateCache(cache, { pattern: `reports:tenant:${tenantId}:*` }, []);
 *   }
 * }
 * ```
 *
 * @example
 * ### Multi-tenant Cache Invalidation
 * ```typescript
 * class MultiTenantCacheManager {
 *   async onUserUpdateInTenant(tenantId: string, userId: string): Promise<void> {
 *     // Evict user profile in tenant context
 *     await invalidateCache(cache, { key: `tenant:${tenantId}:user:${userId}` }, []);
 *
 *     // Evict user's data across all tenants
 *     await invalidateCache(cache, { pattern: `user:${userId}:*` }, []);
 *
 *     // Evict tenant's user list
 *     await invalidateCache(cache, { pattern: `tenant:${tenantId}:users:*` }, []);
 *   }
 *
 *   async onGlobalDataUpdate(): Promise<void> {
 *     // Clear all caches when global data changes
 *     await invalidateCache(cache, { allEntries: true }, []);
 *   }
 * }
 * ```
 */
function isValidCacheKey(key: string): boolean {
  return isString(key) && DB_REGEX.isValidCacheKey(key);
}

function isValidCachePattern(pattern: string): boolean {
  return isString(pattern) && DB_REGEX.isValidCachePattern(pattern);
}

function isValidTableName(table: string): boolean {
  return isString(table) && DB_REGEX.isValidTableName(table);
}

async function evictAllEntries(cache: RedisCache): Promise<void> {
  await cache.invalidatePattern("db:*");
}

async function evictByPattern(
  cache: RedisCache,
  pattern: string,
): Promise<void> {
  if (isValidCachePattern(pattern)) {
    await cache.invalidatePattern(pattern);
  }
}

async function evictByKey(cache: RedisCache, key: string): Promise<void> {
  if (isValidCacheKey(key)) {
    await cache.del(key);
  }
}

async function evictByTable(cache: RedisCache, table: string): Promise<void> {
  if (isValidTableName(table)) {
    await cache.invalidatePattern(`db:${table}:*`);
  }
}

async function invalidateCache(
  cache: RedisCache,
  options: CacheEvictOptions,
  args: [string, ...Array<string>],
): Promise<void> {
  try {
    if (options.allEntries) {
      await evictAllEntries(cache);
      return;
    }

    if (options.pattern) {
      await evictByPattern(cache, options.pattern);
      return;
    }

    if (options.key) {
      await evictByKey(cache, options.key);
      return;
    }

    const table = args[0];
    if (table) {
      await evictByTable(cache, table);
    }
  } catch (error) {
    throw new DatabaseError(
      "Cache eviction failed",
      DATABASE_ERROR_CODES.CACHE_INVALIDATE_FAILED,
      {
        context: { source: "CacheEvict.invalidateCache", cause: error },
      },
    );
  }
}
