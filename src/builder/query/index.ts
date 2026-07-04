/**
 * @module
 * Query builder module.
 *
 * Provides a fluent SQL query builder, raw SQL generation utilities,
 * and ORM-style clause builders (WHERE, ORDER BY, pagination).
 *
 * Composes three sub-modules:
 * - {@link "./sql"} – Safe parameterized SQL clause generation
 * - {@link "./orm"}  – ORM-style (Prisma-compatible) clause builders
 * - {@link "./QueryBuilder"} – Fluent chainable query builder with repository execution
 */

export * from "./sql";
export * from "./orm";
export * from "./QueryBuilder";
