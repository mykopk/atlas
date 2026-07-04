/**
 * @fileoverview Centralized Regex Patterns for @myko/atlas-client package
 *
 * This module contains all regex patterns used throughout the database package.
 * Centralizing regex patterns improves maintainability, reusability, and consistency.
 *
 * Part of the @myko/atlas-client package - a TypeScript database abstraction layer with
 * support for multiple adapters (Drizzle, Supabase, SQL), extensions (audit, encryption,
 * soft delete), and advanced features (caching, read replicas, multi-tenancy).
 *
 */

/**
 * Database field and table name validation patterns
 * Used for SQL injection prevention and database identifier validation
 */
export const DATABASE_PATTERNS = {
  /**
   * Validates database field names (columns)
   * - Must start with letter (a-z, A-Z) or underscore (_)
   * - Can contain letters, numbers, and underscores
   * - Prevents SQL injection through field names
   *
   * Used in: validation.ts, sql.ts, DrizzleAdapter.ts, SQLAdapter.ts
   */
  FIELD_NAME: /^[a-zA-Z_][a-zA-Z0-9_]*$/,

  /**
   * Validates database table names
   * - Same rules as field names for consistency
   * - Follows SQL identifier naming conventions
   *
   * Used in: validation.ts, CacheEvict.decorator.ts
   */
  TABLE_NAME: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
} as const;

/**
 * Cache key validation patterns
 * Used for validating cache keys and patterns in caching system
 */
export const CACHE_PATTERNS = {
  /**
   * Validates cache keys
   * - Allows letters, numbers, colons, underscores, and hyphens
   * - Used for Redis cache key validation
   *
   * Used in: CacheEvict.decorator.ts
   */
  CACHE_KEY: /^[a-zA-Z0-9:_-]+$/,

  /**
   * Validates cache patterns (with wildcards)
   * - Same as cache key but allows asterisk (*) for wildcards
   * - Used for cache pattern matching and eviction
   *
   * Used in: CacheEvict.decorator.ts
   */
  CACHE_PATTERN: /^[a-zA-Z0-9:_*-]+$/,
} as const;

/**
 * SQL query sanitization patterns
 * Used for cleaning and normalizing SQL queries for metrics and logging
 */
export const SQL_PATTERNS = {
  /**
   * Matches PostgreSQL parameter placeholders ($1, $2, etc.)
   * - Used to normalize parameterized queries for metrics
   *
   * Used in: MetricsCollector.ts
   */
  POSTGRES_PARAMS: /\$\d+/g,

  /**
   * Matches numeric values in SQL queries
   * - Used to replace numbers with placeholders for query normalization
   *
   * Used in: MetricsCollector.ts
   */
  NUMERIC_VALUES: /\d+/g,

  /**
   * Matches string literals in SQL queries (single quotes)
   * - Used to replace string values with placeholders
   *
   * Used in: MetricsCollector.ts
   */
  STRING_LITERALS: /'[^']*'/g,
} as const;

/**
 * Input sanitization patterns
 * Used for cleaning user input and preventing injection attacks
 */
