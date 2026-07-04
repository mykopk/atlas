import type { Filter, SortOptions, PaginationOptions } from "@myko/types/db";

const FILTER_OP_TO_PRISMA: Record<string, string> = {
  eq: "equals",
  ne: "not",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  in: "in",
  notIn: "notIn",
  like: "contains",
  ilike: "contains",
};

/**
 * Convert a single Filter to a Prisma-compatible where condition.
 *
 * Handles special operators: isNull, isNotNull, between, like, ilike.
 *
 * @param filter - The filter to convert
 * @returns A Prisma-style where object
 */
function filterToPrismaWhere<T extends object>(filter: Filter<T>): Record<string, unknown> {
  const op = FILTER_OP_TO_PRISMA[filter.operator];
  if (filter.operator === "isNull") {
    return { [filter.field]: null };
  }
  if (filter.operator === "isNotNull") {
    return { [filter.field]: { not: null } };
  }
  if (filter.operator === "between") {
    const arr = filter.value as unknown as [unknown, unknown];
    return { [filter.field]: { gte: arr[0], lte: arr[1] } };
  }
  if (op === "equals" || op === "not") {
    return { [filter.field]: filter.value };
  }
  if (filter.operator === "like" || filter.operator === "ilike") {
    const val = String(filter.value);
    return {
      [filter.field]: {
        [op]: val,
        mode: filter.operator === "ilike" ? ("insensitive" as const) : undefined,
      },
    };
  }
  return { [filter.field]: { [op]: filter.value } };
}

/**
 * Build a Prisma-compatible WHERE clause object from one or more filters.
 *
 * @description
 * Accepts a single Filter, an array of Filters, or undefined.
 * Multiple filters are combined with AND logic.
 *
 * @typeParam T - The record type the filter applies to
 * @param filters - Single filter, array of filters, or undefined
 * @returns A Prisma-style WHERE object, or undefined if no filters
 *
 * @example
 * ```typescript
 * const where = buildWhereClauseORM<User>([
 *   { field: "status", operator: "eq", value: "active" },
 *   { field: "age", operator: "gte", value: 18, logical: "and" },
 * ]);
 * // { AND: [{ status: "active" }, { age: { gte: 18 } }] }
 * ```
 */
export function buildWhereClauseORM<T extends object>(
  filters?: Filter<T> | Filter<T>[],
): Record<string, unknown> | undefined {
  if (!filters) return undefined;
  const arr = Array.isArray(filters) ? filters : [filters];
  if (arr.length === 0) return undefined;
  if (arr.length === 1) return filterToPrismaWhere(arr[0]);
  return { AND: arr.map((f) => filterToPrismaWhere(f)) };
}

/**
 * Build a Prisma-compatible ORDER BY object from sort options.
 *
 * @description
 * Converts an array of SortOptions into a flat Prisma orderBy object.
 * If multiple sort fields reference the same key, later entries overwrite
 * earlier ones.
 *
 * @typeParam T - The record type being sorted
 * @param sort - Array of sort options (or undefined)
 * @returns A flat Prisma orderBy object, or undefined if no sort options
 *
 * @example
 * ```typescript
 * const orderBy = buildOrderClauseORM<User>([
 *   { field: "createdAt", direction: "desc" },
 * ]);
 * // { createdAt: "desc" }
 * ```
 */
export function buildOrderClauseORM<T extends object>(
  sort?: SortOptions<T>[],
): Record<string, "asc" | "desc"> | undefined {
  if (!sort || sort.length === 0) return undefined;
  const result: Record<string, "asc" | "desc"> = {};
  for (const s of sort) {
    result[s.field as string] = s.direction;
  }
  return result;
}

/**
 * Build a Prisma-compatible pagination object (take/skip) from pagination options.
 *
 * @param pagination - Pagination options containing limit and/or offset
 * @returns An object with `take` and/or `skip`, or undefined if no pagination set
 *
 * @example
 * ```typescript
 * const pag = buildPaginationClauseORM({ limit: 10, offset: 20 });
 * // { take: 10, skip: 20 }
 * ```
 */
export function buildPaginationClauseORM(
  pagination?: PaginationOptions,
): { take?: number; skip?: number } | undefined {
  if (!pagination) return undefined;
  const result: { take?: number; skip?: number } = {};
  if (pagination.limit !== undefined) result.take = pagination.limit;
  if (pagination.offset !== undefined) result.skip = pagination.offset;
  return Object.keys(result).length > 0 ? result : undefined;
}
