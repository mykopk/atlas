import { TenantContext } from "./TenantContext";
import { failure } from "@utils/databaseResultHelpers";
import { DatabaseError } from "@myko.pk/errors";
import { DATABASE_ERROR_CODES } from "@myko.pk/errors";
import type {
  DatabaseAdapterType,
  DatabaseResult,
  PaginatedResult,
  QueryOptions,
  TenantValidationContext,
} from "@myko.pk/types/db";

/**
 * Abstract base repository that automatically enforces tenant isolation
 * on all CRUD operations.
 *
 * @description
 * `TenantRepository` wraps a {@link DatabaseAdapterType} and adds a tenant
 * isolation layer on top of every CRUD operation. Subclasses must implement
 * {@link getTenantIdField} to specify which entity field holds the tenant ID.
 *
 * **RESPONSIBILITIES:**
 * 1. **Tenant Isolation** – Automatically filters all queries by the current
 *    tenant from {@link TenantContext}.
 * 2. **Access Control** – Validates that returned entities belong to the
 *    current tenant before returning them.
 * 3. **Auto-Assignment** – Assigns the current tenant ID to new records on
 *    creation.
 * 4. **Validation** – Ensures every operation respects tenant boundaries.
 *
 * **Lifecycle:**
 * 1. Subclass `TenantRepository` and implement `getTenantIdField()`.
 * 2. Ensure a tenant context is active via `TenantContext.run()` before
 *    calling any repository method.
 * 3. Call standard CRUD methods – all tenant-aware by default.
 *
 * **Thread-safety:**
 * Instances are **not** thread-safe. The underlying adapter may be shared;
 * serialise access or create per-request repository instances.
 *
 * @typeParam TEntity - Entity type. Must include a field (returned by
 *                      {@link getTenantIdField}) that stores the tenant ID.
 *
 * @example
 * ### Basic Implementation
 * ```typescript
 * interface User {
 *   id: string;
 *   name: string;
 *   email: string;
 *   tenantId: string; // Required for tenant isolation
 * }
 *
 * class UserRepository extends TenantRepository<User> {
 *   constructor(adapter: DatabaseAdapterType) {
 *     super(adapter, 'users');
 *   }
 *
 *   protected getTenantIdField(): keyof User {
 *     return 'tenantId';
 *   }
 *
 *   // Custom methods with automatic tenant isolation
 *   async findByEmail(email: string) {
 *     return this.findMany({ filter: { field: 'email', operator: 'eq', value: email } });
 *   }
 * }
 * ```
 *
 * @example
 * ### Usage with Tenant Context
 * ```typescript
 * // Set tenant context (usually in middleware)
 * TenantContext.set({ id: 'tenant-123', name: 'Acme Corp' });
 *
 * const userRepo = new UserRepository(adapter);
 *
 * // All operations automatically filtered by tenant
 * const users = await userRepo.findMany(); // Only returns users for tenant-123
 * const user = await userRepo.findById('user-456'); // Validates tenant access
 *
 * // New records automatically get tenant ID
 * const newUser = await userRepo.create({
 *   name: 'John Doe',
 *   email: 'john@example.com'
 *   // tenantId automatically set to 'tenant-123'
 * });
 * ```
 */
export abstract class TenantRepository<TEntity extends object> {
  /**
   * Creates a new tenant repository instance.
   *
   * @param adapter - Database adapter that executes the underlying queries.
   * @param tableName - Name of the database table this repository manages.
   */
  constructor(
    protected adapter: DatabaseAdapterType,
    protected tableName: string,
  ) {}

  /**
   * ABSTRACT METHOD - Tenant ID Field Specification
   *
   * Must be implemented by subclasses to specify which field contains the tenant ID.
   * This field is used for automatic filtering and validation.
   *
   * @returns The key of the tenant ID field in the entity
   *
   * @example
   * ```typescript
   * protected getTenantIdField(): keyof User {
   *   return 'tenantId'; // or 'organizationId', 'companyId', etc.
   * }
   * ```
   */
  protected abstract getTenantIdField(): keyof TEntity;