export const SANITIZATION_PATTERNS = {
  /**
   * Matches dangerous characters for SQL injection prevention
   * - Null byte, backspace, tab, newline, carriage return
   * - Single and double quotes, backslashes, percent signs
   *
   * Used in: validation.ts (sanitizeInput function)
   */
  DANGEROUS_CHARS: /[\0\b\t\n\r"'\\%]/g,

  /**
   * Matches shell metacharacters for command injection prevention
   * - Semicolon, ampersand, pipe, backtick, dollar, parentheses, etc.
   *
   * Used in: BackupService.ts (sanitizeCommand function)
   */
  SHELL_METACHARACTERS: /[;&|`$(){}[\]<>"'\\]/g,

  /**
   * Matches multiple whitespace characters
   * - Used to normalize whitespace in sanitized input
   *
   * Used in: BackupService.ts
   */
  MULTIPLE_WHITESPACE: /\s+/g,

  /**
   * Matches line breaks and tabs
   * - Used to replace line breaks with spaces
   *
   * Used in: BackupService.ts
   */
  LINE_BREAKS_TABS: /[\r\n\t]/g,

  /**
   * Matches Unicode control characters
   * - Uses Unicode property escape to match all control characters
   *
   * Used in: BackupService.ts
   */
  CONTROL_CHARACTERS: /[\p{Cc}]/gu,
} as const;

/**
 * File and path patterns
 * Used for file operations and path validation
 */
export const FILE_PATTERNS = {
  /**
   * Matches colon and dot characters in timestamps
   * - Used to create filesystem-safe timestamps
   *
   * Used in: BackupService.ts (timestamp generation)
   */
  TIMESTAMP_CHARS: /[:.]/g,
} as const;

/**
 * Utility functions for common regex operations
 */
export const DB_REGEX = {
  /**
   * Tests if a string matches the database field name pattern
   * @param fieldName - The field name to validate
   * @returns True if valid database field name
   */
  isValidFieldName: (fieldName: string): boolean => {
    return DATABASE_PATTERNS.FIELD_NAME.test(fieldName);
  },

  /**
   * Tests if a string matches the database table name pattern
   * @param tableName - The table name to validate
   * @returns True if valid database table name
   */
  isValidTableName: (tableName: string): boolean => {
    return DATABASE_PATTERNS.TABLE_NAME.test(tableName);
  },

  /**
   * Tests if a string matches the cache key pattern
   * @param cacheKey - The cache key to validate
   * @returns True if valid cache key
   */
  isValidCacheKey: (cacheKey: string): boolean => {
    return CACHE_PATTERNS.CACHE_KEY.test(cacheKey);
  },

  /**
   * Tests if a string matches the cache pattern (with wildcards)
   * @param cachePattern - The cache pattern to validate
   * @returns True if valid cache pattern
   */
  isValidCachePattern: (cachePattern: string): boolean => {
    return CACHE_PATTERNS.CACHE_PATTERN.test(cachePattern);
  },

  /**
   * Normalizes SQL query by replacing parameters and values with placeholders
   * @param query - The SQL query to normalize
   * @returns Normalized query string
   */
  normalizeSqlQuery: (query: string): string => {
    return query
      .replace(SQL_PATTERNS.POSTGRES_PARAMS, "?")
      .replace(SQL_PATTERNS.NUMERIC_VALUES, "?")
      .replace(SQL_PATTERNS.STRING_LITERALS, "?");
  },

  /**
   * Sanitizes input by escaping dangerous characters
   * @param input - The input string to sanitize
   * @param escapeMap - Map of characters to their escaped equivalents
   * @returns Sanitized string
   */
  sanitizeDangerousChars: (
    input: string,
    escapeMap: Record<string, string>,
  ): string => {
    return input.replace(
      SANITIZATION_PATTERNS.DANGEROUS_CHARS,
      (char) => escapeMap[char] || char,
    );
  },

  /**
   * Creates filesystem-safe timestamp string
   * @param timestamp - ISO timestamp string
   * @returns Filesystem-safe timestamp
   */
  createSafeTimestamp: (timestamp: string): string => {
    return timestamp.replace(FILE_PATTERNS.TIMESTAMP_CHARS, "-");
  },

  /**
   * Sanitizes command string by removing shell metacharacters
   * @param command - Command string to sanitize
   * @returns Sanitized command string
   */
  sanitizeCommand: (command: string): string => {
    return command
      .replace(SANITIZATION_PATTERNS.SHELL_METACHARACTERS, "")
      .replace(SANITIZATION_PATTERNS.MULTIPLE_WHITESPACE, " ")
      .trim();
  },

  /**
   * Sanitizes log message by normalizing whitespace and removing control characters
   * @param message - Log message to sanitize
   * @returns Sanitized log message
   */
  sanitizeLogMessage: (message: string): string => {
    return message
      .replace(SANITIZATION_PATTERNS.LINE_BREAKS_TABS, " ")
      .replace(SANITIZATION_PATTERNS.CONTROL_CHARACTERS, "")
      .trim();
  },
} as const;
