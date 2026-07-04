import { DynamicModule, Module, Provider, Type } from "@nestjs/common";
import type { DatabaseServiceConfig, DatabaseServiceInterface } from "@myko.pk/types/db";
import { createDatabaseService } from "../factory/createDatabaseService";
import { DATABASE_SERVICE } from "./atlas.constants";

/**
 * Options for configuring the AtlasModule asynchronously.
 *
 * Allows dynamic provider registration (e.g., reading config from `ConfigService`)
 * before the database service is created.
 *
 * @property imports - NestJS modules to import (e.g., `ConfigModule`)
 * @property useFactory - Factory function that returns the database configuration
 * @property inject - Providers to inject into the factory function
 * @property extraProviders - Additional providers to register in the module
 *
 * @example
 * ```typescript
 * AtlasModule.forRootAsync({
 *   imports: [ConfigModule],
 *   useFactory: (configService: ConfigService) => configService.get('database'),
 *   inject: [ConfigService],
 * })
 * ```
 */
export interface AtlasModuleAsyncOptions {
  imports?: any[];
  useFactory: (...args: any[]) => Promise<DatabaseServiceConfig> | DatabaseServiceConfig;
  inject?: any[];
  extraProviders?: Provider[];
}

/**
 * NestJS global module that provides the database service to the application.
 *
 * Exposes two initialization strategies:
 * - `forRoot()`: Synchronous configuration with a static config object
 * - `forRootAsync()`: Async configuration via a factory function
 *
 * Registers `DATABASE_SERVICE` as a global provider so it is available
 * throughout the application without re-importing the module.
 *
 * @example
 * ```typescript
 * // Static configuration
 * @Module({
 *   imports: [AtlasModule.forRoot({ adapter: 'postgres', connectionString })],
 * })
 * export class AppModule {}
 *
 * // Async configuration
 * @Module({
 *   imports: [
 *     AtlasModule.forRootAsync({
 *       imports: [ConfigModule],
 *       useFactory: (config: ConfigService) => config.get('database'),
 *       inject: [ConfigService],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class AtlasModule {
  /**
   * Configure the AtlasModule with a static database configuration object.
   *
   * Creates a database service synchronously and registers it as a global provider.
   *
   * @param config - Database service configuration (adapter type, connection settings, etc.)
   * @returns A dynamic NestJS module with the database service provider
   *
   * @example
   * ```typescript
   * AtlasModule.forRoot({
   *   adapter: 'supabase',
   *   connection: { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY },
   * })
   * ```
   */
  static forRoot(config: DatabaseServiceConfig): DynamicModule {
    return {
      module: AtlasModule,
      global: true,
      providers: [
        {
          provide: DATABASE_SERVICE,
          useFactory: () => createDatabaseService(config),
        },
      ],
      exports: [DATABASE_SERVICE],
    };
  }

  /**
   * Configure the AtlasModule asynchronously using a factory function.
   *
   * Useful when database configuration is provided by another module
   * (e.g., `ConfigModule`) or requires async initialization.
   *
   * @param options - Async configuration options including imports, factory, and inject
   * @returns A dynamic NestJS module with the database service provider
   *
   * @example
   * ```typescript
   * AtlasModule.forRootAsync({
   *   imports: [ConfigModule],
   *   useFactory: async (config: ConfigService) => ({
   *     adapter: 'supabase',
   *     connection: await config.getDatabaseConnection(),
   *   }),
   *   inject: [ConfigService],
   * })
   * ```
   */
  static forRootAsync(options: AtlasModuleAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: DATABASE_SERVICE,
        useFactory: async (...args: any[]): Promise<DatabaseServiceInterface> => {
          const config = await options.useFactory(...args);
          return createDatabaseService(config);
        },
        inject: options.inject ?? [],
      },
      ...(options.extraProviders ?? []),
    ];

    return {
      module: AtlasModule,
      global: true,
      imports: options.imports ?? [],
      providers,
      exports: [DATABASE_SERVICE],
    };
  }
}
