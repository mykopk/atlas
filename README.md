# @myko/atlas-client

Universal database abstraction layer for the MYKO ecosystem. Provides a unified API over Drizzle ORM, Prisma, raw SQL, Supabase, and in-memory mock — with pluggable extensions for caching, encryption, soft-delete, audit logging, read replicas, and multi-region writes.

```typescript
import { createDatabaseService } from "@myko/atlas-client";

const db = await createDatabaseService({
  adapter: "drizzle",
  config: {
    connectionString: process.env.DATABASE_URL,
  },
});
```

## Features

- **Multi-adapter** — Drizzle ORM, Prisma, raw SQL, Supabase, Mock
- **Unified CRUD** — same `findById`, `findMany`, `create`, `update`, `delete` API across all adapters
- **Extension decorators** — compose caching, encryption, soft-delete, audit, read-replica, multi-write
- **NestJS native** — `AtlasModule.forRoot()` / `forRootAsync()` with dependency injection
- **Repository pattern** — `BaseRepository<T>` with query builder integration
- **Advanced features** — sharding, multi-tenancy, connection pooling, monitoring, backup
- **Dual-mode DrizzleAdapter** — typed ORM mode (PgTable) and raw SQL fallback
- **`DatabaseResult<T>`** — explicit success/failure monad (no thrown errors)
- **Dual CJS/ESM** — supports both `require()` and `import`

## Installation

```bash
npm install @myko/atlas-client
```

### Peer dependencies (optional)

```bash
# For PrismaAdapter
npm install @prisma/client

# For DrizzleAdapter (already bundled in deps, but pin if needed)
npm install drizzle-orm pg

# For NestJS integration
npm install @nestjs/common

# For advanced caching
npm install ioredis
```

## Quick Start

```typescript
import { createDatabaseService } from "@myko/atlas-client";

const db = await createDatabaseService({
  adapter: "drizzle",
  config: {
    connectionString: process.env.DATABASE_URL!,
    // Custom ID column for tables where PK is not "id"
    tableIdColumns: { users: "user_id" },
  },
});

// CRUD operations return DatabaseResult<T>
const result = await db.findById("users", "abc-123");
if (result.success) {
  console.log(result.data); // User | null
}

const list = await db.findMany("users", {
  filters: [{ field: "email", operator: "eq", value: "test@example.com" }],
  pagination: { limit: 10, offset: 0 },
  sort: [{ field: "createdAt", direction: "desc" }],
});
```

## Adapters

### DrizzleAdapter

Two modes: **typed ORM** (PgTable objects) and **raw SQL** fallback.

```typescript
import { createDatabaseService } from "@myko/atlas-client";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
});

const db = await createDatabaseService({
  adapter: "drizzle",
  config: { connectionString: process.env.DATABASE_URL! },
});

// Register PgTable for typed-mode queries
const reg = db as any;
reg.registerTable("users", users, users.id);

// Now queries use Drizzle's query builder (not raw SQL)
await db.findById("users", "abc-123");
```

If a table is not registered, the adapter falls back to raw SQL using the table name and `"id"` as the default ID column.

### PrismaAdapter

```typescript
const db = await createDatabaseService({
  adapter: "prisma",
  config: {
    datasourceUrl: process.env.DATABASE_URL!,
  },
});
// Internally uses @prisma/client via dynamic import
```

### SQLAdapter

Direct PostgreSQL client with full query control:

```typescript
const db = await createDatabaseService({
  adapter: "sql",
  config: {
    connectionString: process.env.DATABASE_URL!,
    schema: "public",
    ssl: true,
  },
});
```

### SupabaseAdapter

```typescript
const db = await createDatabaseService({
  adapter: "supabase",
  config: {
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseKey: process.env.SUPABASE_SERVICE_KEY!,
  },
});
```

### MockAdapter

In-memory mock for testing with zero infrastructure:

```typescript
const db = await createDatabaseService({
  adapter: "mock",
  config: {
    initialData: {
      users: [{ id: "1", name: "Test" }],
    },
    tableIdColumns: { users: "id" },
    simulateLatency: true, // adds ~50ms delay per operation
    failRate: 0.1, // 10% chance of simulated failure
  },
});
```

## Extensions

Extensions wrap the base adapter in a decorator chain:

```text
Base → Encryption → SoftDelete → Caching → Audit → MultiWrite → ReadReplica
```

They are configured automatically when passed to `createDatabaseService`:

```typescript
const db = await createDatabaseService({
  adapter: "drizzle",
  config: { connectionString: process.env.DATABASE_URL! },
  encryption: {
    keys: { email: process.env.ENCRYPTION_KEY! },
    fields: { users: ["email", "phone"] },
    algorithm: "aes-256-gcm",
  },
  softDelete: {
    tables: ["users"],
    deletedAtField: "deletedAt",
  },
  caching: {
    enabled: true,
    ttl: 300, // 5 minutes
    tables: ["users"],
  },
  audit: {
    enabled: true,
    exclude: ["healthCheck"],
  },
  readReplica: {
    connectionString: process.env.READ_REPLICA_URL!,
  },
  multiWrite: {
    secondaries: [
      { connectionString: process.env.SECONDARY_DB_URL! },
    ],
  },
});
```

