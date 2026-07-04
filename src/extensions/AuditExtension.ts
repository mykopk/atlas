import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";
import { logger } from "@myko.pk/logger";
import type {
  DatabaseAdapterType,
  DatabaseResult,
  Filter,
  DatabaseHealthStatus,
  PaginatedResult,
  QueryOptions,
  Transaction,
  AuditContext,
  AuditEvent,
} from "@myko.pk/types/db";
import {
  AUDIT_OPERATION,
  AUDIT_CATEGORY,
  EXTENSION_SOURCE,
} from "@myko.pk/types/db";

/** Minimum width for padded date parts (month, day) */
const DATE_PART_MIN_WIDTH = 2;

/** Error source patterns for context-based matching */
const CONTEXT_SOURCE_PATTERNS: Array<{
  patterns: string[];
  source: EXTENSION_SOURCE;
}> = [
  { patterns: ["encrypt"], source: EXTENSION_SOURCE.Encryption },
  {
    patterns: ["softdelete", "soft_delete"],
    source: EXTENSION_SOURCE.SoftDelete,
  },
  { patterns: ["cach"], source: EXTENSION_SOURCE.Caching },
  { patterns: ["audit"], source: EXTENSION_SOURCE.Audit },
  {
    patterns: ["replica", "read_replica"],
    source: EXTENSION_SOURCE.ReadReplica,
  },
  {
    patterns: ["multi_write", "multiwrite"],
    source: EXTENSION_SOURCE.MultiWrite,
  },
];

/** Error source patterns for message-based matching */
const MESSAGE_SOURCE_PATTERNS: Array<{
  patterns: string[];
  source: EXTENSION_SOURCE;
}> = [
  { patterns: ["encrypt"], source: EXTENSION_SOURCE.Encryption },
  {
    patterns: ["soft delete", "softdelete"],
    source: EXTENSION_SOURCE.SoftDelete,
  },
  { patterns: ["cache", "caching"], source: EXTENSION_SOURCE.Caching },
  {
    patterns: ["replica", "read replica"],
    source: EXTENSION_SOURCE.ReadReplica,
  },
  {
    patterns: ["multi-write", "multiwrite"],
    source: EXTENSION_SOURCE.MultiWrite,
  },
];

/**
 * Audit extension that automatically logs all database operations for compliance.
 * Fifth layer in the adapter chain (second from outermost).
 *
 * **Audit Flow:**
 * 1. **CREATE:** Records after-state only
 * 2. **UPDATE:** Records before-state, after-state, and changed fields
 * 3. **DELETE:** Records before-state only
 * 4. **SOFT_DELETE:** Records before/after state with deletedAt change
 */
export class AuditAdapter implements DatabaseAdapterType {
  /**
   * Stores the current audit context for tracking user actions.
   * Context is merged across multiple calls and includes userId, requestId, ipAddress, userAgent, reason, and category.
   */
  private auditContext: AuditContext = {};

  /** Cached schema-qualified table name */
  private auditSchema: string;
  /** Whether to use daily partitioned tables */
  private usePartitionedTables: boolean;
  /** Partitions already verified to exist (avoids redundant checks) */
  private verifiedPartitions = new Set<string>();

  /**
   * Creates a new AuditAdapter instance.
   *
   * @param baseAdapter - The underlying database adapter to wrap
   * @param config - Audit configuration options
   */
  constructor(
    public baseAdapter: DatabaseAdapterType,
    private config: {
      enabled: boolean;
      retentionDays?: number;
      excludeFields?: string[];
      excludeTables?: string[];
      /** Database schema for audit tables (default: 'audit') */
      schema?: string;
      /** Use daily partitioned tables (audit_log_yyyy_mm_dd format) (default: true) */
      usePartitionedTables?: boolean;
      onAuditAfterWrite?: (event: AuditEvent) => void | Promise<void>;
      /** Encrypted fields config from encryption extension (for audit metadata) */
      encryptedFields?: Record<string, string[]>;
    },
  ) {
    this.auditSchema = config.schema ?? "audit";
    this.usePartitionedTables = config.usePartitionedTables ?? true;
  }

