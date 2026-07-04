/**
 * Utilities for auto-generating DOWN migration SQL from UP migration files.
 *
 * @description
 * This module provides helpers to analyse SQL migration files and suggest
 * or append appropriate DOWN statements for rollback support. It recognises
 * common DDL patterns (CREATE TABLE, CREATE INDEX, ALTER TABLE ADD COLUMN,
 * etc.) and produces corresponding DROP/ALTER statements.
 *
 * Can be used programmatically or via CLI:
 * ```bash
 * npx ts-node src/migrations/generateDownMigration.ts ./migrations
 * npx ts-node src/migrations/generateDownMigration.ts ./migrations --write
 * ```
 */

import * as fs from "fs";
import * as path from "path";

/** Maximum characters to show in TODO comments for unhandled statements */
const TODO_PREVIEW_LENGTH = 50;
/** Width of separator lines in output */
const SEPARATOR_LINE_WIDTH = 60;
/** CLI arguments slice start index */
const CLI_ARGS_START = 2;

/**
 * Result of a DOWN-migration suggestion generation.
 *
 * @description
 * Contains the original UP statements alongside their corresponding DOWN
 * suggestions (reversed so rollback executes in inverse order).
 */
interface DownSuggestion {
  /** Name of the source migration file */
  file: string;
  /** Extracted UP SQL statements */
  upStatements: string[];
  /** Generated DOWN SQL statements (in reverse execution order) */
  downSuggestions: string[];
}

/**
 * Function that produces a DOWN SQL statement from a single UP statement.
 *
 * @param statement - A single SQL UP statement
 * @returns The corresponding DOWN SQL, or `null` if no handler matched
 */
type StatementHandler = (statement: string) => string | null;

/**
 * Pattern-to-handler mappings for recognised DDL statement types.
 *
 * Each entry matches a regex pattern against the UP statement and, on a
 * match, produces the corresponding DROP/ALTER statement.
 */
const STATEMENT_HANDLERS: Array<{
  pattern: RegExp;
  handler: StatementHandler;
}> = [
  {
    pattern: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i,
    handler: (statement) => {
      const match = statement.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i,
      );
      return match ? `DROP TABLE IF EXISTS ${match[1]} CASCADE` : null;
    },
  },
  {
    pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i,
    handler: (statement) => {
      const match = statement.match(
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i,
      );
      return match ? `DROP INDEX IF EXISTS ${match[1]}` : null;
    },
  },
  {
    pattern: /CREATE\s+TYPE\s+(\w+)/i,
    handler: (statement) => {
      const match = statement.match(/CREATE\s+TYPE\s+(\w+)/i);
      return match ? `DROP TYPE IF EXISTS ${match[1]} CASCADE` : null;
    },
  },
  {
    pattern: /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i,
    handler: (statement) => {
      const match = statement.match(
        /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i,
      );
      return match ? `DROP EXTENSION IF EXISTS "${match[1]}"` : null;
    },
  },
  {
    pattern: /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN/i,
    handler: (statement) => {
      const match = statement.match(
        /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i,
      );
      return match
        ? `ALTER TABLE ${match[1]} DROP COLUMN IF EXISTS ${match[2]}`
        : null;
    },
  },
  {
    pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/i,
    handler: (statement) => {
      const match = statement.match(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/i,
      );
      return match ? `DROP FUNCTION IF EXISTS ${match[1]}` : null;
    },
  },
  {
    pattern:
      /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+(?:BEFORE|AFTER)\s+(?:INSERT|UPDATE|DELETE).*?ON\s+(\w+)/i,
    handler: (statement) => {
      const match = statement.match(
        /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+(?:BEFORE|AFTER)\s+(?:INSERT|UPDATE|DELETE).*?ON\s+(\w+)/i,
      );
      return match ? `DROP TRIGGER IF EXISTS ${match[1]} ON ${match[2]}` : null;
    },
  },
];

/**
 * Generate a DOWN SQL statement for a single UP statement.
 *
 * @description
 * Iterates through the known `STATEMENT_HANDLERS` patterns and returns
 * the first matching DOWN statement. If no handler matches, returns a
 * `-- TODO` comment prompting manual review.
 *
 * @param statement - A single SQL UP statement
 * @returns The DOWN SQL statement, or a `-- TODO` comment for unrecognised patterns
 *
 * @internal
 */
function generateDownStatement(statement: string): string {
  for (const { pattern, handler } of STATEMENT_HANDLERS) {
    if (statement.match(pattern)) {
      const result = handler(statement);
      if (result) return result;
    }
  }
  // Unknown statement type - suggest manual review
  return `-- TODO: Add DOWN statement for: ${statement.substring(0, TODO_PREVIEW_LENGTH)}...`;
}

