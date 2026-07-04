/**
 * @fileoverview Validation utilities for @myko/atlas-client package
 *
 * This module provides comprehensive validation functions for database operations
 * including filter validation, table name validation, ID validation, and input sanitization.
 *
 * Part of the @myko/atlas-client package - a TypeScript database abstraction layer with
 * support for multiple adapters (Drizzle, Supabase, SQL), extensions (audit, encryption,
 * soft delete), and advanced features (caching, read replicas, multi-tenancy).
 *
 */

import type { Filter } from "@myko/types/db";
import { isString, isNonEmptyString, isObject } from "./typeGuards";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import { DB_REGEX } from "./regex";

/**
 * Validates a filter object for database queries
 *
 * Performs comprehensive validation of filter objects used across all database adapters
 * (DrizzleAdapter, SupabaseAdapter, SQLAdapter). Ensures field names are safe from
 * SQL injection and operators are supported.
 *
 * @param {Filter} filter - The filter object from @myko/types/db to validate
 * @returns {boolean} True if the filter is valid and safe for database operations
 *
 * @example
 * ```typescript
 * import { validateFilter } from '@myko/atlas-client';
 *
 * // Valid filter for DatabaseService operations
 * const validFilter = { field: 'user_name', operator: 'eq', value: 'john_doe' };
 * console.log(validateFilter(validFilter)); // true
 *
 * // Invalid filter (unsafe field name)
 * const invalidFilter = { field: 'user; DROP TABLE users;', operator: 'eq', value: 'test' };
 * console.log(validateFilter(invalidFilter)); // false
 * ```
 *
 */

/**
 * Valid database query operators supported across all adapters
 *
 * These operators are validated and supported by:
 * - DrizzleAdapter: Maps to Drizzle ORM operators
 * - SupabaseAdapter: Maps to Supabase query operators
 * - SQLAdapter: Maps to raw SQL WHERE clause operators
 *
 * @constant {string[]} validOperators - List of supported query operators
 */
export const validOperators = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "like",
  "ilike",
  "between",
  "isNull",
  "isNotNull",
];

/**
 * Validates a filter object for database queries.
 *
 * @description
 * Performs comprehensive validation of filter objects used across all database adapters
 * (DrizzleAdapter, SupabaseAdapter, SQLAdapter). Ensures field names are safe from
 * SQL injection, operators are from the supported whitelist, and values are properly
 * formatted for their operator type. Rejects filters with dangerous field names,
 * unsupported operators, missing required values, or improperly structured compound filters.
 *
 * @param filter - The filter object from @myko/types/db to validate
 * @returns True if the filter is structurally valid and safe for database operations
 *
 * @example
 * ```typescript
 * import { validateFilter } from '@myko/atlas-client';
 *
 * const validFilter = { field: 'user_name', operator: 'eq', value: 'john_doe' };
 * console.log(validateFilter(validFilter)); // true
 *
 * const invalidFilter = { field: 'user; DROP TABLE users;', operator: 'eq', value: 'test' };
 * console.log(validateFilter(invalidFilter)); // false
 * ```
 */
// eslint-disable-next-line complexity
export function validateFilter(filter: Filter): boolean {
  try {
    // Basic type and existence validation
    // Ensures filter is a valid object before proceeding with property validation
    if (!isObject(filter)) {
      return false;
    }

    const { field, operator, value, logical } = filter;

    // Field name validation - prevents SQL injection through field names
    // Regex: /^[a-zA-Z_][a-zA-Z0-9_]*$/
    // ^ - Start of string
    // [a-zA-Z_] - First character must be letter (a-z, A-Z) or underscore
    // [a-zA-Z0-9_]* - Subsequent characters can be letters, numbers, or underscores
    // $ - End of string
    // This ensures field names follow safe database column naming conventions
    if (!isNonEmptyString(field) || !DB_REGEX.isValidFieldName(field)) {
      return false;
    }

    // Operator validation against whitelist
    // Only allows predefined operators to prevent SQL injection through operators
    if (!validOperators.includes(operator)) {
      return false;
    }

    // Value validation for operators that require values
    // Some operators like 'isNull' and 'isNotNull' don't need values
    // Others require values to function properly
    const operatorsRequiringValue = [
      "eq",
      "ne",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "notIn",
      "like",
      "ilike",
      "between",
    ];
    if (
      operatorsRequiringValue.includes(operator) &&
      (value === undefined || value === null)
    ) {
      return false;
    }

    // Array operator validation
    // 'in' and 'notIn' operators require array values for proper SQL generation
    if (["in", "notIn"].includes(operator) && !Array.isArray(value)) {
      return false;
    }

    // Between operator validation
    // 'between' operator requires exactly 2 values: [min, max]
    const BETWEEN_ARRAY_LENGTH = 2;
    if (
      operator === "between" &&
      (!Array.isArray(value) ||
        (value as unknown[]).length !== BETWEEN_ARRAY_LENGTH)
    ) {
      return false;
    }

    // Logical operator validation for compound filters
    // Only 'and' and 'or' are supported for combining multiple filters
    if (logical && !isString(logical) && !["and", "or"].includes(logical)) {
      return false;
    }

    return true;
  } catch {
    // Catch any unexpected errors during validation
    // Return false for safety if validation throws an exception
    return false;
  }
}

