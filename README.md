<p align="center">
  <h1 align="center">@myko.pk/atlas</h1>
  <p align="center"><strong>One API. Any Database.</strong></p>
  <p align="center">Unified database abstraction layer for the MYKO ecosystem — Drizzle ORM, Prisma, raw SQL, Supabase, or Mock.</p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@myko.pk/atlas"><img src="https://img.shields.io/npm/v/@myko.pk/atlas" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/@myko.pk/atlas"><img src="https://img.shields.io/npm/dm/@myko.pk/atlas" alt="npm downloads"></a>
    <a href="https://github.com/mykopk/atlas/actions"><img src="https://img.shields.io/github/actions/workflow/status/mykopk/atlas/.github/workflows/ci.yml?branch=main" alt="build"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@myko.pk/atlas" alt="license"></a>
  </p>
</p>

---

```typescript
import { createDatabaseService } from "@myko.pk/atlas";

const db = await createDatabaseService({
  adapter: "drizzle",
  config: { connectionString: process.env.DATABASE_URL },
});

const user = await db.findById("users", "abc-123");
```

## Why @myko.pk/atlas?

Every MYKO service needs a database. But not every service uses the same stack — some use Drizzle ORM, some still run Prisma, others talk directly to PostgreSQL or Supabase. Without a common layer, each service duplicates the same boilerplate: connection management, error handling, pagination, caching, audit logs, encryption.

**@myko.pk/atlas** gives every service the same database API regardless of what's underneath. Swap Drizzle for Prisma (or vice versa) by changing one config line — zero code changes in your repositories. Need encryption? Add a config block. Need caching? Add another. All extensions compose transparently without touching your business logic.

