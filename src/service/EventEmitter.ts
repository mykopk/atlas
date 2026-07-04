/**
 * @fileoverview DatabaseEventEmitter - Event management for database operations
 *
 * Provides a comprehensive event system for monitoring and reacting to database
 * operations. The DatabaseEventEmitter implements the Observer pattern to enable
 * decoupled monitoring of database activities, allowing multiple components to
 * subscribe to and react to various database events.
 *
 * **Application Flow Context:**
 * ```
 * Database Operations → DatabaseEventEmitter → Event Handlers
 *         ↓                    ↓                  ↓
 * Query Execution   → Event Emission     → Logging
 * Transaction       → Handler Dispatch   → Monitoring
 * Health Changes    → Error Handling     → Alerting
 * ```
 *
 * **Supported Events:**
 * - **BeforeQuery**: Emitted before database queries
 * - **AfterQuery**: Emitted after successful queries
 * - **QueryError**: Emitted when queries fail
 * - **BeforeTransaction**: Emitted before transactions start
 * - **AfterTransaction**: Emitted after transactions complete
 * - **TransactionRollback**: Emitted when transactions rollback
 * - **HealthChange**: Emitted when database health status changes
 *
 * @example
 * ```typescript
 * // Event emitter setup
 * const eventEmitter = new DatabaseEventEmitter('drizzle');
 *
 * // Subscribe to query events
 * eventEmitter.on('BeforeQuery', (event) => {
 *   console.log(`Executing ${event.operation} on ${event.table}`);
 * });
 *
 * eventEmitter.on('QueryError', (event) => {
 *   console.error(`Query failed: ${event.error.message}`);
 * });
 *
 * // Emit events during database operations
 * eventEmitter.emitBeforeQuery('users', 'SELECT', { id: '123' });
 * ```
 *
 */

import type {
  AfterQueryEvent,
  AfterTransactionEvent,
  BeforeQueryEvent,
  BeforeTransactionEvent,
  DatabaseEvent,
  DatabaseOperationType,
  DBEventHandler,
  HealthChangeEvent,
  QueryErrorEvent,
  TransactionRollbackEvent,
} from "@myko.pk/types";
import type {
  EmitQueryErrorOptions,
  DatabaseExecutionContext,
} from "@myko.pk/types/db";
import { DATABASE_EVENT_TYPE } from "@myko.pk/types";
import type { ADAPTERS } from "@myko.pk/types";
import { logger } from "@myko.pk/logger";
import { isString, isObject } from "@utils/typeGuards";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";

/**
 * Event emitter for database events that implements the observer pattern.
 * This class manages event subscriptions and emissions for various database operations,
 * allowing decoupled monitoring of database activities.
 *
 * @class
 * @implements {DatabaseEventEmitter}
 */
export class DatabaseEventEmitter implements DatabaseEventEmitter {
  private readonly eventHandlers: Map<string, DBEventHandler<DatabaseEvent>[]> =
    new Map();

  /**
   * Create a DatabaseEventEmitter scoped to the given adapter type.
   *
   * @param adapter - The ADAPTERS enum value identifying the database adapter
   * @throws {DatabaseError} When adapter is not provided
   */
  constructor(private readonly adapter: ADAPTERS) {
    if (!adapter) {
      throw new DatabaseError(
        "Database adapter is required for event emitter",
        DATABASE_ERROR_CODES.CONFIG_REQUIRED,
        {
          context: { source: "DatabaseEventEmitter.constructor" },
          cause: new Error("Database adapter is required for event emitter"),
        },
      );
    }
  }