/**
 * Validates a database table name for all supported adapters
 *
 * Ensures table names are safe for use across DrizzleAdapter, SupabaseAdapter, and SQLAdapter.
 * Follows PostgreSQL naming conventions (63 character limit) for maximum compatibility.
 *
 * Validation rules:
 * - Must be a non-empty string
 * - Must start with a letter or underscore
 * - Can only contain letters, numbers, and underscores
 * - Maximum length of 63 characters (PostgreSQL limit)
 *
 * @param {string} name - The table name to validate
 * @returns {boolean} True if the table name is valid for database operations
 *
 * @example
 * ```typescript
 * import { validateTableName } from '@myko/atlas-client';
 *
 * // Valid table names for DatabaseService
 * console.log(validateTableName('users')); // true
 * console.log(validateTableName('user_profiles')); // true
 * console.log(validateTableName('_audit_logs')); // true
 *
 * // Invalid table names
 * console.log(validateTableName('123users')); // false - starts with number
 * console.log(validateTableName('user-profiles')); // false - contains hyphen
 * console.log(validateTableName('')); // false - empty string
 * ```
 *
 */
export function validateTableName(name: string): boolean {
  try {
    // Basic type and length validation
    // Ensures name is a non-empty string before regex validation
    if (!isNonEmptyString(name)) {
      return false;
    }

    // Database-specific length limits validation
    // PostgreSQL has a 63-character limit for identifiers
    // This ensures compatibility across different database systems
    const MAX_TABLE_NAME_LENGTH = 63; // PostgreSQL limit
    if (name.length > MAX_TABLE_NAME_LENGTH) {
      return false;
    }

    // Table name format validation using regex
    // Regex: /^[a-zA-Z_][a-zA-Z0-9_]*$/
    // ^ - Start of string anchor
    // [a-zA-Z_] - First character must be:
    //   - Lowercase letter (a-z)
    //   - Uppercase letter (A-Z)
    //   - Underscore (_)
    // [a-zA-Z0-9_]* - Zero or more subsequent characters that can be:
    //   - Letters (a-z, A-Z)
    //   - Numbers (0-9)
    //   - Underscores (_)
    // $ - End of string anchor
    // This follows SQL identifier naming conventions and prevents injection
    return DB_REGEX.isValidTableName(name);
  } catch {
    // Handle any unexpected errors during validation
    return false;
  }
}

/**
 * Validates a database record ID for all adapter operations
 *
 * Performs security validation of record IDs used in DatabaseService operations
 * across all adapters. Prevents control character injection and ensures reasonable
 * length limits for database performance.
 *
 * Validation rules:
 * - Must be a non-empty string
 * - Maximum length of 255 characters
 * - No control characters (ASCII 0-31, 127)
 *
 * @param {string} id - The record ID to validate
 * @returns {boolean} True if the ID is safe for database operations
 *
 * @example
 * ```typescript
 * import { validateId } from '@myko/atlas-client';
 *
 * // Valid IDs for DatabaseService.findById()
 * console.log(validateId('user_123')); // true
 * console.log(validateId('550e8400-e29b-41d4-a716-446655440000')); // true - UUID
 * console.log(validateId('abc-def-123')); // true
 *
 * // Invalid IDs
 * console.log(validateId('')); // false - empty
 * console.log(validateId('id\x00injection')); // false - control character
 * ```
 *
 */
