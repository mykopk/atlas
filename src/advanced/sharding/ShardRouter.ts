import { ShardKeyManager } from "./ShardKey";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import type { ShardConfig, ShardKey } from "@myko/types";

/**
 * Routes database operations to the appropriate shard based on shard keys.
 * Provides shard-aware routing and management capabilities.
 *
 * @description
 * `ShardRouter` wraps a {@link ShardKeyManager} together with a map of
 * {@link ShardConfig} instances. Given a table name and record data, it
 * calculates the target shard and returns the corresponding connection
 * configuration.
 *
 * **Lifecycle:**
 * 1. Instantiate with an array of {@link ShardConfig} objects. At least
 *    one shard should be marked `isPrimary: true` for write operations.
 * 2. Register shard keys for each table via {@link registerShardKey}.
 * 3. Route records via {@link routeToShard} to obtain the target shard.
 * 4. Query shard metadata via {@link getShardById}, {@link getAllShards},
 *    or {@link getPrimaryShard}.
 *
 * **Thread-safety:**
 * Instances are **not** thread-safe. Provide external synchronisation
 * when shared across concurrent operations.
 *
 * @example
 * ```typescript
 * const shardConfigs: ShardConfig[] = [
 *   { id: 0, connectionString: 'postgres://shard0:5432/db', isPrimary: false },
 *   { id: 1, connectionString: 'postgres://shard1:5432/db', isPrimary: false },
 *   { id: 2, connectionString: 'postgres://shard2:5432/db', isPrimary: true }
 * ];
 *
 * const router = new ShardRouter(shardConfigs);
 *
 * // Route a record to the appropriate shard
 * const userData = { id: 'user-456', name: 'Jane' };
 * const shard = router.routeToShard('users', userData);
 * console.log(`User should be stored on shard ${shard.id}`);
 *
 * // Get a specific shard
 * const shard2 = router.getShardById(2);
 *
 * // Get all shards
 * const allShards = router.getAllShards();
 * ```
 */
export class ShardRouter {
  private shards: Map<number, ShardConfig> = new Map();
  private shardKeyManager: ShardKeyManager;

  /**
   * Creates a new ShardRouter instance.
   *
   * @description
   * Initialises an internal {@link ShardKeyManager} and indexes the
   * provided shard configurations by their `id` for fast lookup.
   *
   * @param shardConfigs - Array of shard configurations. Each entry
   *                       must have a unique `id`. At least one shard
   *                       should be designated as primary.
   *
   * @example
   * ```typescript
   * const router = new ShardRouter([
   *   { id: 0, connectionString: 'pg://node0/db', isPrimary: true },
   *   { id: 1, connectionString: 'pg://node1/db', isPrimary: false },
   * ]);
   * ```
   */
  constructor(shardConfigs: ShardConfig[]) {
    this.shardKeyManager = new ShardKeyManager();

    shardConfigs.forEach((config) => {
      this.shards.set(config.id, config);
    });
  }

  /**
   * Determines which shard a record should be routed to.
   *
   * @description
   * Strips non-string/non-number values from `data`, delegates to
   * {@link ShardKeyManager.calculateShard} to obtain a shard ID,
   * and returns the corresponding {@link ShardConfig}.
   *
   * @param table - Table name for shard key lookup.
   * @param data - Record data. Only `string` and `number` values are
   *               used for shard calculation; booleans and dates are
   *               silently filtered out.
   * @returns The {@link ShardConfig} of the target shard.
   *
   * @throws {DatabaseError} With `INVALID_PARAMETERS` when:
   *                         - No shard key is registered for the table.
   *                         - The calculated shard ID does not match
   *                           any configured shard.
   *
   * @example
   * ```typescript
   * const shard = router.routeToShard('users', { id: 'user-456', name: 'Jane' });
   * console.log(`Connect to ${shard.connectionString}`);
   * ```
   */
  routeToShard(
    table: string,
    data: Record<string, string | number | boolean | Date>,
  ): ShardConfig {
    const filteredData: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string" || typeof value === "number") {
        filteredData[key] = value;
      }
    }
    const shardId = this.shardKeyManager.calculateShard(table, filteredData);
    const shard = this.shards.get(shardId);

    if (!shard) {
      throw new DatabaseError(
        `Shard not found: ${shardId}`,
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: { source: "routeToShard" },
          cause: new Error(`Shard not found: ${shardId}`),
        },
      );
    }

    return shard;
  }

  /**
   * Looks up a shard configuration by its numeric ID.
   *
   * @param shardId - The 0-based shard identifier.
   * @returns The matching {@link ShardConfig}, or `undefined` if no
   *          shard with that ID has been configured.
   *
   * @example
   * ```typescript
   * const shard = router.getShardById(0);
   * if (shard?.isPrimary) {
   *   console.log('Shard 0 is the primary');
   * }
   * ```
   */
  getShardById(shardId: number): ShardConfig | undefined {
    return this.shards.get(shardId);
  }

  /**
   * Returns all configured shard configurations.
   *
   * @returns An array of every registered {@link ShardConfig}.
   *
   * @example
   * ```typescript
   * router.getAllShards().forEach(s => {
   *   console.log(`Shard ${s.id}: primary=${s.isPrimary}`);
   * });
   * ```
   */
  getAllShards(): ShardConfig[] {
    return Array.from(this.shards.values());
  }

  /**
   * Returns the primary shard configuration.
   *
   * @description
   * Searches all registered shards for one where `isPrimary === true`.
   * If multiple shards are marked as primary, the first encountered is
   * returned. Returns `undefined` if no primary shard is configured.
   *
   * @returns The primary {@link ShardConfig}, or `undefined`.
   *
   * @example
   * ```typescript
   * const primary = router.getPrimaryShard();
   * if (primary) {
   *   console.log(`Primary: ${primary.connectionString}`);
   * }
   * ```
   */
  getPrimaryShard(): ShardConfig | undefined {
    return Array.from(this.shards.values()).find((shard) => shard.isPrimary);
  }

  /**
   * Registers a shard key for a table.
   *
   * @description
   * Delegates to the internal {@link ShardKeyManager} to store the
   * shard key definition. Must be called before {@link routeToShard}
   * for any table.
   *
   * @param table - Logical table name.
   * @param shardKey - Shard key configuration including strategy,
   *                   columns, and shard count.
   * @returns void
   *
   * @example
   * ```typescript
   * router.registerShardKey('orders', {
   *   name: 'order_shard',
   *   type: 'hash',
   *   columns: ['org_id'],
   *   strategy: 'modulus',
   *   shardCount: 8
   * });
   * ```
   */
  registerShardKey(table: string, shardKey: ShardKey): void {
    this.shardKeyManager.registerShardKey(table, shardKey);
  }
}
