import { NUMERIX } from "@myko/config";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import type { ShardKey } from "@myko/types";

/**
 * Manages shard key definitions and calculations.
 * Provides utilities for determining which shard a record belongs to.
 *
 * @description
 * `ShardKeyManager` stores shard key configurations per table and
 * calculates the target shard for a given record using one of three
 * strategies: `modulus`, `hash`, or `range`.
 *
 * **Lifecycle:**
 * 1. Instantiate the manager.
 * 2. Register a shard key per table via {@link registerShardKey}.
 * 3. Call {@link calculateShard} with record data to get the 0-based
 *    shard ID.
 *
 * **Thread-safety:**
 * Instances are **not** thread-safe. Provide external synchronisation
 * if shared across concurrent operations.
 *
 * @example
 * ```typescript
 * const shardKeyManager = new ShardKeyManager();
 *
 * // Register a shard key for users table
 * shardKeyManager.registerShardKey('users', {
 *   name: 'user_shard',
 *   type: 'hash',
 *   columns: ['id'],
 *   strategy: 'hash',
 *   shardCount: 4
 * });
 *
 * // Calculate which shard a user belongs to
 * const shardId = shardKeyManager.calculateShard('users', { id: 'user-123' });
 * console.log(`User belongs to shard ${shardId}`);
 * ```
 */
export class ShardKeyManager {
  private shardKeys: Map<string, ShardKey> = new Map();

  /**
   * Registers a shard key definition for a table.
   *
   * @description
   * Associates a {@link ShardKey} configuration with the given table
   * name. If a key already exists for that table, it is overwritten.
   *
   * @param table - Logical table name (e.g. `'users'`, `'orders'`).
   * @param shardKey - Shard key configuration including strategy,
   *                   columns, and shard count.
   * @returns void
   *
   * @example
   * ```typescript
   * shardKeyManager.registerShardKey('orders', {
   *   name: 'order_shard',
   *   type: 'hash',
   *   columns: ['organization_id'],
   *   strategy: 'modulus',
   *   shardCount: 8
   * });
   * ```
   */
  registerShardKey(table: string, shardKey: ShardKey): void {
    this.shardKeys.set(table, shardKey);
  }

  /**
   * Retrieves the shard key configuration for a table.
   *
   * @param table - The table name to look up.
   * @returns The {@link ShardKey} configuration if found, or
   *          `undefined` if no key has been registered for the table.
   *
   * @example
   * ```typescript
   * const key = shardKeyManager.getShardKey('users');
   * if (key) {
   *   console.log(`Strategy: ${key.strategy}, shards: ${key.shardCount}`);
   * }
   * ```
   */
  getShardKey(table: string): ShardKey | undefined {
    return this.shardKeys.get(table);
  }

  /**
   * Determines which shard a record belongs to.
   *
   * @description
   * Looks up the shard key for the given table, extracts the key value
   * from the record data (joining multiple columns with `|` if needed),
   * and applies the configured strategy (`modulus`, `hash`, or `range`)
   * to compute a 0-based shard index.
   *
   * @typeParam T - Record shape with string or numeric values.
   * @param table - Table name for shard key lookup.
   * @param data - Record data containing the shard key column(s).
   * @returns A 0-based shard ID corresponding to the record.
   *
   * @throws {DatabaseError} With `INVALID_PARAMETERS` when:
   *                         - No shard key is registered for the table.
   *                         - An unknown sharding strategy is configured.
   *
   * @example
   * ```typescript
   * const shard = shardKeyManager.calculateShard('users', { id: 'abc-123' });
   * console.log(`Routing to shard ${shard}`);
   * ```
   */
  calculateShard<T extends Record<string, string | number>>(
    table: string,
    data: T,
  ): number {
    const shardKey = this.getShardKey(table);
    if (!shardKey) {
      throw new DatabaseError(
        `No shard key defined for table: ${table}`,
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: { source: "calculateShard" },
          cause: new Error(`No shard key defined for table: ${table}`),
        },
      );
    }

    const keyValue = this.extractKeyValue(data, shardKey);

    switch (shardKey.strategy) {
      case "modulus":
        return this.modulusShard(keyValue, shardKey.shardCount);
      case "hash":
        return this.hashShard(keyValue, shardKey.shardCount);
      case "range":
        return this.rangeShard(keyValue, shardKey);
      default:
        throw new DatabaseError(
          `Unknown sharding strategy: ${shardKey.strategy}`,
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          {
            context: { source: "calculateShard" },
            cause: new Error(`Unknown sharding strategy: ${shardKey.strategy}`),
          },
        );
    }
  }

  /**
   * Extracts the shard key value from record data.
   * @param data Record data
   * @param shardKey Shard key configuration
   * @returns Extracted key value
   */
  private extractKeyValue<T extends Record<string, string | number>>(
    data: T,
    shardKey: ShardKey,
  ): string | number {
    if (shardKey.columns.length === 1) {
      return data[shardKey.columns[0]];
    }

    return shardKey.columns.map((col) => data[col]).join("|");
  }

  /**
   * Calculates shard ID using modulus strategy.
   * @param keyValue Key value
   * @param shardCount Number of shards
   * @returns Shard ID
   */
  private modulusShard(keyValue: string | number, shardCount: number): number {
    const numericKey =
      typeof keyValue === "string"
        ? this.hashString(keyValue)
        : Number(keyValue);

    return numericKey % shardCount;
  }

  /**
   * Calculates shard ID using hash strategy.
   * @param keyValue Key value
   * @param shardCount Number of shards
   * @returns Shard ID
   */
  private hashShard(keyValue: string | number, shardCount: number): number {
    const hash =
      typeof keyValue === "string"
        ? this.hashString(keyValue)
        : Number(keyValue);

    return Math.abs(hash) % shardCount;
  }

  /**
   * Calculates shard ID using range strategy.
   * @param keyValue Key value
   * @param shardKey Shard key configuration
   * @returns Shard ID
   */
  private rangeShard(keyValue: string | number, shardKey: ShardKey): number {
    // Implementation would depend on range configuration
    // This is a simplified version
    const numericKey =
      typeof keyValue === "string"
        ? this.hashString(keyValue)
        : Number(keyValue);

    return Math.floor(
      numericKey / (Number.MAX_SAFE_INTEGER / shardKey.shardCount),
    );
  }

  /**
   * Hashes a string to a numeric value.
   * @param str String to hash
   * @returns Hash value
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << NUMERIX.FIVE) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }
}
