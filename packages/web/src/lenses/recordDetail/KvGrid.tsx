import { Fragment, type ReactNode } from "react";

export interface KvRow {
  label: string;
  value: ReactNode;
}

/** `.kv` metadata grid — fixed 140px label column, see design-spec/99-components.md. */
export function KvGrid({ rows }: { rows: KvRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="kv mt16">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <span className="lbl">{row.label}</span>
          <span>{row.value}</span>
        </Fragment>
      ))}
    </div>
  );
}
