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

/**
 * The filter a first-time viewer (nothing in localStorage yet) sees — a
 * rolling last-7-days window rather than "all", so the common case fetches
 * (and the Claude adapter analyzes) only recent transcripts instead of every
 * session on the machine. See `useStoredDateFilter`/`parseDateFilter` below
 * for where this applies: only when NOTHING is stored — a stored `"all"` (or
 * any other explicit choice) is a real user decision and is never
 * overridden.
 */
export const DEFAULT_DATE_FILTER: DateFilter = { kind: "last", days: 7 };

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
 * Parses a stored (localStorage) filter back into a `DateFilter`. `raw ===
 * null` means nothing has ever been stored — a first-time viewer — so it
 * resolves to `DEFAULT_DATE_FILTER` (last 7 days), not "all": the point is
 * to default the common case to a cheap, narrow fetch. Anything ELSE
 * unrecognized — old JSON shapes, hand-edited values, a preset that no
 * longer exists — falls back to `ALL_DATES` instead: a stored value (even a
 * corrupt one) means the viewer already interacted with the filter once, and
 * silently narrowing their view to 7 days instead of respecting "whatever
 * they last had" would be a surprising regression, not a sensible default.
 * An explicit stored `{"kind":"all"}` always round-trips to `ALL_DATES` —
 * that's a genuine user choice, never overridden.
 */
export function parseDateFilter(raw: string | null): DateFilter {
  if (raw === null) return DEFAULT_DATE_FILTER;
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

/** Floor `x` (epoch ms) to the nearest 5-minute mark — see `dateFilterFetchBounds`. */
function roundDownTo5Min(x: number): number {
  const FIVE_MIN_MS = 5 * 60 * 1000;
  return Math.floor(x / FIVE_MIN_MS) * FIVE_MIN_MS;
}

/**
 * Server-side fetch bounds (`GET /api/sessions`'s `sinceMs`/`untilMs`, see
 * `@junrei/server`'s `SessionListBounds`) for `filter`, evaluated against
 * `nowMs`. This is what lets the default last-7-days filter actually skip
 * analyzing old transcripts server-side — `matchesDateFilter` above still
 * applies the exact per-row cutoff client-side, so this only needs to be a
 * SUPERSET of what the filter really wants:
 *
 * - `all` imposes no bound at all.
 * - `last N days` bounds `sinceMs` to `N` days before `nowMs`, ROUNDED DOWN
 *   to the nearest 5 minutes. The rounding matters because the caller keys a
 *   `useEffect` fetch on this value (see `SessionList.tsx`): a raw
 *   `Date.now() - N * DAY_MS` would differ by however many milliseconds
 *   elapsed between renders, so every re-render would compute a "new"
 *   `sinceMs` and refetch forever. Rounding down to a 5-minute mark makes two
 *   calls made within the same 5-minute window return the IDENTICAL value,
 *   so the effect only re-runs when the filter itself changes (or a real
 *   5-minute boundary passes) — at the cost of the server-side window being
 *   up to 5 minutes looser than the exact client-side cutoff, which just
 *   means at most a few extra (still-recent) rows get fetched and then
 *   trimmed by `matchesDateFilter`.
 * - `custom` bounds `sinceMs`/`untilMs` from the local-calendar-day bounds,
 *   exactly like `matchesDateFilter` does (`localDayStartMs(from)` /
 *   `localDayStartMs(to) + DAY_MS`) — these are already stable values (no
 *   `Date.now()` involved), so no rounding is needed.
 */
export function dateFilterFetchBounds(
  filter: DateFilter,
  nowMs: number,
): { sinceMs?: number; untilMs?: number } {
  if (filter.kind === "all") return {};
  if (filter.kind === "last") {
    return { sinceMs: roundDownTo5Min(nowMs - filter.days * DAY_MS) };
  }
  return {
    ...(filter.from !== undefined && { sinceMs: localDayStartMs(filter.from) }),
    ...(filter.to !== undefined && { untilMs: localDayStartMs(filter.to) + DAY_MS }),
  };
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
 * same storage pattern as `useTheme`. A first-time viewer (nothing stored
 * yet) starts on `DEFAULT_DATE_FILTER`, not `ALL_DATES` — see
 * `parseDateFilter`'s doc comment. The `localStorage.getItem` call itself
 * throwing (storage blocked entirely, e.g. some private-browsing modes) is a
 * DIFFERENT case from "nothing stored" — whether a value existed is
 * unknowable here, so this still falls back to `ALL_DATES` rather than
 * risking a surprising narrower view for a returning viewer.
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
