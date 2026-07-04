/**
 * @fileoverview Detail Normalization Utilities for @myko/atlas-client package
 *
 * This module provides utilities for normalizing various data types into consistent
 * string-based record formats. Used throughout the @myko/atlas-client package for standardizing
 * error details, health status information, and event metadata.
 *
 * Part of the @myko/atlas-client package - a TypeScript database abstraction layer with
 * support for multiple adapters (Drizzle, Supabase, SQL), extensions (audit, encryption,
 * soft delete), and advanced features (caching, read replicas, multi-tenancy).
 *
 */

import { isObject } from "./typeGuards";

/**
 * Normalizes any input into a standardized Record<string, string> format
 *
 * Converts various data types into a consistent string-based record format
 * for use in error details, health status information, and event metadata.
 * Provides safe handling of different input types with fallback strategies.
 *
 * **Normalization Rules:**
 * - Objects: Converts all property values to strings while preserving keys
 * - Primitives: Wraps in { info: stringValue } format
 * - null/undefined: Returns undefined (no details)
 * - Arrays: Converts to { info: stringified array }
 * - Errors: Safely handles conversion failures
 *
 * **Used by:**
 * - HealthManager for health status details
 * - DatabaseEventEmitter for event metadata
 * - Error handling throughout adapter chain
 * - Audit logging for consistent detail formatting
 *
 * @param {unknown} details - Input details of any type to normalize
 * @returns {Record<string, string> | undefined} Normalized details as string record or undefined
 *
 * @example
 * ```typescript
 * import { normalizeDetails } from '@myko/atlas-client/utils';
 *
 * // Object normalization
 * const objDetails = normalizeDetails({
 *   count: 42,
 *   active: true,
 *   name: 'test'
 * });
 * console.log(objDetails);
 * // { count: "42", active: "true", name: "test" }
 *
 * // Primitive normalization
 * const stringDetails = normalizeDetails("Connection timeout");
 * console.log(stringDetails);
 * // { info: "Connection timeout" }
 *
 * // Number normalization
 * const numberDetails = normalizeDetails(404);
 * console.log(numberDetails);
 * // { info: "404" }
 *
 * // Null/undefined handling
 * const nullDetails = normalizeDetails(null);
 * console.log(nullDetails);
 * // undefined
 *
 * // Array normalization
 * const arrayDetails = normalizeDetails(['error1', 'error2']);
 * console.log(arrayDetails);
 * // { info: "error1,error2" }
 *
 * // Error object normalization
 * const errorDetails = normalizeDetails(new Error('Database error'));
 * console.log(errorDetails);
 * // { info: "Error: Database error" }
 * ```
 *
 * @example
 * ### Usage in Health Status
 * ```typescript
 * // In HealthManager.checkHealth()
 * const healthStatus = {
 *   isHealthy: true,
 *   responseTime: 150,
 *   details: normalizeDetails({
 *     adapter: 'drizzle',
 *     connections: 5,
 *     lastQuery: new Date()
 *   })
 * };
 * // details: { adapter: "drizzle", connections: "5", lastQuery: "2024-01-01T10:00:00.000Z" }
 * ```
 *
 * @example
 * ### Usage in Error Handling
 * ```typescript
 * // In adapter error handling
 * catch (error) {
 *   return failure(new DatabaseError(
 *     'QUERY_FAILED',
 *     HTTP_STATUS.INTERNAL_SERVER_ERROR,
 *     'Query execution failed',
 *     normalizeDetails({
 *       query: sql,
 *       params: queryParams,
 *       originalError: error.message
 *     })
 *   ));
 * }
 * ```
 *
 */
export function normalizeDetails(
  details: unknown,
): Record<string, string> | undefined {
  try {
    // Handle null, undefined, or falsy values
    // Return undefined to indicate no details available
    if (!details) return undefined;

    // Handle object types (but not arrays)
    // Convert all object property values to strings while preserving keys
    if (isObject(details)) {
      const mapped: Record<string, string> = {};

      // Iterate through object entries and convert values to strings
      for (const [key, value] of Object.entries(details)) {
        // Use String() for safe conversion of any value type
        mapped[key] = String(value);
      }
      return mapped;
    }

    // Handle primitives, arrays, and other non-object types
    // Wrap in standardized { info: value } format
    return { info: String(details) };
  } catch (error) {
    // Fallback error handling for extreme cases
    // Return error information if normalization fails
    return {
      error: "Failed to normalize details",
      reason: (error as Error).message,
    };
  }
}
