import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseService } from "./DatabaseService";
import { MockAdapter } from "../adapters/mock/MockAdapter";

function createService() {
  const adapter = new MockAdapter({
    initialData: {
      users: [
        { id: "1", name: "Alice", age: 30 },
        { id: "2", name: "Bob", age: 25 },
      ],
    },
  });
  const service = new DatabaseService({
    adapter,
    globalConfig: {
      adapter: "mock",
      config: {},
    },
  });
  return { service, adapter };
}

describe("DatabaseService", () => {
  describe("get", () => {
    it("retrieves a record by id", async () => {
      const { service } = createService();
      const result = await service.get<any>("users", "1");
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Alice");
    });

    it("returns null for non-existent record", async () => {
      const { service } = createService();
      const result = await service.get<any>("users", "999");
      expect(result.success).toBe(true);
      expect(result.value).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all records with no options", async () => {
      const { service } = createService();
      const result = await service.list<any>("users");
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(2);
    });

    it("filters records", async () => {
      const { service } = createService();
      const result = await service.list<any>("users", {
        filter: { field: "name", operator: "eq", value: "Alice" },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(1);
    });

    it("paginates results", async () => {
      const { service } = createService();
      const result = await service.list<any>("users", {
        pagination: { limit: 1 },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(1);
    });
  });

  describe("create", () => {
    it("creates a new record", async () => {
      const { service } = createService();
      const result = await service.create<any>("users", {
        id: "3",
        name: "Charlie",
        age: 35,
      });
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Charlie");
    });

    it("creates with timestamps", async () => {
      const { service } = createService();
      const result = await service.create<any>("users", {
        id: "4",
        name: "Diana",
        age: 28,
      });
      expect(result.success).toBe(true);
      expect(result.value?.created_at).toBeDefined();
      expect(result.value?.updated_at).toBeDefined();
    });
  });

  describe("update", () => {
    it("updates an existing record", async () => {
      const { service } = createService();
      const result = await service.update<any>("users", "1", {
        name: "Alice Updated",
      });
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Alice Updated");
    });
  });

  describe("delete", () => {
    it("deletes an existing record", async () => {
      const { service } = createService();
      const result = await service.delete("users", "1");
      expect(result.success).toBe(true);

      const check = await service.get<any>("users", "1");
      expect(check.value).toBeNull();
    });
  });

  describe("healthCheck", () => {
    it("returns health status", async () => {
      const { service } = createService();
      const result = await service.healthCheck();
      expect(result.success).toBe(true);
    });
  });

  describe("count", () => {
    it("counts all records", async () => {
      const { service } = createService();
      const result = await service.count<any>("users");
      expect(result.success).toBe(true);
      expect(result.value).toBe(2);
    });

    it("counts filtered records", async () => {
      const { service } = createService();
      const result = await service.count<any>("users", {
        field: "age",
        operator: "gt",
        value: 25,
      } as any);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1);
    });
  });

  describe("exists", () => {
    it("returns true for existing record", async () => {
      const { service } = createService();
      const result = await service.exists("users", "1");
      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
    });

    it("returns false for non-existing record", async () => {
      const { service } = createService();
      const result = await service.exists("users", "999");
      expect(result.success).toBe(true);
      expect(result.value).toBe(false);
    });
  });

  describe("findById (legacy)", () => {
    it("retrieves a record", async () => {
      const { service } = createService();
      const result = await service.findById<any>("users", "1");
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Alice");
    });
  });

  describe("findMany (legacy)", () => {
    it("returns all records", async () => {
      const { service } = createService();
      const result = await service.findMany<any>("users");
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(2);
    });
  });

  describe("getStatus", () => {
    it("returns service status", () => {
      const { service } = createService();
      const status = service.getStatus();
      expect(status.isHealthy).toBe(true);
      expect(status.adapter).toBe("MockAdapter");
    });
  });

  describe("close", () => {
    it("closes the adapter connection", async () => {
      const { service } = createService();
      const result = await service.close();
      expect(result.success).toBe(true);
    });
  });

  describe("registerTable", () => {
    it("registers a table with custom id column", async () => {
      const { service, adapter } = createService();
      service.registerTable("products", "products", "sku");
      await adapter.create<any>("products", { sku: "SKU-001", name: "Widget" });
      const result = await service.get<any>("products", "SKU-001");
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Widget");
    });
  });

  describe("setAuditContext", () => {
    it("sets audit context successfully", async () => {
      const { service } = createService();
      const result = await service.setAuditContext({ userId: "test-user" });
      expect(result.success).toBe(true);
    });
  });

  describe("on/off events", () => {
    it("allows subscribing and unsubscribing from events", () => {
      const { service } = createService();
      const handler = vi.fn();
      service.on("beforeRead", handler);
      service.off("beforeRead", handler);
    });
  });

  describe("transaction", () => {
    it("executes a transaction", async () => {
      const { service } = createService();
      const result = await service.transaction(async () => "done");
      expect(result.success).toBe(true);
      expect(result.value).toBe("done");
    });
  });
});