  /**
   * Register an event handler for a specific event type
   */
  on<T extends DatabaseEvent>(
    eventType: T["type"],
    handler: DBEventHandler<T>,
  ): void {
    try {
      if (!isString(eventType)) {
        throw new DatabaseError(
          "Invalid event type",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          {
            context: { source: "on" },
            cause: new Error("Invalid event type"),
          },
        );
      }

      if (!handler || typeof handler !== "function") {
        throw new DatabaseError(
          "Invalid event handler",
          DATABASE_ERROR_CODES.INVALID_PARAMETERS,
          {
            context: { source: "on" },
            cause: new Error("Invalid event handler"),
          },
        );
      }

      if (!this.eventHandlers.has(eventType)) {
        this.eventHandlers.set(eventType, []);
      }

      const handlers = this.eventHandlers.get(eventType);
      if (handlers) {
        handlers.push(handler as DBEventHandler<DatabaseEvent>);
      }
    } catch (error) {
      logger.error(
        `Failed to register event handler: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Remove an event handler for a specific event type
   */
  off<T extends DatabaseEvent>(
    eventType: T["type"],
    handler: DBEventHandler<T>,
  ): void {
    const handlers = this.eventHandlers.get(eventType);
    if (handlers) {
      const index = handlers.indexOf(handler as DBEventHandler<DatabaseEvent>);
      if (index !== -1) handlers.splice(index, 1);
    }
  }

  /**
   * Emit an event to all registered handlers for the event type.
   *
   * Both synchronous and asynchronous handlers are supported.
   * Async rejections are caught and logged to prevent unhandled
   * promise rejections. If no handlers are registered for the
   * event type, this is a no-op.
   *
   * @param event - The event object (must have a `type` property)
   */
  emit(event: DatabaseEvent): void {
    try {
      if (!isObject(event) || !event.type) {
        logger.error("Invalid event object");
        return;
      }

      const handlers = this.eventHandlers.get(event.type as string);
      if (!handlers || handlers.length === 0) return;

      handlers.forEach((handler) => {
        try {
          const result = handler(event);
          if (result instanceof Promise) {
            result.catch((error) => {
              logger.error(
                `Async event handler error: ${(error as Error).message}`,
              );
            });
          }
        } catch (error) {
          logger.error(`Event handler error: ${(error as Error).message}`);
        }
      });
    } catch (error) {
      logger.error(`Failed to emit event: ${(error as Error).message}`);
    }
  }

  /**
   * Emit a before query event
   */
  emitBeforeQuery(
    table: string,
    operation: DatabaseOperationType,
    params?: Record<string, object>,
    context?: DatabaseExecutionContext,
  ): void {
    const event: BeforeQueryEvent = {
      type: DATABASE_EVENT_TYPE.BeforeQuery,
      timestamp: new Date(),
      adapter: this.adapter.toString(),
      table,
      operation,
      params,
      context,
    };
    this.emit(event);
  }

  /**
   * Emit an after query event
   */
  emitAfterQuery(
    table: string,
    operation: DatabaseOperationType,
    duration: number,
    affectedRows?: number,
  ): void {
    const event: AfterQueryEvent = {
      type: DATABASE_EVENT_TYPE.AfterQuery,
      timestamp: new Date(),
      adapter: this.adapter.toString(),
      table,
      operation,
      duration,
      affectedRows,
    };
    this.emit(event);
  }

  /**
   * Emit a query error event with structured error details.
   *
   * Validates that required fields (table, operation, error) are
   * present before emitting. Catches and logs any emission failures.
   *
   * @param options - Options containing table, operation, error, and optional params/context
   */
  emitQueryError(options: EmitQueryErrorOptions): void {
    try {
      if (!isObject(options)) {
        logger.error("Invalid options for emitQueryError");
        return;
      }

      const { table, operation, error, params, context } = options;

      if (!table || !operation || !error) {
        logger.error("Missing required fields for query error event");
        return;
      }

      const event: QueryErrorEvent = {
        type: DATABASE_EVENT_TYPE.QueryError,
        timestamp: new Date(),
        adapter: this.adapter.toString(),
        table,
        operation,
        error,
        params,
        context,
      };

      this.emit(event);
    } catch (emitError) {
      logger.error(
        `Failed to emit query error event: ${(emitError as Error).message}`,
      );
    }
  }

  /**
   * Emit a before transaction event
   */
  emitBeforeTransaction(
    transactionId: string,
    context?: DatabaseExecutionContext,
  ): void {
    const event: BeforeTransactionEvent = {
      type: DATABASE_EVENT_TYPE.BeforeTransaction,
      timestamp: new Date(),
      adapter: this.adapter.toString(),
      transactionId,
      context,
    };
    this.emit(event);
  }

  /**
   * Emit an after transaction event
   */
  emitAfterTransaction(transactionId: string, duration: number): void {
    const event: AfterTransactionEvent = {
      type: DATABASE_EVENT_TYPE.AfterTransaction,
      timestamp: new Date(),
      adapter: this.adapter.toString(),
      transactionId,
      duration,
    };
    this.emit(event);
  }

  /**
   * Emit a transaction rollback event
   */
  emitTransactionRollback(transactionId: string, error?: Error): void {
    const event: TransactionRollbackEvent = {
      type: DATABASE_EVENT_TYPE.TransactionRollback,
      timestamp: new Date(),
      adapter: this.adapter.toString(),
      transactionId,
      error,
    };
    this.emit(event);
  }

  /**
   * Emit a health change event
   */
  emitHealthChange(
    previousStatus: boolean,
    currentStatus: boolean,
    details?: Record<string, string | number | boolean>,
  ): void {
    const event: HealthChangeEvent = {
      type: DATABASE_EVENT_TYPE.HealthChange,
      timestamp: new Date(),
      adapter: this.adapter.toString(),
      previousStatus,
      currentStatus,
      details,
    };
    this.emit(event as DatabaseEvent);
  }
}
