import Link from "next/link";
import { flights } from "@/lib/flights";
import { memory, parseQuery } from "@/lib/store";

export const dynamic = "force-dynamic";

const CARRIERS = ["UA", "B6", "EV", "DL", "AA", "MQ", "US", "9E", "WN"];
const ORIGINS = ["EWR", "JFK", "LGA"];
const nf = new Intl.NumberFormat("en-US");

type Search = Promise<Record<string, string | string[] | undefined>>;

function href(cur: Record<string, string | undefined>, patch: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

export default async function Page({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const cur = {
    carrier: typeof sp.carrier === "string" ? sp.carrier : undefined,
    origin: typeof sp.origin === "string" ? sp.origin : undefined,
  };
  const q = parseQuery((k) => (k in cur ? cur[k as keyof typeof cur] : undefined));
  const store = flights();

  const t0 = performance.now();
  const summary = store.summary(q);
  const dests = Object.entries(store.byDest(q)).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const sample = store.list(q, 8, 0).rows;
  const queryMs = performance.now() - t0;
  const mem = memory();
  const top = dests[0]?.[1] ?? 1;
  const qs = new URLSearchParams(Object.entries(cur).filter((e): e is [string, string] => !!e[1])).toString();

  return (
    <main>
      <header>
        <p className="eyebrow">packmem · Next.js route handlers</p>
        <h1>
          {nf.format(store.rows)} flights,{" "}
          {store.packedBytes ? <>held in {(store.packedBytes / 1e6).toFixed(1)} MB</> : <>held as JS objects</>}
        </h1>
        <p className="lede">
          Every query on this page runs inside the server process against the dataset in memory. Restart with{" "}
          <code>MODE=baseline</code> to compare against a plain array of objects.
        </p>
      </header>

      <section className="stats" aria-label="Process">
        <Stat label="Mode" value={store.mode} accent={store.mode === "packmem"} />
        <Stat label="Process RSS" value={`${mem.rss_mb} MB`} />
        <Stat label="JS heap used" value={`${mem.heap_used_mb} MB`} />
        <Stat label="Load" value={`${Math.round(store.loadMs)} ms`} />
        <Stat label="This page's queries" value={`${queryMs.toFixed(1)} ms`} />
      </section>

      <nav className="filters" aria-label="Filters">
        <div>
          <span>Carrier</span>
          <Link className={!cur.carrier ? "on" : ""} href={href(cur, { carrier: undefined })}>All</Link>
          {CARRIERS.map((c) => (
            <Link key={c} className={cur.carrier === c ? "on" : ""} href={href(cur, { carrier: c })}>{c}</Link>
          ))}
        </div>
        <div>
          <span>Origin</span>
          <Link className={!cur.origin ? "on" : ""} href={href(cur, { origin: undefined })}>All</Link>
          {ORIGINS.map((o) => (
            <Link key={o} className={cur.origin === o ? "on" : ""} href={href(cur, { origin: o })}>{o}</Link>
          ))}
        </div>
      </nav>

      <section className="grid">
        <div className="card">
          <h2>Selection</h2>
          <dl>
            <dt>Flights</dt><dd>{nf.format(summary.flights)}</dd>
            <dt>Total distance</dt><dd>{nf.format(summary.total_distance)} mi</dd>
            <dt>Departed over 60 min late</dt><dd>{nf.format(summary.delayed_over_60)}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Top destinations</h2>
          <ol className="bars">
            {dests.map(([d, n]) => (
              <li key={d}>
                <span className="k">{d}</span>
                <span className="bar" style={{ width: `${(n / top) * 100}%` }} />
                <span className="n">{nf.format(n)}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="card">
        <h2>First rows</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Date</th><th>Carrier</th><th>Flight</th><th>Route</th><th>Dep delay</th><th>Distance</th></tr>
            </thead>
            <tbody>
              {sample.map((r, i) => (
                <tr key={i}>
                  <td>{`${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`}</td>
                  <td>{String(r.carrier)}</td>
                  <td>{String(r.flight)}</td>
                  <td>{`${r.origin} → ${r.dest}`}</td>
                  <td className="num">{r.dep_delay === null ? "–" : String(r.dep_delay)}</td>
                  <td className="num">{String(r.distance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>API</h2>
        <ul className="api">
          {[
            ["/api/health", "mode, rows and process memory"],
            [`/api/flights?${qs ? qs + "&" : ""}min_delay=60&limit=20`, "filtered page of rows"],
            [`/api/stats/by-dest${qs ? "?" + qs : ""}`, "group by destination"],
            [`/api/stats/summary${qs ? "?" + qs : ""}`, "count, sum and a nested filter"],
            [`/api/flights/export${qs ? "?" + qs : ""}`, "every matching row, streamed as one JSON array"],
          ].map(([u, d]) => (
            <li key={u}><a href={u}><code>{u}</code></a><span>{d}</span></li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={accent ? "stat accent" : "stat"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
