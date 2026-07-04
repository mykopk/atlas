/**
 * MigrationManager - Database schema migrations with version control.
 *
 * @description
 * Manages database schema migrations with support for versioning,
 * rollback, and migration history tracking. Automatically discovers
 * migration files from a specified directory and applies them in order.
 *
 * Supports three file types:
 * - **SQL** (`.sql`) — inlined UP/DOWN sections delimited by `-- DOWN`
 * - **TypeScript** (`.ts`) — exported `up`/`down` functions
 * - **JavaScript** (`.js`) — exported `up`/`down` functions
 *
 * @example
 * ```typescript
 * const manager = new MigrationManager({
 *   adapter: sqlAdapter,
 *   migrationsPath: './migrations',
 *   tableName: 'schema_migrations',
 * });
 *
 * // Apply all pending migrations
 * await manager.up();
 *
 * // Rollback the last migration
 * await manager.down();
 *
 * // Inspect what's applied vs pending
 * const status = await manager.status();
 * ```
 */

import type {
  DatabaseAdapterType,
  DatabaseResult,
  Migration,
  MigrationFile,
  MigrationRecord,
  MigrationManagerConfig,
  MigrationStatus,
} from "@myko.pk/types/db";
import { success, failure } from "../utils/databaseResultHelpers";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";
import * as fs from "fs";
import * as path from "path";

/** Constants for statement description extraction */
const DESCRIPTION_MAX_LENGTH = 60;
const FALLBACK_DESCRIPTION_LENGTH = 50;

/** Constants for progress logging */
const PROGRESS_LOG_INTERVAL = 10;

/** Constants for error message truncation */
const ERROR_MESSAGE_MAX_LENGTH = 300;

/**
 * MigrationManager - Handles database schema migrations.
 *
 * @description
 * Discovers migration files, tracks migration history, and applies
 * migrations in order with support for rollback. Each migration can be
 * a SQL file with `-- UP` / `-- DOWN` sections, or a TypeScript/JavaScript
 * module exporting `up(databaseAdapter)` and `down(databaseAdapter)` functions.
 *
 * Lifecycle:
 * 1. Call {@link initialize} once to create the tracking table.
 * 2. Call {@link up} to apply pending migrations.
 * 3. Call {@link down} to roll back the most recent migration(s).
 * 4. Call {@link status} to inspect the current state.
 * 5. Call {@link reset} to roll back every applied migration.
 * 6. Use {@link clearHistory} in test/dev to reset tracking without undoing DDL.
 */
export class MigrationManager {
  private adapter: DatabaseAdapterType;
  private migrationsPath: string;
  private tableName: string;
  private schema: string;

  /**
   * Create a MigrationManager.
   *
   * @param config - Configuration object
   * @param config.adapter - The database adapter used for query execution
   * @param config.migrationsPath - Path to the directory containing migration files (default: `"./migrations"`)
   * @param config.tableName - Name of the migration tracking table (default: `"schema_migrations"`)
   * @param config.schema - Database schema name (default: `"public"`)
   */
  constructor(config: MigrationManagerConfig) {
    this.adapter = config.adapter;
    this.migrationsPath = path.resolve(config.migrationsPath ?? "./migrations");
    this.schema = config.schema ?? "public";
    // Prefix table name with schema if not 'public'
    this.tableName =
      this.schema !== "public"
        ? `${this.schema}.${config.tableName ?? "schema_migrations"}`
        : (config.tableName ?? "schema_migrations");
  }

