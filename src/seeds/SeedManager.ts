/**
 * SeedManager - Database seeding for development and testing
 *
 * Manages database seeding with support for ordered execution,
 * seed history tracking, and idempotent seed operations.
 * Automatically discovers seed files from a specified directory.
 *
 * @example
 * ```typescript
 * const seedManager = new SeedManager({
 *   adapter: sqlAdapter,
 *   seedsPath: './seeds', // default
 *   tableName: 'seed_history' // default
 * });
 *
 * // Run all seeds
 * await seedManager.run();
 *
 * // Run specific seed
 * await seedManager.run('users');
 *
 * // Clear all data (for testing)
 * await seedManager.reset();
 * ```
 */

import type {
  DatabaseAdapterType,
  DatabaseResult,
  Seed,
  SeedFile,
  SeedRecord,
  SeedManagerConfig,
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
 * SeedManager - Handles database seeding operations
 *
 * Discovers seed files, tracks seed history, and executes
 * seeds in order with support for cleanup and reset.
 */
export class SeedManager {
  private adapter: DatabaseAdapterType;
  private seedsPath: string;
  private tableName: string;
  private schema: string;
  private skipExisting: boolean;

  /**
   * Create a SeedManager.
   *
   * @param config - Configuration object
   * @param config.adapter - Database adapter instance for query execution
   * @param config.seedsPath - Directory containing seed files (default: `"./seeds"`)
   * @param config.tableName - Name of the tracking table (default: `"seed_history"`)
   * @param config.schema - Database schema name (default: `"public"`)
   * @param config.skipExisting - If true, skip seeds already recorded (default: false)
   */
  constructor(config: SeedManagerConfig) {
    this.adapter = config.adapter;
    this.seedsPath = path.resolve(config.seedsPath ?? "./seeds");
    this.schema = config.schema ?? "public";
    // Prefix table name with schema if not 'public'
    this.tableName =
      this.schema !== "public"
        ? `${this.schema}.${config.tableName ?? "seed_history"}`
        : (config.tableName ?? "seed_history");
    this.skipExisting = config.skipExisting ?? false;
  }

  /**
   * Initialize the seeds tracking table if it doesn't exist.
   *
   * @description
   * Creates a `seed_history` table (or custom name) to track seed execution.
   * Also attempts to backfill a `file_path` column on existing installations.
   *
   * @returns `DatabaseResult<void>` – succeeds when the table exists
   */
  async initialize(): Promise<DatabaseResult<void>> {
    try {
      // Create seeds tracking table with file_path for traceability
      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          name VARCHAR(255) PRIMARY KEY,
          file_path VARCHAR(500),
          run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
          `Failed to initialize seeds table: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.INIT_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Discover seed files from the seeds directory.
   *
   * @description
   * Scans the seeds path for files matching the pattern `{order}_{name}.{ts|js|sql}`,
   * e.g. `001_users.ts`, `002_campaigns.js`, `003_data.sql`. Returns them sorted by
   * order (ascending).
   *
   * @returns Array of discovered seed file metadata
   */
  private async discoverSeeds(): Promise<SeedFile[]> {
    if (!fs.existsSync(this.seedsPath)) {
      return [];
    }

    const files = fs.readdirSync(this.seedsPath);
    const seeds: SeedFile[] = [];

    for (const file of files) {
      // Match seed file pattern: {order}_{name}.{ts|js|sql}
      // Examples: 001_users.ts, 002_campaigns.js, 003_data.sql
      const match = file.match(/^(\d+)_(.+)\.(ts|js|sql)$/);
      if (match) {
        const [, order, name] = match;
        seeds.push({
          filePath: path.join(this.seedsPath, file),
          order: Number.parseInt(order, 10),
          name,
        });
      }
    }

    // Sort by order
    return seeds.sort((a, b) => a.order - b.order);
  }

  /**
   * Process dollar-quoted string delimiters ($$ or $tag$).
   *
   * @returns Updated state for tracking whether we're inside a dollar block
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
   * Check whether a statement is a comment-only line.
   *
   * @returns `true` if the statement contains no SQL (only comments/whitespace)
   */
  private isNonCommentStatement(statement: string): boolean {
    const withoutComments = statement.replace(/--.*$/gm, "").trim();
    return withoutComments.length > 0;
  }

  /**
   * Split SQL into individual statements, respecting `$$` dollar-quoted blocks.
   *
   * @description
   * Splits on semicolons but guards against false splits inside PL/pgSQL
   * functions and trigger bodies delimited by `$$` or `$tag$`.
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

      current += line + "\n";
      if (isEmptyOrComment) continue;

      const dollarState = this.processDollarDelimiters(
        line,
        inDollarBlock,
        dollarTag,
      );
      inDollarBlock = dollarState.inDollarBlock;
      dollarTag = dollarState.dollarTag;

      if (!inDollarBlock && trimmedLine.endsWith(";") && current.trim()) {
        statements.push(current.trim());
        current = "";
      }
    }

    if (current.trim()) {
      statements.push(current.trim());
    }

    return statements.filter((s) => this.isNonCommentStatement(s));
  }

  /**
   * Extract a short human-readable description from a SQL statement for logging.
   *
   * @param statement - A raw SQL statement
   * @returns A truncated description (e.g. `"INSERT INTO users"`)
   */
  private getStatementDescription(statement: string): string {
    const firstLine =
      statement
        .split("\n")
        .find((l) => l.trim() && !l.trim().startsWith("--"))
        ?.trim() ?? "";

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
   * Execute SQL statements individually with progress logging and error reporting.
   *
   * @param sql - Raw SQL containing one or more statements
   * @param seedName - Seed name (used in error messages for traceability)
   * @throws {DatabaseError} `QUERY_FAILED` if any statement fails, with the
   *   exact statement index and description in the message
   */
  private async executeSqlStatements(
    sql: string,
    seedName: string,
  ): Promise<void> {
    const statements = this.splitSqlStatements(sql);
    const total = statements.length;

    console.log(`  → ${total} statements to execute`);

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const description = this.getStatementDescription(statement);

      try {
        await this.adapter.query!(statement);
        const isInterval = (i + 1) % PROGRESS_LOG_INTERVAL === 0;
        const isLast = i === total - 1;
        const isSignificant = Boolean(description.match(/^(INSERT INTO)/i));
        if (isInterval || isLast || isSignificant) {
          console.log(`  ✓ [${i + 1}/${total}] ${description}`);
        }
      } catch (error) {
        console.log(`  ✗ [${i + 1}/${total}] ${description}`);

        const rawMessage = (error as Error).message;
        const errorMessage = rawMessage
          .replace(/^SQL Error:\s*/i, "")
          .replace(/^Failed to execute query:.*?-\s*/i, "")
          .slice(0, ERROR_MESSAGE_MAX_LENGTH);

        throw new DatabaseError(
          `Seed "${seedName}" failed at statement ${i + 1}/${total}:\n` +
            `  Statement: ${description}\n` +
            `  Error: ${errorMessage}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        );
      }
    }
  }

  /**
   * Load a SQL seed from a `.sql` file.
   *
   * @param seedFile - Seed file metadata
   * @returns A Seed object wrapping the SQL content as the `run` function
   */
  private loadSqlSeed(seedFile: SeedFile): Seed {
    const sql = fs.readFileSync(seedFile.filePath, "utf-8");

    return {
      name: seedFile.name,
      run: async () => {
        if (typeof this.adapter.query === "function") {
          await this.executeSqlStatements(sql, seedFile.name);
        }
      },
      // SQL seeds don't have cleanup by default
      cleanup: undefined,
    };
  }

  /**
   * Load a seed from a file (supports `.ts`, `.js`, and `.sql`).
   *
   * @description
   * SQL seeds are parsed and executed statement-by-statement.
   * JS/TS seeds are dynamically imported and expected to export `run`
   * (or `default.run`, `seed`, or `default`) and optionally `cleanup`.
   *
   * @param seedFile - Seed file metadata
   * @returns A Seed with `run` and optionally `cleanup` functions
   */
  // eslint-disable-next-line complexity
  private async loadSeed(seedFile: SeedFile): Promise<Seed> {
    const ext = path.extname(seedFile.filePath);

    // Handle SQL seeds
    if (ext === ".sql") {
      return this.loadSqlSeed(seedFile);
    }

    // Handle JS/TS seeds
    // Convert Windows paths to file:// URLs for ESM imports
    const importPath = seedFile.filePath.startsWith("/")
      ? seedFile.filePath
      : new URL(`file:///${seedFile.filePath.replace(/\\/g, "/")}`).href;

    const seedModule = await import(importPath);
    return {
      name: seedFile.name,
      run:
        seedModule.run ??
        seedModule.default?.run ??
        seedModule.seed ??
        seedModule.default,
      cleanup: seedModule.cleanup ?? seedModule.default?.cleanup,
    };
  }

  /**
   * Get previously seeded records from the database.
   *
   * @returns Array of seed records, ordered by `run_at`
   */
  private async getExecutedSeeds(): Promise<SeedRecord[]> {
    try {
      if (typeof this.adapter.query === "function") {
        const result = await this.adapter.query<SeedRecord>(
          `SELECT * FROM ${this.tableName} ORDER BY run_at ASC`,
        );
        // Handle both array results and postgres-style { rows: [] } results
        return Array.isArray(result)
          ? result
          : (result as unknown as { rows: SeedRecord[] }).rows || [];
      }
      return [];
    } catch {
      // Table might not exist yet
      return [];
    }
  }

  /**
   * Record a seed execution in the tracking table.
   *
   * @param name - Seed name
   * @param executionTime - Duration in milliseconds
   * @param filePath - Absolute file path (stored as relative for portability)
   */
  private async recordSeed(
    name: string,
    executionTime: number,
    filePath?: string,
  ): Promise<void> {
    if (typeof this.adapter.query === "function") {
      // Store relative path from seeds directory for portability
      const relativePath = filePath
        ? path.relative(this.seedsPath, filePath)
        : null;

      await this.adapter.query(
        `INSERT INTO ${this.tableName} (name, file_path, execution_time) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET run_at = CURRENT_TIMESTAMP, file_path = $2, execution_time = $3`,
        [name, relativePath, executionTime],
      );
    }
  }

  /**
   * Remove a seed record from the tracking table (used during reset).
   *
   * @param name - Seed name to delete
   */
  private async unrecordSeed(name: string): Promise<void> {
    if (typeof this.adapter.query === "function") {
      await this.adapter.query(
        `DELETE FROM ${this.tableName} WHERE name = $1`,
        [name],
      );
    }
  }

  /**
   * Execute a seed function, optionally wrapping it in a database transaction.
   *
   * @param seed - The seed to execute
   * @throws {DatabaseError} `QUERY_FAILED` if the transaction or seed.run() fails
   */
  private async executeSeed(seed: Seed): Promise<void> {
    if (typeof this.adapter.transaction === "function") {
      const txResult = await this.adapter.transaction(async () => {
        await seed.run(this.adapter);
      });
      // Check transaction result - transaction() returns failure() instead of throwing
      if (!txResult.success) {
        throw (
          txResult.error ??
          new DatabaseError(
            `Seed ${seed.name} failed`,
            DATABASE_ERROR_CODES.QUERY_FAILED,
          )
        );
      }
    } else {
      await seed.run(this.adapter);
    }
  }

  /**
   * Determine whether a seed file should be skipped.
   *
   * @param seedFile - Discovered seed file metadata
   * @param seedName - Optional target seed name (if filtering for a specific seed)
   * @param executedNames - Set of already-executed seed names
   * @returns `true` if the seed should be skipped
   */
  private shouldSkipSeed(
    seedFile: SeedFile,
    seedName: string | undefined,
    executedNames: Set<string>,
  ): boolean {
    if (seedName && seedFile.name !== seedName) return true;

    if (this.skipExisting && executedNames.has(seedFile.name)) {
      console.log(`[Seeds] Skipping ${seedFile.name} (already executed)`);
      return true;
    }

    return false;
  }

  /**
   * Run all pending seeds, or a specific seed by name.
   *
   * @description
   * Initialises the tracking table, discovers seed files, filters already-executed
   * seeds (if `skipExisting` is enabled), and runs each seed in order. Each seed
   * is recorded with execution time for history tracking.
   *
   * @param seedName - If provided, only run the seed with this name
   * @returns `DatabaseResult<number>` – the count of successfully executed seeds
   *
   * @example
   * ```typescript
   * // Run all seeds
   * await seedManager.run();
   *
   * // Run a specific seed
   * await seedManager.run('users');
   * ```
   */
  async run(seedName?: string): Promise<DatabaseResult<number>> {
    try {
      await this.initialize();

      const allSeeds = await this.discoverSeeds();
      const executedSeeds = await this.getExecutedSeeds();
      const executedNames = new Set(executedSeeds.map((s) => s.name));

      let executed = 0;

      for (const seedFile of allSeeds) {
        if (this.shouldSkipSeed(seedFile, seedName, executedNames)) {
          continue;
        }

        console.log(`[Seeds] Running ${seedFile.name}...`);

        const seed = await this.loadSeed(seedFile);
        const startTime = Date.now();

        await this.executeSeed(seed);

        const executionTime = Date.now() - startTime;
        await this.recordSeed(seed.name, executionTime, seedFile.filePath);

        console.log(`[Seeds] Executed ${seed.name} in ${executionTime}ms`);
        executed++;

        if (seedName) break;
      }

      return success(executed);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Seed execution failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Execute a seed's cleanup function, optionally within a transaction.
   *
   * @param seed - The seed whose cleanup to execute
   * @throws {DatabaseError} `QUERY_FAILED` if the cleanup transaction/function fails
   */
  private async executeCleanup(seed: Seed): Promise<void> {
    if (!seed.cleanup) return;

    if (typeof this.adapter.transaction === "function") {
      const txResult = await this.adapter.transaction(async () => {
        await seed.cleanup!(this.adapter);
      });
      // Check transaction result - transaction() returns failure() instead of throwing
      if (!txResult.success) {
        throw (
          txResult.error ??
          new DatabaseError(
            `Seed cleanup for ${seed.name} failed`,
            DATABASE_ERROR_CODES.QUERY_FAILED,
          )
        );
      }
    } else {
      await seed.cleanup(this.adapter);
    }
  }

  /**
   * Reset all seeds by running cleanup functions in reverse order.
   *
   * @description
   * Discovers all seed files, iterates in reverse order, and calls each
   * seed's `cleanup` function. Seed records are removed from the tracking
   * table after successful cleanup.
   *
   * @returns `DatabaseResult<number>` – the count of seeds cleaned up
   *
   * @example
   * ```typescript
   * await seedManager.reset(); // Cleans up all seeded data
   * ```
   */
  async reset(): Promise<DatabaseResult<number>> {
    try {
      const allSeeds = await this.discoverSeeds();
      let cleaned = 0;

      // Run cleanup in reverse order
      for (const seedFile of allSeeds.reverse()) {
        console.log(`[Seeds] Cleaning up ${seedFile.name}...`);

        const seed = await this.loadSeed(seedFile);

        if (!seed.cleanup) {
          console.warn(`[Seeds] No cleanup function for ${seed.name}`);
          continue;
        }

        const startTime = Date.now();
        await this.executeCleanup(seed);
        const executionTime = Date.now() - startTime;

        await this.unrecordSeed(seed.name);

        console.log(`[Seeds] Cleaned ${seed.name} in ${executionTime}ms`);
        cleaned++;
      }

      return success(cleaned);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Seed cleanup failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Get seed execution status.
   *
   * @description
   * Returns both executed and pending seed names so callers can inspect
   * what has run and what remains.
   *
   * @returns `DatabaseResult<{ executed: SeedRecord[]; pending: string[] }>`
   *
   * @example
   * ```typescript
   * const status = await seedManager.status();
   * console.log('Executed:', status.value?.executed);
   * console.log('Pending:', status.value?.pending);
   * ```
   */
  async status(): Promise<
    DatabaseResult<{ executed: SeedRecord[]; pending: string[] }>
  > {
    try {
      await this.initialize();

      const allSeeds = await this.discoverSeeds();
      const executedSeeds = await this.getExecutedSeeds();
      const executedNames = new Set(executedSeeds.map((s) => s.name));

      const pending = allSeeds
        .filter((s) => !executedNames.has(s.name))
        .map((s) => s.name);

      return success({
        executed: executedSeeds,
        pending,
      });
    } catch (error) {
      return failure(
        new DatabaseError(
          `Failed to get seed status: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Clear seed execution history without cleaning data.
   *
   * @description
   * Deletes all records from the seed tracking table. This is useful in
   * test/development environments to force re-execution of all seeds
   * without undoing the actual database changes.
   *
   * @returns `DatabaseResult<void>`
   *
   * @example
   * ```typescript
   * await seedManager.clearHistory();
   * await seedManager.run(); // re-runs every seed
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
          `Failed to clear seed history: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }
}
