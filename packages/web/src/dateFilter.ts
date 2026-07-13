import { useCallback, useState } from "react";

/**
 * Session-list date filter. `last` presets are rolling windows relative to
 * "now"; `custom` is a calendar range of local dates where either bound may
 * be left open (from-only = "since that day", to-only = "through that day",
 * both set to the same day = exactly that day). Bounds are `<input
 * type="date">` values (`YYYY-MM-DD`), interpreted in the viewer's local
 * timezone with `to` covering its whole day.
 */
export type DateFilter =
  | { kind: "all" }
  | { kind: "last"; days: number }
  | { kind: "custom"; from?: string | undefined; to?: string | undefined };

/** Rolling-window preset choices, in dropdown order. */
export const DATE_FILTER_PRESET_DAYS: readonly number[] = [7, 14, 30];

export const ALL_DATES: DateFilter = { kind: "all" };

const STORAGE_KEY = "junrei.sessionList.dateFilter";
const DAY_MS = 24 * 60 * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch ms of local midnight opening the calendar day `ymd` (a validated `YYYY-MM-DD`). */
function localDayStartMs(ymd: string): number {
  const [y = 0, m = 1, d = 1] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Whether a session that started at `startedAt` passes `filter`, evaluated
 * against the epoch-ms `now`. Sessions with no (or unparseable) start time
 * pass only when the filter imposes no bound at all — an active bound can't
 * be checked against a missing date, so such rows are hidden rather than
 * leaking through every range.
 */
export function matchesDateFilter(
  startedAt: string | undefined,
  filter: DateFilter,
  now: number,
): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "custom" && filter.from === undefined && filter.to === undefined) return true;
  if (startedAt === undefined) return false;
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return false;
  if (filter.kind === "last") return t >= now - filter.days * DAY_MS;
  if (filter.from !== undefined && t < localDayStartMs(filter.from)) return false;
  if (filter.to !== undefined && t >= localDayStartMs(filter.to) + DAY_MS) return false;
  return true;
}

/**
 * Parses a stored (localStorage) filter back into a `DateFilter`, falling
 * back to "all" on anything unrecognized — old JSON shapes, hand-edited
 * values, or a preset that no longer exists — so a stale entry can never
 * wedge the list into an inexplicable empty state.
 */
export function parseDateFilter(raw: string | null): DateFilter {
  if (raw === null) return ALL_DATES;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return ALL_DATES;
  }
  if (typeof value !== "object" || value === null) return ALL_DATES;
  const v = value as { kind?: unknown; days?: unknown; from?: unknown; to?: unknown };
  if (v.kind === "all") return ALL_DATES;
  if (v.kind === "last" && typeof v.days === "number" && DATE_FILTER_PRESET_DAYS.includes(v.days)) {
    return { kind: "last", days: v.days };
  }
  if (v.kind === "custom") {
    const from = typeof v.from === "string" && YMD.test(v.from) ? v.from : undefined;
    const to = typeof v.to === "string" && YMD.test(v.to) ? v.to : undefined;
    return { kind: "custom", from, to };
  }
  return ALL_DATES;
}

export function serializeDateFilter(filter: DateFilter): string {
  return JSON.stringify(filter);
}

/**
 * `<select>` value for a filter — presets collapse to their day count so the
 * dropdown options can stay flat strings ("all" | "7" | ... | "custom").
 */
export function dateFilterSelectValue(filter: DateFilter): string {
  return filter.kind === "last" ? String(filter.days) : filter.kind;
}

/** Inverse of `dateFilterSelectValue`, for the `<select>` onChange handler. */
export function dateFilterFromSelectValue(value: string): DateFilter {
  if (value === "custom") return { kind: "custom" };
  const days = Number(value);
  if (DATE_FILTER_PRESET_DAYS.includes(days)) return { kind: "last", days };
  return ALL_DATES;
}

/**
 * Date filter state persisted to localStorage (unlike source/repo/page,
 * which live in the URL: "how far back do I care" is a per-viewer
 * preference that should survive reloads without polluting shared links) —
 * same storage pattern as `useTheme`.
 */
export function useStoredDateFilter(): [DateFilter, (next: DateFilter) => void] {
  const [filter, setFilter] = useState<DateFilter>(() => {
    try {
      return parseDateFilter(localStorage.getItem(STORAGE_KEY));
    } catch {
      return ALL_DATES;
    }
  });
  const update = useCallback((next: DateFilter) => {
    setFilter(next);
    try {
      localStorage.setItem(STORAGE_KEY, serializeDateFilter(next));
    } catch {
      // Storage unavailable (private mode, etc.) — filter still applies for this session.
    }
  }, []);
  return [filter, update];
}