  /**
   * Initializes the underlying database adapter.
   *
   * @returns Promise resolving to the initialization result
   */
  async initialize(): Promise<DatabaseResult<void>> {
    return this.baseAdapter.initialize();
  }

  /**
   * Establishes the database connection through the base adapter.
   *
   * @returns Promise that resolves when connected
   */
  async connect(): Promise<void> {
    return this.baseAdapter.connect();
  }

  /**
   * Closes the database connection through the base adapter.
   *
   * @returns Promise that resolves when disconnected
   */
  async disconnect(): Promise<void> {
    return this.baseAdapter.disconnect();
  }

  /**
   * Closes the database adapter and releases resources.
   *
   * @returns Promise resolving to the close result
   */
  async close(): Promise<DatabaseResult<void>> {
    return this.baseAdapter.close();
  }

  /**
   * Returns the underlying database client for direct access.
   *
   * @returns The database client instance
   */
  getClient<T extends object = object>(): T {
    return this.baseAdapter.getClient<T>();
  }

  /**
   * Executes raw SQL query through base adapter.
   * Does not audit raw SQL operations — use CRUD methods for automatic audit logging.
   */
  async query<TResult, TParams = unknown>(
    sql: string,
    params?: TParams[],
  ): Promise<TResult[]> {
    return this.baseAdapter.query<TResult, TParams>(sql, params);
  }

  /**
   * Registers a table schema with the base adapter for typed operations.
   *
   * @param name - Table name
   * @param table - Table schema definition
   * @param idColumn - Primary key column name
   */
  registerTable<T, U>(name: string, table: T, idColumn?: U): void {
    this.baseAdapter.registerTable(name, table, idColumn);
  }

  /**
   * Sets audit context for tracking user actions.
   * Context includes userId, requestId, ipAddress, userAgent, reason, category.
   */
  setAuditContext(context: AuditContext): void {
    this.auditContext = { ...this.auditContext, ...context };
  }

  /**
   * Finds a record by its primary key through the base adapter.
   * Read operations are not audited.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns The found record or null
   */
  async findById<T>(
    table: string,
    id: string,
  ): Promise<DatabaseResult<T | null>> {
    return this.baseAdapter.findById<T>(table, id);
  }

  /**
   * Finds multiple records matching the given query options.
   * Read operations are not audited.
   *
   * @param table - Table name
   * @param options - Query options including filters, pagination, and sorting
   * @returns Paginated query results
   */
  async findMany<T extends object>(
    table: string,
    options?: QueryOptions<T>,
  ): Promise<DatabaseResult<PaginatedResult<T>>> {
    return this.baseAdapter.findMany<T>(table, options);
  }

  /**
   * Creates a new record and logs the operation for audit compliance.
   * Audits the after-state of the created record along with user context.
   * On failure, logs the operation failure with error details.
   *
   * @param table - Table name
   * @param data - Record data to create
   * @returns The created record
   * @throws {DatabaseError} INVALID_PARAMETERS - If table or data is invalid
   */
  async create<T extends object>(
    table: string,
    data: T,
  ): Promise<DatabaseResult<T>> {
    this.validateCreateParams(table, data);

    try {
      const result = await this.baseAdapter.create<T>(table, data);

      if (result.success && this.shouldAudit(table)) {
        await this.logAudit({
          operation: AUDIT_OPERATION.Create,
          table,
          recordId: (result.value as Record<string, string>)?.id,
          changes: {
            after: result.value as Record<
              string,
              string | number | boolean | Date
            >,
            encryptedFields: this.getEncryptedFields(table),
          },
          userId: this.auditContext.userId,
          requestId: this.auditContext.requestId,
          timestamp: new Date(),
          ipAddress: this.auditContext.ipAddress,
          userAgent: this.auditContext.userAgent,
          reason: this.auditContext.reason,
          category: this.auditContext.category,
        });
      }

      return result;
    } catch (error) {
      if (this.shouldAudit(table)) {
        await this.logOperationFailure({
          operation: AUDIT_OPERATION.Create,
          table,
          data,
          error: error as Error,
        });
      }
      throw error;
    }
  }

