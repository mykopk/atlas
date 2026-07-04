import { describe, it, expect } from "vitest";
import { SoftDeleteAdapter } from "./SoftDeleteExtension";
import { MockAdapter } from "../adapters/mock/MockAdapter";

function createAdapter() {
  const mock = new MockAdapter({
    initialData: {
      users: [
        { id: "1", name: "Alice", deletedAt: null },
        { id: "2", name: "Bob", deletedAt: null },
      ],
    },
  });
  return new SoftDeleteAdapter(mock, {
    enabled: true,
    field: "deletedAt",
  });
}

describe("SoftDeleteAdapter", () => {
  it("soft deletes by setting deletedAt instead of removing", async () => {
    const adapter = createAdapter();
    const result = await adapter.delete("users", "1");
    expect(result.success).toBe(true);

    const check = await adapter.findById<any>("users", "1");
    expect(check.value).not.toBeNull();
    expect(check.value?.deletedAt).toBeTruthy();
  });

  it("filters out soft-deleted records in findMany", async () => {
    const adapter = createAdapter();
    await adapter.delete("users", "1");
    const list = await adapter.findMany<any>("users");
    expect(list.value?.data).toHaveLength(1);
    expect(list.value?.data[0].name).toBe("Bob");
  });

  it("delegates getClient to base", () => {
    const adapter = createAdapter();
    const client = adapter.getClient();
    expect(client).toBeDefined();
  });

  it("delegates healthCheck to base", async () => {
    const adapter = createAdapter();
    await adapter.initialize();
    const result = await adapter.healthCheck();
    expect(result.success).toBe(true);
  });

  it("delegates create to base", async () => {
    const adapter = createAdapter();
    const result = await adapter.create<any>("users", {
      id: "3",
      name: "Charlie",
    });
    expect(result.success).toBe(true);
    expect(result.value?.name).toBe("Charlie");
  });

  it("delegates update to base", async () => {
    const adapter = createAdapter();
    const result = await adapter.update<any>("users", "2", {
      name: "Bob Updated",
    });
    expect(result.success).toBe(true);
    expect(result.value?.name).toBe("Bob Updated");
  });
});
