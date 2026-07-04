/**
 * @fileoverview Database Result Helper Functions for @myko/atlas-client package
 *
 * This module provides utility functions for creating standardized DatabaseResult objects
 * used throughout the @myko/atlas-client package. These helpers ensure consistent result formatting
 * across all database operations and adapters.
 *
 * Part of the @myko/atlas-client package - a TypeScript database abstraction layer with
 * support for multiple adapters (Drizzle, Supabase, SQL), extensions (audit, encryption,
 * soft delete), and advanced features (caching, read replicas, multi-tenancy).
 *
 */

import type { DatabaseResult } from "@myko/types/db";

/**
 * Creates a successful DatabaseResult wrapper for operation results
 *
 * Used throughout all database adapters and extensions to wrap successful operation results
 * in a consistent format. This enables standardized error handling and result processing
 * across the entire @myko/atlas-client package.
 *
 * **Used by:**
 * - All database adapters (DrizzleAdapter, SupabaseAdapter, SQLAdapter)
 * - All extensions (AuditAdapter, EncryptionAdapter, SoftDeleteAdapter, etc.)
 * - DatabaseService for operation results
 * - Repository layer for consistent return types
 *
 * @template T - The type of the successful result value
 * @param {T} value - The successful result value to wrap
 * @returns {DatabaseResult<T>} A success result object with the value
 *
 * @example
 * ```typescript
 * import { success } from '@myko/atlas-client/utils';
 *
 * // In adapter methods
 * async findById<T>(table: string, id: string): Promise<DatabaseResult<T | null>> {
 *   try {
 *     const record = await this.db.select().from(table).where(eq(id));
 *     return success(record[0] || null); // Wrap successful result
 *   } catch (error) {
 *     return failure(new DatabaseError('FIND_FAILED', error.message));
 *   }
 * }
 *
 * // In service methods
 * const userResult = await userRepository.findById('user-123');
 * if (userResult.success) {
 *   console.log('Found user:', userResult.value.name);
 * }
 * ```
 *
 */
export function success<T = null>(value: T = null as T): DatabaseResult<T> {
  return { success: true, value };
}

/**
 * Creates a failed DatabaseResult wrapper for operation errors
 * 
 * Used throughout all database adapters and extensions to wrap error results
 * in a consistent format. This enables standardized error handling and result processing
 * across the entire @myko/atlas-client package.
 * 
 * **Used by:**
 * - All database adapters for error cases
 * - All extensions for error propagation
 * - DatabaseService for operation failures
 * - Repository layer for consistent error handling
 * 
 * @template T - The type that would have been returned on success
 * @param {Error} error - The error that occurred during the operation
 * @returns {DatabaseResult<T>} A failure result object with the error
 * 
 * @example
 * ```typescript
 * import { failure } from '@myko/atlas-client/utils';
 * import { DatabaseError } from '@myko/errors';
import { DATABASE_ERROR_CODES } from '@myko/errors';
 * 
 * // In adapter methods
 * async create<T>(table: string, data: T): Promise<DatabaseResult<T>> {
 *   try {
 *     const result = await this.db.insert(table).values(data).returning();
 *     return success(result[0]);
 *   } catch (error) {
 *     return failure(new DatabaseError(
 *       `Failed to create record: ${error.message}`));
 *   }
 * }
 * 
 * // In service layer error handling
 * const createResult = await userRepository.create(userData);
 * if (!createResult.success) {
 *   logger.error('User creation failed:', createResult.error.message);
 *   throw createResult.error;
 * }
 * ```
 * 
 */
export function failure<T>(error: Error): DatabaseResult<T> {
  return { success: false, error };
}
