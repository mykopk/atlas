import type {
  Filter,
  QueryOptions,
  SortOptions,
  PaginationOptions,
  DatabaseResult,
  PaginatedResult,
  OperationConfig,
  // QueryBuilder types
  FilterOperator,
  RawCondition,
  JoinClause,
  GroupByClause,
  SelectClause,
  QueryBuilderResult,
  QueryExecutor,
} from "@myko/types/db";

/**
 * Re-exported database filter operator type.
 *
 * @description
 * Represents the set of supported comparison operators for WHERE conditions
 * (e.g. `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`,
 * `ilike`, `between`, `isNull`, `isNotNull`).
 */
export type {
  FilterOperator,
  /**
   * Raw SQL condition expression with positional parameters.
   */
  RawCondition,
  /**
   * SQL JOIN clause descriptor (type, table, condition, schema, alias).
   */
  JoinClause,
  /**
   * GROUP BY clause descriptor with optional HAVING conditions.
   */
  GroupByClause,
  /**
   * SELECT clause descriptor (fields, raw expressions, distinct flag).
   */
  SelectClause,
  /**
   * Full query builder result containing filters, joins, group-by, and select.
   */
  QueryBuilderResult,
  /**
   * Repository execution interface providing findMany and optional count.
   */
  QueryExecutor,
};

/**
 * Fluent Query Builder.
 *
 * @description
 * Provides a chainable API for constructing database queries with full type safety.
 * Supports WHERE (standard + raw), JOIN, GROUP BY / HAVING, SELECT (fields + raw),
 * ORDER BY, pagination (offset + cursor), and schema selection.
 *
 * Two usage modes:
 * 1. **Standalone** — call {@link create} to build a query and use
 *    {@link build} / {@link buildFull} to produce a `QueryOptions` / `QueryBuilderResult`.
 * 2. **Repository-bound** — call {@link forRepository} to bind an executor,
 *    enabling direct execution via {@link execute}, {@link getMany}, {@link getOne},
 *    {@link count}, and {@link exists}.
 *
 * @typeParam TRecord - The entity/record type this query operates on
 *
 * @example
 * ```typescript
 * const result = await QueryBuilder
 *   .create<User>()
 *   .where('status', 'eq', 'active')
 *   .andWhere('age', 'gte', 18)
 *   .orderByDesc('createdAt')
 *   .paginate(1, 20)
 *   .build();
 * ```
 */
export class QueryBuilder<TRecord extends object> {
  private _filters: Filter<TRecord>[] = [];
  private _rawConditions: RawCondition[] = [];
  private _sort: SortOptions<TRecord>[] = [];
  private _pagination: PaginationOptions = {};
  private _schema?: string;
  private _executor?: QueryExecutor<TRecord>;
  private _operationConfig?: OperationConfig;
  private _countExecutor?: (
    filter?: Filter<TRecord>,
  ) => Promise<DatabaseResult<number>>;

  // Advanced query features
  private _joins: JoinClause[] = [];
  private _groupByFields: string[] = [];
  private _havingConditions: RawCondition[] = [];
  private _selectFields: string[] = [];
  private _selectRawExpressions: string[] = [];
  private _distinct: boolean = false;

  /**
   * Create a new standalone QueryBuilder.
   *
   * @description
   * The returned builder has no executor bound and supports building
   * query options via {@link build} / {@link buildFull}.
   *
   * @typeParam T - The record type the builder operates on
   * @returns A new unbound QueryBuilder instance
   *
   * @example
   * ```typescript
   * const qb = QueryBuilder.create<User>().where('age', 'gt', 21);
   * const options = qb.build();
   * ```
   */
  static create<T extends object>(): QueryBuilder<T> {
    return new QueryBuilder<T>();
  }

  /**
   * Create a QueryBuilder bound to a repository executor for direct execution.
   *
   * @description
   * The returned builder is pre-bound to the given executor, enabling
   * {@link execute}, {@link getMany}, {@link getOne}, {@link count}, and
   * {@link exists} without a separate repository call.
   *
   * @typeParam T - The record type the executor handles
   * @param executor - The query executor (typically a repository's internal executor)
   * @returns A new QueryBuilder bound to the executor
   *
   * @example
   * ```typescript
   * const qb = QueryBuilder.forRepository(userRepo.executor())
   *   .where('status', 'eq', 'active')
   *   .execute();
   * ```
   */
  static forRepository<T extends object>(
    executor: QueryExecutor<T>,
  ): QueryBuilder<T> {
    const builder = new QueryBuilder<T>();
    builder._executor = executor;
    return builder;
  }

  private constructor() {}

