import { describe, it, expect } from "vitest";
import { EncryptionAdapter } from "./EncryptionExtension";
import { MockAdapter } from "../adapters/mock/MockAdapter";

function createAdapter() {
  const mock = new MockAdapter({
    autoGenerateIds: false,
  });
  return new EncryptionAdapter(mock, {
    enabled: true,
    key: "0123456789abcdef0123456789abcdef",
    fields: {
      users: ["ssn", "taxId"],
    },
  });
}

describe("EncryptionAdapter", () => {
  it("encrypts specified fields on create", async () => {
    const adapter = createAdapter();
    await adapter.create<any>("users", {
      id: "1",
      name: "Alice",
      ssn: "123-45-6789",
    });
    const raw = (adapter.baseAdapter as MockAdapter).getData("users") as any[];
    expect(raw[0].ssn).not.toBe("123-45-6789");
  });

  it("decrypts specified fields on findById", async () => {
    const adapter = createAdapter();
    await adapter.create<any>("users", {
      id: "1",
      name: "Alice",
      ssn: "123-45-6789",
    });
    const result = await adapter.findById<any>("users", "1");
    expect(result.value?.ssn).toBe("123-45-6789");
  });

  it("passes through non-encrypted fields", async () => {
    const adapter = createAdapter();
    await adapter.create<any>("users", {
      id: "1",
      name: "Alice",
      ssn: "123-45-6789",
    });
    const result = await adapter.findById<any>("users", "1");
    expect(result.value?.name).toBe("Alice");
  });

  it("delegates getClient to base", () => {
    const adapter = createAdapter();
    const client = adapter.getClient();
    expect(client).toBeDefined();
  });

  it("skips encryption when disabled", async () => {
    const mock = new MockAdapter({ autoGenerateIds: false });
    const adapter = new EncryptionAdapter(mock, {
      enabled: false,
      key: "0123456789abcdef0123456789abcdef",
      fields: { users: ["ssn"] },
    });
    await adapter.create<any>("users", {
      id: "1",
      name: "Alice",
      ssn: "123-45-6789",
    });
    const raw = mock.getData("users") as any[];
    expect(raw[0].ssn).toBe("123-45-6789");
  });
});