export function validateId(id: string): boolean {
  try {
    // Basic type and length validation
    // Ensures ID is a non-empty string before further validation
    if (!isNonEmptyString(id)) {
      return false;
    }

    // Length limit validation for database performance
    // 255 characters is a reasonable limit for most database ID fields
    // Prevents excessively long IDs that could impact query performance
    const MAX_ID_LENGTH = 255;
    if (id.length > MAX_ID_LENGTH) {
      return false;
    }

    // Control character validation to prevent injection attacks
    // ASCII control characters (0-31) and DEL (127) can be used for attacks
    // We iterate through each character to check its ASCII value
    const MAX_CONTROL_CHAR = 31; // Highest ASCII control character
    const DEL_CHAR = 127; // ASCII DEL character

    // Loop through each character in the ID string
    for (let i = 0; i < id.length; i++) {
      const charCode = id.charCodeAt(i); // Get ASCII code of character

      // Reject IDs containing control characters or DEL
      // These characters can be used for injection or cause parsing issues
      if (charCode <= MAX_CONTROL_CHAR || charCode === DEL_CHAR) {
        return false;
      }
    }

    return true;
  } catch {
    // Handle any unexpected errors during validation
    return false;
  }
}
/**
 * Sanitizes input strings to prevent SQL injection across all database adapters
 *
 * Provides defense-in-depth security for user input used in database operations.
 * Used internally by SQLAdapter and as a fallback security measure for other adapters.
 *
 * **Security Note:** This function complements parameterized queries used by
 * DrizzleAdapter and SupabaseAdapter. SQLAdapter uses this for additional protection.
 *
 * Escapes dangerous characters:
 * - Null bytes, backspace, tab, newline, carriage return
 * - Single and double quotes
 * - Backslashes and percent signs
 * - Control-Z character
 *
 * @param {string} input - The user input string to sanitize
 * @returns {string} The sanitized string with escaped dangerous characters
 * @throws {Error} If input is not a string or sanitization fails
 *
 * @example
 * ```typescript
 * import { sanitizeInput } from '@myko/atlas-client';
 *
 * // Sanitize user input before database operations
 * const userInput = "Robert'); DROP TABLE users; --";
 * const sanitized = sanitizeInput(userInput);
 * console.log(sanitized); // "Robert\\'); DROP TABLE users; --"
 *
 * // Used internally by SQLAdapter for additional security
 * const safeValue = sanitizeInput(userProvidedData);
 * ```
 *
 */
export function sanitizeInput(input: string): string {
  try {
    // Input type validation
    // Ensures we're working with a string before sanitization
    if (!isString(input)) {
      throw new DatabaseError(
        "Input must be a string",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: { source: "sanitizeInput" },
          cause: new Error("Input must be a string"),
        },
      );
    }

    // Character escape mapping for SQL injection prevention
    // Maps dangerous characters to their escaped equivalents
    const escapeMap: Record<string, string> = {
      "\0": "\\0", // Null byte - can terminate strings unexpectedly
      "\b": "\\b", // Backspace - can cause parsing issues
      "\t": "\\t", // Tab - can break query formatting
      "\n": "\\n", // Newline - can break single-line queries
      "\r": "\\r", // Carriage return - can break query parsing
      '"': '\\"', // Double quote - can break string literals
      "'": "\\'", // Single quote - primary SQL injection vector
      "\\": "\\\\", // Backslash - can escape other escape sequences
      "%": "\\%", // Percent - can break LIKE patterns
    };

    // Primary sanitization using regex replacement
    // Regex: /[\0\b\t\n\r"'\\%]/g
    // [\0\b\t\n\r"'\\%] - Character class matching any of:
    //   \0 - Null byte
    //   \b - Backspace
    //   \t - Tab
    //   \n - Newline
    //   \r - Carriage return
    //   " - Double quote
    //   ' - Single quote
    //   \\ - Backslash (escaped)
    //   % - Percent sign
    // g - Global flag to replace all occurrences
    let sanitized = DB_REGEX.sanitizeDangerousChars(input, escapeMap);

    // Handle Ctrl+Z character separately to avoid ESLint control-regex warning
    // \x1a is the Ctrl+Z character which can cause issues in some contexts
    sanitized = sanitized.replaceAll("\x1a", "\\z");

    return sanitized;
  } catch {
    // Re-throw with more specific error message if sanitization fails
    throw new DatabaseError(
      "Failed to sanitize input",
      DATABASE_ERROR_CODES.UNKNOWN_ERROR,
      {
        context: { source: "sanitizeInput" },
        cause: new Error("Failed to sanitize input"),
      },
    );
  }
}
