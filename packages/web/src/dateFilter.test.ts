import { describe, expect, it } from "vitest";
import {
  ALL_DATES,
  DATE_FILTER_PRESET_DAYS,
  DEFAULT_DATE_FILTER,
  dateFilterFetchBounds,
  dateFilterFromSelectValue,
  dateFilterSelectValue,
  matchesDateFilter,
  parseDateFilter,
  serializeDateFilter,
} from "./dateFilter.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed "now" for rolling-window tests: an arbitrary mid-day instant. */
const NOW = Date.parse("2026-07-13T12:00:00");

/** Local-time ISO string `days` days before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

describe("matchesDateFilter", () => {
  it("passes everything (even undated sessions) on 'all'", () => {
    expect(matchesDateFilter(daysAgo(1000), ALL_DATES, NOW)).toBe(true);
    expect(matchesDateFilter(undefined, ALL_DATES, NOW)).toBe(true);
  });

  it("keeps sessions inside a rolling window and drops older ones", () => {
    const last7 = { kind: "last", days: 7 } as const;
    expect(matchesDateFilter(daysAgo(6), last7, NOW)).toBe(true);
    expect(matchesDateFilter(daysAgo(8), last7, NOW)).toBe(false);
  });

  it("hides undated/unparseable sessions once any bound is active", () => {
    expect(matchesDateFilter(undefined, { kind: "last", days: 7 }, NOW)).toBe(false);
    expect(matchesDateFilter("not a date", { kind: "last", days: 7 }, NOW)).toBe(false);
    expect(matchesDateFilter(undefined, { kind: "custom", from: "2026-07-01" }, NOW)).toBe(false);
  });

  it("treats a custom range with no bounds as 'all'", () => {
    expect(matchesDateFilter(undefined, { kind: "custom" }, NOW)).toBe(true);
    expect(matchesDateFilter(daysAgo(1000), { kind: "custom" }, NOW)).toBe(true);
  });

  it("interprets custom bounds as inclusive local calendar days", () => {
    const day = { kind: "custom", from: "2026-07-10", to: "2026-07-10" } as const;
    // Local midnight boundaries: the whole of July 10 matches, neighbors don't.
    expect(matchesDateFilter(new Date(2026, 6, 10, 0, 0, 0).toISOString(), day, NOW)).toBe(true);
    expect(matchesDateFilter(new Date(2026, 6, 10, 23, 59, 59).toISOString(), day, NOW)).toBe(true);
    expect(matchesDateFilter(new Date(2026, 6, 9, 23, 59, 59).toISOString(), day, NOW)).toBe(false);
    expect(matchesDateFilter(new Date(2026, 6, 11, 0, 0, 0).toISOString(), day, NOW)).toBe(false);
  });

  it("supports open-ended custom ranges (from-only / to-only)", () => {
    const since = { kind: "custom", from: "2026-07-10" } as const;
    expect(matchesDateFilter(new Date(2026, 6, 12).toISOString(), since, NOW)).toBe(true);
    expect(matchesDateFilter(new Date(2026, 6, 9).toISOString(), since, NOW)).toBe(false);

    const until = { kind: "custom", to: "2026-07-10" } as const;
    expect(matchesDateFilter(new Date(2026, 6, 9).toISOString(), until, NOW)).toBe(true);
    expect(matchesDateFilter(new Date(2026, 6, 11).toISOString(), until, NOW)).toBe(false);
  });
});

describe("parseDateFilter / serializeDateFilter", () => {
  it("round-trips every filter shape", () => {
    const filters = [
      ALL_DATES,
      { kind: "last", days: 7 },
      { kind: "last", days: 30 },
      { kind: "custom", from: "2026-07-01", to: "2026-07-13" },
      { kind: "custom", from: "2026-07-01", to: undefined },
      { kind: "custom", from: undefined, to: undefined },
    ] as const;
    for (const f of filters) {
      expect(parseDateFilter(serializeDateFilter(f))).toEqual(f);
    }
  });

  it("defaults to the last-7-days filter when NOTHING is stored yet (a first-time viewer)", () => {
    expect(parseDateFilter(null)).toEqual(DEFAULT_DATE_FILTER);
    expect(DEFAULT_DATE_FILTER).toEqual({ kind: "last", days: 7 });
  });

  it("falls back to 'all' (not the default) on corrupt or unrecognized storage — a stored value means the viewer already chose once", () => {
    expect(parseDateFilter("not json")).toEqual(ALL_DATES);
    expect(parseDateFilter('"14"')).toEqual(ALL_DATES);
    expect(parseDateFilter('{"kind":"weekly"}')).toEqual(ALL_DATES);
    // A preset that no longer exists must not leave the dropdown value dangling.
    expect(parseDateFilter('{"kind":"last","days":90}')).toEqual(ALL_DATES);
  });

  it("an explicit stored 'all' always round-trips to ALL_DATES, never silently promoted to the default", () => {
    expect(parseDateFilter(serializeDateFilter(ALL_DATES))).toEqual(ALL_DATES);
    expect(parseDateFilter('{"kind":"all"}')).toEqual(ALL_DATES);
  });

  it("drops malformed custom bounds instead of the whole filter", () => {
    expect(parseDateFilter('{"kind":"custom","from":"07/01/2026","to":"2026-07-13"}')).toEqual({
      kind: "custom",
      from: undefined,
      to: "2026-07-13",
    });
  });
});

describe("select-value mapping", () => {
  it("round-trips through the <select> value for every option", () => {
    expect(dateFilterFromSelectValue(dateFilterSelectValue(ALL_DATES))).toEqual(ALL_DATES);
    expect(dateFilterFromSelectValue(dateFilterSelectValue({ kind: "custom" }))).toEqual({
      kind: "custom",
    });
    for (const days of DATE_FILTER_PRESET_DAYS) {
      expect(dateFilterFromSelectValue(dateFilterSelectValue({ kind: "last", days }))).toEqual({
        kind: "last",
        days,
      });
    }
  });

  it("maps unknown select values to 'all'", () => {
    expect(dateFilterFromSelectValue("90")).toEqual(ALL_DATES);
    expect(dateFilterFromSelectValue("")).toEqual(ALL_DATES);
  });
});

describe("dateFilterFetchBounds", () => {
  it("imposes no bound at all for 'all'", () => {
    expect(dateFilterFetchBounds(ALL_DATES, NOW)).toEqual({});
  });

  it("bounds sinceMs to N days before now for a 'last' preset, rounded down to a 5-minute mark", () => {
    const { sinceMs, untilMs } = dateFilterFetchBounds({ kind: "last", days: 7 }, NOW);
    expect(untilMs).toBeUndefined();
    expect(sinceMs).toBeDefined();
    // NOW is exactly noon, so 7 days before it is already on a 5-minute mark —
    // the rounding must be a no-op here.
    expect(sinceMs).toBe(NOW - 7 * DAY_MS);
  });

  it("rounds down to the nearest 5-minute mark when now isn't already aligned", () => {
    const unaligned = Date.parse("2026-07-13T12:03:47.000Z");
    const { sinceMs } = dateFilterFetchBounds({ kind: "last", days: 7 }, unaligned);
    const expectedFloor = Date.parse("2026-07-13T12:00:00.000Z") - 7 * DAY_MS;
    expect(sinceMs).toBe(expectedFloor);
  });

  it("gives two 'now' values inside the same 5-minute window the IDENTICAL sinceMs — the whole point of rounding, so a re-render never refetches on its own", () => {
    const first = Date.parse("2026-07-13T12:01:00.000Z");
    const second = first + 10_000; // 10s later, same 5-minute window
    const a = dateFilterFetchBounds({ kind: "last", days: 14 }, first);
    const b = dateFilterFetchBounds({ kind: "last", days: 14 }, second);
    expect(a).toEqual(b);
  });

  it("crossing a real 5-minute boundary DOES change sinceMs", () => {
    const before = Date.parse("2026-07-13T12:04:59.000Z");
    const after = Date.parse("2026-07-13T12:05:00.000Z");
    const a = dateFilterFetchBounds({ kind: "last", days: 7 }, before);
    const b = dateFilterFetchBounds({ kind: "last", days: 7 }, after);
    expect(a.sinceMs).not.toBe(b.sinceMs);
  });

  it("maps a custom range's local-day bounds the same way matchesDateFilter interprets them, with no rounding", () => {
    const bothBounds = dateFilterFetchBounds(
      { kind: "custom", from: "2026-07-01", to: "2026-07-13" },
      NOW,
    );
    expect(bothBounds).toEqual({
      sinceMs: new Date(2026, 6, 1).getTime(),
      untilMs: new Date(2026, 6, 13).getTime() + DAY_MS,
    });

    const fromOnly = dateFilterFetchBounds({ kind: "custom", from: "2026-07-01" }, NOW);
    expect(fromOnly).toEqual({ sinceMs: new Date(2026, 6, 1).getTime() });

    const toOnly = dateFilterFetchBounds({ kind: "custom", to: "2026-07-01" }, NOW);
    expect(toOnly).toEqual({ untilMs: new Date(2026, 6, 1).getTime() + DAY_MS });

    const neither = dateFilterFetchBounds({ kind: "custom" }, NOW);
    expect(neither).toEqual({});
  });
});
