/**
 * @fileoverview Pagination Utilities for @myko/atlas-client package
 *
 * This module provides pagination calculation utilities used across all database adapters
 * to generate consistent pagination metadata for query results. Supports offset-based
 * pagination with page calculation and validation.
 *
 * Part of the @myko/atlas-client package - a TypeScript database abstraction layer with
 * support for multiple adapters (Drizzle, Supabase, SQL), extensions (audit, encryption,
 * soft delete), and advanced features (caching, read replicas, multi-tenancy).
 *
 * @module pagination
 */

import type { PaginationInfo, PaginationOptions } from "@myko/types";
import { isNumber } from "./typeGuards";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";

/**
 * Validates pagination input parameters for safety and consistency
 *
 * Performs comprehensive validation of pagination parameters to prevent invalid
 * calculations and ensure consistent behavior across all database adapters.
 *
 * **Validation Rules:**
 * - Total must be a non-negative number (>= 0)
 * - Limit must be a positive number (> 0) if provided
 * - Offset must be a non-negative number (>= 0)
 *
 * @private
 * @param {number} total - Total number of items in the dataset
 * @param {number} [limit] - Optional maximum number of items per page
 * @param {number} [offset] - Optional number of items to skip (default: 0)
 * @throws {Error} If any parameter fails validation
 *
 * @example
 * ```typescript
 * // Valid inputs
 * validatePaginationInputs(100, 20, 0);  // ✓ Valid
 * validatePaginationInputs(0, 10, 0);    // ✓ Valid (empty dataset)
 * validatePaginationInputs(50);          // ✓ Valid (no pagination)
 *
 * // Invalid inputs
 * validatePaginationInputs(-1, 10, 0);   // ✗ Throws: negative total
 * validatePaginationInputs(100, 0, 0);   // ✗ Throws: zero limit
 * validatePaginationInputs(100, 10, -5); // ✗ Throws: negative offset
 * ```
 *
 */
function validatePaginationInputs(
  total: number,
  limit?: number,
  offset?: number,
): void {
  // Total count validation
  // Must be non-negative to represent valid dataset size
  if (!isNumber(total) || total < 0) {
    throw new DatabaseError(
      "Total must be a non-negative number",
      DATABASE_ERROR_CODES.INVALID_PARAMETERS,
      {
        context: { source: "validatePaginationInputs" },
        cause: new Error("Total must be a non-negative number"),
      },
    );
  }

  // Limit validation (if provided)
  // Must be positive to create meaningful pages
  if (limit !== undefined && (!isNumber(limit) || limit <= 0)) {
    throw new DatabaseError(
      "Limit must be a positive number",
      DATABASE_ERROR_CODES.INVALID_PARAMETERS,
      {
        context: { source: "validatePaginationInputs" },
        cause: new Error("Limit must be a positive number"),
      },
    );
  }

  // Offset validation
  // Must be non-negative to represent valid starting position
  if (!isNumber(offset) || offset < 0) {
    throw new DatabaseError(
      "Offset must be a non-negative number",
      DATABASE_ERROR_CODES.INVALID_PARAMETERS,
      {
        context: { source: "validatePaginationInputs" },
        cause: new Error("Offset must be a non-negative number"),
      },
    );
  }
}

/**
 * Calculates comprehensive pagination metadata for database query results
 *
 * Generates pagination information used by all database adapters to provide
 * consistent pagination metadata in query results. Supports both paginated
 * and non-paginated queries with automatic page calculation.
 *
 * **Used by:**
 * - DrizzleAdapter.findMany() for ORM-based pagination
 * - SupabaseAdapter.findMany() for Supabase pagination
 * - SQLAdapter.findMany() for raw SQL pagination
 * - All repository methods that return paginated results
 *
 * **Calculation Logic:**
 * - Page numbers are 1-based (first page = 1)
 * - Current page = floor(offset / limit) + 1
 * - Total pages = ceil(total / limit)
 * - Handles edge cases (no limit, empty results, etc.)
 *
 * @param {number} total - Total number of items matching the query
 * @param {PaginationOptions} [options] - Optional pagination configuration
 * @param {number} [options.limit] - Maximum items per page
 * @param {number} [options.offset] - Number of items to skip (default: 0)
 * @returns {PaginationInfo} Complete pagination metadata object
 *
 * @example
 * ```typescript
 * import { calculatePagination } from '@myko/atlas-client/utils';
 *
 * // Standard pagination (page 2 of 20 items per page)
 * const pagination1 = calculatePagination(100, { limit: 20, offset: 20 });
 * console.log(pagination1);
 * // {
 * //   page: 2,
 * //   limit: 20,
 * //   offset: 20,
 * //   totalPages: 5
 * // }
 *
 * // First page
 * const pagination2 = calculatePagination(100, { limit: 20, offset: 0 });
 * console.log(pagination2);
 * // {
 * //   page: 1,
 * //   limit: 20,
 * //   offset: 0,
 * //   totalPages: 5
 * // }
 *
 * // No pagination (return all results)
 * const pagination3 = calculatePagination(100);
 * console.log(pagination3);
 * // {
 * //   page: undefined,
 * //   limit: undefined,
 * //   offset: 0,
 * //   totalPages: undefined
 * // }
 * ```
 *
 */
export function calculatePagination(
  total: number,
  options?: PaginationOptions,
): PaginationInfo {
  const limit = options?.limit;
  const offset = options?.offset ?? 0;

  // Validate all inputs before calculation
  validatePaginationInputs(total, limit, offset);

  // Calculate current page (1-based indexing)
  // Only calculate if limit is provided and positive
  // Formula: floor(offset / limit) + 1
  // Example: offset=20, limit=10 → floor(20/10) + 1 = 3 (page 3)
  const page = limit && limit > 0 ? Math.floor(offset / limit) + 1 : undefined;

  // Calculate total number of pages
  // Only calculate if limit is provided and positive
  // Formula: ceil(total / limit)
  // Example: total=95, limit=10 → ceil(95/10) = 10 pages
  const totalPages = limit && limit > 0 ? Math.ceil(total / limit) : undefined;

  return {
    page,
    limit,
    offset,
    totalPages,
  };
}
