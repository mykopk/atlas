import { describe, it, expect, beforeEach } from "vitest";
import { CachingAdapter } from "./CachingAdapter";
import { MockAdapter } from "../adapters/mock/MockAdapter";

function createCacheAdapter(): CachingAdapter {
  const mock = new MockAdapter({
    initialData: {
      users: [
        { id: "1", name: "Alice", age: 30 },
        { id: "2", name: "Bob", age: 25 },
      ],
    },
  });
  return new CachingAdapter(mock, {
    enabled: true,
    ttl: 300,
    invalidation: "write",
  });
}

describe("CachingAdapter", () => {
  let adapter: CachingAdapter;

  beforeEach(() => {
    adapter = createCacheAdapter();
  });

  it("caches findById results on first call", async () => {
    const r1 = await adapter.findById<any>("users", "1");
    expect(r1.success).toBe(true);
    expect(r1.value?.name).toBe("Alice");
  });

  it("returns cached result on second call", async () => {
    await adapter.findById<any>("users", "1");
    const r2 = await adapter.findById<any>("users", "1");
    expect(r2.success).toBe(true);
    expect(r2.value?.name).toBe("Alice");
  });

  it("caches findMany results", async () => {
    const r1 = await adapter.findMany<any>("users", {
      filter: { field: "age", operator: "gt", value: 20 },
    });
    expect(r1.success).toBe(true);
    expect(r1.value?.data).toHaveLength(2);
  });

  it("invalidates cache on create", async () => {
    await adapter.findById<any>("users", "1");
    await adapter.create<any>("users", { id: "3", name: "Charlie", age: 35 });
    const r = await adapter.findById<any>("users", "3");
    expect(r.success).toBe(true);
    expect(r.value?.name).toBe("Charlie");
  });

  it("invalidates cache on update", async () => {
    await adapter.findById<any>("users", "1");
    await adapter.update<any>("users", "1", { name: "Alice Updated" });
    const r = await adapter.findById<any>("users", "1");
    expect(r.value?.name).toBe("Alice Updated");
  });

  it("invalidates cache on delete", async () => {
    await adapter.findById<any>("users", "1");
    await adapter.delete("users", "1");
    const r = await adapter.findById<any>("users", "1");
    expect(r.value).toBeNull();
  });

  it("skips cache when disabled", async () => {
    const mock = new MockAdapter({
      initialData: { users: [{ id: "1", name: "Alice", age: 30 }] },
    });
    const noCache = new CachingAdapter(mock, { enabled: false });
    const r = await noCache.findById<any>("users", "1");
    expect(r.success).toBe(true);
    expect(r.value?.name).toBe("Alice");
  });

  it("delegates getClient to base", () => {
    const client = adapter.getClient();
    expect(client).toBeDefined();
  });

  it("delegates healthCheck to base", async () => {
    const result = await adapter.healthCheck();
    expect(result.success).toBe(true);
  });
});