### Extensions reference

| Extension | Decorator | What it does |
|-----------|-----------|--------------|
| Encryption | `EncryptionAdapter` | Transparently encrypts/decrypts specified fields |
| SoftDelete | `SoftDeleteAdapter` | Intercepts `delete()` to set `deletedAt` instead |
| Caching | `CachingAdapter` | Caches `findById`/`findMany` results in Redis |
| Audit | `AuditAdapter` | Logs all CRUD operations with context |
| ReadReplica | `ReadReplicaAdapter` | Routes reads to a replica, writes to primary |
| MultiWrite | `MultiWriteAdapter` | Fan-out writes to multiple regions |
| MultiRead | `MultiReadAdapter` | Round-robins reads across read replicas |

## NestJS Integration

Register the module globally:

```typescript
import { Module } from "@nestjs/common";
import { AtlasModule } from "@myko/atlas-client";

@Module({
  imports: [
    AtlasModule.forRoot({
      adapter: "drizzle",
      config: {
        connectionString: process.env.DATABASE_URL!,
      },
    }),
  ],
})
export class AppModule {}
```

Async configuration:

```typescript
AtlasModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    adapter: "drizzle",
    config: { connectionString: config.get("DATABASE_URL")! },
  }),
})
```

Inject the database service:

```typescript
import { Inject } from "@nestjs/common";
import { DATABASE_SERVICE, DatabaseService } from "@myko/atlas-client";

export class UsersService {
  constructor(
    @Inject(DATABASE_SERVICE) private readonly db: DatabaseService,
  ) {}
}
```

## Repository Pattern

```typescript
import { BaseRepository } from "@myko/atlas-client";

interface User {
  id: string;
  name: string;
  email: string;
}

class UsersRepository extends BaseRepository<User> {
  protected tableName = "users";

  async findByEmail(email: string) {
    return this.findFirst({ filter: { field: "email", operator: "eq", value: email } });
  }
}

const repo = new UsersRepository(db);
const user = await repo.findById("abc-123");
```

## Query Builder

```typescript
import { QueryBuilder } from "@myko/atlas-client";

const query = QueryBuilder.create()
  .select("id", "name", "email")
  .from("users")
  .where("email", "=", "test@example.com")
  .orderBy("createdAt", "DESC")
  .limit(10)
  .offset(0)
  .build();

const result = await db.query(query.sql, query.params);
```

## Health Checking

```typescript
const status = await db.healthCheck();
// {
//   success: true,
//   data: {
//     isHealthy: true,
//     responseTime: 5,
//     details: { adapter: "drizzle" },
//   },
// }
```

## Advanced Features

### Sharding

```typescript
import { ShardKey, ShardRouter } from "@myko/atlas-client";

const router = new ShardRouter();
router.registerShardKey("users", { column: "id", shards: 4 });
const shard = router.routeToShard("users", "user-123");
```

### Multi-tenancy

```typescript
import { TenantContext, TenantRepository } from "@myko/atlas-client";

// Set tenant context
TenantContext.run({ tenantId: "org-456" }, async () => {
  const tenantRepo = new TenantRepository(db, "tenant_id");
  // All queries automatically scoped to tenant
  const users = await tenantRepo.findMany("users");
});
```

### Connection Pooling

```typescript
import { DynamicPool } from "@myko/atlas-client";

const pool = DynamicPool.create({
  min: 2,
  max: 20,
  acquireTimeout: 5000,
  idleTimeout: 30000,
});
```

### Monitoring

```typescript
import { MetricsCollector, AlertManager } from "@myko/atlas-client";

const metrics = new MetricsCollector();
metrics.recordQuery("users", "SELECT", 5); // queryName, type, durationMs

const alerts = new AlertManager();
alerts.addRule({
  name: "slow-query",
  evaluate: () => metrics.getTopSlowQueries(5).length > 3,
  severity: "warning",
});
```

### Backup

```typescript
import { BackupService } from "@myko/atlas-client";

const backup = new BackupService(db);
await backup.createBackup({ tables: ["users", "sessions"] });
```

### Migrations

```typescript
import { MigrationManager } from "@myko/atlas-client";

const mgr = new MigrationManager(db, {
  migrationsDir: "./migrations",
  tableName: "_migrations",
});
await mgr.run(); // runs all pending migrations
await mgr.rollback(); // rolls back the last batch
```

### Seeds

```typescript
import { SeedManager } from "@myko/atlas-client";

const seeder = new SeedManager(db, { seedsDir: "./seeds" });
await seeder.run();
```

### Caching Decorators

```typescript
import { Cacheable, CacheEvict } from "@myko/atlas-client";

class UserService {
  @Cacheable({ ttl: 300 })
  async getUser(id: string) { /* ... */ }

  @CacheEvict({ key: "getUser" })
  async updateUser(id: string, data: any) { /* ... */ }
}
```

## Security

