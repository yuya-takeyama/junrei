import { useEffect, useState } from "react";

type Health = { status: string; name: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Junrei</h1>
      <p>Agent Statistics Analyzer — prototype scaffold.</p>
      {health !== null && (
        <p>
          Server: <code>{health.name}</code> is <strong>{health.status}</strong>
        </p>
      )}
      {error !== null && <p style={{ color: "crimson" }}>Server unreachable: {error}</p>}
    </main>
  );
}
