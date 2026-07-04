/**
 * Database adapter implementations for @myko/atlas-client.
 *
 * Each adapter provides a consistent interface for interacting with different
 * database backends. Adapters handle connection management, query execution,
 * and result mapping.
 *
 * @module adapters
 */

/**
 * Supabase client adapter for PostgreSQL databases.
 *
 * Wraps the Supabase JavaScript client to provide type-safe CRUD operations,
 * real-time subscriptions, and storage integration.
 *
 * @example
 * ```typescript
 * import { SupabaseAdapter } from '@myko.pk/atlas-client';
 * const adapter = new SupabaseAdapter({ url: SUPABASE_URL, key: SUPABASE_KEY });
 * ```
 */
export { SupabaseAdapter } from "./supabase/SupabaseAdapter";

/**
 * Plain SQL adapter for direct PostgreSQL queries.
 *
 * Executes raw SQL statements against a PostgreSQL database using a connection pool.
 * Useful for complex queries, transactions, or migrations.
 *
 * @example
 * ```typescript
 * import { SQLAdapter } from '@myko.pk/atlas-client';
 * const adapter = new SQLAdapter({ connectionString: process.env.DATABASE_URL });
 * ```
 */
export { SQLAdapter } from "./sql/SQLAdapter";

/**
 * Mock adapter for testing and development.
 *
 * Simulates database operations in-memory without a real database connection.
 * Ideal for unit tests, integration tests, and local development.
 *
 * @example
 * ```typescript
 * import { MockAdapter } from '@myko.pk/atlas-client';
 * const adapter = new MockAdapter();
 * await adapter.create('users', { id: '1', name: 'Test' });
 * ```
 */
export { MockAdapter } from "./mock/MockAdapter";

/**
 * Drizzle ORM adapter for type-safe SQL queries.
 *
 * Integrates with Drizzle ORM to provide a type-safe query builder
 * that maps directly to database tables and relationships.
 *
 * @example
 * ```typescript
 * import { DrizzleAdapter } from '@myko.pk/atlas-client';
 * const adapter = new DrizzleAdapter(drizzleClient);
 * ```
 */
export { DrizzleAdapter } from "./drizzle/DrizzleAdapter";

/**
 * Prisma ORM adapter for schema-driven database access.
 *
 * Integrates with Prisma ORM to leverage its schema definition,
 * migrations, and type-safe client generation.
 *
 * @example
 * ```typescript
 * import { PrismaAdapter } from '@myko.pk/atlas-client';
 * const adapter = new PrismaAdapter(prismaClient);
 * ```
 */
export { PrismaAdapter } from "./prisma/PrismaAdapter";
