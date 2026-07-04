/**
 * SQL utility functions for safe query building.
 */

/**
 * Escape and normalize a value for safe use in PostgreSQL ILIKE/LIKE patterns.
 * - Escapes special characters (%, _, \) to prevent wildcard abuse / full table scans
 * - Optionally trims and lowercases the value
 *
 * @param value - Raw user input
 * @param options - Normalization options
 * @param options.trim - Trim whitespace (default: true)
 * @param options.lowercase - Convert to lowercase (default: false, since ILIKE is case-insensitive)
 *
 * @example
 * ```typescript
 * // For ILIKE (case-insensitive — no need for lowercase)
 * query(`WHERE name ILIKE $1`, [`%${escapeIlike(userInput)}%`]);
 *
 * // For LIKE with manual LOWER() (needs lowercase)
 * query(`WHERE LOWER(name) LIKE $1`, [`%${escapeIlike(userInput, { lowercase: true })}%`]);
 * ```
 */
export function escapeIlike(
  value: string,
  options?: { trim?: boolean; lowercase?: boolean },
): string {
  let result = value;
  if (options?.trim !== false) result = result.trim();
  if (options?.lowercase) result = result.toLowerCase();
  return result.replace(/[%_\\]/g, '\\$&');
}