  /**
   * Initialize the migrations tracking table if it doesn't exist.
   *
   * @description
   * Creates the `schema_migrations` table (or custom name) with columns for
   * version, name, file_path, applied_at, and execution_time. Also attempts
   * to backfill a `file_path` column for installations that pre-date this feature.
   *
   * @returns `DatabaseResult<void>` – resolves when the table is ready
   */
  async initialize(): Promise<DatabaseResult<void>> {
    try {
      // Create migrations tracking table with file_path for traceability
      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          version VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          file_path VARCHAR(500),
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          execution_time INTEGER NOT NULL
        )
      `;

      // Execute using adapter's raw query if available
      if (typeof this.adapter.query === "function") {
        await this.adapter.query(createTableSQL);

        // Add file_path column if it doesn't exist (for existing tables)
        await this.adapter
          .query(
            `
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = '${this.tableName.split(".").pop()}'
              AND column_name = 'file_path'
            ) THEN
              ALTER TABLE ${this.tableName} ADD COLUMN file_path VARCHAR(500);
            END IF;
          END $$;
        `,
          )
          .catch(() => {
            // Ignore if column already exists or syntax not supported
          });
      }

      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to initialize migrations table: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.INIT_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Discover migration files from the migrations directory (recursive).
   *
   * @description
   * Recursively scans `migrationsPath` for files matching the pattern
   * `{version}_{name}.{ts|js|sql}` (e.g. `001_initial_schema.sql`,
   * `20231124_add_users_table.ts`). Returns files sorted by version
   * (ascending, using locale compare so `"9" < "10"` is handled lexicographically).
   *
   * @returns Array of discovered migration file metadata
   */
  private async discoverMigrations(): Promise<MigrationFile[]> {
    if (!fs.existsSync(this.migrationsPath)) {
      return [];
    }

    const migrations: MigrationFile[] = [];

    const scanDirectory = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          scanDirectory(fullPath);
        } else if (entry.isFile()) {
          // Match migration file pattern: {version}_{name}.{ts|js|sql}
          // Examples: 001_initial_schema.sql, 20231124_add_users_table.ts
          const match = entry.name.match(/^(\d+)_(.+)\.(ts|js|sql)$/);
          if (match) {
            const [, version, name] = match;
            migrations.push({
              filePath: fullPath,
              version,
              name: name.replace(/_/g, " "),
            });
          }
        }
      }
    };

    scanDirectory(this.migrationsPath);

    // Sort by version
    return migrations.sort((a, b) => a.version.localeCompare(b.version));
  }

  /**
   * Parse SQL content to extract `-- UP` and `-- DOWN` sections.
   *
   * @param sql - Raw SQL content of a migration file
   * @returns Parsed sections — `upSQL` and optionally `downSQL`
   */
  private parseSqlSections(sql: string): {
    upSQL: string;
    downSQL: string | null;
  } {
    const hasUpMarker = sql.includes("-- UP");
    const hasDownMarker = sql.includes("-- DOWN");

    if (hasUpMarker && hasDownMarker) {
      const parts = sql.split("-- DOWN");
      return {
        upSQL: parts[0].replace("-- UP", "").trim(),
        downSQL: parts[1].trim(),
      };
    }

    if (hasDownMarker) {
      const parts = sql.split("-- DOWN");
      return {
        upSQL: parts[0].trim(),
        downSQL: parts[1].trim(),
      };
    }

    return { upSQL: sql.trim(), downSQL: null };
  }

  /**
   * Process dollar-quoted string delimiters (`$$` or `$tag$`).
   *
   * @returns Updated state for tracking whether we are inside a dollar block
   */
  private processDollarDelimiters(
    line: string,
    inDollarBlock: boolean,
    dollarTag: string,
  ): { inDollarBlock: boolean; dollarTag: string } {
    const dollarMatch = line.match(/\$([a-zA-Z_]*)\$/g);
    if (!dollarMatch) return { inDollarBlock, dollarTag };

    let currentInBlock = inDollarBlock;
    let currentTag = dollarTag;

    for (const match of dollarMatch) {
      if (!currentInBlock) {
        currentInBlock = true;
        currentTag = match;
      } else if (match === currentTag) {
        currentInBlock = false;
        currentTag = "";
      }
    }

    return { inDollarBlock: currentInBlock, dollarTag: currentTag };
  }

  /**
   * Check whether a SQL statement is a comment-only line.
   *
   * @returns `true` if the statement has no SQL content after removing comments
   */
  private isNonCommentStatement(statement: string): boolean {
    const withoutComments = statement.replace(/--.*$/gm, "").trim();
    return withoutComments.length > 0;
  }

  /**
   * Split SQL into individual statements, respecting `$$` dollar-quoted blocks.
   *
   * @description
   * Splits on semicolons but correctly handles PL/pgSQL function/trigger bodies
   * that use `$$` or `$tag$` delimiters (which may contain internal semicolons).
   *
   * @param sql - Raw SQL content
   * @returns Array of individual SQL statement strings
   */
  private splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = "";
    let inDollarBlock = false;
    let dollarTag = "";

    for (const line of sql.split("\n")) {
      const trimmedLine = line.trim();
      const isEmptyOrComment =
        trimmedLine === "" || trimmedLine.startsWith("--");

      // Always append line to current statement
      current += line + "\n";

      // Skip processing for empty lines and comments
      if (isEmptyOrComment) continue;

      // Update dollar block tracking
      const dollarState = this.processDollarDelimiters(
        line,
        inDollarBlock,
        dollarTag,
      );
      inDollarBlock = dollarState.inDollarBlock;
      dollarTag = dollarState.dollarTag;

      // Check for end of statement
      const isEndOfStatement = !inDollarBlock && trimmedLine.endsWith(";");
      if (isEndOfStatement && current.trim()) {
        statements.push(current.trim());
        current = "";
      }
    }

    // Add any remaining content
    if (current.trim()) {
      statements.push(current.trim());
    }

    return statements.filter((s) => this.isNonCommentStatement(s));
  }

  /**
   * Extract a short human-readable description from a SQL statement for logging.
   *
   * @param statement - A raw SQL statement
   * @returns A truncated description (e.g. `"CREATE TABLE users"`)
   */
  private getStatementDescription(statement: string): string {
    const firstLine =
      statement
        .split("\n")
        .find((l) => l.trim() && !l.trim().startsWith("--"))
        ?.trim() ?? "";

    // Extract the type and name of the object being created/modified
    const patterns = [
      /^(CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|TYPE|FUNCTION|TRIGGER|EXTENSION|SCHEMA|VIEW|POLICY))\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i,
      /^(ALTER\s+TABLE)\s+([^\s]+)/i,
      /^(DROP\s+(?:TABLE|INDEX|TYPE|FUNCTION|TRIGGER|EXTENSION|SCHEMA|VIEW|POLICY))\s+(?:IF\s+EXISTS\s+)?([^\s(;]+)/i,
      /^(INSERT\s+INTO)\s+([^\s(]+)/i,
      /^(COMMENT\s+ON\s+(?:TABLE|COLUMN|INDEX|FUNCTION|TYPE))\s+([^\s]+)/i,
      /^(GRANT|REVOKE)\s+.+\s+ON\s+([^\s]+)/i,
    ];

    for (const pattern of patterns) {
      const match = firstLine.match(pattern);
      if (match) {
        return `${match[1]} ${match[2]}`.slice(0, DESCRIPTION_MAX_LENGTH);
      }
    }

    const truncated = firstLine.slice(0, FALLBACK_DESCRIPTION_LENGTH);
    const suffix = firstLine.length > FALLBACK_DESCRIPTION_LENGTH ? "..." : "";
    return truncated + suffix;
  }

  /**
   * Execute SQL statements individually with detailed error reporting.
   *
   * @param adapter - The database adapter to execute against
   * @param sql - Raw SQL containing one or more statements
   * @param migrationVersion - Migration version string (used in error messages for traceability)
   * @throws {DatabaseError} `QUERY_FAILED` with the exact statement index and description
   *   if any statement fails
   */
  private async executeSqlStatements(
    adapter: DatabaseAdapterType,
    sql: string,
    migrationVersion: string,
  ): Promise<void> {
    const statements = this.splitSqlStatements(sql);
    const total = statements.length;

    console.log(`  → ${total} statements to execute`);

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const description = this.getStatementDescription(statement);

      try {
        await adapter.query!(statement);
        // Show progress at intervals or for significant operations
        const isInterval = (i + 1) % PROGRESS_LOG_INTERVAL === 0;
        const isLast = i === total - 1;
        const isSignificant = Boolean(
          description.match(/^(CREATE TABLE|CREATE FUNCTION|CREATE TRIGGER)/i),
        );
        if (isInterval || isLast || isSignificant) {
          console.log(`  ✓ [${i + 1}/${total}] ${description}`);
        }
      } catch (error) {
        console.log(`  ✗ [${i + 1}/${total}] ${description}`);

        // Extract clean error message
        const rawMessage = (error as Error).message;
        const errorMessage = rawMessage
          .replace(/^SQL Error:\s*/i, "")
          .replace(/^Failed to execute query:.*?-\s*/i, "")
          .slice(0, ERROR_MESSAGE_MAX_LENGTH);

        throw new DatabaseError(
          `Migration ${migrationVersion} failed at statement ${i + 1}/${total}:\n` +
            `  Statement: ${description}\n` +
            `  Error: ${errorMessage}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        );
      }
    }
  }

  /**
   * Load a SQL migration from a `.sql` file.
   *
   * @description
   * Reads the file, parses `-- UP` / `-- DOWN` sections, and returns a
   * Migration object that executes statements one-by-one through the adapter.
   *
   * @param migrationFile - Migration file metadata
   * @returns A Migration with `up` and `down` async functions
   */
  private loadSqlMigration(migrationFile: MigrationFile): Migration {
    const sql = fs.readFileSync(migrationFile.filePath, "utf-8");
    const { upSQL, downSQL } = this.parseSqlSections(sql);

    return {
      version: migrationFile.version,
      name: migrationFile.name,
      up: async (adapter: DatabaseAdapterType) => {
        if (typeof adapter.query === "function") {
          await this.executeSqlStatements(
            adapter,
            upSQL,
            migrationFile.version,
          );
        }
      },
      down: async (adapter: DatabaseAdapterType) => {
        if (downSQL && typeof adapter.query === "function") {
          await this.executeSqlStatements(
            adapter,
            downSQL,
            migrationFile.version,
          );
        } else {
          console.warn(
            `[Migrations] No DOWN migration for ${migrationFile.version}`,
          );
        }
      },
    };
  }

  /**
   * Load a TypeScript/JavaScript migration from a `.ts` or `.js` file.
   *
   * @description
   * Dynamically imports the module and resolves `up`/`down` functions,
   * checking both named exports and `default` export properties.
   *
   * @param migrationFile - Migration file metadata
   * @returns A Migration with `up` and `down` async functions
   */
  private async loadJsMigration(
    migrationFile: MigrationFile,
  ): Promise<Migration> {
    const importPath = migrationFile.filePath.startsWith("/")
      ? migrationFile.filePath
      : new URL(`file:///${migrationFile.filePath.replace(/\\/g, "/")}`).href;

    const migrationModule = await import(importPath);
    return {
      version: migrationFile.version,
      name: migrationFile.name,
      up: migrationModule.up ?? migrationModule.default?.up,
      down: migrationModule.down ?? migrationModule.default?.down,
    };
  }

  /**
   * Load a migration from a file, dispatching to the correct handler by extension.
   *
   * @param migrationFile - Migration file metadata
   * @returns A Migration with `up` and `down` async functions
   * @throws {DatabaseError} `INVALID_PARAMETERS` if the file extension is not
   *   `.sql`, `.ts`, or `.js`
   */
  private async loadMigration(
    migrationFile: MigrationFile,
  ): Promise<Migration> {
    const ext = path.extname(migrationFile.filePath);

    switch (ext) {
      case ".sql":
        return this.loadSqlMigration(migrationFile);
      case ".ts":
      case ".js":
        return this.loadJsMigration(migrationFile);
      default:
        throw new DatabaseError(
          `Unsupported migration file extension: ${ext}`,
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          { cause: new Error(`Unsupported extension: ${ext}`) },
        );
    }
  }

  /**
   * Get applied migrations from the tracking table.
   *
   * @returns Array of migration records, ordered by version ascending.
   *          Returns an empty array if the table doesn't exist yet.
   */
  private async getAppliedMigrations(): Promise<MigrationRecord[]> {
    try {
      if (typeof this.adapter.query === "function") {
        const result = await this.adapter.query<MigrationRecord>(
          `SELECT * FROM ${this.tableName} ORDER BY version ASC`,
        );
        // Handle both array results and postgres-style { rows: [] } results
        return Array.isArray(result)
          ? result
          : (result as unknown as { rows: MigrationRecord[] }).rows || [];
      }
      return [];
    } catch {
      // Table might not exist yet
      return [];
    }
  }

  /**
   * Record a migration as applied in the tracking table.
   *
   * @param version - Migration version string
   * @param name - Human-readable migration name
   * @param executionTime - Duration in milliseconds
   * @param filePath - Absolute file path (stored as relative for portability)
   */
  private async recordMigration(
    version: string,
    name: string,
    executionTime: number,
    filePath?: string,
  ): Promise<void> {
    if (typeof this.adapter.query === "function") {
      // Store relative path from migrations directory for portability
      const relativePath = filePath
        ? path.relative(this.migrationsPath, filePath)
        : null;

      await this.adapter.query(
        `INSERT INTO ${this.tableName} (version, name, file_path, execution_time) VALUES ($1, $2, $3, $4)`,
        [version, name, relativePath, executionTime],
      );
    }
  }

  /**
   * Remove a migration record from the tracking table (used during rollback).
   *
   * @param version - Migration version string to delete
   */
  private async unrecordMigration(version: string): Promise<void> {
    if (typeof this.adapter.query === "function") {
      await this.adapter.query(
        `DELETE FROM ${this.tableName} WHERE version = $1`,
        [version],
      );
    }
  }

  /**
   * Get migration status — which migrations are applied and which are pending.
   *
   * @description
   * Initialises the tracking table if needed, discovers all migration files,
   * and compares them against the applied set.
   *
   * @returns `DatabaseResult<MigrationStatus>` with `applied` array and `pending` name array
   *
   * @example
   * ```typescript
   * const { value } = await manager.status();
   * console.log('Applied:', value.applied.length);
   * console.log('Pending:', value.pending);
   * ```
   */
  async status(): Promise<DatabaseResult<MigrationStatus>> {
    try {
      await this.initialize();

      const allMigrations = await this.discoverMigrations();
      const appliedMigrations = await this.getAppliedMigrations();
      const appliedVersions = new Set(appliedMigrations.map((m) => m.version));

      const pending = allMigrations
        .filter((m) => !appliedVersions.has(m.version))
        .map((m) => `${m.version}_${m.name}`);

      return success({
        applied: appliedMigrations,
        pending,
      });
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to get migration status: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Run all pending migrations, or up to a specific target version.
   *
   * @description
   * Initialises the tracking table, discovers migration files, filters out
   * already-applied migrations, and applies each pending migration in order.
   * Each migration is wrapped in a transaction if the adapter supports it.
   *
   * @param targetVersion - If provided, only migrations with `version <= targetVersion`
   *   are applied (useful for partial upgrades)
   * @returns `DatabaseResult<number>` – the count of migrations applied
   *
   * @example
   * ```typescript
   * // Apply everything
   * await manager.up();
   *
   * // Apply only up to version 003
   * await manager.up('003');
   * ```
   */
  /* eslint-disable max-depth, complexity */
  async up(targetVersion?: string): Promise<DatabaseResult<number>> {
    try {
      await this.initialize();

      const allMigrations = await this.discoverMigrations();
      const appliedMigrations = await this.getAppliedMigrations();
      const appliedVersions = new Set(appliedMigrations.map((m) => m.version));

      let applied = 0;

      for (const migrationFile of allMigrations) {
        // Skip if already applied
        if (appliedVersions.has(migrationFile.version)) {
          continue;
        }

        // Stop if we've reached target version
        if (targetVersion && migrationFile.version > targetVersion) {
          break;
        }

        console.log(
          `[Migrations] Applying ${migrationFile.version}_${migrationFile.name}...`,
        );

        const migration = await this.loadMigration(migrationFile);
        const startTime = Date.now();

        // Run migration in transaction if possible
        if (typeof this.adapter.transaction === "function") {
          const txResult = await this.adapter.transaction(async () => {
            await migration.up(this.adapter);
          });
          // Check transaction result - transaction() returns failure() instead of throwing
          if (!txResult.success) {
            throw (
              txResult.error ??
              new DatabaseError(
                `Migration ${migration.version} failed`,
                DATABASE_ERROR_CODES.QUERY_FAILED,
              )
            );
          }
        } else {
          await migration.up(this.adapter);
        }

        const executionTime = Date.now() - startTime;

        // Record migration with file path for traceability
        await this.recordMigration(
          migration.version,
          migration.name,
          executionTime,
          migrationFile.filePath,
        );

        console.log(
          `[Migrations] Applied ${migration.version} in ${executionTime}ms`,
        );
        applied++;
      }

      return success(applied);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Migration failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Rollback the most recent migration(s).
   *
   * @description
   * Reverses the most recently applied migrations by calling `down()` on
   * each. Migrations are rolled back in reverse-applied order. Each rollback
   * is wrapped in a transaction if the adapter supports it.
   *
   * @param steps - Number of migrations to roll back (default: `1`).
   *   Must be >= 1.
   * @returns `DatabaseResult<number>` – the count of migrations rolled back
   *
   * @example
   * ```typescript
   * // Rollback the last migration
   * await manager.down();
   *
   * // Rollback three migrations
   * await manager.down(3);
   * ```
   */
  async down(steps: number = 1): Promise<DatabaseResult<number>> {
    try {
      const appliedMigrations = await this.getAppliedMigrations();

      if (appliedMigrations.length === 0) {
        return success(0);
      }

      // Get migrations to rollback (in reverse order)
      const toRollback = appliedMigrations.slice(-steps).reverse();
      let rolledBack = 0;

      for (const appliedMigration of toRollback) {
        console.log(
          `[Migrations] Rolling back ${appliedMigration.version}_${appliedMigration.name}...`,
        );

        // Find migration file
        const allMigrations = await this.discoverMigrations();
        const migrationFile = allMigrations.find(
          (m) => m.version === appliedMigration.version,
        );

        if (!migrationFile) {
          console.warn(
            `[Migrations] Migration file not found for version ${appliedMigration.version}`,
          );
          continue;
        }

        const migration = await this.loadMigration(migrationFile);
        const startTime = Date.now();

        // Run rollback in transaction if possible
        if (typeof this.adapter.transaction === "function") {
          const txResult = await this.adapter.transaction(async () => {
            await migration.down(this.adapter);
          });
          // Check transaction result - transaction() returns failure() instead of throwing
          if (!txResult.success) {
            throw (
              txResult.error ??
              new DatabaseError(
                `Rollback ${appliedMigration.version} failed`,
                DATABASE_ERROR_CODES.QUERY_FAILED,
              )
            );
          }
        } else {
          await migration.down(this.adapter);
        }

        const executionTime = Date.now() - startTime;

        // Remove migration record
        await this.unrecordMigration(appliedMigration.version);

        console.log(
          `[Migrations] Rolled back ${appliedMigration.version} in ${executionTime}ms`,
        );
        rolledBack++;
      }

      return success(rolledBack);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Rollback failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Reset the database by rolling back all applied migrations.
   *
   * @description
   * Calls {@link down} with a step count equal to the number of currently
   * applied migrations, effectively undoing every migration in reverse order.
   *
   * @returns `DatabaseResult<number>` – the count of migrations rolled back
   *
   * @example
   * ```typescript
   * // Undo everything
   * await manager.reset();
   * ```
   */
  async reset(): Promise<DatabaseResult<number>> {
    const appliedMigrations = await this.getAppliedMigrations();
    return this.down(appliedMigrations.length);
  }

  /**
   * Clear migration history without rolling back database changes.
   *
   * @description
   * Deletes all records from the migration tracking table. Use in test/development
   * environments only to force fresh migrations without undoing actual DDL.
   *
   * @returns `DatabaseResult<void>`
   *
   * @example
   * ```typescript
   * // Clear history and re-run all migrations
   * await migrationManager.clearHistory();
   * await migrationManager.up();
   * ```
   */
  async clearHistory(): Promise<DatabaseResult<void>> {
    try {
      if (typeof this.adapter.query === "function") {
        await this.adapter.query(`DELETE FROM ${this.tableName}`);
      }
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to clear migration history: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }
}
