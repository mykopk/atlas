import { DrizzleAdapter } from "../adapters/drizzle/DrizzleAdapter";
import { SupabaseAdapter } from "../adapters/supabase/SupabaseAdapter";
import { SQLAdapter } from "../adapters/sql/SQLAdapter";
import { MockAdapter } from "../adapters/mock/MockAdapter";
import { PrismaAdapter } from "../adapters/prisma/PrismaAdapter";
import type {
  DatabaseAdapterType,
  DatabaseConfig,
  DrizzleAdapterConfig,
  SQLAdapterConfig,
  SupabaseAdapterConfig,
  DbMockAdapterConfig,
  PrismaAdapterConfig,
} from "@myko/types/db";
import { ADAPTERS } from "@myko/types/db";
import { DatabaseError } from "@myko/errors";
import { DATABASE_ERROR_CODES } from "@myko/errors";

/**
 * Factory for creating database adapter instances.
 *
 * @description
 * Provides a static `create` method that instantiates the appropriate
 * adapter class based on the provided type and configuration.
 * Supports Drizzle, Supabase, SQL, Mock, and Prisma adapters.
 * Throws a descriptive {@link DatabaseError} when the type is unsupported
 * or when configuration is missing or invalid.
 */
export class AdapterFactory {
  /**
   * Create and return a database adapter instance matching the given type.
   *
   * @typeParam T - The specific config type (extends DatabaseConfig)
   * @param type - Adapter type identifier (e.g. ADAPTERS.DRIZZLE)
   * @param config - Configuration object specific to the adapter type
   * @returns A fully configured DatabaseAdapterType instance
   * @throws {DatabaseError} When type or config is missing, or the type is unsupported
   */
  static create<T extends DatabaseConfig>(
    type: T["adapter"],
    config: T,
  ): DatabaseAdapterType {
    try {
      if (!type) {
        throw new DatabaseError(
          "Adapter type is required",
          DATABASE_ERROR_CODES.CONFIG_REQUIRED,
          {
            context: { source: "AdapterFactory.create" },
            cause: new Error("Adapter type is required"),
          },
        );
      }

      if (!config) {
        throw new DatabaseError(
          "Adapter configuration is required",
          DATABASE_ERROR_CODES.CONFIG_REQUIRED,
          {
            context: { source: "AdapterFactory.create" },
            cause: new Error("Adapter configuration is required"),
          },
        );
      }

      switch (type) {
        case ADAPTERS.DRIZZLE:
          return new DrizzleAdapter(config as DrizzleAdapterConfig);

        case ADAPTERS.SUPABASE:
          return new SupabaseAdapter(config as SupabaseAdapterConfig);

        case ADAPTERS.SQL:
          return new SQLAdapter(config as SQLAdapterConfig);

        case ADAPTERS.MOCK:
          return new MockAdapter(config as DbMockAdapterConfig);

        case ADAPTERS.PRISMA:
          return new PrismaAdapter(config as PrismaAdapterConfig);

        default:
          throw new DatabaseError(
            `Unsupported adapter type: ${type}`,
            DATABASE_ERROR_CODES.INVALID_PARAMETERS,
            {
              context: { source: "AdapterFactory.create" },
              cause: new Error(`Unsupported adapter type: ${type}`),
            },
          );
      }
    } catch (error) {
      throw new DatabaseError(
        `Failed to create adapter: ${(error as Error).message}`,
        DATABASE_ERROR_CODES.INIT_FAILED,
        {
          context: { source: "AdapterFactory.create" },
          cause: error as Error,
        },
      );
    }
  }
}
