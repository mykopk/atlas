import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import type { PaginationOptions, SortOptions, Filter } from "@myko/types/db";
import { DB_REGEX } from "@utils/regex";

/**
 * SQL query builder utilities.
 *
 * @description
 * Provides safe, parameterized SQL query generation for WHERE, ORDER BY,
 * and pagination clauses. Each function validates input and throws typed
 * DatabaseErrors on invalid data. Field names are validated against a
 * regex whitelist to prevent SQL injection.
 *
 * Works independently of any specific ORM or query engine — intended for
 * use by repository adapters.
 */

/**
 * Build a WHERE clause string from an array of filters.
 *
 * @description
 * Supports all standard operators (eq, ne, gt, gte, lt, lte, in, notIn,
 * like, between, isNull, isNotNull) and combines multiple filters with
 * AND/OR logical operators. Each condition uses positional parameters
 * ($1, $2, …) for safe parameterised queries.
 *
 * @typeParam T - The record type (defaults to object)
 * @param filters - Array of filter conditions; may be empty or undefined
 * @returns A SQL WHERE clause string (starts with " WHERE "), or "" if no filters
 * @throws {DatabaseError} `INVALID_PARAMETERS` if a filter is missing field/operator,
 *   if logical is not AND/OR, or if operator-specific requirements are violated
 * @throws {DatabaseError} `QUERY_FAILED` if clause building fails
 * @throws {DatabaseError} `INIT_FAILED` if a field name fails validation
 *
 * @example
 * ```typescript
 * const sql = buildWhereClause([
 *   { field: "status", operator: "eq", value: "active" },
 *   { field: "age", operator: "gte", value: 18, logical: "and" },
 * ]);
 * // ' WHERE "status" = $1 AND "age" >= $2'
 * ```
 */
export function buildWhereClause<T extends object = object>(
  filters?: Filter[],
): string {
  if (!filters || filters.length === 0) {
    return "";
  }

  try {
    const conditions: string[] = [];
    let paramIndex = 1;

    for (const filter of filters) {
      if (!filter.field || !filter.operator) {
        throw new DatabaseError(
          "Invalid filter: field and operator are required",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          {
            context: { source: "buildWhereClause" },
            cause: new Error("Invalid filter: field and operator are required"),
          },
        );
      }

      const condition = buildCondition<T>(filter, paramIndex);
      conditions.push(condition.clause);
      paramIndex = condition.paramCount;
    }

    const whereClause = conditions
      .map((cond, idx) => {
        if (idx === 0) return cond;
        const logical = (filters[idx]?.logical ?? "and").toUpperCase();
        if (!["AND", "OR"].includes(logical)) {
          throw new DatabaseError(
            `Invalid logical operator: ${logical}`,
            DATABASE_ERROR_CODES.INVALID_PARAMETERS,
            {
              context: { source: "buildWhereClause" },
              cause: new Error(`Invalid logical operator: ${logical}`),
            },
          );
        }
        return `${logical} ${cond}`;
      })
      .join(" ");

    return " WHERE " + whereClause;
  } catch (error) {
    throw new DatabaseError(
      `Failed to build WHERE clause: ${(error as Error).message}`,
      DATABASE_ERROR_CODES.QUERY_FAILED,
      {
        context: { source: "buildWhereClause" },
        cause: error as Error,
      },
    );
  }
}

/**
 * Build a single SQL condition for a WHERE clause.
 *
 * @description
 * Converts a Filter into a parameterised SQL fragment like `"field" = $1`.
 * Validates field names and operator-specific value types (e.g. IN requires
 * an array, BETWEEN requires exactly 2 values).
 *
 * @typeParam T - The record type (used for value array typing)
 * @param filter - The filter to convert
 * @param startIndex - Starting positional parameter index (1-based)
 * @returns An object containing the clause string and the next parameter index
 * @throws {DatabaseError} `INIT_FAILED` if the field name is invalid
 * @throws {DatabaseError} `INVALID_PARAMETERS` if the operator is unsupported
 *   or the value has the wrong shape
 *
 * @internal
 */