  /**
   * Add a WHERE condition with AND logical operator.
   *
   * @description
   * The first call omits the logical operator; subsequent calls default to AND.
   * For explicit AND, use {@link andWhere}.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @param operator - The filter operator (eq, ne, gt, gte, lt, lte, etc.)
   * @param value - The value to compare against (typed to the field's type)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.where('status', 'eq', 'active').where('age', 'gte', 18);
   * ```
   */
  where<K extends keyof TRecord & string>(
    field: K,
    operator: FilterOperator,
    value: TRecord[K],
  ): this {
    this._filters.push({
      field,
      operator,
      value,
      logical: this._filters.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a WHERE condition with explicit AND logical operator.
   *
   * @description
   * Always prefixes the condition with AND, regardless of position in the chain.
   * Useful after an {@link orWhere} call to return to AND conjunction.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @param operator - The filter operator
   * @param value - The value to compare against
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder
   *   .where('status', 'eq', 'active')
   *   .orWhere('role', 'eq', 'admin')
   *   .andWhere('age', 'gte', 18);
   * ```
   */
  andWhere<K extends keyof TRecord & string>(
    field: K,
    operator: FilterOperator,
    value: TRecord[K],
  ): this {
    this._filters.push({
      field,
      operator,
      value,
      logical: "and",
    });
    return this;
  }

  /**
   * Add a WHERE condition with OR logical operator.
   *
   * @description
   * Always prefixes the condition with OR, enabling disjunctive
   * combinations within the WHERE clause.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @param operator - The filter operator
   * @param value - The value to compare against
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder
   *   .where('status', 'eq', 'active')
   *   .orWhere('status', 'eq', 'pending');
   * ```
   */
  orWhere<K extends keyof TRecord & string>(
    field: K,
    operator: FilterOperator,
    value: TRecord[K],
  ): this {
    this._filters.push({
      field,
      operator,
      value,
      logical: "or",
    });
    return this;
  }

  /**
   * Add a WHERE IN condition.
   *
   * @description
   * Checks if the field's value is in the given array.
   * The first call omits the logical operator; subsequent calls default to AND.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @param values - Array of allowed values
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.whereIn('status', ['active', 'pending']);
   * ```
   */
  whereIn<K extends keyof TRecord & string>(
    field: K,
    values: TRecord[K][],
  ): this {
    this._filters.push({
      field,
      operator: "in",
      value: values as TRecord[K],
      logical: this._filters.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a WHERE NOT IN condition.
   *
   * @description
   * Excludes records whose field value is in the given array.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @param values - Array of excluded values
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.whereNotIn('status', ['deleted', 'archived']);
   * ```
   */
  whereNotIn<K extends keyof TRecord & string>(
    field: K,
    values: TRecord[K][],
  ): this {
    this._filters.push({
      field,
      operator: "notIn",
      value: values as TRecord[K],
      logical: this._filters.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a WHERE BETWEEN condition.
   *
   * @description
   * Filters records where the field falls within the inclusive range [min, max].
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @param min - Lower bound (inclusive)
   * @param max - Upper bound (inclusive)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.whereBetween('age', 18, 65);
   * ```
   */
  whereBetween<K extends keyof TRecord & string>(
    field: K,
    min: TRecord[K],
    max: TRecord[K],
  ): this {
    this._filters.push({
      field,
      operator: "between",
      value: [min, max] as unknown as TRecord[K],
      logical: this._filters.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a WHERE LIKE condition for pattern matching.
   *
   * @description
   * Uses SQL `LIKE` for pattern matching. Use `%` as a wildcard.
   * For case-insensitive matching on PostgreSQL, use {@link whereILike}.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @param pattern - LIKE pattern (e.g. `"%john%"`)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.whereLike('name', '%john%');
   * ```
   */
  whereLike<K extends keyof TRecord & string>(field: K, pattern: string): this {
    this._filters.push({
      field,
      operator: "like",
      value: pattern as TRecord[K],
      logical: this._filters.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a case-insensitive ILIKE condition (PostgreSQL only).
   *
   * @description
   * Uses PostgreSQL's `ILIKE` operator for case-insensitive pattern matching.
   * Use `%` as a wildcard. Not available on other database engines.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @param pattern - ILIKE pattern (e.g. `"%john%"`)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.whereILike('email', '%@EXAMPLE.COM%');
   * ```
   */
  whereILike<K extends keyof TRecord & string>(field: K, pattern: string): this {
    this._filters.push({
      field,
      operator: "ilike",
      value: pattern as TRecord[K],
      logical: this._filters.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a WHERE IS NULL condition.
   *
   * @description
   * Filters records where the specified field is NULL.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.whereNull('deletedAt');
   * ```
   */
  whereNull<K extends keyof TRecord & string>(field: K): this {
    this._filters.push({
      field,
      operator: "isNull",
      value: null as TRecord[K],
      logical: this._filters.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a WHERE IS NOT NULL condition.
   *
   * @description
   * Filters records where the specified field is NOT NULL.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.whereNotNull('email');
   * ```
   */
  whereNotNull<K extends keyof TRecord & string>(field: K): this {
    this._filters.push({
      field,
      operator: "isNotNull",
      value: null as TRecord[K],
      logical: this._filters.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a raw SQL WHERE condition for complex queries.
   *
   * @description
   * Use for conditions that cannot be expressed with standard operators,
   * such as subqueries, JSON operations, or full-text search.
   * The clause may contain positional parameters (`$1`, `$2`, …) which
   * are bound from the `params` array.
   *
   * @param clause - Raw SQL fragment (e.g. `"metadata"->'tags' @> $1`)
   * @param params - Parameter values for positional placeholders (default: `[]`)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * // JSON field query (PostgreSQL)
   * builder.whereRaw('"metadata"->\'tags\' @> $1', [JSON.stringify(['featured'])])
   *
   * // Full-text search
   * builder.whereRaw('to_tsvector(name) @@ plainto_tsquery($1)', ['search term'])
   *
   * // Date functions
   * builder.whereRaw('DATE_TRUNC(\'month\', "createdAt") = DATE_TRUNC(\'month\', $1)', [new Date()])
   * ```
   */
  whereRaw(clause: string, params: unknown[] = []): this {
    const hasConditions =
      this._filters.length > 0 || this._rawConditions.length > 0;
    this._rawConditions.push({
      clause,
      params,
      logical: hasConditions ? "and" : undefined,
    });
    return this;
  }

  /**
   * Add a raw SQL WHERE condition with explicit AND logical operator.
   *
   * @description
   * Always prefixes the condition with AND, regardless of position
   * in the chain. Use when you want to guarantee AND conjunction.
   *
   * @param clause - Raw SQL fragment with optional positional parameters
   * @param params - Parameter values for positional placeholders (default: `[]`)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder
   *   .whereRaw('"metadata" @> $1', ['{}'])
   *   .andWhereRaw('"age" > $1', [18]);
   * ```
   */
  andWhereRaw(clause: string, params: unknown[] = []): this {
    this._rawConditions.push({
      clause,
      params,
      logical: "and",
    });
    return this;
  }

  /**
   * Add a raw SQL WHERE condition with OR logical operator.
   *
   * @param clause - Raw SQL fragment with optional positional parameters
   * @param params - Parameter values for positional placeholders (default: `[]`)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder
   *   .where('age', 'lt', 18)
   *   .orWhereRaw('"parental_consent" = $1', [true]);
   * ```
   */
  orWhereRaw(clause: string, params: unknown[] = []): this {
    this._rawConditions.push({
      clause,
      params,
      logical: "or",
    });
    return this;
  }

  // ============================================================
  // SELECT Methods
  // ============================================================

  /**
   * Select specific fields (columns) to return.
   *
   * @description
   * When called, only the specified fields are included in the result.
   * If not called, all columns (`*`) are returned.
   * Can be called multiple times with additional fields.
   *
   * @typeParam K - Field key of TRecord
   * @param fields - One or more field/column names to include
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.select('id', 'name', 'email');
   * ```
   */
  select<K extends keyof TRecord & string>(...fields: (K | string)[]): this {
    this._selectFields.push(...fields);
    return this;
  }

  /**
   * Add a raw SQL expression to the SELECT clause.
   *
   * @description
   * Use for computed columns, aggregate functions, or expressions that
   * cannot be expressed as simple field names (e.g. `COUNT(*) as total`,
   * `CONCAT(first_name, ' ', last_name) as full_name`).
   *
   * @param expression - Raw SQL expression to include in SELECT
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.selectRaw('COUNT(*) as count').selectRaw('AVG(score) as average');
   * ```
   */
  selectRaw(expression: string): this {
    this._selectRawExpressions.push(expression);
    return this;
  }

  /**
   * Add DISTINCT to the SELECT clause.
   *
   * @description
   * Ensures the query returns only distinct rows.
   *
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.distinct().select('status');
   * ```
   */
  distinct(): this {
    this._distinct = true;
    return this;
  }

  // ============================================================
  // JOIN Methods
  // ============================================================

  /**
   * Add an INNER JOIN clause (alias for {@link innerJoin}).
   *
   * @param table - Table name (optionally schema-qualified, e.g. `"public.orders"`)
   * @param condition - JOIN condition (e.g. `"users.id = orders.user_id"`)
   * @param alias - Optional table alias
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.join('orders', 'users.id = orders.user_id')
   * ```
   */
  join(table: string, condition: string, alias?: string): this {
    return this.innerJoin(table, condition, alias);
  }

  /**
   * Add an INNER JOIN clause.
   *
   * @param table - Table name (optionally schema-qualified)
   * @param condition - JOIN condition
   * @param alias - Optional table alias
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.innerJoin('orders', 'users.id = orders.user_id', 'o');
   * ```
   */
  innerJoin(table: string, condition: string, alias?: string): this {
    const [schema, tableName] = this.parseTableName(table);
    this._joins.push({
      type: "inner",
      table: tableName,
      condition,
      alias,
      schema,
    });
    return this;
  }

  /**
   * Add a LEFT JOIN clause.
   *
   * @param table - Table name (optionally schema-qualified)
   * @param condition - JOIN condition
   * @param alias - Optional table alias
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.leftJoin('profiles', 'users.id = profiles.user_id');
   * ```
   */
  leftJoin(table: string, condition: string, alias?: string): this {
    const [schema, tableName] = this.parseTableName(table);
    this._joins.push({
      type: "left",
      table: tableName,
      condition,
      alias,
      schema,
    });
    return this;
  }

  /**
   * Add a RIGHT JOIN clause.
   *
   * @param table - Table name (optionally schema-qualified)
   * @param condition - JOIN condition
   * @param alias - Optional table alias
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.rightJoin('orders', 'users.id = orders.user_id');
   * ```
   */
  rightJoin(table: string, condition: string, alias?: string): this {
    const [schema, tableName] = this.parseTableName(table);
    this._joins.push({
      type: "right",
      table: tableName,
      condition,
      alias,
      schema,
    });
    return this;
  }

  /**
   * Add a FULL OUTER JOIN clause.
   *
   * @param table - Table name (optionally schema-qualified)
   * @param condition - JOIN condition
   * @param alias - Optional table alias
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.fullJoin('orders', 'users.id = orders.user_id');
   * ```
   */
  fullJoin(table: string, condition: string, alias?: string): this {
    const [schema, tableName] = this.parseTableName(table);
    this._joins.push({
      type: "full",
      table: tableName,
      condition,
      alias,
      schema,
    });
    return this;
  }

  /**
   * Parse a table name that may include a schema prefix.
   *
   * @param table - Table name, optionally `"schema.table"`
   * @returns A tuple of `[schema | undefined, tableName]`
   */
  private parseTableName(table: string): [string | undefined, string] {
    const SCHEMA_TABLE_PARTS = 2;
    const parts = table.split(".");
    if (parts.length === SCHEMA_TABLE_PARTS) {
      return [parts[0], parts[1]];
    }
    return [undefined, table];
  }

  // ============================================================
  // GROUP BY / HAVING Methods
  // ============================================================

  /**
   * Add a GROUP BY clause.
   *
   * @description
   * Groups results by the specified fields, typically used with
   * aggregate functions in {@link selectRaw}.
   *
   * @typeParam K - Field key of TRecord
   * @param fields - One or more field names to group by
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder
   *   .selectRaw('COUNT(*) as count')
   *   .groupBy('status');
   * ```
   */
  groupBy<K extends keyof TRecord & string>(...fields: (K | string)[]): this {
    this._groupByFields.push(...fields);
    return this;
  }

  /**
   * Add a HAVING condition (used with GROUP BY).
   *
   * @description
   * Filters groups after aggregation. The clause may contain positional
   * parameters (`$1`, `$2`, …) bound from the `params` array.
   *
   * @param clause - Raw HAVING condition (e.g. `"COUNT(*) > $1"`)
   * @param params - Parameter values for positional placeholders (default: `[]`)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder
   *   .select('status')
   *   .selectRaw('COUNT(*) as count')
   *   .groupBy('status')
   *   .having('COUNT(*) > $1', [10]);
   * ```
   */
  having(clause: string, params: unknown[] = []): this {
    this._havingConditions.push({
      clause,
      params,
      logical: this._havingConditions.length === 0 ? undefined : "and",
    });
    return this;
  }

  /**
   * Add a HAVING condition with OR logical operator.
   *
   * @param clause - Raw HAVING condition
   * @param params - Parameter values for positional placeholders (default: `[]`)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder
   *   .groupBy('department')
   *   .having('SUM(salary) > $1', [100000])
   *   .orHaving('COUNT(*) > $2', [50]);
   * ```
   */
  orHaving(clause: string, params: unknown[] = []): this {
    this._havingConditions.push({
      clause,
      params,
      logical: "or",
    });
    return this;
  }

  /**
   * Add an ORDER BY clause.
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name to sort by
   * @param direction - Sort direction: `"asc"` (default) or `"desc"`
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.orderBy('createdAt', 'desc');
   * ```
   */
  orderBy<K extends keyof TRecord & string>(
    field: K,
    direction: "asc" | "desc" = "asc",
  ): this {
    this._sort.push({ field, direction });
    return this;
  }

  /**
   * Add an ORDER BY ASC clause (convenience).
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name to sort ascending
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.orderByAsc('name');
   * ```
   */
  orderByAsc<K extends keyof TRecord & string>(field: K): this {
    return this.orderBy(field, "asc");
  }

  /**
   * Add an ORDER BY DESC clause (convenience).
   *
   * @typeParam K - Field key of TRecord
   * @param field - The field/column name to sort descending
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.orderByDesc('createdAt');
   * ```
   */
  orderByDesc<K extends keyof TRecord & string>(field: K): this {
    return this.orderBy(field, "desc");
  }

  /**
   * Set LIMIT on the number of results returned.
   *
   * @param limit - Maximum number of records to return (must be >= 0)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.limit(10);
   * ```
   */
  limit(limit: number): this {
    this._pagination.limit = limit;
    return this;
  }

  /**
   * Set OFFSET for result skipping.
   *
   * @param offset - Number of records to skip (must be >= 0)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.offset(20);
   * ```
   */
  offset(offset: number): this {
    this._pagination.offset = offset;
    return this;
  }

  /**
   * Set pagination by page number (1-indexed).
   *
   * @description
   * Convenience method that calculates offset from page and pageSize.
   * Page 1 returns the first `pageSize` records.
   *
   * @param page - Page number (1-indexed)
   * @param pageSize - Number of records per page
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.paginate(2, 20); // offset = 20, limit = 20
   * ```
   */
  paginate(page: number, pageSize: number): this {
    this._pagination.limit = pageSize;
    this._pagination.offset = (page - 1) * pageSize;
    return this;
  }

  /**
   * Set a cursor for cursor-based pagination.
   *
   * @description
   * Cursor-based pagination is more stable than offset-based for high-write
   * datasets. The cursor value is typically an opaque string (e.g. a base64-
   * encoded record identifier) that the adapter resolves internally.
   *
   * @param cursor - Opaque cursor string
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.afterCursor('eyJpZCI6MX0=');
   * ```
   */
  afterCursor(cursor: string): this {
    this._pagination.cursor = cursor;
    return this;
  }

  /**
   * Set the database schema for this query.
   *
   * @param schema - Schema name (e.g. `"public"`, `"billing"`)
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.schema('billing');
   * ```
   */
  schema(schema: string): this {
    this._schema = schema;
    return this;
  }

  /**
   * Set operation config for query execution.
   *
   * @description
   * Operation config can include settings like timeout, retry policy,
   * or read-replica preference that the adapter honours during execution.
   *
   * @param config - Operation configuration object
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * builder.withConfig({ timeout: 5000, useReplica: true });
   * ```
   */
  withConfig(config: OperationConfig): this {
    this._operationConfig = config;
    return this;
  }

  /**
   * Execute the query using the bound repository executor.
   *
   * @description
   * Requires that the builder was created via {@link forRepository} or
   * was attached to a repository's executor. Returns a paginated result
   * that includes the data array and total count (if supported).
   *
   * @returns A paginated result with the matching records
   * @throws {Error} If no executor is bound — use {@link forRepository} or
   *   call via `repository.query()`.
   *
   * @example
   * ```typescript
   * const result = await QueryBuilder
   *   .forRepository(executor)
   *   .where('status', 'eq', 'active')
   *   .execute();
   * ```
   */
  async execute(): Promise<DatabaseResult<PaginatedResult<TRecord>>> {
    if (!this._executor) {
      throw new Error(
        "QueryBuilder has no executor. Use repository.query() or QueryBuilder.forRepository() to enable execute().",
      );
    }
    return this._executor.findMany(this.build(), this._operationConfig);
  }

  /**
   * Execute and return just the data array.
   *
   * @description
   * Convenience wrapper around {@link execute} that unwraps the result
   * and throws on failure.
   *
   * @returns The array of matching records
   * @throws {Error} If the query fails or no executor is bound
   *
   * @example
   * ```typescript
   * const users = await builder
   *   .where('active', 'eq', true)
   *   .getMany();
   * ```
   */
  async getMany(): Promise<TRecord[]> {
    const result = await this.execute();
    if (!result.success || !result.value) {
      throw result.error ?? new Error("Query failed");
    }
    return result.value.data;
  }

  /**
   * Execute and return the first result, or `null` if none match.
   *
   * @description
   * Internally sets `LIMIT 1`, executes the query, then restores the
   * original limit.
   *
   * @returns The first matching record or `null`
   * @throws {Error} If the query fails or no executor is bound
   *
   * @example
   * ```typescript
   * const user = await builder
   *   .where('id', 'eq', userId)
   *   .getOne();
   * // → User | null
   * ```
   */
  async getOne(): Promise<TRecord | null> {
    const originalLimit = this._pagination.limit;
    this._pagination.limit = 1;

    const result = await this.execute();

    this._pagination.limit = originalLimit;

    if (!result.success || !result.value) {
      throw result.error ?? new Error("Query failed");
    }
    return result.value.data[0] ?? null;
  }

  /**
   * Execute a count query.
   *
   * @description
   * Returns the count of records matching the current filter conditions.
   * Ignores pagination, joins, and sorting — only filters are considered.
   * Requires the executor to expose a `count` method.
   *
   * @returns The number of matching records
   * @throws {Error} If no executor is bound or the executor lacks a `count` method
   *
   * @example
   * ```typescript
   * const total = await builder
   *   .where('status', 'eq', 'active')
   *   .count();
   * ```
   */
  async count(): Promise<number> {
    if (!this._executor) {
      throw new Error(
        "QueryBuilder has no executor. Use repository.query() to enable count().",
      );
    }
    if (!this._executor.count) {
      throw new Error("Executor does not support count().");
    }

    const filters = this._filters.length > 0 ? [...this._filters] : undefined;
    const result = await this._executor.count(filters, this._operationConfig);

    if (!result.success) {
      throw result.error ?? new Error("Count query failed");
    }
    return result.value ?? 0;
  }

  /**
   * Check whether any records exist matching the current conditions.
   *
   * @description
   * Internally calls {@link count} and returns `true` if the count > 0.
   *
   * @returns `true` if at least one matching record exists
   * @throws {Error} If the query fails or no executor is bound
   *
   * @example
   * ```typescript
   * const hasActive = await builder
   *   .where('status', 'eq', 'active')
   *   .exists();
   * ```
   */
  async exists(): Promise<boolean> {
    const count = await this.count();
    return count > 0;
  }

  /**
   * Build a `QueryOptions` object for use with `BaseRepository.findMany()`.
   *
   * @description
   * Produces a backward-compatible options object that sets both `filter`
   * (single, first filter) and `filters` (full array) so adapters can use
   * multi-filter support. Also includes sort, pagination, and schema
   * when they are defined.
   *
   * @returns `QueryOptions<TRecord>` with only the set properties
   *
   * @example
   * ```typescript
   * const options = builder
   *   .where('status', 'eq', 'active')
   *   .orderByAsc('name')
   *   .build();
   * ```
   */
  build(): QueryOptions<TRecord> {
    const options: QueryOptions<TRecord> = {};

    if (this._filters.length > 0) {
      options.filter = this._filters[0];
      options.filters = [...this._filters];
    }

    if (this._sort.length > 0) {
      options.sort = this._sort;
    }

    if (
      this._pagination.limit !== undefined ||
      this._pagination.offset !== undefined ||
      this._pagination.cursor !== undefined
    ) {
      options.pagination = this._pagination;
    }

    if (this._schema) {
      options.schema = this._schema;
    }

    return options;
  }

  /**
   * Build and return the full query result including filters, raw conditions,
   * joins, group-by, and select clauses.
   *
   * @description
   * Unlike {@link build}, this method returns the complete `QueryBuilderResult`
   * with all advanced query features. Use for direct SQL building or when
   * the adapter needs full access to joins, raw conditions, and select expressions.
   *
   * @returns `QueryBuilderResult<TRecord>` with every configured clause
   *
   * @example
   * ```typescript
   * const full = builder
   *   .where('status', 'eq', 'active')
   *   .innerJoin('orders', 'users.id = orders.user_id')
   *   .buildFull();
   * // full.joins → [{ type: 'inner', table: 'orders', ... }]
   * ```
   */
  buildFull(): QueryBuilderResult<TRecord> {
    const result: QueryBuilderResult<TRecord> = {
      options: this.build(),
      filters: [...this._filters],
      rawConditions: [...this._rawConditions],
      joins: [...this._joins],
    };

    if (this._groupByFields.length > 0) {
      result.groupBy = {
        fields: [...this._groupByFields],
        having:
          this._havingConditions.length > 0
            ? this._havingConditions.map((h) => ({ ...h }))
            : undefined,
      };
    }

    if (
      this._selectFields.length > 0 ||
      this._selectRawExpressions.length > 0 ||
      this._distinct
    ) {
      result.select = {
        fields: [...this._selectFields],
        rawExpressions: [...this._selectRawExpressions],
        distinct: this._distinct,
      };
    }

    return result;
  }

  /**
   * Get a copy of all filters for direct SQL building.
   *
   * @returns A shallow copy of the filters array
   *
   * @example
   * ```typescript
   * const filters = builder.toFilters();
   * ```
   */
  toFilters(): Filter<TRecord>[] {
    return [...this._filters];
  }

  /**
   * Get a copy of all raw SQL conditions for manual SQL building.
   *
   * @returns A shallow copy of the raw conditions array
   *
   * @example
   * ```typescript
   * const raw = builder.toRawConditions();
   * ```
   */
  toRawConditions(): RawCondition[] {
    return [...this._rawConditions];
  }

  /**
   * Get a copy of all sort options.
   *
   * @returns A shallow copy of the sort options array
   *
   * @example
   * ```typescript
   * const sorts = builder.toSortOptions();
   * ```
   */
  toSortOptions(): SortOptions<TRecord>[] {
    return [...this._sort];
  }

  /**
   * Get a copy of the pagination options.
   *
   * @returns A shallow copy of the pagination object
   *
   * @example
   * ```typescript
   * const pag = builder.toPaginationOptions();
   * ```
   */
  toPaginationOptions(): PaginationOptions {
    return { ...this._pagination };
  }

  /**
   * Check whether any filters (standard or raw) are defined.
   *
   * @returns `true` if there are filters or raw conditions
   */
  hasFilters(): boolean {
    return this._filters.length > 0 || this._rawConditions.length > 0;
  }

  /**
   * Check whether raw SQL conditions are defined.
   *
   * @returns `true` if raw conditions exist
   */
  hasRawConditions(): boolean {
    return this._rawConditions.length > 0;
  }

  /**
   * Check whether sorting is defined.
   *
   * @returns `true` if sort options exist
   */
  hasSort(): boolean {
    return this._sort.length > 0;
  }

  /**
   * Check whether pagination is defined.
   *
   * @returns `true` if limit, offset, or cursor is set
   */
  hasPagination(): boolean {
    return (
      this._pagination.limit !== undefined ||
      this._pagination.offset !== undefined ||
      this._pagination.cursor !== undefined
    );
  }

  /**
   * Reset all query parameters to their default state.
   *
   * @description
   * Clears filters, raw conditions, sort, pagination, schema, operation
   * config, joins, group-by, having, select, and distinct flags.
   * Preserves the executor binding, so the builder can be reused.
   *
   * @returns `this` for chaining
   *
   * @example
   * ```typescript
   * const base = QueryBuilder.forRepository(executor)
   *   .where('status', 'eq', 'active');
   *
   * // Reuse the same builder for a different query
   * base.reset().where('age', 'gt', 21);
   * ```
   */
  reset(): this {
    this._filters = [];
    this._rawConditions = [];
    this._sort = [];
    this._pagination = {};
    this._schema = undefined;
    this._operationConfig = undefined;
    this._joins = [];
    this._groupByFields = [];
    this._havingConditions = [];
    this._selectFields = [];
    this._selectRawExpressions = [];
    this._distinct = false;
    return this;
  }

  /**
   * Clone this query builder, including all conditions and the executor binding.
   *
   * @description
   * Performs a deep-ish clone: filters, raw conditions, joins, having conditions,
   * and operation config are copied by spreading individual objects. Arrays of
   * primitives and the executor reference are shallow-copied.
   *
   * @returns A new `QueryBuilder<TRecord>` with the same state
   *
   * @example
   * ```typescript
   * const baseQuery = QueryBuilder.create<User>()
   *   .where('status', 'eq', 'active');
   *
   * const adminQuery = baseQuery.clone()
   *   .andWhere('role', 'eq', 'admin');
   * ```
   */
  clone(): QueryBuilder<TRecord> {
    const cloned = new QueryBuilder<TRecord>();
    cloned._filters = [...this._filters];
    cloned._rawConditions = this._rawConditions.map((rc) => ({ ...rc }));
    cloned._sort = [...this._sort];
    cloned._pagination = { ...this._pagination };
    cloned._schema = this._schema;
    cloned._executor = this._executor;
    cloned._operationConfig = this._operationConfig
      ? { ...this._operationConfig }
      : undefined;
    cloned._joins = this._joins.map((j) => ({ ...j }));
    cloned._groupByFields = [...this._groupByFields];
    cloned._havingConditions = this._havingConditions.map((h) => ({ ...h }));
    cloned._selectFields = [...this._selectFields];
    cloned._selectRawExpressions = [...this._selectRawExpressions];
    cloned._distinct = this._distinct;
    return cloned;
  }

  // ============================================================
  // Additional Helper Methods
  // ============================================================

  /**
   * Check whether JOINs are defined.
   *
   * @returns `true` if any join clauses exist
   */
  hasJoins(): boolean {
    return this._joins.length > 0;
  }

  /**
   * Check whether GROUP BY is defined.
   *
   * @returns `true` if group-by fields exist
   */
  hasGroupBy(): boolean {
    return this._groupByFields.length > 0;
  }

  /**
   * Check whether a custom SELECT is defined (fields, raw expressions, or distinct).
   *
   * @returns `true` if any SELECT customisation is present
   */
  hasSelect(): boolean {
    return (
      this._selectFields.length > 0 ||
      this._selectRawExpressions.length > 0 ||
      this._distinct
    );
  }

  /**
   * Get a copy of all JOIN clauses.
   *
   * @returns A shallow copy of the joins array
   */
  toJoins(): JoinClause[] {
    return [...this._joins];
  }

  /**
   * Get a copy of the GROUP BY fields.
   *
   * @returns A shallow copy of the group-by fields array
   */
  toGroupByFields(): string[] {
    return [...this._groupByFields];
  }

  /**
   * Get a copy of all HAVING conditions.
   *
   * @returns A shallow copy of the having conditions array
   */
  toHavingConditions(): RawCondition[] {
    return [...this._havingConditions];
  }

  /**
   * Get a copy of the SELECT fields.
   *
   * @returns A shallow copy of the select fields array
   */
  toSelectFields(): string[] {
    return [...this._selectFields];
  }

  /**
   * Get a copy of the SELECT raw expressions.
   *
   * @returns A shallow copy of the select raw expressions array
   */
  toSelectRawExpressions(): string[] {
    return [...this._selectRawExpressions];
  }

  /**
   * Check whether DISTINCT is enabled.
   *
   * @returns `true` if distinct is active
   */
  isDistinct(): boolean {
    return this._distinct;
  }

  /**
   * Generate a simplified SQL string for debugging/logging.
   *
   * @description
   * Produces a human-readable SQL representation of the current query state.
   * This is a best-effort approximation — actual execution uses the adapter's
   * SQL generation. Not intended for production query execution.
   *
   * @param tableName - The name of the primary table to select FROM
   * @returns A formatted SQL string
   *
   * @example
   * ```typescript
   * console.log(builder
   *   .where('status', 'eq', 'active')
   *   .orderByAsc('name')
   *   .toSQL('users'));
   * // SELECT * FROM "users" WHERE "status" = $1 ORDER BY "name" ASC
   * ```
   */
  // eslint-disable-next-line complexity
  toSQL(tableName: string): string {
    const parts: string[] = [];

    // SELECT clause
    const selectParts: string[] = [];
    if (this._selectFields.length > 0) {
      selectParts.push(...this._selectFields.map((f) => `"${f}"`));
    }
    if (this._selectRawExpressions.length > 0) {
      selectParts.push(...this._selectRawExpressions);
    }
    const selectClause = selectParts.length > 0 ? selectParts.join(", ") : "*";
    parts.push(
      `SELECT ${this._distinct ? "DISTINCT " : ""}${selectClause} FROM "${tableName}"`,
    );

    // JOIN clauses
    for (const join of this._joins) {
      const joinType = join.type.toUpperCase();
      const tableRef = join.schema
        ? `"${join.schema}"."${join.table}"`
        : `"${join.table}"`;
      const aliasStr = join.alias ? ` AS "${join.alias}"` : "";
      parts.push(
        `${joinType} JOIN ${tableRef}${aliasStr} ON ${join.condition}`,
      );
    }

    // WHERE clause (simplified)
    if (this._filters.length > 0 || this._rawConditions.length > 0) {
      const whereParts: string[] = [];
      for (const filter of this._filters) {
        whereParts.push(`"${filter.field}" ${filter.operator} ?`);
      }
      for (const raw of this._rawConditions) {
        whereParts.push(raw.clause);
      }
      parts.push(`WHERE ${whereParts.join(" AND ")}`);
    }

    // GROUP BY clause
    if (this._groupByFields.length > 0) {
      parts.push(
        `GROUP BY ${this._groupByFields.map((f) => `"${f}"`).join(", ")}`,
      );
    }

    // HAVING clause
    if (this._havingConditions.length > 0) {
      const havingParts = this._havingConditions.map((h) => h.clause);
      parts.push(`HAVING ${havingParts.join(" AND ")}`);
    }

    // ORDER BY clause
    if (this._sort.length > 0) {
      const orderParts = this._sort.map(
        (s) => `"${s.field}" ${s.direction.toUpperCase()}`,
      );
      parts.push(`ORDER BY ${orderParts.join(", ")}`);
    }

    // LIMIT/OFFSET
    if (this._pagination.limit !== undefined) {
      parts.push(`LIMIT ${this._pagination.limit}`);
    }
    if (this._pagination.offset !== undefined) {
      parts.push(`OFFSET ${this._pagination.offset}`);
    }

    return parts.join("\n");
  }
}
