# Quick Start

## Installation

```bash
npm install @myko.pk/atlas
```

## 1. Create a Database Service

```ts
import { createDatabaseService } from '@myko.pk/atlas';

const db = await createDatabaseService({
  adapter: 'drizzle',
  config: {
    connectionString: process.env.DATABASE_URL!,
  },
});
```

## 2. CRUD Operations

```ts
// Find by ID
const user = await db.findById('users', 'abc-123');
if (user.success) console.log(user.data);

// Query with filters
const results = await db.findMany('users', {
  filters: { status: 'active' },
  limit: 20,
  offset: 0,
});

// Create
const created = await db.create('users', {
  name: 'Alice',
  email: 'alice@example.com',
});

// Update
const updated = await db.update('users', 'abc-123', {
  status: 'inactive',
});

// Delete
const deleted = await db.delete('users', 'abc-123');
```

## 3. Mock Adapter (for testing)

```ts
import { createDatabaseService } from '@myko.pk/atlas';

const db = await createDatabaseService({
  adapter: 'mock',
  config: {
    data: {
      users: [
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
      ],
    },
  },
});
```

## What's Next?

See the [full README](../README.md) for all adapters, extensions, and NestJS integration.