function buildCondition<T>(
  filter: Filter,
  startIndex: number,
): { clause: string; paramCount: number } {
  const { field, operator, value } = filter;
  let paramCount = startIndex;

  // Validate field name to prevent SQL injection
  if (!DB_REGEX.isValidFieldName(field)) {
    throw new DatabaseError(
      `Invalid field name: ${field}`,
      DATABASE_ERROR_CODES.INIT_FAILED,
    );
  }

  const operatorsMap: Record<string, () => string> = {
    eq: () => `"${field}" = $${paramCount++}`,
    ne: () => `"${field}" != $${paramCount++}`,
    gt: () => `"${field}" > $${paramCount++}`,
    gte: () => `"${field}" >= $${paramCount++}`,
    lt: () => `"${field}" < $${paramCount++}`,
    lte: () => `"${field}" <= $${paramCount++}`,
    in: () => {
      if (!Array.isArray(value)) {
        throw new DatabaseError(
          "IN operator requires array value",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          {
            context: { source: "buildCondition" },
            cause: new Error("IN operator requires array value"),
          },
        );
      }
      return `"${field}" IN (${(value as T[]).map(() => `$${paramCount++}`).join(", ")})`;
    },
    notIn: () => {
      if (!Array.isArray(value)) {
        throw new DatabaseError(
          "NOT IN operator requires array value",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          {
            context: { source: "buildCondition" },
            cause: new Error("NOT IN operator requires array value"),
          },
        );
      }
      return `"${field}" NOT IN (${(value as T[]).map(() => `$${paramCount++}`).join(", ")})`;
    },
    like: () => `"${field}" LIKE $${paramCount++}`,
    between: () => {
      const BETWEEN_ARRAY_LENGTH = 2;
      if (
        !Array.isArray(value) ||
        (value as unknown[]).length !== BETWEEN_ARRAY_LENGTH
      ) {
        throw new DatabaseError(
          "BETWEEN operator requires array with exactly 2 values",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          {
            context: { source: "buildCondition" },
            cause: new Error(
              "BETWEEN operator requires array with exactly 2 values",
            ),
          },
        );
      }
      return `"${field}" BETWEEN $${paramCount++} AND $${paramCount++}`;
    },
    isNull: () => `"${field}" IS NULL`,
    isNotNull: () => `"${field}" IS NOT NULL`,
  };

  const clauseFn = operatorsMap[operator];
  if (!clauseFn) {
    throw new DatabaseError(
      `Unsupported operator: ${operator}`,
      DATABASE_ERROR_CODES.INVALID_PARAMETERS,
      {
        context: { source: "buildCondition" },
        cause: new Error(`Unsupported operator: ${operator}`),
      },
    );
  }

  try {
    return { clause: clauseFn(), paramCount };
  } catch (error) {
    throw new DatabaseError(
      `Failed to build condition for field ${field}: ${error instanceof Error ? error.message : "Unknown error"}`,
      DATABASE_ERROR_CODES.INIT_FAILED,
    );
  }
}

/**
 * Build an ORDER BY clause string from sort options.
 *
 * @description
 * Validates each sort option's field name and direction, then produces a
 * clause like `ORDER BY "field" ASC, "field2" DESC`.
 *
 * @param sortOptions - Array of sort options with field and direction
 * @returns An ORDER BY clause string (starts with " ORDER BY "), or "" if none
 * @throws {DatabaseError} `INIT_FAILED` if a field name is invalid
 * @throws {DatabaseError} `INVALID_PARAMETERS` if a direction is not ASC/DESC
 * @throws {DatabaseError} `QUERY_FAILED` if clause building fails
 *
 * @example
 * ```typescript
 * const sql = buildOrderClause([
 *   { field: "createdAt", direction: "desc" },
 *   { field: "name", direction: "asc" },
 * ]);
 * // ' ORDER BY "createdAt" DESC, "name" ASC'
 * ```
 */
export function buildOrderClause(sortOptions?: SortOptions[]): string {
  if (!sortOptions || sortOptions.length === 0) return "";

  try {
    const clauses = sortOptions.map((option) => {
      // Validate field name to prevent SQL injection
      if (!DB_REGEX.isValidFieldName(option.field)) {
        throw new DatabaseError(
          `Invalid field name: ${option.field}`,
          DATABASE_ERROR_CODES.INIT_FAILED,
        );
      }

      const direction = option.direction.toUpperCase();
      if (!["ASC", "DESC"].includes(direction)) {
        throw new DatabaseError(
          `Invalid sort direction: ${direction}`,
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          {
            context: { source: "buildOrderClause" },
            cause: new Error(`Invalid sort direction: ${direction}`),
          },
        );
      }

      return `"${option.field}" ${direction}`;
    });

    return " ORDER BY " + clauses.join(", ");
  } catch (error) {
    throw new DatabaseError(
      `Failed to build ORDER BY clause: ${(error as Error).message}`,
      DATABASE_ERROR_CODES.QUERY_FAILED,
      {
        context: { source: "buildOrderClause" },
        cause: error as Error,
      },
    );
  }
}

/**
 * Build LIMIT and OFFSET clause strings from pagination options.
 *
 * @description
 * Generates a parameterised pagination clause with positional parameters
 * ($1, $2, …). Returns both the clause string and the parameter values
 * for use with parameterised query execution.
 *
 * @typeParam T - The parameter value type (default inferred from pagination values)
 * @param pagination - Pagination options with optional limit and offset
 * @returns An object with `clause` (SQL fragment) and `params` (value array)
 *
 * @example
 * ```typescript
 * const { clause, params } = buildPaginationClause({ limit: 10, offset: 20 });
 * // clause: ' LIMIT $1 OFFSET $2'
 * // params: [10, 20]
 * ```
 */
export function buildPaginationClause<T>(pagination?: PaginationOptions): {
  clause: string;
  params: T[];
} {
  if (!pagination) return { clause: "", params: [] };

  const params: T[] = [];
  let clause = "";

  const { limit, offset } = pagination;

  if (limit !== undefined) {
    clause += ` LIMIT $${params.length + 1}`;
    params.push(limit as T);
  }

  if (offset !== undefined) {
    clause += ` OFFSET $${params.length + 1}`;
    params.push(offset as T);
  }

  return { clause, params };
}
