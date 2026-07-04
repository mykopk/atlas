/**
 * NestJS DI token for the database service provider.
 *
 * Used as the injection token when consuming `DatabaseServiceInterface` in NestJS modules.
 * Import this token with `@Inject(DATABASE_SERVICE)` to inject the database service.
 *
 * @example
 * ```typescript
 * @Injectable()
 * class UserService {
 *   constructor(
 *     @Inject(DATABASE_SERVICE)
 *     private readonly db: DatabaseServiceInterface,
 *   ) {}
 * }
 * ```
 */
export const DATABASE_SERVICE = "DATABASE_SERVICE";