```typescript
import { SanitizeHtmlPipe } from "@myko/atlas-client";

// NestJS pipe that sanitizes HTML inputs
@Body(SanitizeHtmlPipe)
data: Record<string, any>;
```

## API Reference

### `createDatabaseService(config)`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `adapter` | `"drizzle" \| "prisma" \| "sql" \| "supabase" \| "mock"` | Yes | Backend adapter |
| `config` | `object` | Yes | Adapter-specific configuration |
| `config.connectionString` | `string` | For drizzle/sql | PostgreSQL connection string |
| `config.tableIdColumns` | `Record<string, string>` | No | Custom ID column per table |
| `encryption` | `object` | No | Encryption extension config |
| `softDelete` | `object` | No | Soft-delete extension config |
| `caching` | `object` | No | Caching extension config |
| `audit` | `object` | No | Audit extension config |
| `readReplica` | `object` | No | Read-replica extension config |
| `multiWrite` | `object` | No | Multi-write extension config |

### `DatabaseService`

| Method | Returns | Description |
|--------|---------|-------------|
| `findById(table, id)` | `DatabaseResult<T \| null>` | Find by primary key |
| `findOne(table, filter)` | `DatabaseResult<T \| null>` | Find first match |
| `findFirst(table, filter)` | `DatabaseResult<T \| null>` | Alias for findOne |
| `findMany(table, options?)` | `DatabaseResult<PaginatedResult<T>>` | List with filters, sort, pagination |
| `create(table, data)` | `DatabaseResult<T>` | Insert row |
| `update(table, id, data)` | `DatabaseResult<T>` | Update by primary key |
| `delete(table, id)` | `DatabaseResult<void>` | Delete by primary key |
| `upsert(table, where, create, update)` | `DatabaseResult<T>` | Insert or update |
| `updateMany(table, where, data)` | `DatabaseResult<number>` | Bulk update |
| `deleteMany(table, where)` | `DatabaseResult<number>` | Bulk delete |
| `batchCreate(table, items)` | `DatabaseResult<T[]>` | Bulk insert |
| `batchUpdate(table, items)` | `DatabaseResult<T[]>` | Bulk update by ID |
| `batchDelete(table, ids)` | `DatabaseResult<number>` | Bulk delete by IDs |
| `batchUpsert(table, items, key)` | `DatabaseResult<T[]>` | Bulk upsert |
| `count(table, filter?)` | `DatabaseResult<number>` | Row count |
| `exists(table, id)` | `DatabaseResult<boolean>` | Existence check |
| `query(sql, params?)` | `Promise<T[]>` | Raw SQL |
| `transaction(callback)` | `DatabaseResult<T>` | Transaction with rollback |
| `healthCheck()` | `DatabaseResult<HealthStatus>` | Connection health |
| `registerTable(name, table, idColumn?)` | `void` | Register table for typed mode |
| `setAuditContext(context)` | `void` | Set audit metadata |
| `on(event, handler)` | `void` | Subscribe to events |
| `off(event, handler)` | `void` | Unsubscribe from events |
| `getStatus()` | `StatusInfo` | Runtime diagnostics |
| `close()` | `Promise<void>` | Graceful shutdown |

### Filter Operators

| Operator | Type | Example |
|----------|------|---------|
| `eq` | `any` | `{ field: "email", operator: "eq", value: "a@b.com" }` |
| `ne` | `any` | Not equal |
| `gt` | `number \| string` | Greater than |
| `gte` | `number \| string` | Greater than or equal |
| `lt` | `number \| string` | Less than |
| `lte` | `number \| string` | Less than or equal |
| `in` | `any[]` | `{ field: "id", operator: "in", value: ["a", "b"] }` |
| `notIn` | `any[]` | Not in array |
| `like` | `string` | SQL LIKE |
| `ilike` | `string` | Case-insensitive LIKE |
| `between` | `[any, any]` | Range inclusive |
| `isNull` | — | `{ field: "email", operator: "isNull" }` |
| `isNotNull` | — | Not null |

## DatabaseResult Monad

Every CRUD method returns `DatabaseResult<T>` — an explicit success/failure wrapper.
No try/catch needed for expected database errors:

```typescript
const result = await db.findById("users", "abc-123");

if (result.success) {
  // result.data is T | null
  console.log(result.data);
} else {
  // result.error is DatabaseError
  console.error(result.error.message, result.error.code);
}
```

## Architecture

```text
┌─────────────────────────────────────────────────────┐
│                   Your Application                   │
├─────────────────────────────────────────────────────┤
│                  BaseRepository<T>                   │
├─────────────────────────────────────────────────────┤
│                  DatabaseService                     │
├─────────────────────────────────────────────────────┤
│   Extension Chain (Encryption → Cache → Audit ...)   │
├─────────────────────────────────────────────────────┤
│    DrizzleAdapter │ PrismaAdapter │ SQLAdapter ...   │
├─────────────────────────────────────────────────────┤
│              pg │ @prisma/client │ supabase-js       │
└─────────────────────────────────────────────────────┘
```

## License

MIT &mdash; MYKO Labs
