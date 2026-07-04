import { isString } from "@utils/typeGuards";
import type { RedisCache } from "./RedisCache";
import type { CacheableOptions, DatabaseResult } from "@myko.pk/types/db";

/**
 * Decorator that caches the result of a method.
 * Automatically generates cache keys and handles TTL.
 *
 * @example
 * ### Basic Usage
 * ```typescript
 * class UserService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @Cacheable({ ttl: 300 }) // Cache for 5 minutes
 *   async getUserById(id: string): Promise<DatabaseResult<User>> {
 *     // First call: executes query and caches result
 *     // Subsequent calls: returns cached result for 5 minutes
 *     return this.db.findById('users', id);
 *   }
 * }
 * ```
 *
 * @example
 * ### Custom Cache Key
 * ```typescript
 * class ProductService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @Cacheable({
 *     key: 'featured-products',
 *     ttl: 1800 // Cache for 30 minutes
 *   })
 *   async getFeaturedProducts(): Promise<DatabaseResult<Product[]>> {
 *     // Uses custom cache key 'featured-products'
 *     return this.db.findMany('products', {
 *       filter: { field: 'featured', operator: 'eq', value: true }
 *     });
 *   }
 * }
 * ```
 *
 * @example
 * ### Conditional Caching
 * ```typescript
 * class OrderService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @Cacheable({
 *     ttl: 600,
 *     condition: (result) => result.success && result.value?.length > 0
 *   })
 *   async getRecentOrders(): Promise<DatabaseResult<Order[]>> {
 *     // Only caches successful responses with non-empty results
 *     // Prevents caching empty arrays or error responses
 *     return this.db.findMany('orders', {
 *       sort: [{ field: 'createdAt', direction: 'desc' }],
 *       pagination: { limit: 10 }
 *     });
 *   }
 * }
 * ```
 *
 * @example
 * ### User Profile Caching
 * ```typescript
 * class ProfileService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @Cacheable({ ttl: 3600 }) // Cache for 1 hour
 *   async getUserProfile(userId: string): Promise<DatabaseResult<Profile>> {
 *     // User profiles change infrequently, perfect for caching
 *     return this.db.findById('profiles', userId);
 *   }
 *
 *   @CacheEvict({ key: 'user-profile' })
 *   async updateProfile(userId: string, data: Partial<Profile>): Promise<DatabaseResult<Profile>> {
 *     // When profile is updated, evict the cached version
 *     return this.db.update('profiles', userId, data);
 *   }
 * }
 * ```
 *
 * @example
 * ### Analytics Data Caching
 * ```typescript
 * class AnalyticsService {
 *   constructor(private cache: RedisCache) {}
 *
 *   @Cacheable({
 *     ttl: 7200, // Cache for 2 hours
 *     key: 'daily-stats'
 *   })
 *   async getDailyStats(date: string): Promise<DatabaseResult<DailyStats>> {
 *     // Analytics queries are expensive, cache them longer
 *     return this.db.findById('daily_stats', date);
 *   }
 * }
 * ```
 */
export function Cacheable(options: CacheableOptions = {}): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value;

    if (!originalMethod || typeof originalMethod !== "function") {
      throw new TypeError(
        "Cacheable decorator can only be applied to methods.",
      );
    }

    descriptor.value = async function (
      this: { cache?: RedisCache },
      ...args: [string, ...Array<string>]
    ): Promise<DatabaseResult<object>> {
      // Check if cache is available on the instance
      const cache = this.cache;
      if (!cache) {
        return originalMethod.apply(this, args);
      }

      // Generate cache key
      const table = args[0];
      const operation = String(propertyKey);
      const params = buildParamsObject(args);

      const cacheKey =
        options.key ?? cache.generateKey(table, operation, params);

      // Try to get from cache with explicit type
      const cachedResult = await cache.get<object>(cacheKey);
      if (cachedResult.success && cachedResult.value !== null) {
        return cachedResult as DatabaseResult<object>;
      }

      // Execute original method
      const result = await originalMethod.apply(this, args);

      // Cache result if successful and meets condition
      if (
        result.success &&
        (!options.condition || options.condition(result.value))
      ) {
        await cache.set(cacheKey, result.value, options.ttl);
      }

      return result as DatabaseResult<object>;
    };

    return descriptor;
  };
}

/**
 * Builds a parameters object from function arguments for cache key generation.
 * Converts all arguments to strings to ensure consistent cache keys.
 *
 * @param args Function arguments (first is table name, rest are parameters)
 * @returns Parameters object with indexed keys for cache key generation
 *
 * @example
 * ### Basic Usage
 * ```typescript
 * const params = buildParamsObject(['users', '123']);
 * // Returns: { param0: '123' }
 * ```
 *
 * @example
 * ### Multiple Parameters
 * ```typescript
 * const params = buildParamsObject(['products', 'electronics', 'active', { limit: 10 }]);
 * // Returns: { param0: 'electronics', param1: 'active', param2: '{"limit":10}' }
 * ```
 *
 * @example
 * ### Complex Objects
 * ```typescript
 * const filters = { category: 'books', priceRange: { min: 10, max: 50 } };
 * const params = buildParamsObject(['products', 'search', filters]);
 * // Returns: { param0: 'search', param1: '{"category":"books","priceRange":{"min":10,"max":50}}' }
 * ```
 *
 * @example
 * ### Cache Key Generation
 * ```typescript
 * const cacheKey = cache.generateKey('users', 'findById', params);
 * // Results in: 'users:findById:param0-123'
 *
 * const complexKey = cache.generateKey('products', 'search', params);
 * // Results in: 'products:search:param0-electronics_param1-active_param2-{"limit":10}'
 * ```
 *
 * @example
 * ### Real-World Usage in Repository
 * ```typescript
 * class UserRepository {
 *   async findUsers(filters: UserFilters): Promise<DatabaseResult<User[]>> {
 *     const args = ['users', 'find', filters];
 *     const params = buildParamsObject(args);
 *     const cacheKey = this.cache.generateKey('users', 'find', params);
 *
 *     // Check cache first
 *     const cached = await this.cache.get(cacheKey);
 *     if (cached.success && cached.value) {
 *       return cached;
 *     }
 *
 *     // Execute query and cache result
 *     const result = await this.db.findMany('users', { filter: filters });
 *     await this.cache.set(cacheKey, result.value, 300);
 *     return result;
 *   }
 * }
 * ```
 */
function buildParamsObject<T extends Record<string, string>>(
  args: [string, ...Array<string>],
): T {
  // extract and skip the table name
  const [, ...params] = args;
  const result: Record<string, string> = {};

  params.forEach((arg, index) => {
    const key = `param${index}`;
    result[key] = isString(arg) ? arg : JSON.stringify(arg);
  });

  return result as T;
}
