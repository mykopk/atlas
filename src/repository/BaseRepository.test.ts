import { describe, it, expect } from "vitest";
import { BaseRepository } from "./BaseRepository";
import { DatabaseService } from "../service/DatabaseService";
import { MockAdapter } from "../adapters/mock/MockAdapter";

interface User {
  id: string;
  name: string;
  age: number;
}

function createRepo() {
  const adapter = new MockAdapter({
    initialData: {
      users: [
        { id: "1", name: "Alice", age: 30 },
        { id: "2", name: "Bob", age: 25 },
      ],
    },
  });
  const db = new DatabaseService({
    adapter,
    globalConfig: { adapter: "mock", config: {} },
  });
  const repo = new (class extends BaseRepository<User> {
    constructor() {
      super(db, "users");
    }
  })();
  return { repo, adapter, db };
}

describe("BaseRepository", () => {
  describe("findById", () => {
    it("retrieves a record by id", async () => {
      const { repo } = createRepo();
      const result = await repo.findById("1");
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Alice");
    });

    it("returns null for non-existent id", async () => {
      const { repo } = createRepo();
      const result = await repo.findById("999");
      expect(result.success).toBe(true);
      expect(result.value).toBeNull();
    });
  });

  describe("findMany", () => {
    it("returns all records", async () => {
      const { repo } = createRepo();
      const result = await repo.findMany({});
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(2);
    });
  });

  describe("findMany with filter", () => {
    it("filters records", async () => {
      const { repo } = createRepo();
      const result = await repo.findMany({
        filter: { field: "age", operator: "gt", value: 25 },
      });
      expect(result.success).toBe(true);
      expect(result.value?.data).toHaveLength(1);
    });
  });

  describe("create", () => {
    it("creates a new record", async () => {
      const { repo } = createRepo();
      const result = await repo.create({
        name: "Charlie",
        age: 35,
      });
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Charlie");
    });
  });

  describe("update", () => {
    it("updates an existing record", async () => {
      const { repo } = createRepo();
      const result = await repo.update("1", { name: "Alice Updated" });
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Alice Updated");
    });
  });

  describe("delete", () => {
    it("deletes an existing record", async () => {
      const { repo } = createRepo();
      const result = await repo.delete("1");
      expect(result.success).toBe(true);

      const check = await repo.findById("1");
      expect(check.value).toBeNull();
    });
  });

  describe("count", () => {
    it("counts records", async () => {
      const { repo } = createRepo();
      const result = await repo.count();
      expect(result.success).toBe(true);
      expect(result.value).toBe(2);
    });
  });

  describe("findOne", () => {
    it("finds one record matching filter", async () => {
      const { repo } = createRepo();
      const result = await repo.findOne({
        field: "name",
        operator: "eq",
        value: "Bob",
      });
      expect(result.success).toBe(true);
      expect(result.value?.name).toBe("Bob");
    });
  });

  describe("exists", () => {
    it("checks if record exists", async () => {
      const { repo } = createRepo();
      const result = await repo.exists("1");
      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
    });
  });
});
