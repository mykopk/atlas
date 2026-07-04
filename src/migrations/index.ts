/**
 * @module
 * Database migrations module.
 *
 * Provides migration management for database schema versioning.
 * Supports versioned migration files (SQL/TS/JS), up/down workflows,
 * rollback, migration history tracking, and status reporting.
 *
 * Sub-modules:
 * - {@link "./MigrationManager"} – Manager class for discovering and applying migrations
 * - {@link "./generateDownMigration"} – Utility for auto-generating DOWN migration SQL
 */

export { MigrationManager } from "./MigrationManager";
