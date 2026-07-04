import { describe, it, expect, vi } from "vitest";
import { PrismaAdapter } from "./PrismaAdapter";

function createAdapter(config?: Record<string, any>): PrismaAdapter {
  const mockPrisma = {
    $use: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn((cb: any) => cb(mockPrisma)),
  };

  return new PrismaAdapter({
    adapter: "prisma",
    client: mockPrisma,
    ...config,
  } as any);
}

describe("PrismaAdapter", () => {
  describe("getClient", () => {
    it("returns the prisma client", () => {
      const adapter = createAdapter();
      const client = adapter.getClient();
      expect(client).toBeDefined();
      expect(typeof client).toBe("object");
    });

    it("supports generic type parameter", () => {
      const adapter = createAdapter();
      const client = adapter.getClient<{ $connect: Function }>();
      expect(typeof client.$connect).toBe("function");
    });
  });

  describe("initialize", () => {
    it("connects and registers middleware", async () => {
      const adapter = createAdapter();
      const result = await adapter.initialize();
      expect(result.success).toBe(true);
    });
  });

  describe("healthCheck", () => {
    it("returns healthy when query succeeds", async () => {
      const adapter = createAdapter();
      vi.spyOn(adapter as any, "prisma", "get").mockReturnValue({
        $queryRawUnsafe: vi.fn().mockResolvedValue([{ "1": 1 }]),
        $use: vi.fn(),
        $connect: vi.fn(),
      });

      const result = await adapter.healthCheck();
      expect(result.success).toBe(true);
      expect(result.value?.isHealthy).toBe(true);
    });
  });
});
