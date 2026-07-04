/**
 * @fileoverview Repository Pattern Implementation for Database Operations
 * @module repository
 *
 * Provides the `BaseRepository` class, which implements the Repository pattern
 * to achieve a clean separation between domain logic and data access.
 * This abstraction ensures consistent, testable, and maintainable database interaction
 * across all entities and services.
 *
 * ---
 *
 * **Repository Pattern Benefits:**
 * - **Separation of Concerns** → Domain logic isolated from persistence layer
 * - **Testability** → Easy to mock repositories for unit testing
 * - **Consistency** → Unified CRUD interface for all entities
 * - **Type Safety** → Full TypeScript support with generics
 * - **Extensibility** → Easily extendable for entity-specific operations
 *
 * ---
 *
 * **Application Flow Context:**
 * ```
 * Domain Layer → Repository Layer → Service Layer → Database
 *      ↓               ↓                 ↓              ↓
 *  UserService → UserRepository → DatabaseService → Adapters
 *  OrderService → OrderRepository → CRUD Operations → PostgreSQL
 * ```
 *
 * ---
 *
 * @example
 * ```typescript
 * // Define an entity-specific repository
 * interface User {
 *   id: string;
 *   name: string;
 *   email: string;
 *   status: 'active' | 'inactive';
 * }
 *
 * class UserRepository extends BaseRepository<User> {
 *   constructor(db: IDatabaseService) {
 *     super(db, Tables.USERS);
 *   }
 *
 *   // Add entity-specific methods
 *   async findByEmail(email: string): Promise<DatabaseResult<User | null>> {
 *     const result = await this.findMany({
 *       filter: { field: 'email', operator: 'eq', value: email }
 *     });
 *
 *     if (result.success && result.value.data.length > 0) {
 *       return success(result.value.data[0]);
 *     }
 *     return success();
 *   }
 *
 *   async findActiveUsers(): Promise<DatabaseResult<PaginatedResult<User>>> {
 *     return this.findMany({
 *       filter: { field: 'status', operator: 'eq', value: 'active' }
 *     });
 *   }
 * }
 *
 * // Example usage in a service layer
 * class UserService {
 *   constructor(private userRepo: UserRepository) {}
 *
 *   async createUser(userData: CreateInput<User>): Promise<User> {
 *     const result = await this.userRepo.create(userData);
 *     if (!result.success) {
 *       throw new DatabaseError(`Failed to create user: ${result.error?.message}`, DATABASE_ERROR_CODES.INIT_FAILED);
 *     }
 *     return result.value;
 *   }
 * }
 * ```
 */

/** Base repository class implementing the Repository pattern */
export { BaseRepository } from "./BaseRepository";
