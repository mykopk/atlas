import { describe, it, expect, vi } from "vitest";
import { ReadReplicaAdapter } from "./ReadReplicaAdapter";
import { MockAdapter } from "../adapters/mock/MockAdapter";

function createAdapter() {
  const primary = new MockAdapter({
    initialData: {
      users: [{ id: "1", name: "Alice" }],
    },
  });
  const replica = new MockAdapter({
    initialData: {
      users: [{ id: "1", name: "Alice (from replica)" }],
    },
  });
  return {
    primary,
    replica,
    adapter: new ReadReplicaAdapter(primary, {
      enabled: true,
      replicas: [replica],
      strategy: "round-robin",
    }),
  };
}

describe("ReadReplicaAdapter", () => {
  it("routes reads to replica", async () => {
    const { adapter, replica } = createAdapter();
    const spy = vi.spyOn(replica, "findById");
    const result = await adapter.findById<any>("users", "1");
    expect(spy).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("routes creates to primary", async () => {
    const { adapter, primary, replica } = createAdapter();
    const primarySpy = vi.spyOn(primary, "create");
    const replicaSpy = vi.spyOn(replica, "create");
    await adapter.create<any>("users", { id: "2", name: "Bob" });
    expect(primarySpy).toHaveBeenCalled();
    expect(replicaSpy).not.toHaveBeenCalled();
  });

  it("routes updates to primary", async () => {
    const { adapter, primary, replica } = createAdapter();
    const primarySpy = vi.spyOn(primary, "update");
    const replicaSpy = vi.spyOn(replica, "update");
    await adapter.update<any>("users", "1", { name: "Updated" });
    expect(primarySpy).toHaveBeenCalled();
    expect(replicaSpy).not.toHaveBeenCalled();
  });

  it("routes deletes to primary", async () => {
    const { adapter, primary, replica } = createAdapter();
    const primarySpy = vi.spyOn(primary, "delete");
    const replicaSpy = vi.spyOn(replica, "delete");
    await adapter.delete("users", "1");
    expect(primarySpy).toHaveBeenCalled();
    expect(replicaSpy).not.toHaveBeenCalled();
  });

  it("delegates getClient to primary", () => {
    const { adapter, primary } = createAdapter();
    const spy = vi.spyOn(primary, "getClient");
    adapter.getClient();
    expect(spy).toHaveBeenCalled();
  });

  it("delegates healthCheck to primary", async () => {
    const { adapter, primary } = createAdapter();
    await primary.initialize();
    const result = await adapter.healthCheck();
    expect(result.success).toBe(true);
  });
});