  /**
   * Finds a single record by ID with automatic tenant access validation.
   *
   * @description
   * Retrieves a record from the database, then validates that it belongs to
   * the current tenant. Returns a `failure` with `ACCESS_DENIED` if the
   * record exists but belongs to a different tenant.
   *
   * @param id - The unique identifier of the record to find.
   * @returns A `DatabaseResult` resolving to the record if found and
   *          tenant-accessible, or `null` if not found. Returns a failure
   *          result when the ID is invalid, the record belongs to another
   *          tenant, or a database error occurs.
   *
   * @throws {DatabaseError} Returned as a failure (not thrown) when:
   *                         - `id` is empty or not a string (`INVALID_ID`).
   *                         - The record belongs to a different tenant
   *                           (`ACCESS_DENIED`).
   *                         - The underlying adapter throws (`FIND_BY_ID_FAILED`).
   *
   * @example
   * ```typescript
   * await TenantContext.run({ id: 'tenant-123' }, async () => {
   *   const result = await userRepo.findById('user-456');
   *   if (result.success && result.value) {
   *     console.log('User found:', result.value.name);
   *   }
   * });
   * ```
   */
  async findById(id: string): Promise<DatabaseResult<TEntity | null>> {
    try {
      if (!id || typeof id !== "string") {
        return failure(
          new DatabaseError(
            "Invalid record ID",
            DATABASE_ERROR_CODES.INVALID_ID,
            { context: { source: "TenantRepository.findById" } },
          ),
        );
      }

      const result = await this.adapter.findById<TEntity>(this.tableName, id);

      if (result.success && result.value) {
        try {
          this.validateTenantAccess(result.value);
        } catch (error) {
          return failure(
            new DatabaseError(
              "Access denied to record from different tenant",
              DATABASE_ERROR_CODES.ACCESS_DENIED,
              {
                context: { source: "TenantRepository.findById", cause: error },
              },
            ),
          );
        }
      }

      return result;
    } catch (error) {
      return failure(
        new DatabaseError(
          "Failed to find record",
          DATABASE_ERROR_CODES.FIND_BY_ID_FAILED,
          { context: { source: "TenantRepository.findById", cause: error } },
        ),
      );
    }
  }

  /**
   * Finds multiple records with automatic tenant filtering.
   *
   * @description
   * Injects an equality filter on the tenant ID field into the query
   * options, ensuring only records belonging to the current tenant are
   * returned. The tenant is obtained from {@link TenantContext.requireCurrent},
   * which throws if no context is active.
   *
   * @param options - Optional query parameters (filters, sort, pagination).
   *                  The tenant filter is merged with any existing filters.
   * @returns A `DatabaseResult` wrapping a {@link PaginatedResult} of
   *          entities scoped to the current tenant.
   *
   * @throws {DatabaseError} Thrown (not returned) when no tenant context
   *                         is active. All other errors are returned as
   *                         failures from the adapter.
   *
   * @example
   * ```typescript
   * const result = await userRepo.findMany({
   *   filter: { field: 'status', operator: 'eq', value: 'active' },
   *   pagination: { page: 1, limit: 10 },
   *   sort: { field: 'name', direction: 'asc' }
   * });
   * ```
   */
  async findMany(
    options?: QueryOptions<TEntity>,
  ): Promise<DatabaseResult<PaginatedResult<TEntity>>> {
    const tenant = TenantContext.requireCurrent();

    const tenantFilter = {
      field: this.getTenantIdField() as keyof TEntity & string,
      operator: "eq" as const,
      value: tenant.id as TEntity[keyof TEntity],
    };

    const enhancedOptions: QueryOptions<TEntity> = {
      ...options,
      filter: tenantFilter,
    };

    return this.adapter.findMany<TEntity>(this.tableName, enhancedOptions);
  }

