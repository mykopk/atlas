import { describe, it, expect } from "vitest";
import { MockAdapter } from "./MockAdapter";

function createAdapter() {
  return new MockAdapter({
    initialData: {
      users: [
        { id: "1", name: "Alice", age: 30, email: "alice@test.com" },
        { id: "2", name: "Bob", age: 25, email: "bob@test.com" },
        { id: "3", name: "Charlie", age: 35, email: "charlie@test.com" },
        { id: "4", name: "Diana", age: 28, email: null },
        { id: "5", name: null, age: 40, email: "eve@test.com" },
      ],
    },
    tableIdColumns: { users: "id" },
  });
}

describe("MockAdapter", () => {
  describe("constructor", () => {
    it("creates empty adapter with no config", () => {
      const adapter = new MockAdapter();
      expect(adapter).toBeDefined();
    });

    it("creates adapter with initial data", () => {
      const adapter = createAdapter();
      const data = adapter.getData("users");
      expect(data).toHaveLength(5);
    });
  });

  describe("findById", () => {
    it("returns record by id", async () => {
      const adapter = createAdapter();
      const result = await adapter.findById<any>("users", "1");
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Alice");
    });

    it("returns null for non-existent id", async () => {
      const adapter = createAdapter();
      const result = await adapter.findById<any>("users", "999");
      expect(result.success).toBe(true);
      expect(result.value).toBeNull();
    });

    it("returns null for non-existent table", async () => {
      const adapter = createAdapter();
      const result = await adapter.findById<any>("nonexistent", "1");
      expect(result.success).toBe(true);
      expect(result.value).toBeNull();
    });
  });

  describe("create", () => {
    it("creates a record with auto-generated id", async () => {
      const adapter = new MockAdapter({ autoGenerateIds: true });
      const result = await adapter.create<any>("users", {
        name: "Frank",
        age: 32,
      });
      expect(result.success).toBe(true);
      expect(result.value).toBeDefined();
      expect(typeof (result.value as any).id).toBe("string");
    });

    it("creates a record with provided id", async () => {
      const adapter = new MockAdapter();
      const result = await adapter.create<any>("users", {
        id: "100",
        name: "Frank",
      });
      expect(result.success).toBe(true);
      expect(result.value?.id).toBe("100");
    });
  });

  describe("update", () => {
    it("updates an existing record", async () => {
      const adapter = createAdapter();
      const result = await adapter.update<any>("users", "1", {
        name: "Alice Updated",
      });
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Alice Updated");

      const check = await adapter.findById<any>("users", "1");
      expect(check.value?.name).toBe("Alice Updated");
    });

    it("fails to update non-existent record", async () => {
      const adapter = createAdapter();
      const result = await adapter.update<any>("users", "999", {
        name: "Ghost",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("delete", () => {
    it("deletes an existing record", async () => {
      const adapter = createAdapter();
      const result = await adapter.delete("users", "1");
      expect(result.success).toBe(true);

      const check = await adapter.findById<any>("users", "1");
      expect(check.value).toBeNull();
    });

    it("fails to delete non-existent record", async () => {
      const adapter = createAdapter();
      const result = await adapter.delete("users", "999");
      expect(result.success).toBe(false);
    });
  });

  describe("findMany", () => {
    it("returns all records with no options", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users");
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(5);
    });

    it("filters with eq operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "name", operator: "eq", value: "Alice" },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(1);
      expect(result.value?.data[0].email).toBe("alice@test.com");
    });

    it("filters with ne operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "name", operator: "ne", value: "Alice" },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data.length).toBeGreaterThanOrEqual(3);
    });

    it("filters with gt operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "age", operator: "gt", value: 30 },
      });
      expect(result.success).toBe(true);
      const ages = result.value!.data.map((r: any) => r.age);
      expect(ages.every((a: number) => a > 30)).toBe(true);
    });

    it("filters with gte operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "age", operator: "gte", value: 30 },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(3);
    });

    it("filters with lt operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "age", operator: "lt", value: 30 },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(2);
    });

    it("filters with lte operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "age", operator: "lte", value: 30 },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(3);
    });

    it("filters with in operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "name", operator: "in", value: ["Alice", "Bob"] as any },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(2);
    });

    it("filters with like operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "name", operator: "like", value: "ali" },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(1);
    });

    it("filters with between operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "age", operator: "between", value: [25, 30] as any },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(3);
    });

    it("filters with isNull operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "email", operator: "isNull", value: true },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(1);
    });

    it("filters with isNotNull operator", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        filter: { field: "name", operator: "isNotNull", value: true },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(4);
    });

    it("sorts ascending", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        sort: [{ field: "age", direction: "asc" }],
      });
      expect(result.success).toBe(true);
      const ages = result.value!.data.map((r: any) => r.age);
      expect(ages).toEqual([25, 28, 30, 35, 40]);
    });

    it("sorts descending", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        sort: [{ field: "age", direction: "desc" }],
      });
      expect(result.success).toBe(true);
      const ages = result.value!.data.map((r: any) => r.age);
      expect(ages).toEqual([40, 35, 30, 28, 25]);
    });

    it("paginates with limit", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        pagination: { limit: 2 },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(2);
      expect(result.value?.total).toBe(5);
    });

    it("paginates with offset", async () => {
      const adapter = createAdapter();
      const result = await adapter.findMany<any>("users", {
        pagination: { limit: 2, offset: 2 },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(2);
      expect(result.value?.data[0].name).toBe("Charlie");
    });

  });

  describe("exists", () => {
    it("returns true for existing record", async () => {
      const adapter = createAdapter();
      const result = await adapter.exists("users", "1");
      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
    });

    it("returns false for non-existing record", async () => {
      const adapter = createAdapter();
      const result = await adapter.exists("users", "999");
      expect(result.success).toBe(true);
      expect(result.value).toBe(false);
    });
  });

  describe("count", () => {
    it("counts all records with no filter", async () => {
      const adapter = createAdapter();
      const result = await adapter.count("users");
      expect(result.success).toBe(true);
      expect(result.value).toBe(5);
    });

    it("counts filtered records", async () => {
      const adapter = createAdapter();
      const result = await adapter.count<any>("users", {
        field: "age",
        operator: "gt",
        value: 30,
      } as any);
      expect(result.success).toBe(true);
      expect(result.value).toBe(2);
    });
  });

  describe("healthCheck", () => {
    it("returns healthy after initialize", async () => {
      const adapter = createAdapter();
      await adapter.initialize();
      const result = await adapter.healthCheck();
      expect(result.success).toBe(true);
      expect(result.value?.isHealthy).toBe(true);
    });
  });

  describe("getClient", () => {
    it("returns mock metadata", () => {
      const adapter = createAdapter();
      const client = adapter.getClient<{ type: string }>();
      expect(client.type).toBe("mock");
    });
  });

  describe("registerTable", () => {
    it("registers custom id column", async () => {
      const adapter = new MockAdapter();
      adapter.registerTable("products", "products", "sku");
      await adapter.create<any>("products", { sku: "SKU-001", name: "Widget" });
      const result = await adapter.findById<any>("products", "SKU-001");
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Widget");
    });
  });

  describe("transaction", () => {
    it("commits successful transaction", async () => {
      const adapter = new MockAdapter({ autoGenerateIds: true });
      const result = await adapter.transaction(async (trx) => {
        await trx.create("users", { name: "Txn User" });
        return "done";
      });
      expect(result.success).toBe(true);
      expect(result.value).toBe("done");
    });
  });

  describe("clearAll and setData", () => {
    it("clearAll resets data", () => {
      const adapter = createAdapter();
      expect(adapter.getData("users")).toHaveLength(5);
      adapter.clearAll();
      expect(adapter.getData("users")).toHaveLength(0);
    });

    it("setData replaces data", () => {
      const adapter = new MockAdapter();
      adapter.setData("users", [{ id: "1", name: "Custom" }]);
      const data = adapter.getData("users");
      expect(data).toHaveLength(1);
      expect((data as Record<string, unknown>[])[0].name).toBe("Custom");
    });
  });
});
