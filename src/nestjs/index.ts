/**
 * NestJS integration module for @myko/atlas-client.
 *
 * Provides the `AtlasModule` for dependency injection and the `DATABASE_SERVICE`
 * injection token for consuming the database service in NestJS applications.
 *
 * @module nestjs
 *
 * @example
 * ```typescript
 * import { AtlasModule } from '@myko.pk/atlas-client/nestjs';
 *
 * @Module({
 *   imports: [AtlasModule.forRoot({ adapter: 'postgres', connectionString })],
 * })
 * export class AppModule {}
 * ```
 */

/** Global NestJS module for database service registration */
export { AtlasModule } from "./atlas.module";
/** Options interface for async module configuration */
export { AtlasModuleAsyncOptions } from "./atlas.module";
/** Injection token for the database service */
export { DATABASE_SERVICE } from "./atlas.constants";
