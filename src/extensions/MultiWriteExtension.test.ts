import { describe, it, expect, vi } from "vitest";
import { MultiWriteAdapter } from "./MultiWriteExtension";
import { MockAdapter } from "../adapters/mock/MockAdapter";

function createAdapter() {
  const primary = new MockAdapter({ autoGenerateIds: false });
  const secondary = new MockAdapter({ autoGenerateIds: false });
  const adapter = new MultiWriteAdapter(primary, {
    enabled: true,
    adapters: [secondary],
    mode: "best-effort",
  });
  return { primary, secondary, adapter };
}

describe("MultiWriteAdapter", () => {
  it("writes to primary and secondary on create", async () => {
    const { adapter, primary, secondary } = createAdapter();
    const primarySpy = vi.spyOn(primary, "create");
    const secondarySpy = vi.spyOn(secondary, "create");

    await adapter.create<any>("users", { id: "1", name: "Alice" });

    expect(primarySpy).toHaveBeenCalled();
    expect(secondarySpy).toHaveBeenCalled();
  });

  it("reads only from primary", async () => {
    const { adapter, primary, secondary } = createAdapter();
    await adapter.create<any>("users", { id: "1", name: "Alice" });

    const primarySpy = vi.spyOn(primary, "findById");
    const secondarySpy = vi.spyOn(secondary, "findById");

    await adapter.findById<any>("users", "1");

    expect(primarySpy).toHaveBeenCalled();
    expect(secondarySpy).not.toHaveBeenCalled();
  });

  it("writes to primary and secondary on update", async () => {
    const { adapter, primary, secondary } = createAdapter();
    await adapter.create<any>("users", { id: "1", name: "Alice" });

    const primarySpy = vi.spyOn(primary, "update");
    const secondarySpy = vi.spyOn(secondary, "update");

    await adapter.update<any>("users", "1", { name: "Updated" });

    expect(primarySpy).toHaveBeenCalled();
    expect(secondarySpy).toHaveBeenCalled();
  });

  it("writes to primary and secondary on delete", async () => {
    const { adapter, primary, secondary } = createAdapter();
    await adapter.create<any>("users", { id: "1", name: "Alice" });

    const primarySpy = vi.spyOn(primary, "delete");
    const secondarySpy = vi.spyOn(secondary, "delete");

    await adapter.delete("users", "1");

    expect(primarySpy).toHaveBeenCalled();
    expect(secondarySpy).toHaveBeenCalled();
  });

  it("delegates getClient to primary", () => {
    const { adapter, primary } = createAdapter();
    const spy = vi.spyOn(primary, "getClient");
    adapter.getClient();
    expect(spy).toHaveBeenCalled();
  });
});
