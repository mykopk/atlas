/**
 * @module @mykopk/atlas-client/advanced/multi-tenancy
 *
 * Multi-tenant data isolation for Atlas clients.
 *
 * @description
 * Enables tenant-scoped database operations with automatic isolation.
 * - {@link TenantContext}: Request-scoped tenant propagation via AsyncLocalStorage.
 * - {@link TenantRepository}: Abstract base repository that enforces tenant isolation
 *   on all CRUD operations (create, read, update, delete).
 *
 * @example
 * ```typescript
 * import { TenantContext, TenantRepository } from "@myko.pk/atlas-client/advanced/multi-tenancy";
 *
 * class UserRepo extends TenantRepository<User> {
 *   protected getTenantIdField(): keyof User { return "tenantId"; }
 * }
 *
 * await TenantContext.run({ id: "tenant-1", name: "Acme", schema: "acme" }, () => {
 *   return userRepo.findMany();
 * });
 * ```
 */
export { TenantContext } from "./TenantContext";

export { TenantRepository } from "./TenantRepository";
