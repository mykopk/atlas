import type {
  DatabaseAdapterType,
  DatabaseResult,
  PaginatedResult,
  QueryOptions,
  DatabaseHealthStatus,
  Filter,
  FindFirstOptions,
  Transaction,
  PrismaAdapterConfig,
} from "@myko.pk/types/db";
import { failure, success } from "@utils/databaseResultHelpers";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";
import { calculatePagination } from "@utils/pagination";

/**
 * Recursively converts BigInt values to Number for JSON-safe serialization.
 *
 * @description
 * Traverses the input value tree and replaces any BigInt-typed values with their
 * Number equivalents. This is necessary because Prisma returns BigInt for integer
 * fields, but most API consumers expect plain JSON-safe numbers. Handles null values,
 * arrays, and deeply nested objects. Primitive values other than BigInt are returned
 * unchanged.
 *
 * @param value - The value to serialize (can be BigInt, array, object, or primitive)
 * @returns The serialized value with all BigInts converted to Numbers
 */
function serializeBigInts(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(serializeBigInts);
  if (typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = serializeBigInts(v);
    }
    return obj;
  }
  return value;
}

/**
 * Maps generic filter operator names to Prisma-native operator names.
 *
 * @description
 * Translation table that converts abstract filter operators (e.g., "eq", "like")
 * into the string keys Prisma's query engine expects (e.g., "equals", "contains").
 * Used by filterToPrismaWhere to build Prisma-compatible where clauses.
 */
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
 * Converts a single generic Filter object into a Prisma where-clause fragment.
 *
 * @description
 * Translates the filter's field, operator, and value into the nested object structure
 * that Prisma's where option requires. Special handling exists for isNull, isNotNull,
 * between, like, and ilike operators which have non-trivial Prisma representations.
 * The ilike operator enables case-insensitive matching via Prisma's mode property.
 *
 * @param filter - The filter definition containing field, operator, and value
 * @returns A Prisma-compatible where clause fragment
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
 * Builds a complete Prisma where clause from optional filters and OR filter groups.
 *
 * @description
 * Combines top-level filters (combined with AND) and OR filter groups into a single
 * Prisma-compatible where clause. A single filter is applied directly. Multiple filters
 * are wrapped in AND. Multiple OR groups are appended with OR semantics. Returns
 * undefined when no filters are provided, allowing Prisma to omit the where clause
 * entirely.
 *
 * @param filters - A single filter, array of AND filters, or undefined
 * @param orFilters - Array of OR filter groups (each group is AND-ed internally)
 * @returns A complete Prisma where clause, or undefined if no filters given
 */