```typescript
// Same API, different adapter — only the config changes
const db = await createDatabaseService({ adapter: "drizzle", ... });
const db = await createDatabaseService({ adapter: "prisma",  ... });
const db = await createDatabaseService({ adapter: "sql",     ... });
```

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Choose Your Path](#choose-your-path)
  - [DrizzleAdapter](#drizzleadapter)
  - [PrismaAdapter](#prismaadapter)
  - [SQLAdapter](#sqladapter)
  - [SupabaseAdapter](#supabaseadapter)
  - [MockAdapter](#mockadapter)
- [Extensions](#extensions)
- [NestJS](#nestjs-integration)
- [Repository Pattern](#repository-pattern)
- [Advanced Features](#advanced-features)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [License](#license)

---

## Features

- **Multi-adapter** — Drizzle ORM, Prisma, raw SQL, Supabase, Mock — same API for all
- **Extension decorator chain** — compose Encryption → SoftDelete → Caching → Audit → ReadReplica → MultiWrite
- **NestJS native** — `AtlasModule.forRoot()` / `forRootAsync()` with dependency injection
- **Repository pattern** — `BaseRepository<T>` with integrated QueryBuilder
- **Advanced out of the box** — sharding, multi-tenancy, connection pooling, monitoring, backup, migrations, seeds
- **Dual-mode DrizzleAdapter** — typed ORM (PgTable) where you want it, raw SQL fallback where you don't
- **`DatabaseResult<T>` monad** — every operation returns success/failure explicitly, no thrown errors
- **Dual CJS/ESM** — `require()` and `import` both supported
- **Fully documented** — JSDoc on every public API, comprehensive README

---

## Quick Start

```bash
npm install @myko.pk/atlas-client
```

```typescript
import { createDatabaseService } from "@myko.pk/atlas";

const db = await createDatabaseService({
  adapter: "drizzle",
  config: {
    connectionString: process.env.DATABASE_URL!,
    tableIdColumns: { users: "user_id" },  // custom PK
  },
});

// Get by ID
const user = await db.findById("users", "abc-123");
if (user.success) console.log(user.data);

// List with filters, pagination, sorting
const result = await db.findMany("users", {
  filters: [{ field: "email", operator: "eq", value: "test@example.com" }],
  pagination: { limit: 10, offset: 0 },
  sort: [{ field: "createdAt", direction: "desc" }],
});
```

---

## Installation

```bash
npm install @myko.pk/atlas-client
```

### Optional peer dependencies

Only install what you need:

```bash
# For PrismaAdapter
npm install @prisma/client

# For NestJS integration
npm install @nestjs/common

# For advanced Redis caching
npm install ioredis
```

`drizzle-orm` and `pg` are bundled — no extra install needed for the DrizzleAdapter.

---

## Choose Your Path

### DrizzleAdapter

Two modes: **typed ORM** with registered `PgTable` objects, or **raw SQL** fallback.

```typescript
import { createDatabaseService } from "@myko.pk/atlas";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
});

const db = await createDatabaseService({
  adapter: "drizzle",
  config: { connectionString: process.env.DATABASE_URL! },
});

// Register PgTable → typed ORM mode
const reg = db as any;
reg.registerTable("users", users, users.id);

// Now uses Drizzle query builder, not raw SQL
await db.findById("users", "abc-123");
```

Unregistered tables fall back to `SELECT * FROM "table" WHERE "id" = $1` automatically.

### PrismaAdapter

```typescript
const db = await createDatabaseService({
  adapter: "prisma",
  config: { datasourceUrl: process.env.DATABASE_URL! },
});
// Loads @prisma/client via dynamic import at runtime
```

### SQLAdapter

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

Zero-infrastructure in-memory database for testing:

```typescript
const db = await createDatabaseService({
  adapter: "mock",
  config: {
    initialData: { users: [{ id: "1", name: "Test" }] },
    simulateLatency: true, // ~50ms per operation
    failRate: 0.1,         // 10% chance of simulated failure
    tableIdColumns: { users: "id" },
  },
});
```

---

## Extensions

Extensions wrap the base adapter in a decorator chain. Configure them all in one `createDatabaseService` call:

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
  },

  caching: {
    enabled: true,
    ttl: 300,
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
    secondaries: [{ connectionString: process.env.SECONDARY_DB_URL! }],
  },
});
```

| Extension | Decorator | What it does |
|-----------|-----------|--------------|
| Encryption | `EncryptionAdapter` | Transparently encrypts/decrypts specified fields |
| SoftDelete | `SoftDeleteAdapter` | Intercepts `delete()` → sets `deletedAt` instead |
| Caching | `CachingAdapter` | Caches `findById`/`findMany` in Redis |
| Audit | `AuditAdapter` | Logs all CRUD operations with context |
| ReadReplica | `ReadReplicaAdapter` | Routes reads to replica, writes to primary |
| MultiWrite | `MultiWriteAdapter` | Fan-out writes to secondary regions |
| MultiRead | `MultiReadAdapter` | Round-robins reads across replicas |

---

## NestJS Integration

```typescript
import { Module } from "@nestjs/common";
import { AtlasModule } from "@myko.pk/atlas-client";

@Module({
  imports: [
    AtlasModule.forRoot({
      adapter: "drizzle",
      config: { connectionString: process.env.DATABASE_URL! },
    }),
  ],
})
export class AppModule {}

// Async configuration
AtlasModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    adapter: "drizzle",
    config: { connectionString: config.get("DATABASE_URL")! },
  }),
});
```

Inject anywhere:

```typescript
import { Inject } from "@nestjs/common";
import { DATABASE_SERVICE, DatabaseService } from "@myko.pk/atlas-client";

export class UsersService {
  constructor(
    @Inject(DATABASE_SERVICE) private readonly db: DatabaseService,
  ) {}
}
```

---

## Repository Pattern

```typescript
import { BaseRepository } from "@myko.pk/atlas-client";

interface User { id: string; name: string; email: string; }

class UsersRepository extends BaseRepository<User> {
  protected tableName = "users";

  async findByEmail(email: string) {
    return this.findFirst({
      filter: { field: "email", operator: "eq", value: email },
    });
  }
}

const repo = new UsersRepository(db);
const user = await repo.findById("abc-123");
```

---

## Advanced Features

| Feature | Module | What it does |
|---------|--------|-------------|
| Sharding | `ShardKey`, `ShardRouter` | Route queries by shard key |
| Multi-tenancy | `TenantContext`, `TenantRepository` | Auto-scope queries to tenant |
| Connection Pool | `DynamicPool` | Configurable min/max/acquire/idle |
| Monitoring | `MetricsCollector`, `AlertManager` | Track slow queries, N+1 detection |
| Backup | `BackupService` | Export table data |
| Migrations | `MigrationManager` | Run/rollback migration batches |
| Seeds | `SeedManager` | Run seed files |
| Caching decorators | `@Cacheable`, `@CacheEvict` | Method-level Redis caching |
| Query Builder | `QueryBuilder` | Fluent SELECT/WHERE/JOIN builder |
| Security | `SanitizeHtmlPipe` | NestJS HTML sanitization pipe |

---

## API Reference

### `createDatabaseService(config)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `adapter` | `"drizzle" \| "prisma" \| "sql" \| "supabase" \| "mock"` | Yes | Backend adapter |
| `config` | `object` | Yes | Adapter-specific config |
| `config.connectionString` | `string` | For drizzle/sql | PostgreSQL connection string |
| `config.tableIdColumns` | `Record<string, string>` | No | Custom PK per table |
| `encryption` | `object` | No | Encryption extension |
| `softDelete` | `object` | No | Soft-delete extension |
| `caching` | `object` | No | Caching extension |
| `audit` | `object` | No | Audit extension |
| `readReplica` | `object` | No | Read-replica extension |
| `multiWrite` | `object` | No | Multi-write extension |

### `DatabaseService` methods

| Method | Returns | Description |
|--------|---------|-------------|
| `findById(table, id)` | `DatabaseResult<T \| null>` | By primary key |
| `findOne(table, filter)` | `DatabaseResult<T \| null>` | First match |
| `findFirst(table, filter)` | `DatabaseResult<T \| null>` | Alias for findOne |
| `findMany(table, opts?)` | `DatabaseResult<PaginatedResult<T>>` | Filtered + sorted + paginated |
| `create(table, data)` | `DatabaseResult<T>` | Insert |
| `update(table, id, data)` | `DatabaseResult<T>` | Update by PK |
| `delete(table, id)` | `DatabaseResult<void>` | Delete by PK |
| `upsert(table, where, create, upd)` | `DatabaseResult<T>` | Insert on conflict |
| `updateMany(table, where, data)` | `DatabaseResult<number>` | Bulk update |
| `deleteMany(table, where)` | `DatabaseResult<number>` | Bulk delete |
| `batchCreate(table, items)` | `DatabaseResult<T[]>` | Bulk insert |
| `batchUpdate(table, items)` | `DatabaseResult<T[]>` | Bulk update by ID |
| `batchDelete(table, ids)` | `DatabaseResult<number>` | Bulk delete by IDs |
| `batchUpsert(table, items, key)` | `DatabaseResult<T[]>` | Bulk upsert |
| `count(table, filter?)` | `DatabaseResult<number>` | Row count |
| `exists(table, id)` | `DatabaseResult<boolean>` | Exists check |
| `query(sql, params?)` | `Promise<T[]>` | Raw SQL |
| `transaction(cb)` | `DatabaseResult<T>` | Transaction |
| `healthCheck()` | `DatabaseResult<HealthStatus>` | Connection health |
| `registerTable(name, table, idCol?)` | `void` | Register for typed mode |
| `setAuditContext(ctx)` | `void` | Audit metadata |
| `on(event, handler)` | `void` | Subscribe |
| `off(event, handler)` | `void` | Unsubscribe |
| `close()` | `Promise<void>` | Shutdown |

### Filter operators

| Operator | Type | Example |
|----------|------|---------|
| `eq` | `any` | `{ field: "email", operator: "eq", value: "a@b.com" }` |
| `ne` | `any` | Not equal |
| `gt` | `number \| string` | Greater than |
| `gte` | `number \| string` | Greater than or equal |
| `lt` | `number \| string` | Less than |
| `lte` | `number \| string` | Less than or equal |
| `in` | `any[]` | `{ field: "id", operator: "in", value: ["a", "b"] }` |
| `notIn` | `any[]` | Not in |
| `like` | `string` | SQL LIKE |
| `ilike` | `string` | Case-insensitive LIKE |
| `between` | `[any, any]` | Range inclusive |
| `isNull` | — | `{ field: "email", operator: "isNull" }` |
| `isNotNull` | — | `{ field: "email", operator: "isNotNull" }` |

### DatabaseResult monad

Every CRUD method returns `DatabaseResult<T>` — never throw for expected errors:

```typescript
const result = await db.findById("users", "abc-123");

if (result.success) {
  console.log(result.data);
} else {
  console.error(result.error.message, result.error.code);
}
```

---

## Architecture

```text
┌─────────────────────────────────────────────┐
│           Your Application / NestJS         │
├─────────────────────────────────────────────┤
│              BaseRepository<T>              │
├─────────────────────────────────────────────┤
│              DatabaseService                │
├─────────────────────────────────────────────┤
│  Extensions (Encrypt → Cache → Audit …)     │
├─────────────────────────────────────────────┤
│  Drizzle │ Prisma │ SQL │ Supabase │ Mock   │
├─────────────────────────────────────────────┤
│      pg │ @prisma/client │ supabase-js      │
└─────────────────────────────────────────────┘
```

---

## Project Structure

```
src/
├── adapters/          # Drizzle, Prisma, SQL, Supabase, Mock
├── advanced/          # Sharding, multi-tenancy, pools, monitoring, backup
├── builder/query/     # Fluent QueryBuilder (ORM + SQL)
├── extensions/        # Encryption, SoftDelete, Caching, Audit, Multi-*
├── factory/           # AdapterFactory, createDatabaseService
├── migrations/        # MigrationManager
├── nestjs/            # AtlasModule, DATABASE_SERVICE token
├── repository/        # BaseRepository
├── security/          # HTML sanitizer, validation pipes
├── seeds/             # SeedManager
├── service/           # DatabaseService, EventEmitter, HealthManager
└── utils/             # ConfigMerger, pagination, typeGuards, regex, SQL
```

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`npm run build && npm test`)
4. Push and open a PR

All contributions are welcome — bugs, docs, features, tests.

---

## Roadmap

- [ ] Biome linting + formatting (replace ESLint + Prettier)
- [ ] Changesets for automated versioning + changelog
- [ ] GitHub Actions publish workflow with Trusted Publishing (OIDC)
- [ ] OpenAPI/Swagger integration
- [ ] GraphQL adapter
- [ ] Edge runtime support (Vercel Edge, Cloudflare Workers)

---

## FAQ

**Q: Do I need NestJS to use this?**
No. `createDatabaseService` works standalone. NestJS integration is entirely optional.

**Q: Can I use DrizzleAdapter without registering PgTable objects?**
Yes. Unregistered tables use raw SQL (`SELECT * FROM "table" WHERE "id" = $1`).

**Q: How do I run migrations?**
```typescript
import { MigrationManager } from "@myko.pk/atlas-client";
const mgr = new MigrationManager(db, { migrationsDir: "./migrations" });
await mgr.run();
```

**Q: Does it support transactions?**
Yes. `db.transaction(async (trx) => { ... })` with automatic commit/rollback.

**Q: What Node.js versions are supported?**
Node 18+.

**Q: What about edge/worker runtimes?**
Currently Node.js only. Edge support is on the roadmap.

---

## License

MIT License — Copyright © 2026 MYKO Pakistan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software to use, copy, modify, merge, publish, distribute, sublicense,
and sell copies. See [`LICENSE`](./LICENSE) for full terms.

---

## Company

**MYKO Pakistan**

| Detail | Information |
|--------|-------------|
| **Website** | [myko.pk](https://myko.pk) |
| **Email** | [support@myko.pk](mailto:support@myko.pk) |
| **About** | Building digital infrastructure and super-app experiences for millions of users across Pakistan. |

---

<p align="center">Built with ❤️ in Pakistan 🇵🇰</p>