  /**
   * Creates a new record with automatic tenant ID assignment.
   *
   * @description
   * Assigns the current tenant's ID to the entity's tenant field before
   * delegating to the adapter. The caller does not need to set the tenant
   * ID manually.
   *
   * @param entity - The entity data to create, excluding the `id` field.
   *                 The tenant ID is injected automatically.
   * @returns A `DatabaseResult` resolving to the newly created entity with
   *          the tenant ID populated.
   *
   * @throws {DatabaseError} Thrown when no tenant context is active
   *                         (propagated from `TenantContext.requireCurrent`).
   *
   * @example
   * ```typescript
   * const result = await userRepo.create({
   *   name: 'John Doe',
   *   email: 'john@example.com'
   * });
   * // result.value.tenantId === 'current-tenant-id'
   * ```
   */
  async create(entity: Omit<TEntity, "id">): Promise<DatabaseResult<TEntity>> {
    const tenant = TenantContext.requireCurrent();
    const tenantEntity = {
      ...entity,
      [this.getTenantIdField()]: tenant.id,
    } as TEntity;

    return this.adapter.create<TEntity>(this.tableName, tenantEntity);
  }

  /**
   * Updates an existing record after verifying tenant access.
   *
   * @description
   * First fetches the existing record via {@link findById} (which validates
   * tenant access), then delegates the update to the adapter. If the record
   * does not exist or belongs to another tenant, a failure is returned
   * without calling the adapter.
   *
   * @param id - The unique identifier of the record to update.
   * @param entity - Partial entity data containing the fields to update.
   * @returns A `DatabaseResult` resolving to the updated entity.
   *
   * @throws {DatabaseError} Returned as a failure (not thrown) when:
   *                         - `id` or `entity` is invalid (`INVALID_PARAMETERS`).
   *                         - The record is not found (`RECORD_NOT_FOUND`).
   *                         - The underlying adapter throws (`UPDATE_FAILED`).
   *
   * @example
   * ```typescript
   * const result = await userRepo.update('user-456', { name: 'Jane Doe' });
   * ```
   */
  async update(
    id: string,
    entity: Partial<TEntity>,
  ): Promise<DatabaseResult<TEntity>> {
    try {
      if (!id || !entity || typeof entity !== "object") {
        return failure(
          new DatabaseError(
            "Invalid parameters",
            DATABASE_ERROR_CODES.INVALID_PARAMETERS,
            { context: { source: "TenantRepository.update" } },
          ),
        );
      }

      const existing = await this.findById(id);
      if (!existing.success) {
        return failure(
          existing.error ??
            new DatabaseError(
              "Failed to fetch record",
              DATABASE_ERROR_CODES.FETCH_FAILED,
              { context: { source: "TenantRepository.update" } },
            ),
        );
      }
      if (!existing.value) {
        return failure(
          new DatabaseError(
            "Record not found",
            DATABASE_ERROR_CODES.RECORD_NOT_FOUND,
            {
              context: {
                source: "TenantRepository.update",
              },
            },
          ),
        );
      }

      return this.adapter.update<TEntity>(this.tableName, id, entity);
    } catch (error) {
      return failure(
        new DatabaseError(
          "Failed to update record",
          DATABASE_ERROR_CODES.UPDATE_FAILED,
          {
            context: {
              source: "TenantRepository.update",
              cause: error,
            },
          },
        ),
      );
    }
  }

