import { AsyncLocalStorage } from "async_hooks";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";
import type { TenantInfo } from "@myko/types";

/**
 * Manages tenant context throughout the application using AsyncLocalStorage.
 * Provides a way to isolate tenant-specific data and operations.
 *
 * @description
 * `TenantContext` is a static utility that propagates {@link TenantInfo}
 * across async boundaries via Node.js `AsyncLocalStorage`. It enables
 * tenant-scoped database operations without explicitly passing tenant
 * parameters through every function call.
 *
 * **Lifecycle:**
 * 1. Call {@link run} with a {@link TenantInfo} object and a callback.
 *    Inside the callback the tenant is accessible via {@link current}.
 * 2. At any depth in the async chain, read the tenant via {@link current}
 *    or {@link requireCurrent}.
 * 3. When the callback's promise resolves, the tenant context is
 *    automatically cleaned up.
 *
 * **Thread-safety:**
 * Safe. Each async chain gets its own context store via `AsyncLocalStorage`.
 * Multiple concurrent requests do not interfere.
 *
 * **Browser note:**
 * The underlying `AsyncLocalStorage` is lazily initialised and will throw
 * at runtime in environments where `async_hooks` is unavailable (e.g. the
 * browser). Code paths that invoke `run`/`current`/`requireCurrent` should
 * be guarded by a server-only check when necessary.
 *
 * @example
 * ```typescript
 * const tenant: TenantInfo = {
 *   id: 'tenant-123',
 *   name: 'Acme Corp',
 *   schema: 'acme_corp'
 * };
 *
 * // Run code within tenant context
 * const result = await TenantContext.run(tenant, async () => {
 *   // This code has access to the tenant context
 *   const currentTenant = TenantContext.current();
 *   console.log(`Running as tenant: ${currentTenant?.name}`);
 *
 *   // Perform tenant-specific operations
 *   return await userService.getUsers();
 * });
 *
 * // Access current tenant from anywhere
 * const current = TenantContext.current();
 * if (current) {
 *   console.log(`Current tenant: ${current.name}`);
 * }
 * ```
 */
export class TenantContext {
  private static _storage: AsyncLocalStorage<TenantInfo> | null = null;

  /**
   * Lazily initialized AsyncLocalStorage instance.
   * Prevents crash in browser environments where async_hooks is not available.
   */
  private static get storage(): AsyncLocalStorage<TenantInfo> {
    // AsyncLocalStorage is not available in browser runtimes
    // This will only be called on the server
    this._storage ??= new AsyncLocalStorage<TenantInfo>();
    return this._storage;
  }

  /**
   * Executes an async callback within a specific tenant context.
   *
   * @description
   * The provided `tenant` is stored in `AsyncLocalStorage` for the
   * duration of the `callback`. Any code running inside the callback
   * (including nested promises) can retrieve the tenant via
   * {@link current} or {@link requireCurrent}. When the returned
   * promise settles, the context is automatically disposed.
   *
   * @typeParam T - Return type of the callback.
   * @param tenant - Tenant information to associate with the scope.
   * @param callback - Async function to execute within the tenant scope.
   * @returns A promise resolving to the callback's return value.
   *
   * @throws {Error} Propagates any error thrown inside the callback.
   *
   * @example
   * ```typescript
   * const data = await TenantContext.run({ id: 't1', name: 'Acme' }, async () => {
   *   return db.query('SELECT * FROM users');
   * });
   * ```
   */
  static run<T>(tenant: TenantInfo, callback: () => Promise<T>): Promise<T> {
    return this.storage.run(tenant, callback);
  }

  /**
   * Returns the current tenant context, if one is active.
   *
   * @description
   * Returns the {@link TenantInfo} that was set by the nearest
   * {@link run} call in the current async chain. Returns `undefined`
   * if no tenant context has been established.
   *
   * @returns The current {@link TenantInfo}, or `undefined` if no
   *          context is active.
   *
   * @example
   * ```typescript
   * const tenant = TenantContext.current();
   * if (tenant) {
   *   console.log(`Running as ${tenant.name}`);
   * }
   * ```
   */
  static current(): TenantInfo | undefined {
    return this.storage.getStore();
  }

  /**
   * Returns the current tenant context or throws if none is active.
   *
   * @description
   * Identical to {@link current} but throws a {@link DatabaseError}
   * with code `NO_TENANT_CONTEXT` when no tenant is available. Use
   * this in code paths that must always run within a tenant scope.
   *
   * @returns The current {@link TenantInfo}.
   *
   * @throws {DatabaseError} With `DATABASE_ERROR_CODES.NO_TENANT_CONTEXT`
   *                         when no tenant context is active.
   *
   * @example
   * ```typescript
   * try {
   *   const tenant = TenantContext.requireCurrent();
   *   // safe to use tenant.id
   * } catch (err) {
   *   // handle missing tenant context
   * }
   * ```
   */
  static requireCurrent(): TenantInfo {
    const tenant = this.current();
    if (!tenant) {
      throw new DatabaseError(
        "No tenant context available",
        DATABASE_ERROR_CODES.NO_TENANT_CONTEXT,
        {
          context: {
            source: "TenantContext.requireCurrent",
          },
        },
      );
    }
    return tenant;
  }
}