  /**
   * Validates that create operation parameters are present.
   *
   * @param table - Table name to validate
   * @param data - Record data to validate
   * @throws {DatabaseError} INVALID_PARAMETERS - If table or data is falsy
   */
  private validateCreateParams<T>(table: string, data: T): void {
    if (!table || !data) {
      throw new DatabaseError(
        "Invalid parameters for create operation",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: { source: "validateCreateParams" },
          cause: new Error("Invalid parameters for create operation"),
        },
      );
    }
  }

  /**
   * Updates a record and logs the before/after state for audit compliance.
   * Captures changed fields and user context. On failure, logs the operation
   * failure with the before state and error details.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @param data - Partial record data with fields to update
   * @returns The updated record
   */
  async update<T>(
    table: string,
    id: string,
    data: Partial<T>,
  ): Promise<DatabaseResult<T>> {
    const before = await this.baseAdapter.findById(table, id);

    try {
      const result = await this.baseAdapter.update<T>(table, id, data);

      if (result.success && this.shouldAudit(table)) {
        await this.logAudit({
          operation: AUDIT_OPERATION.Update,
          table,
          recordId: id,
          changes: {
            before: before.success
              ? (before.value as Record<
                  string,
                  string | number | boolean | Date
                >)
              : undefined,
            after: result.value as Record<
              string,
              string | number | boolean | Date
            >,
            fields: Object.keys(data),
            encryptedFields: this.getEncryptedFields(table),
          },
          userId: this.auditContext.userId,
          requestId: this.auditContext.requestId,
          timestamp: new Date(),
          ipAddress: this.auditContext.ipAddress,
          userAgent: this.auditContext.userAgent,
          reason: this.auditContext.reason,
          category: this.auditContext.category,
        });
      }

      return result;
    } catch (error) {
      if (this.shouldAudit(table)) {
        await this.logOperationFailure({
          operation: AUDIT_OPERATION.Update,
          table,
          data,
          error: error as Error,
          recordId: id,
          beforeState: before.value,
        });
      }
      throw error;
    }
  }

  /**
   * Deletes a record and logs the before-state for audit compliance.
   * Captures the record state prior to deletion and user context.
   * On failure, logs the operation failure with error details.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns Deletion result
   */
  async delete(table: string, id: string): Promise<DatabaseResult<void>> {
    const before = await this.baseAdapter.findById(table, id);

    try {
      const result = await this.baseAdapter.delete(table, id);

      if (result.success && this.shouldAudit(table)) {
        await this.logAudit({
          operation: AUDIT_OPERATION.Delete,
          table,
          recordId: id,
          changes: {
            before: before.success
              ? (before.value as Record<
                  string,
                  string | number | boolean | Date
                >)
              : undefined,
          },
          userId: this.auditContext.userId,
          requestId: this.auditContext.requestId,
          timestamp: new Date(),
          ipAddress: this.auditContext.ipAddress,
          userAgent: this.auditContext.userAgent,
          reason: this.auditContext.reason,
          category: this.auditContext.category,
        });
      }

      return result;
    } catch (error) {
      if (this.shouldAudit(table)) {
        await this.logOperationFailure({
          operation: AUDIT_OPERATION.Delete,
          table,
          data: null,
          error: error as Error,
          recordId: id,
          beforeState: before.value,
        });
      }
      throw error;
    }
  }

  /**
   * Logs operation failures to audit for compliance tracking.
   * Captures the before state, attempted changes, and error details.
   */
  private async logOperationFailure<T>(options: {
    operation: AUDIT_OPERATION;
    table: string;
    data: T | null;
    error: Error;
    recordId?: string;
    beforeState?: unknown;
  }): Promise<void> {
    const { operation, table, data, error, recordId, beforeState } = options;

    try {
      const errorSource = this.getErrorSource(error);

      const failedOperation = this.getFailedOperation(operation);

      await this.logAudit({
        operation: failedOperation,
        table,
        recordId: recordId ?? (data as Record<string, string>)?.id,
        changes: {
          before: beforeState as
            | Record<string, string | number | boolean | Date>
            | undefined,
          attempted: data as
            | Record<string, string | number | boolean | Date>
            | undefined,
          failure: {
            source: errorSource,
            error_type: error.name,
            error_message: error.message,
            error_code: (error as DatabaseError).errorCode,
          },
        },
        userId: this.auditContext.userId,
        requestId: this.auditContext.requestId,
        timestamp: new Date(),
        ipAddress: this.auditContext.ipAddress,
        userAgent: this.auditContext.userAgent,
        reason: this.auditContext.reason,
        category: this.auditContext.category,
      });
    } catch (auditError) {
      logger.error(
        `Failed to log operation failure to audit: ${(auditError as Error).message}`,
      );
    }
  }

  /** Maps a successful operation to its failed counterpart. */
  private getFailedOperation(operation: AUDIT_OPERATION): AUDIT_OPERATION {
    switch (operation) {
      case AUDIT_OPERATION.Create:
        return AUDIT_OPERATION.CreateFailed;
      case AUDIT_OPERATION.Update:
        return AUDIT_OPERATION.UpdateFailed;
      case AUDIT_OPERATION.Delete:
        return AUDIT_OPERATION.DeleteFailed;
      default:
        return operation;
    }
  }

  /**
   * Determines which extension/layer caused the error based on error details.
   * Checks error context first (most reliable), then falls back to error message analysis.
   */
  private getErrorSource(error: Error): EXTENSION_SOURCE {
    const errorMessage = error.message.toLowerCase();
    const dbError = error as DatabaseError;
    const errorContext = (
      dbError.context as { source?: string }
    )?.source?.toLowerCase();

    if (errorContext) {
      const contextSource = this.matchPatterns(
        errorContext,
        CONTEXT_SOURCE_PATTERNS,
      );
      if (contextSource) return contextSource;
    }

    const messageSource = this.matchPatterns(
      errorMessage,
      MESSAGE_SOURCE_PATTERNS,
    );
    if (messageSource) return messageSource;

    return EXTENSION_SOURCE.DatabaseAdapter;
  }

  /** Matches a text against a list of pattern groups. */
  private matchPatterns(
    text: string,
    patternGroups: Array<{ patterns: string[]; source: EXTENSION_SOURCE }>,
  ): EXTENSION_SOURCE | null {
    for (const { patterns, source } of patternGroups) {
      if (patterns.some((pattern) => text.includes(pattern))) {
        return source;
      }
    }
    return null;
  }

  /** Gets encrypted fields for a table (if any). */
  private getEncryptedFields(table: string): string[] | undefined {
    return this.config.encryptedFields?.[table];
  }

  /**
   * Executes operations within a database transaction through the base adapter.
   * Audit events within a transaction are logged per operation.
   *
   * @param callback - Async callback receiving the transaction object
   * @returns Promise resolving to the transaction result
   */
  async transaction<T>(
    callback: (trx: Transaction) => Promise<T>,
  ): Promise<DatabaseResult<T>> {
    return this.baseAdapter.transaction(callback);
  }

  /**
   * Checks whether a record exists by its primary key through the base adapter.
   *
   * @param table - Table name
   * @param id - Record primary key value
   * @returns True if the record exists
   */
  async exists(table: string, id: string): Promise<DatabaseResult<boolean>> {
    return this.baseAdapter.exists(table, id);
  }

  /**
   * Counts records in a table matching the optional filter through the base adapter.
   *
   * @param table - Table name
   * @param filter - Optional filter conditions
   * @returns Record count
   */
  async count<T extends object = object>(
    table: string,
    filter?: Filter<T>,
  ): Promise<DatabaseResult<number>> {
    return this.baseAdapter.count<T>(table, filter);
  }

  /**
   * Performs a health check against the underlying database adapter.
   *
   * @returns Health status including connectivity and latency information
   */
  async healthCheck(): Promise<DatabaseResult<DatabaseHealthStatus>> {
    return this.baseAdapter.healthCheck();
  }

  /**
   * Determines if a table should be audited.
   * Based on enabled flag and excludeTables array.
   */
  private shouldAudit(table: string): boolean {
    if (!this.config.enabled) return false;
    return !(this.config.excludeTables?.includes(table) ?? false);
  }

  /**
   * Orchestrates audit record creation and event handling.
   * Validates event, writes to audit table, then executes custom handler.
   */
  private async logAudit(event: AuditEvent): Promise<void> {
    if (!this.shouldAudit(event.table)) return;

    this.validateAuditEvent(event);

    try {
      await this.writeAuditRecord(event);
      await this.executeCustomHandler(event);
    } catch (error) {
      logger.error(
        `Audit log failed for ${event.operation} on ${event.table}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Validates audit event has required operation and table fields.
   */
  private validateAuditEvent(event: AuditEvent): void {
    if (!event?.operation || !event?.table) {
      throw new DatabaseError(
        "Invalid audit event",
        DATABASE_ERROR_CODES.INVALID_PARAMETERS,
        {
          context: { source: "validateAuditEvent" },
          cause: new Error("Invalid audit event"),
        },
      );
    }
  }

  /**
   * Generates the audit table name based on configuration.
   *
   * **Table Naming:**
   *   - Partitioned: `{schema}.audit_log_yyyy_mm_dd` (e.g., audit.audit_log_2024_12_01)
   *   - Non-partitioned: `{schema}.audit_logs` (e.g., audit.audit_logs)
   */
  private getAuditTableName(timestamp: Date): string {
    if (this.usePartitionedTables) {
      const year = timestamp.getFullYear();
      const month = String(timestamp.getMonth() + 1).padStart(
        DATE_PART_MIN_WIDTH,
        "0",
      );
      const day = String(timestamp.getDate()).padStart(
        DATE_PART_MIN_WIDTH,
        "0",
      );
      return `${this.auditSchema}.audit_log_${year}_${month}_${day}`;
    }
    return `${this.auditSchema}.audit_logs`;
  }

  /**
   * Writes audit record to the appropriate audit table.
   * Uses daily partitioned tables (audit.audit_log_yyyy_mm_dd) by default.
   */
  private async writeAuditRecord(event: AuditEvent): Promise<void> {
    const tableName = this.getAuditTableName(event.timestamp);

    if (this.usePartitionedTables && !this.verifiedPartitions.has(tableName)) {
      const created = await this.ensurePartitionExists(event.timestamp);
      if (created) {
        this.verifiedPartitions.add(tableName);
      }
    }

    const auditResult = await this.baseAdapter.create(tableName, {
      operation: event.operation,
      table_name: event.table,
      record_id: event.recordId,
      user_id: event.userId,
      request_id: event.requestId,
      changes: event.changes,
      ip_address: event.ipAddress,
      user_agent: event.userAgent,
      timestamp: event.timestamp,
      reason: event.reason,
      category: event.category ?? AUDIT_CATEGORY.General,
    });

    if (!auditResult.success) {
      throw new DatabaseError(
        "Failed to write audit record",
        DATABASE_ERROR_CODES.CREATE_FAILED,
        {
          context: { source: "writeAuditRecord" },
          cause: auditResult.error ?? new Error("Failed to write audit record"),
        },
      );
    }
  }

  /**
   * Creates audit partition for the given date if it doesn't exist.
   * Calls the audit.create_partition_if_not_exists() database function.
   * @returns true if partition was verified/created, false if creation failed
   */
  private async ensurePartitionExists(timestamp: Date): Promise<boolean> {
    const dateStr = timestamp.toISOString().split("T")[0]; // YYYY-MM-DD
    try {
      await this.baseAdapter.query(
        `SELECT ${this.auditSchema}.create_partition_if_not_exists($1::date)`,
        [dateStr],
      );
      logger.info(`Auto-created audit partition for date: ${dateStr}`);
      return true;
    } catch (error) {
      logger.warn(
        `Failed to auto-create audit partition for ${dateStr}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Executes custom audit event handler if configured.
   * Logs handler errors without failing the operation.
   */
  private async executeCustomHandler(event: AuditEvent): Promise<void> {
    if (this.config.onAuditAfterWrite) {
      try {
        await this.config.onAuditAfterWrite(event);
      } catch (handlerError) {
        logger.error(
          `Custom audit handler failed: ${(handlerError as Error).message}`,
        );
      }
    }
  }
}