  /**
   * Deletes a record after verifying tenant access.
   *
   * @description
   * First fetches the existing record via {@link findById} (which validates
   * tenant access), then delegates the deletion to the adapter. If the
   * record does not exist or belongs to another tenant, a failure is
   * returned without calling the adapter.
   *
   * @param id - The unique identifier of the record to delete.
   * @returns A `DatabaseResult` resolving to `void` on success.
   *
   * @throws {DatabaseError} Returned as a failure (not thrown) when:
   *                         - `id` is invalid (`INVALID_ID`).
   *                         - The record is not found (`RECORD_NOT_FOUND`).
   *                         - The underlying adapter throws (`DELETE_FAILED`).
   *
   * @example
   * ```typescript
   * const result = await userRepo.delete('user-456');
   * if (result.success) {
   *   console.log('Deleted successfully');
   * }
   * ```
   */
  async delete(id: string): Promise<DatabaseResult<void>> {
    try {
      if (!id || typeof id !== "string") {
        return failure(
          new DatabaseError(
            "Invalid record ID",
            DATABASE_ERROR_CODES.INVALID_ID,
            {
              context: {
                source: "TenantRepository.delete",
              },
            },
          ),
        );
      }

      const existing = await this.findById(id);
      if (!existing.success) {
        return failure(
          existing.error ??
            new DatabaseError(
              "Failed to fetch record",
              DATABASE_ERROR_CODES.FETCH_FAILED,
              {
                context: {
                  source: "TenantRepository.delete",
                },
              },
            ),
        );
      }
      if (!existing.value) {
        return failure(
          new DatabaseError(
            "Record not found",
            DATABASE_ERROR_CODES.RECORD_NOT_FOUND,
            {
              context: {
                source: "TenantRepository.delete",
              },
            },
          ),
        );
      }

      return this.adapter.delete(this.tableName, id);
    } catch (error) {
      return failure(
        new DatabaseError(
          "Failed to delete record",
          DATABASE_ERROR_CODES.DELETE_FAILED,
          {
            context: {
              source: "TenantRepository.delete",
              cause: error,
            },
          },
        ),
      );
    }
  }

  /**
   * Validates that the entity is a valid object.
   * @private
   * @param entity - The entity to validate
   * @throws {DatabaseError} When entity is invalid
   */
  private validateEntity(entity: TEntity): void {
    if (!entity || typeof entity !== "object") {
      throw new DatabaseError(
        "Invalid entity",
        DATABASE_ERROR_CODES.INVALID_ENTITY,
        {
          context: {
            source: "TenantRepository.validateEntity",
          },
        },
      );
    }
  }

  /**
   * Validates that tenant context exists and has an ID.
   * @private
   * @param tenant - The tenant context to validate
   * @throws {DatabaseError} When tenant context is invalid
   */

  private validateTenantContext(tenant: TenantValidationContext): void {
    if (!tenant?.id) {
      throw new DatabaseError(
        "No tenant context available",
        DATABASE_ERROR_CODES.NO_TENANT_CONTEXT,
        {
          context: {
            source: "TenantRepository.validateTenantContext",
          },
        },
      );
    }
  }

  /**
   * Validates that the entity has a tenant ID.
   * @private
   * @param tenantId - The tenant ID from the entity
   * @throws {DatabaseError} When tenant ID is missing
   */
  private validateEntityTenantId(tenantId: TEntity[keyof TEntity]): void {
    if (!tenantId) {
      throw new DatabaseError(
        "Entity has no tenant ID",
        DATABASE_ERROR_CODES.NO_TENANT_ID,
        {
          context: {
            source: "TenantRepository.validateEntityTenantId",
          },
        },
      );
    }
  }

  /**
   * Validates that the current tenant has access to the entity.
   * @private
   * @param entity - The entity to validate access for
   * @throws {DatabaseError} When access is denied
   */
  private validateTenantAccess(entity: TEntity): void {
    try {
      this.validateEntity(entity);

      const tenant = TenantContext.requireCurrent();
      this.validateTenantContext(tenant);

      const tenantId = entity[this.getTenantIdField()];
      this.validateEntityTenantId(tenantId);

      if (tenantId !== tenant.id) {
        throw new DatabaseError(
          "Access denied to entity from different tenant",
          DATABASE_ERROR_CODES.ACCESS_DENIED,
          {
            context: {
              source: "TenantRepository.validateTenantAccess",
            },
          },
        );
      }
    } catch (error) {
      throw new DatabaseError(
        "Tenant validation failed",
        DATABASE_ERROR_CODES.TENANT_VALIDATION_FAILED,
        {
          context: {
            source: "TenantRepository.validateTenantAccess",
            cause: error,
          },
        },
      );
    }
  }
}
