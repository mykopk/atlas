/**
 * @fileoverview Type Guard Utilities for @myko/atlas-client package
 *
 * This module provides type guard functions for runtime type checking throughout
 * the @myko/atlas-client package. These utilities replace direct typeof checks with
 * consistent, reusable type validation functions.
 *
 */

/**
 * Type guard to check if a value is a string
 *
 * @param {unknown} value - The value to check
 * @returns {value is string} True if value is a string, false otherwise
 *
 * @example
 * ```typescript
 * import { isString } from '@myko.pk/atlas-client/utils';
 *
 * if (isString(userInput)) {
 *   // userInput is now typed as string
 *   console.log(userInput.toLowerCase());
 * }
 * ```
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Type guard to check if a value is a non-empty string
 *
 * @param {unknown} value - The value to check
 * @returns {value is string} True if value is a non-empty string, false otherwise
 *
 * @example
 * ```typescript
 * import { isNonEmptyString } from '@myko.pk/atlas-client/utils';
 *
 * if (isNonEmptyString(tableName)) {
 *   // tableName is guaranteed to be a non-empty string
 *   const query = `SELECT * FROM ${tableName}`;
 * }
 * ```
 */
export function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

/**
 * Type guard to check if a value is a number
 *
 * @param {unknown} value - The value to check
 * @returns {value is number} True if value is a number, false otherwise
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/**
 * Type guard to check if a value is an object (not null, not array)
 *
 * @param {unknown} value - The value to check
 * @returns {value is object} True if value is an object, false otherwise
 */
export function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
