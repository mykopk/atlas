import { describe, it, expect, vi } from "vitest";
import { MultiReadAdapter } from "./MultiReadExtension";
import { MockAdapter } from "../adapters/mock/MockAdapter";

function createAdapter() {
  const primary = new MockAdapter({
    autoGenerateIds: false,
    initialData: {
      users: [{ id: "1", name: "Alice" }],
    },
  });
  const replica = new MockAdapter({
    autoGenerateIds: false,
    initialData: {
      users: [{ id: "1", name: "Alice (replica)" }],
    },
  });
  const adapter = new MultiReadAdapter(primary, {
    enabled: true,
    adapters: [replica],
    strategy: "round-robin",
    fallbackToPrimary: true,
    healthCheckInterval: 5000,
    maxFailures: 3,
  });
  return { primary, replica, adapter };
}

describe("MultiReadAdapter", () => {
  it("distributes reads across replicas", async () => {
    const { adapter, replica } = createAdapter();
    const spy = vi.spyOn(replica, "findById");

    const result = await adapter.findById<any>("users", "1");
    expect(spy).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("routes writes to primary", async () => {
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
});
