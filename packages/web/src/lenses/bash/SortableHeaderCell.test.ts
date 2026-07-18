import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { SortSpec } from "../../tableSort.js";
import { SortableHeaderCell } from "./SortableHeaderCell.js";

/** Flattens a React element's text content — same "walk the element tree" approach the sibling `*.test.ts` files in this folder use (no jsdom/testing-library in this repo). */
function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement(node)) return flattenText((node.props as { children?: ReactNode }).children);
  return "";
}

function button(element: ReactElement) {
  const span = element.props as { children: ReactElement; "aria-sort": string };
  return { span, btn: span.children.props as { className: string; onClick: () => void } };
}

type Key = "calls" | "label";

describe("SortableHeaderCell", () => {
  it("renders aria-sort=none and no indicator glyph when it isn't the active column", () => {
    const sortSpec: SortSpec<Key> = { key: "label", dir: "asc" };
    const element = SortableHeaderCell<Key>({
      label: "Calls",
      columnKey: "calls",
      defaultDir: "desc",
      sortSpec,
      onSortChange: () => {},
    });

    const { span, btn } = button(element);
    expect(span["aria-sort"]).toBe("none");
    expect(btn.className).toBe("sortbtn lbl");
    expect(flattenText(element)).toBe("Calls");
  });

  it("renders aria-sort=ascending + a ▲ indicator when active and sorted asc", () => {
    const sortSpec: SortSpec<Key> = { key: "calls", dir: "asc" };
    const element = SortableHeaderCell<Key>({
      label: "Calls",
      columnKey: "calls",
      defaultDir: "desc",
      sortSpec,
      onSortChange: () => {},
    });

    const { span, btn } = button(element);
    expect(span["aria-sort"]).toBe("ascending");
    expect(btn.className).toBe("sortbtn lbl on");
    expect(flattenText(element)).toBe("Calls▲");
  });

  it("renders aria-sort=descending + a ▼ indicator when active and sorted desc", () => {
    const sortSpec: SortSpec<Key> = { key: "calls", dir: "desc" };
    const element = SortableHeaderCell<Key>({
      label: "Calls",
      columnKey: "calls",
      defaultDir: "desc",
      sortSpec,
      onSortChange: () => {},
    });

    expect(flattenText(element)).toBe("Calls▼");
  });

  it("clicking a non-active column jumps straight to defaultDir, ignoring the current column's direction", () => {
    const calls: SortSpec<Key>[] = [];
    const element = SortableHeaderCell<Key>({
      label: "Calls",
      columnKey: "calls",
      defaultDir: "desc",
      sortSpec: { key: "label", dir: "asc" },
      onSortChange: (spec) => calls.push(spec),
    });

    button(element).btn.onClick();
    expect(calls).toEqual([{ key: "calls", dir: "desc" }]);
  });

  it("clicking the already-active column toggles its direction", () => {
    const calls: SortSpec<Key>[] = [];
    const element = SortableHeaderCell<Key>({
      label: "Calls",
      columnKey: "calls",
      defaultDir: "desc",
      sortSpec: { key: "calls", dir: "desc" },
      onSortChange: (spec) => calls.push(spec),
    });

    button(element).btn.onClick();
    expect(calls).toEqual([{ key: "calls", dir: "asc" }]);
  });

  it("right-aligns via the cellr class only when align='right' is passed", () => {
    const sortSpec: SortSpec<Key> = { key: "label", dir: "asc" };
    const left = SortableHeaderCell<Key>({
      label: "Command",
      columnKey: "label",
      defaultDir: "asc",
      sortSpec,
      onSortChange: () => {},
    });
    const right = SortableHeaderCell<Key>({
      label: "Calls",
      columnKey: "calls",
      defaultDir: "desc",
      sortSpec,
      onSortChange: () => {},
      align: "right",
    });

    expect(left.props.className).toBeUndefined();
    expect(right.props.className).toBe("cellr");
  });
});
