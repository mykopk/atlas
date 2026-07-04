import { describe, it, expect } from "vitest";
import { buildWhereClauseORM, buildOrderClauseORM, buildPaginationClauseORM } from "./orm";

interface TestRecord {
  id: string;
  name: string;
  email: string;
  age: number;
  status: "active" | "inactive";
}

describe("buildWhereClauseORM", () => {
  it("returns undefined for no filters", () => {
    expect(buildWhereClauseORM()).toBeUndefined();
    expect(buildWhereClauseORM([])).toBeUndefined();
  });

  it("handles single filter", () => {
    const result = buildWhereClauseORM<TestRecord>({
      field: "status",
      operator: "eq",
      value: "active",
    });
    expect(result).toEqual({ status: "active" });
  });

  it("handles multiple filters with AND", () => {
    const result = buildWhereClauseORM<TestRecord>([
      { field: "status", operator: "eq", value: "active" },
      { field: "age", operator: "gte", value: 18 },
    ]);
    expect(result).toEqual({
      AND: [{ status: "active" }, { age: { gte: 18 } }],
    });
  });

  it("handles isNull operator", () => {
    const result = buildWhereClauseORM<TestRecord>({
      field: "email",
      operator: "isNull",
      value: null as any,
    });
    expect(result).toEqual({ email: null });
  });

  it("handles isNotNull operator", () => {
    const result = buildWhereClauseORM<TestRecord>({
      field: "email",
      operator: "isNotNull",
      value: null as any,
    });
    expect(result).toEqual({ email: { not: null } });
  });

  it("handles in operator", () => {
    const result = buildWhereClauseORM<TestRecord>({
      field: "status",
      operator: "in",
      value: ["active", "inactive"] as any,
    });
    expect(result).toEqual({ status: { in: ["active", "inactive"] } });
  });

  it("handles like operator", () => {
    const result = buildWhereClauseORM<TestRecord>({
      field: "name",
      operator: "like",
      value: "john",
    });
    expect(result).toEqual({ name: { contains: "john" } });
  });

  it("handles ilike operator with insensitive mode", () => {
    const result = buildWhereClauseORM<TestRecord>({
      field: "name",
      operator: "ilike",
      value: "john",
    });
    expect(result).toEqual({
      name: { contains: "john", mode: "insensitive" },
    });
  });

  it("handles between operator", () => {
    const result = buildWhereClauseORM<TestRecord>({
      field: "age",
      operator: "between",
      value: [18, 65] as any,
    });
    expect(result).toEqual({ age: { gte: 18, lte: 65 } });
  });

  it("handles gt/lt operators", () => {
    const gt = buildWhereClauseORM<TestRecord>({
      field: "age",
      operator: "gt",
      value: 21,
    });
    expect(gt).toEqual({ age: { gt: 21 } });

    const lt = buildWhereClauseORM<TestRecord>({
      field: "age",
      operator: "lt",
      value: 65,
    });
    expect(lt).toEqual({ age: { lt: 65 } });
  });
});

describe("buildOrderClauseORM", () => {
  it("returns undefined for no sort", () => {
    expect(buildOrderClauseORM()).toBeUndefined();
    expect(buildOrderClauseORM([])).toBeUndefined();
  });

  it("handles single sort field", () => {
    const result = buildOrderClauseORM<TestRecord>([
      { field: "name", direction: "asc" },
    ]);
    expect(result).toEqual({ name: "asc" });
  });

  it("handles multiple sort fields", () => {
    const result = buildOrderClauseORM<TestRecord>([
      { field: "status", direction: "asc" },
      { field: "age", direction: "desc" },
    ]);
    expect(result).toEqual({ status: "asc", age: "desc" });
  });
});

describe("buildPaginationClauseORM", () => {
  it("returns undefined for no pagination", () => {
    expect(buildPaginationClauseORM()).toBeUndefined();
  });

  it("handles limit only", () => {
    const result = buildPaginationClauseORM({ limit: 10 });
    expect(result).toEqual({ take: 10 });
  });

  it("handles offset only", () => {
    const result = buildPaginationClauseORM({ offset: 20 });
    expect(result).toEqual({ skip: 20 });
  });

  it("handles limit and offset", () => {
    const result = buildPaginationClauseORM({ limit: 10, offset: 20 });
    expect(result).toEqual({ take: 10, skip: 20 });
  });
});