/**
 * Parse SQL migration content and suggest DOWN statements for each UP statement.
 *
 * @description
 * Splits the SQL content by semicolons, filters out comments and empty
 * statements, generates a DOWN suggestion for each UP statement, and
 * reverses the DOWN suggestions so rollback executes in inverse order.
 *
 * @param sqlContent - The raw SQL content of an UP migration file
 * @param filename - The filename (used only for the result's `file` property)
 * @returns A DownSuggestion containing upStatements and reversed downSuggestions
 *
 * @example
 * ```typescript
 * const sql = `CREATE TABLE users (id INT PRIMARY KEY);
 * CREATE INDEX idx_users_name ON users (name);`;
 * const result = suggestDownMigration(sql, '001_users.sql');
 * // result.downSuggestions[0] → 'DROP INDEX IF EXISTS idx_users_name'
 * // result.downSuggestions[1] → 'DROP TABLE IF EXISTS users CASCADE'
 * ```
 */
export function suggestDownMigration(
  sqlContent: string,
  filename: string,
): DownSuggestion {
  const upStatements: string[] = [];
  const downSuggestions: string[] = [];

  // Split by semicolons to get individual statements
  const statements = sqlContent
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  for (const statement of statements) {
    upStatements.push(statement);
    downSuggestions.push(generateDownStatement(statement));
  }

  // Reverse the order for DOWN migration (undo in reverse order)
  downSuggestions.reverse();

  return {
    file: filename,
    upStatements,
    downSuggestions,
  };
}

/**
 * Add a `-- DOWN` section to a migration file that lacks one.
 *
 * @description
 * Reads the file at `filePath`, analyses its UP SQL statements, generates
 * corresponding DOWN statements, and returns the new content with the
 * `-- DOWN` section appended. The original file is NOT modified — the
 * caller is responsible for writing.
 *
 * @param filePath - Absolute path to the SQL migration file
 * @returns The file content with the DOWN section appended, or the original
 *          content unchanged if the file already contains `-- DOWN`
 *
 * @example
 * ```typescript
 * const newContent = addDownSection('/abs/path/to/migrations/001_users.sql');
 * fs.writeFileSync('/abs/path/to/migrations/001_users.sql', newContent, 'utf-8');
 * ```
 */
export function addDownSection(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");

  // Check if already has DOWN section
  if (content.includes("-- DOWN")) {
    return content; // Already has DOWN section
  }

  const suggestion = suggestDownMigration(content, path.basename(filePath));

  // Build the new content with DOWN section
  const downSection =
    "\n\n-- DOWN\n" + suggestion.downSuggestions.join(";\n\n") + ";\n";

  return content + downSection;
}

/**
 * Process all SQL migration files in a directory, optionally appending
 * `-- DOWN` sections.
 *
 * @description
 * Scans `migrationsPath` for `.sql` files. In dry-run mode (default),
 * prints each suggested DOWN section to the console. When `dryRun` is
 * `false`, modifies the files in-place.
 *
 * @param migrationsPath - Path to the migrations directory
 * @param dryRun - If `true` (default), only prints suggestions; if `false`, writes files
 *
 * @example
 * ```typescript
 * // Preview only
 * processDirectory('./migrations', true);
 *
 * // Apply changes
 * processDirectory('./migrations', false);
 * ```
 */
export function processDirectory(migrationsPath: string, dryRun = true): void {
  if (!fs.existsSync(migrationsPath)) {
    console.error(`Migration directory not found: ${migrationsPath}`);
    return;
  }

  const files = fs
    .readdirSync(migrationsPath)
    .filter((f) => f.endsWith(".sql"));

  console.log(`Found ${files.length} SQL migration files\n`);

  for (const file of files) {
    const filePath = path.join(migrationsPath, file);
    const content = fs.readFileSync(filePath, "utf-8");

    if (content.includes("-- DOWN")) {
      console.log(`✓ ${file} - Already has DOWN section`);
      continue;
    }

    const newContent = addDownSection(filePath);

    if (dryRun) {
      console.log(`\n📄 ${file}`);
      console.log("─".repeat(SEPARATOR_LINE_WIDTH));
      console.log("Suggested DOWN section:");
      const downSection = newContent.split("-- DOWN")[1];
      console.log(downSection);
    } else {
      fs.writeFileSync(filePath, newContent, "utf-8");
      console.log(`✓ ${file} - Added DOWN section`);
    }
  }

  if (dryRun) {
    console.log("\n" + "=".repeat(SEPARATOR_LINE_WIDTH));
    console.log("⚠️  DRY RUN MODE - No files were modified");
    console.log("Run with --write to apply changes");
  }
}

// CLI usage
if (globalThis.require.main === globalThis.module) {
  const args = process.argv.slice(CLI_ARGS_START);
  const migrationsPath = args[0] || "./migrations";
  const dryRun = !args.includes("--write");

  console.log("🔍 Analyzing migrations for DOWN section generation\n");
  processDirectory(migrationsPath, dryRun);
}
