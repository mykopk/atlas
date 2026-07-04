/**
 * @module @mykopk/atlas-client/advanced/sharding
 *
 * Database sharding infrastructure for Atlas clients.
 *
 * @description
 * Enables horizontal partitioning of data across multiple database instances.
 * - {@link ShardKeyManager}: Registers shard key definitions and calculates target
 *   shards using hash, modulus, or range strategies.
 * - {@link ShardRouter}: Wraps ShardKeyManager with full shard configuration
 *   management; routes records to the appropriate shard by ID.
 *
 * @example
 * ```typescript
 * import { ShardRouter } from "@myko.pk/atlas-client/advanced/sharding";
 *
 * const router = new ShardRouter([
 *   { id: 0, connectionString: "pg://shard0:5432/db", isPrimary: true },
 *   { id: 1, connectionString: "pg://shard1:5432/db", isPrimary: false },
 * ]);
 *
 * router.registerShardKey("users", {
 *   name: "user_shard", type: "hash", columns: ["id"],
 *   strategy: "hash", shardCount: 2,
 * });
 *
 * const shard = router.routeToShard("users", { id: "user-123" });
 * ```
 */
export { ShardKeyManager } from "./ShardKey";
export { ShardRouter } from "./ShardRouter";