function buildPrismaWhere<T extends object>(
  filters?: Filter<T> | Filter<T>[],
  orFilters?: Filter<T>[][],
): Record<string, unknown> | undefined {
  if (!filters && !orFilters) return undefined;

  const conditions: Record<string, unknown>[] = [];

  if (filters) {
    const arr = Array.isArray(filters) ? filters : [filters];
    if (arr.length > 0) {
      if (arr.length === 1) {
        conditions.push(filterToPrismaWhere(arr[0]));
      } else {
        conditions.push({ AND: arr.map((f) => filterToPrismaWhere(f)) });
      }
    }
  }

  if (orFilters && orFilters.length > 0) {
    const orConditions = orFilters.map((group) => {
      if (group.length === 1) return filterToPrismaWhere(group[0]);
      return { AND: group.map((f) => filterToPrismaWhere(f)) };
    });
    conditions.push({ OR: orConditions });
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { AND: conditions };
}

/**
 * Default primary key column name used when no custom ID column is configured.
 */
const DEFAULT_ID_COLUMN = "id";

/**
 * Database adapter implementation using Prisma ORM.
 *
 * @description
 * Provides a standardized database interface built on top of Prisma ORM. Handles
 * CRUD operations, pagination, filtering, transactions, and health checks by
 * translating generic query options into Prisma-specific syntax. Manages table-to-model
 * mapping, custom ID columns, and automatic BigInt serialization. Supports lazy
 * initialization of PrismaClient, accepting either an existing client instance or
 * creating one from configuration. All operations return typed DatabaseResult objects
 * for consistent error handling.
 *
 * Use this adapter in production environments where Prisma is the chosen ORM layer.
 * The adapter must be initialized via initialize() before performing database operations.
 *
 * @implements {DatabaseAdapterType}
 */
export class PrismaAdapter implements DatabaseAdapterType {
  /**
   * Optional base adapter for composing multiple database adapters.
   */
  baseAdapter?: DatabaseAdapterType;

  /** The underlying Prisma client instance. */
  private prisma: any;
  /** Adapter configuration. */
  private config: PrismaAdapterConfig;
  /** Maps logical table names to Prisma model names. */
  private tableMap: Map<string, string> = new Map();
  /** Maps logical table names to custom primary key column names. */
  private idColumnMap: Map<string, string> = new Map();
  /** ID column overrides provided via configuration. */
  private configIdColumns: Record<string, string>;
  /** Whether the Prisma client has been fully initialized. */
  private prismaClientInitialized = false;

  /**
   * Creates a new PrismaAdapter instance.
   *
   * @description
   * Initializes the adapter with the provided configuration. If a PrismaClient instance
   * is supplied in config.client, it is stored for immediate use. Otherwise, the client
   * is loaded lazily when initialize() is called. Stores table ID column overrides for
   * later resolution in queries.
   *
   * @param config - Configuration object for the Prisma adapter
   */
  constructor(config: PrismaAdapterConfig) {
    this.config = config;
    this.configIdColumns = config.tableIdColumns ?? {};

    if (config.client) {
      this.prisma = config.client;
      this.prismaClientInitialized = true;
    }
  }

  /**
   * Resolves the ID column name for the given table.
   *
   * @description
   * Checks the runtime idColumnMap first, then the configuration-based configIdColumns,
   * and falls back to "id" as the default. Allows per-table override of the primary key
   * column name without changing the database schema.
   *
   * @param table - The logical table name
   * @returns The resolved ID column name
   */
  private getIdColumn(table: string): string {
    return this.idColumnMap.get(table) ?? this.configIdColumns[table] ?? DEFAULT_ID_COLUMN;
  }

  /**
   * Retrieves the Prisma model delegate for the given table.
   *
   * @description
   * Resolves the logical table name to a Prisma model name via tableMap, then accesses
   * the corresponding delegate from the PrismaClient instance. Throws if the model is
   * not found on the client, which typically indicates a misconfigured table mapping.
   *
   * @param table - The logical table name
   * @returns The Prisma model delegate
   * @throws {DatabaseError} If the Prisma model is not found on the client
   */
  private getDelegate(table: string): any {
    const resolved = this.tableMap.get(table) ?? table;
    const delegate = this.prisma[resolved];
    if (!delegate) {
      throw new DatabaseError(
        `Prisma model "${resolved}" not found on PrismaClient`,
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        { cause: new Error(`Prisma model "${resolved}" not found`) },
      );
    }
    return delegate;
  }

  /**
   * Dynamically loads and instantiates the PrismaClient.
   *
   * @description
   * Uses dynamic import to load @prisma/client at runtime. Creates a new PrismaClient
   * with the configured datasource URL and any additional Prisma options. Sets the
   * prismaClientInitialized flag on success. Called lazily during initialize() if no
   * client was provided in the constructor.
   *
   * @throws {DatabaseError} If @prisma/client cannot be loaded or resolved
   */
  private async loadPrismaClient(): Promise<void> {
    try {
      // @ts-expect-error - @prisma/client is a peer dependency, may not be resolvable at build time
      const { PrismaClient } = await import("@prisma/client");
      this.prisma = new PrismaClient({
        datasources: this.config.url ? { db: { url: this.config.url } } : undefined,
        ...this.config.prismaOptions,
      });
      this.prismaClientInitialized = true;
    } catch (error) {
      throw new DatabaseError(
        "Failed to load @prisma/client. Ensure it is installed as a peer dependency.",
        DATABASE_ERROR_CODES.CONFIG_REQUIRED,
        { cause: error as Error },
      );
    }
  }

  /**
   * Initializes the database connection and registers BigInt serialization middleware.
   *
   * @description
   * If the PrismaClient has not been initialized, loads it via loadPrismaClient.
   * Registers a $use middleware that automatically serializes BigInt values on all
   * query results. Calls $connect to establish the database connection. Must be
   * called once during application startup before any other operations.
   *
   * @returns A DatabaseResult indicating success or containing failure details
   */
  async initialize(): Promise<DatabaseResult<void>> {
    try {
      if (!this.prismaClientInitialized) {
        await this.loadPrismaClient();
      }

      this.prisma.$use((params: any, next: any) => {
        return next(params).then(serializeBigInts);
      });

      await this.prisma.$connect();
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `PrismaAdapter initialize failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.INIT_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Establishes the database connection.
   *
   * @description
   * Calls PrismaClient.$connect() to open the database connection. No-op if the
   * PrismaClient has not been initialized yet.
   */
  async connect(): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.$connect();
  }

  /**
   * Closes the database connection.
   *
   * @description
   * Calls PrismaClient.$disconnect() to gracefully close the database connection.
   * No-op if the PrismaClient has not been initialized.
   */
  async disconnect(): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.$disconnect();
  }

  /**
   * Closes the connection and resets the adapter to uninitialized state.
   *
   * @description
   * Disconnects from the database, nullifies the PrismaClient reference, and resets
   * the initialization flag. After close(), the adapter must be re-initialized via
   * initialize() before further database operations.
   *
   * @returns A DatabaseResult indicating success or containing failure details
   */
  async close(): Promise<DatabaseResult<void>> {
    try {
      await this.disconnect();
      this.prisma = null;
      this.prismaClientInitialized = false;
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `PrismaAdapter close failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DISCONNECT_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Returns the underlying PrismaClient instance.
   *
   * @description
   * Provides direct access to the Prisma client for operations not covered by the
   * adapter interface. Bypassing the adapter means losing consistent error handling
   * and BigInt serialization — use with caution.
   *
   * @returns The PrismaClient instance cast to the specified type
   */
  getClient<T extends object = object>(): T {
    return this.prisma as T;
  }

  /**
   * Executes a raw SQL query against the database.
   *
   * @description
   * Uses Prisma's $queryRawUnsafe to execute arbitrary SQL with optional positional
   * parameters for SQL injection protection. Returns the result rows cast to the
   * expected type. Prefer using the adapter's typed methods over raw queries.
   *
   * @param sql - The raw SQL query string
   * @param params - Optional positional parameters for the query
   * @returns The query result rows
   */
  async query<TResult, TParams = unknown>(sql: string, params?: TParams[]): Promise<TResult[]> {
    const result = await this.prisma.$queryRawUnsafe(sql, ...(params ?? []));
    return result as TResult[];
  }

  /**
   * Registers a table with an optional custom ID column.
   *
   * @description
   * Maps a logical table name to its Prisma model name and optionally specifies
   * a custom primary key column. This mapping is used by all subsequent CRUD
   * operations to resolve the correct Prisma delegate and ID column.
   *
   * @param name - The logical table name used in subsequent operations
   * @param table - The Prisma model name (defaults to logical name if not provided)
   * @param idColumn - Optional custom ID column name
   */
  registerTable<TTable, TIdColumn>(name: string, table: TTable, idColumn?: TIdColumn): void {
    if (table) {
      this.tableMap.set(name, table as unknown as string);
    }
    if (idColumn !== undefined) {
      this.idColumnMap.set(name, idColumn as unknown as string);
    }
  }

  /**
   * Finds a single record by its primary key value.
   *
   * @description
   * Uses Prisma's findUnique to retrieve a record by its primary key. The ID column
   * is determined by the table's registered or configured ID column, defaulting to
   * "id". Returns null if no matching record is found.
   *
   * @param table - The logical table name
   * @param id - The primary key value of the record
   * @returns The found record, or null if not found
   */
  async findById<T>(table: string, id: string): Promise<DatabaseResult<T | null>> {
    try {
      const col = this.getIdColumn(table);
      const delegate = this.getDelegate(table);
      const record = await delegate.findUnique({ where: { [col]: id } });
      return success((record as T) ?? null);
    } catch (error) {
      return failure(
        new DatabaseError(
          `FindById failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.FIND_BY_ID_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Finds multiple records with filtering, sorting, and pagination.
   *
   * @description
   * Queries the database for records matching the provided filters, sorted by the
   * specified fields, and paginated by offset and limit. Supports AND and OR filter
   * combinations, as well as select and include projections. Returns a PaginatedResult
   * containing the data array, total count, and pagination metadata.
   *
   * @param table - The logical table name
   * @param options - Query options (filters, sort, pagination, select, include)
   * @returns A paginated result set containing matching records and metadata
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    try {
      const delegate = this.getDelegate(table);
      const where = buildPrismaWhere(
        options?.orFilters ? undefined : (options?.filter ?? options?.filters),
        options?.orFilters,
      );

      const sortObj: Record<string, "asc" | "desc"> = {};
      if (options?.sort) {
        for (const s of options.sort) {
          sortObj[s.field as string] = s.direction;
        }
      }

      const limit = options?.pagination?.limit;
      const offset = options?.pagination?.offset ?? 0;

      const findManyArgs: Record<string, unknown> = {
        where,
        orderBy: Object.keys(sortObj).length > 0 ? sortObj : undefined,
        take: limit,
        skip: offset,
      };
      if (options?.select) findManyArgs.select = options.select;
      if (options?.include) findManyArgs.include = options.include;

      const [records, total] = await Promise.all([
        delegate.findMany(findManyArgs),
        delegate.count({ where }),
      ]);

      const pagination = calculatePagination(total, { limit, offset });
      return success({
        data: records as T[],
        total,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          totalPages: pagination.totalPages,
        },
      });
    } catch (error) {
      return failure(
        new DatabaseError(
          `FindMany failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.FIND_MANY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Creates a new record in the specified table.
   *
   * @description
   * Inserts a record using Prisma's create method. The data object should include all
   * required fields for the model. Returns the created record populated with any
   * auto-generated fields such as IDs and timestamps.
   *
   * @param table - The logical table name
   * @param data - The record data to insert
   * @returns The created record with server-generated fields populated
   */
  async create<T extends object>(table: string, data: T): Promise<DatabaseResult<T>> {
    try {
      const delegate = this.getDelegate(table);
      const record = await delegate.create({ data });
      return success(record as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Create failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.CREATE_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Updates an existing record identified by its primary key.
   *
   * @description
   * Performs a partial update using Prisma's update method. Only fields present in
   * the data object are modified. The ID column is resolved via getIdColumn. Returns
   * a failure result if no record matches the given ID.
   *
   * @param table - The logical table name
   * @param id - The primary key value of the record to update
   * @param data - Partial data to apply to the record
   * @returns The updated record
   */
  async update<T>(table: string, id: string, data: Partial<T>): Promise<DatabaseResult<T>> {
    try {
      const col = this.getIdColumn(table);
      const delegate = this.getDelegate(table);
      const record = await delegate.update({ where: { [col]: id }, data });
      return success(record as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Update failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Deletes a record by its primary key.
   *
   * @description
   * Removes a record using Prisma's delete method. The ID column is resolved via
   * getIdColumn. Returns a failure result if no record matches the given ID.
   *
   * @param table - The logical table name
   * @param id - The primary key value of the record to delete
   * @returns Void on success
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    try {
      const col = this.getIdColumn(table);
      const delegate = this.getDelegate(table);
      await delegate.delete({ where: { [col]: id } });
      return success();
    } catch (error) {
      return failure(
        new DatabaseError(
          `Delete failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Executes operations within an atomic database transaction.
   *
   * @description
   * Uses Prisma's $transaction to run multiple database operations atomically.
   * The callback receives a Transaction object with findById, create, update, delete,
   * updateMany, deleteMany, and upsert methods. If the callback throws or returns a
   * rejected promise, all operations within the transaction are automatically rolled
   * back by Prisma.
   *
   * @param callback - Function receiving a Transaction object for transactional operations
   * @returns The callback's return value wrapped in a DatabaseResult
   */
  async transaction<T>(callback: (trx: Transaction) => Promise<T>): Promise<DatabaseResult<T>> {
    try {
      const result = await this.prisma.$transaction(async (tx: any) => {
        const txAdapter: Transaction = {
          findById: async <TX>(t: string, id: string) => {
            const col = this.idColumnMap.get(t) ?? this.configIdColumns[t] ?? DEFAULT_ID_COLUMN;
            const record = await tx[t].findUnique({ where: { [col]: id } });
            return success<TX | null>((record as TX) ?? null);
          },
          create: async <TX>(t: string, d: TX) => {
            const record = await tx[t].create({ data: d });
            return success(record as TX);
          },
          update: async <TX>(t: string, id: string, d: Partial<TX>) => {
            const col = this.idColumnMap.get(t) ?? this.configIdColumns[t] ?? DEFAULT_ID_COLUMN;
            const record = await tx[t].update({ where: { [col]: id }, data: d });
            return success(record as TX);
          },
          delete: async (t: string, id: string) => {
            const col = this.idColumnMap.get(t) ?? this.configIdColumns[t] ?? DEFAULT_ID_COLUMN;
            await tx[t].delete({ where: { [col]: id } });
            return success();
          },
          updateMany: async (t: string, where: Record<string, any>, data: Record<string, any>) => {
            const result = await tx[t].updateMany({ where, data });
            return success(result.count as number);
          },
          deleteMany: async (t: string, where: Record<string, any>) => {
            const result = await tx[t].deleteMany({ where });
            return success(result.count as number);
          },
          upsert: async <TX>(t: string, where: Record<string, any>, create: Record<string, any>, update: Record<string, any>) => {
            const record = await tx[t].upsert({ where, create, update });
            return success(record as TX);
          },
          commit: async () => {},
          rollback: async () => {},
        };
        return callback(txAdapter);
      });
      return success(result as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Transaction failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.TRANSACTION_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Checks whether a record with the given primary key exists.
   *
   * @description
   * Uses Prisma's count with a where clause for the ID column. More efficient than
   * findById for existence checks since it only queries the count rather than
   * retrieving the full record.
   *
   * @param table - The logical table name
   * @param id - The primary key value to check
   * @returns True if a matching record exists, false otherwise
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    try {
      const col = this.getIdColumn(table);
      const delegate = this.getDelegate(table);
      const count = await delegate.count({ where: { [col]: id } });
      return success(count > 0);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Exists check failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.EXISTS_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Counts records matching the optional filter criteria.
   *
   * @description
   * Uses Prisma's count with an optional where clause built from the provided
   * filter(s). Supports both single filters and arrays of AND-combined filters.
   *
   * @param table - The logical table name
   * @param filter - Optional filter or array of filters to scope the count
   * @returns The count of matching records
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T> | Filter<T>[],
  ): Promise<DatabaseResult<number>> {
    try {
      const delegate = this.getDelegate(table);
      const where = buildPrismaWhere(filter);
      const count = await delegate.count({ where });
      return success(count);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Count failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.COUNT_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Finds the first record matching the given criteria.
   *
   * @description
   * Uses Prisma's findFirst to retrieve the first matching record based on optional
   * where, select, and include options. Supports field projections via select and
   * relation inclusion via include. Returns null if no record matches.
   *
   * @param table - The logical table name
   * @param options - Optional criteria (where, select, include)
   * @returns The first matching record, or null if none found
   */
  async findFirst<T extends object>(
    table: string,
    options?: FindFirstOptions<T>,
  ): Promise<DatabaseResult<T | null>> {
    try {
      const delegate = this.getDelegate(table);
      const args: Record<string, unknown> = {};
      if (options?.where) args.where = options.where;
      if (options?.select) args.select = options.select;
      if (options?.include) args.include = options.include;
      const record = await delegate.findFirst(args);
      return success((record as T) ?? null);
    } catch (error) {
      return failure(
        new DatabaseError(
          `FindFirst failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.QUERY_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Creates or updates a record based on whether it already exists.
   *
   * @description
   * Uses Prisma's upsert to atomically create a new record or update an existing one.
   * The where clause identifies the record — if found, it is updated with the update
   * data; if not found, a new record is created with the create data.
   *
   * @param table - The logical table name
   * @param where - Criteria to identify an existing record
   * @param create - Data used when creating a new record
   * @param update - Data used when updating an existing record
   * @returns The created or updated record
   */
  async upsert<T extends object>(
    table: string,
    where: Record<string, any>,
    create: Record<string, any>,
    update: Record<string, any>,
  ): Promise<DatabaseResult<T>> {
    try {
      const delegate = this.getDelegate(table);
      const record = await delegate.upsert({ where, create, update });
      return success(record as T);
    } catch (error) {
      return failure(
        new DatabaseError(
          `Upsert failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Updates multiple records matching the given criteria.
   *
   * @description
   * Uses Prisma's updateMany to apply the provided data to all records matching
   * the where clause. Returns the count of updated records.
   *
   * @param table - The logical table name
   * @param where - Criteria identifying records to update
   * @param data - Partial data to apply to matching records
   * @returns The number of records updated
   */
  async updateMany(
    table: string,
    where: Record<string, any>,
    data: Record<string, any>,
  ): Promise<DatabaseResult<number>> {
    try {
      const delegate = this.getDelegate(table);
      const result = await delegate.updateMany({ where, data });
      return success(result.count as number);
    } catch (error) {
      return failure(
        new DatabaseError(
          `UpdateMany failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Deletes multiple records matching the given criteria.
   *
   * @description
   * Uses Prisma's deleteMany to remove all records matching the where clause.
   * Returns the count of deleted records. Use with caution — this operation cannot
   * be undone outside a transaction.
   *
   * @param table - The logical table name
   * @param where - Criteria identifying records to delete
   * @returns The number of records deleted
   */
  async deleteMany(
    table: string,
    where: Record<string, any>,
  ): Promise<DatabaseResult<number>> {
    try {
      const delegate = this.getDelegate(table);
      const result = await delegate.deleteMany({ where });
      return success(result.count as number);
    } catch (error) {
      return failure(
        new DatabaseError(
          `DeleteMany failed: ${(error as Error).message}`,
          DATABASE_ERROR_CODES.DELETE_FAILED,
          { cause: error as Error },
        ),
      );
    }
  }

  /**
   * Performs a database health check.
   *
   * @description
   * Executes "SELECT 1" and measures response time to determine database health.
   * Returns isHealthy: true with the response time in milliseconds on success.
   * On failure, returns isHealthy: false with error details. Even on query failure,
   * the method itself succeeds (returns success()) so the caller can inspect
   * the health status without exception handling.
   *
   * @returns Health status including healthy flag, response time, and optional details
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    const start = Date.now();
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
      return success({
        isHealthy: true,
        responseTime: Date.now() - start,
      });
    } catch (error) {
      return success({
        isHealthy: false,
        responseTime: Date.now() - start,
        details: { error: (error as Error).message } as unknown as undefined,
      });
    }
  }
}
