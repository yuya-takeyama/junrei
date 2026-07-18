import { describe, expect, it } from "vitest";
import {
  defaultDirFor,
  nextSortSpec,
  type SortColumnDef,
  type SortSpec,
  sortRows,
} from "./tableSort.js";

describe("defaultDirFor", () => {
  it("defaults numeric columns to descending", () => {
    expect(defaultDirFor("numeric")).toBe("desc");
  });

  it("defaults string columns to ascending", () => {
    expect(defaultDirFor("string")).toBe("asc");
  });
});

describe("nextSortSpec", () => {
  it("toggles direction when clicking the already-active column", () => {
    const current: SortSpec<"calls"> = { key: "calls", dir: "desc" };
    expect(nextSortSpec(current, "calls", "desc")).toEqual({ key: "calls", dir: "asc" });
    expect(nextSortSpec({ key: "calls", dir: "asc" }, "calls", "desc")).toEqual({
      key: "calls",
      dir: "desc",
    });
  });

  it("switches to a new column at its own default direction, not the old column's direction", () => {
    const current: SortSpec<"calls" | "label"> = { key: "calls", dir: "asc" };
    expect(nextSortSpec(current, "label", defaultDirFor("string"))).toEqual({
      key: "label",
      dir: "asc",
    });
  });

  it("starts at the given default direction when there's no current spec", () => {
    expect(nextSortSpec<"calls">(undefined, "calls", "desc")).toEqual({
      key: "calls",
      dir: "desc",
    });
  });
});

interface Row {
  id: string;
  label: string;
  n: number | undefined;
}

const COLUMNS: SortColumnDef<Row, "label" | "n">[] = [
  { key: "label", type: "string", value: (r) => r.label },
  { key: "n", type: "numeric", value: (r) => r.n },
];

describe("sortRows", () => {
  it("sorts numeric columns ascending/descending by raw value", () => {
    const rows: Row[] = [
      { id: "a", label: "a", n: 3 },
      { id: "b", label: "b", n: 1 },
      { id: "c", label: "c", n: 2 },
    ];
    expect(sortRows(rows, { key: "n", dir: "asc" }, COLUMNS).map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(sortRows(rows, { key: "n", dir: "desc" }, COLUMNS).map((r) => r.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("sorts string columns via localeCompare, both directions", () => {
    const rows: Row[] = [
      { id: "a", label: "banana", n: 1 },
      { id: "b", label: "apple", n: 1 },
      { id: "c", label: "cherry", n: 1 },
    ];
    expect(sortRows(rows, { key: "label", dir: "asc" }, COLUMNS).map((r) => r.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(sortRows(rows, { key: "label", dir: "desc" }, COLUMNS).map((r) => r.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("places undefined values last regardless of direction", () => {
    const rows: Row[] = [
      { id: "a", label: "a", n: 5 },
      { id: "b", label: "b", n: undefined },
      { id: "c", label: "c", n: 1 },
    ];
    expect(sortRows(rows, { key: "n", dir: "asc" }, COLUMNS).map((r) => r.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(sortRows(rows, { key: "n", dir: "desc" }, COLUMNS).map((r) => r.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("keeps every undefined-valued row in its original relative order, in either direction", () => {
    const rows: Row[] = [
      { id: "first", label: "x", n: undefined },
      { id: "mid", label: "x", n: 9 },
      { id: "second", label: "x", n: undefined },
    ];
    expect(sortRows(rows, { key: "n", dir: "asc" }, COLUMNS).map((r) => r.id)).toEqual([
      "mid",
      "first",
      "second",
    ]);
    expect(sortRows(rows, { key: "n", dir: "desc" }, COLUMNS).map((r) => r.id)).toEqual([
      "mid",
      "first",
      "second",
    ]);
  });

  it("is stable — rows tied on the sorted column keep their original relative order", () => {
    const rows: Row[] = [
      { id: "first", label: "tie", n: 2 },
      { id: "second", label: "tie", n: 2 },
      { id: "third", label: "tie", n: 2 },
    ];
    expect(sortRows(rows, { key: "n", dir: "asc" }, COLUMNS).map((r) => r.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(sortRows(rows, { key: "n", dir: "desc" }, COLUMNS).map((r) => r.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("does not mutate the input array", () => {
    const rows: Row[] = [
      { id: "a", label: "a", n: 2 },
      { id: "b", label: "b", n: 1 },
    ];
    const copy = [...rows];
    sortRows(rows, { key: "n", dir: "asc" }, COLUMNS);
    expect(rows).toEqual(copy);
  });

  it("returns a shallow copy, unsorted, when the spec's key matches no column def", () => {
    const rows: Row[] = [
      { id: "a", label: "a", n: 2 },
      { id: "b", label: "b", n: 1 },
    ];
    expect(sortRows(rows, { key: "unknown" as "n", dir: "asc" }, COLUMNS)).toEqual(rows);
  });
});
