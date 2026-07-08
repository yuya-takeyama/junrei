import { useEffect, useMemo, useState } from "react";
import type { ModelMixEntry, SessionListItem } from "./api.js";
import { client } from "./api.js";
import { formatDateTime, formatDuration, formatProject, formatUsd } from "./format.js";
import type { ModelClass } from "./modelClass.js";
import { classifyModel } from "./modelClass.js";
import { buildHash } from "./router.js";
import { Band } from "./shell/Band.js";

const LIST_LIMIT = "200";

type DateFilter = "14" | "30" | "all";
const DATE_FILTER_CYCLE: readonly DateFilter[] = ["all", "14", "30"];
const DATE_FILTER_LABEL: Record<DateFilter, string> = {
  all: "all dates",
  "14": "last 14 days",
  "30": "last 30 days",
};
const DAY_MS = 24 * 60 * 60 * 1000;

function ModelMixBar({ mix }: { mix: ModelMixEntry[] }) {
  const total = mix.reduce((sum, m) => sum + m.outputTokens, 0);
  if (total <= 0) return <span className="mix" />;

  const byClass = new Map<ModelClass, number>();
  for (const m of mix) {
    const cls = classifyModel(m.model);
    byClass.set(cls, (byClass.get(cls) ?? 0) + m.outputTokens);
  }

  return (
    <span className="mix">
      {(["f", "s", "h", "mut"] as const).map((cls) => {
        const tokens = byClass.get(cls);
        if (tokens === undefined || tokens <= 0) return null;
        const pct = (tokens / total) * 100;
        return <span key={cls} className={`mseg c-${cls}`} style={{ width: `${pct}%` }} />;
      })}
    </span>
  );
}

/** Numeric cell rendered muted when the value is zero — the app-wide "de-emphasize zero" rule. */
function NumCell({
  value,
  format = String,
  errorish = false,
}: {
  value: number;
  format?: (n: number) => string;
  errorish?: boolean;
}) {
  const className =
    value === 0 ? "num fs12 cellr mut" : errorish ? "num fs12 cellr errtx" : "num fs12 cellr";
  return <span className={className}>{format(value)}</span>;
}

export function SessionList() {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState("all");
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");

  useEffect(() => {
    client.api.sessions
      .$get({ query: { limit: LIST_LIMIT } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const body = await res.json();
        setSessions(body.sessions);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const projects = useMemo(() => {
    if (sessions === null) return [];
    return [...new Set(sessions.map((s) => s.projectDirName))].sort();
  }, [sessions]);

  const filtered = useMemo(() => {
    if (sessions === null) return [];
    const cutoff = dateFilter === "all" ? undefined : Date.now() - Number(dateFilter) * DAY_MS;
    const needle = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (project !== "all" && s.projectDirName !== project) return false;
      if (needle !== "") {
        const title = (s.title ?? s.firstUserPrompt ?? s.sessionId).toLowerCase();
        if (!title.includes(needle)) return false;
      }
      if (cutoff !== undefined) {
        if (s.startedAt === undefined || Date.parse(s.startedAt) < cutoff) return false;
      }
      return true;
    });
  }, [sessions, project, search, dateFilter]);

  const cycleDateFilter = () => {
    const index = DATE_FILTER_CYCLE.indexOf(dateFilter);
    setDateFilter(DATE_FILTER_CYCLE[(index + 1) % DATE_FILTER_CYCLE.length] ?? "all");
  };

  return (
    <div>
      <Band
        left={<span className="mono fs11 mut">{"// session recorder"}</span>}
        right={<span className="mono fs11 mut">local · ~/.claude/projects</span>}
      />
      <div className="fx ac jb hpad gap12" style={{ padding: "18px 28px 14px", flexWrap: "wrap" }}>
        <h1 className="ttl" style={{ fontSize: "20px" }}>
          Sessions
        </h1>
        <div className="fx ac gap8" style={{ flexWrap: "wrap" }}>
          <select
            className="chip on"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            aria-label="Filter by project"
          >
            <option value="all">project: all</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                project: {formatProject(p)}
              </option>
            ))}
          </select>
          <button type="button" className="chip" onClick={cycleDateFilter}>
            {DATE_FILTER_LABEL[dateFilter]} ▾
          </button>
          <input
            className="chip"
            style={{ minWidth: "180px" }}
            type="text"
            placeholder="⌕ search title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search by title"
          />
          <span className="mono fs11 mut num nowrap">
            {sessions === null ? "…" : filtered.length} sessions
          </span>
        </div>
      </div>

      {error !== null && <div className="mut hpad">Failed to load sessions: {error}</div>}
      {error === null && sessions === null && <div className="mut hpad">Analyzing sessions…</div>}

      {sessions !== null && (
        <div className="l0-wrap">
          <div className="l0g hdr">
            <span className="lbl">Project</span>
            <span className="lbl">Title</span>
            <span className="lbl">Start</span>
            <span className="lbl cellr">Dur</span>
            <span className="lbl cellr">Turns</span>
            <span className="lbl cellr">Cost est</span>
            <span className="lbl">Model mix</span>
            <span className="lbl cellr">Sub</span>
            <span className="lbl cellr">Err</span>
            <span className="lbl cellr">Cmp</span>
          </div>
          {filtered.map((s) => (
            <a
              key={`${s.projectDirName}/${s.sessionId}`}
              className="l0g"
              href={buildHash(s.projectDirName, s.sessionId)}
            >
              <span className="mono fs11 mut nowrap" title={s.projectDirName}>
                {formatProject(s.projectDirName, s.cwd)}
              </span>
              <span className="nowrap">{s.title ?? s.firstUserPrompt ?? s.sessionId}</span>
              <span className="num fs12 mut">
                {s.startedAt !== undefined ? formatDateTime(s.startedAt) : "—"}
              </span>
              <span className="num fs12 cellr mut">
                {s.durationMs !== undefined ? formatDuration(s.durationMs) : "—"}
              </span>
              <NumCell value={s.userTurnCount} />
              <span className={s.totalCostUsd === 0 ? "num fs12 cellr mut" : "num fs12 cellr"}>
                {formatUsd(s.totalCostUsd)}
                {s.costIsComplete ? "" : "*"}
              </span>
              <ModelMixBar mix={s.modelMix} />
              <NumCell value={s.subagentCount} />
              <NumCell value={s.toolErrorCount} errorish />
              <NumCell value={s.compactionCount} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
