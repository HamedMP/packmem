"""The flights demo API on FastAPI. MODE=baseline holds the data as a list of dicts, MODE=packmem (default) as a packmem Table."""

import gc
import json
import os
import resource
import sys
import time
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.responses import Response, StreamingResponse

MODE = os.environ.get("MODE", "packmem")
PATH = os.environ.get("FLIGHTS_PATH", str(Path(__file__).resolve().parents[2] / "data" / "flights.jsonl"))
PG_URL = os.environ.get("FLIGHTS_PG_URL")  # postgres://... selects Postgres instead of the file
PG_QUERY = "select * from flights"
SOURCE = "postgres" if PG_URL else "file"
BATCH = 4096


def rss_mb():
    if sys.platform == "darwin":
        import ctypes, ctypes.util

        # current resident size from task_info; ru_maxrss would give the peak
        libc = ctypes.CDLL(ctypes.util.find_library("c"))

        class Info(ctypes.Structure):
            _fields_ = [("virtual_size", ctypes.c_uint64), ("resident_size", ctypes.c_uint64), ("resident_size_max", ctypes.c_uint64),
                        ("user_time", ctypes.c_uint64 * 2), ("system_time", ctypes.c_uint64 * 2), ("policy", ctypes.c_int), ("suspend_count", ctypes.c_int)]

        info, count = Info(), ctypes.c_uint(ctypes.sizeof(Info) // 4)
        libc.task_info(libc.mach_task_self(), 20, ctypes.byref(info), ctypes.byref(count))  # 20 = MACH_TASK_BASIC_INFO
        return round(info.resident_size / 1e6, 1)
    with open("/proc/self/statm") as f:
        return round(int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6, 1)


def dumps(v):
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


class Baseline:
    mode = "baseline"
    packed_bytes = None

    def __init__(self, path):
        if PG_URL:
            import psycopg
            from psycopg.rows import dict_row

            with psycopg.connect(PG_URL) as conn, conn.cursor(row_factory=dict_row) as cur:
                cur.execute(PG_QUERY)
                self.rows = cur.fetchall()
            return
        with open(path) as f:
            self.rows = [json.loads(line) for line in f if line.strip()]

    def _match(self, carrier, origin, dest, min_delay):
        def m(r):
            d = r.get("dep_delay")
            return ((carrier is None or r.get("carrier") == carrier) and (origin is None or r.get("origin") == origin)
                    and (dest is None or r.get("dest") == dest)
                    and (min_delay is None or (isinstance(d, (int, float)) and d > min_delay)))
        return m

    def __len__(self):
        return len(self.rows)

    def list(self, q, limit, offset):
        hit = [r for r in self.rows if self._match(**q)(r)]
        return {"total": len(hit), "rows": hit[offset:offset + limit]}

    def by_dest(self, q):
        m, out = self._match(**q), {}
        for r in self.rows:
            if m(r) and isinstance(r.get("dest"), str):
                out[r["dest"]] = out.get(r["dest"], 0) + 1
        return out

    def summary(self, q):
        m = self._match(**q)
        flights = dist = late = 0
        for r in self.rows:
            if not m(r):
                continue
            flights += 1
            if isinstance(r.get("distance"), (int, float)):
                dist += r["distance"]
            d = r.get("dep_delay")
            if isinstance(d, (int, float)) and d > 60:
                late += 1
        return {"flights": flights, "total_distance": dist, "delayed_over_60": late}

    def export(self, q):
        # json.dumps on the list, as a developer who knows to skip FastAPI's jsonable_encoder would write it
        yield dumps([r for r in self.rows if self._match(**q)(r)]).encode()


class Packed:
    mode = "packmem"

    def __init__(self, path):
        import packmem

        if PG_URL:
            import psycopg

            # a server-side cursor streams rows in batches; from_cursor packs them without a dict per row
            with psycopg.connect(PG_URL) as conn, conn.cursor(name="flights") as cur:
                cur.itersize = 50_000  # the default of 100 rows per round trip would make this a test of latency
                cur.execute(PG_QUERY)
                self.t = packmem.from_cursor(cur)
        else:
            self.t = packmem.load_jsonl(path)
        nb = self.t.nbytes
        self.packed_bytes = nb() if callable(nb) else nb

    def __len__(self):
        return len(self.t)

    def _view(self, carrier, origin, dest, min_delay):
        f = {k: v for k, v in (("carrier", carrier), ("origin", origin), ("dest", dest)) if v is not None}
        if min_delay is not None:
            f["dep_delay__gt"] = min_delay
        return self.t.where(**f)

    def list(self, q, limit, offset):
        v = self._view(**q)
        return {"total": len(v), "rows": v.rows(limit=limit, offset=offset)}

    def by_dest(self, q):
        return self._view(**q).group_count("dest")

    def summary(self, q):
        v = self._view(**q)
        return {"flights": len(v), "total_distance": v.sum("distance"), "delayed_over_60": len(v.where(dep_delay__gt=60))}

    def export(self, q):
        v = self._view(**q)
        if hasattr(v, "iter_json"):  # JSON written from the packed columns, when the installed packmem has it
            yield from v.iter_json(batch=BATCH)
            return
        # fallback: materialise one batch of dicts at a time
        ids = v.indices()
        yield b"["
        for a in range(0, len(ids), BATCH):
            part = dumps([self.t[i] for i in ids[a:a + BATCH]])[1:-1]
            if part:
                yield (b"," if a else b"") + part.encode()
        yield b"]"


t0 = time.perf_counter()
store = Packed(PATH) if MODE == "packmem" else Baseline(PATH)
LOAD_MS = round((time.perf_counter() - t0) * 1000)
gc.collect()  # same steady-state point as the Node demos, which collect after loading

app = FastAPI(title="packmem flights")


def q(carrier, origin, dest, min_delay):
    return {"carrier": carrier, "origin": origin, "dest": dest, "min_delay": min_delay}


@app.get("/api/health")
def health():
    pb = store.packed_bytes
    return {"framework": "fastapi", "mode": store.mode, "source": SOURCE, "rows": len(store), "load_ms": LOAD_MS,
            "packed_mb": round(pb / 1e6, 1) if pb else None, "rss_mb": rss_mb()}


@app.get("/api/flights")
def flights(carrier: str | None = None, origin: str | None = None, dest: str | None = None, min_delay: float | None = None,
            limit: int = Query(50, le=1000), offset: int = 0):
    return Response(dumps(store.list(q(carrier, origin, dest, min_delay), limit, offset)), media_type="application/json")


@app.get("/api/stats/by-dest")
def by_dest(carrier: str | None = None, origin: str | None = None, dest: str | None = None, min_delay: float | None = None):
    return store.by_dest(q(carrier, origin, dest, min_delay))


@app.get("/api/stats/summary")
def summary(carrier: str | None = None, origin: str | None = None, dest: str | None = None, min_delay: float | None = None):
    return store.summary(q(carrier, origin, dest, min_delay))


@app.get("/api/flights/export")
def export(carrier: str | None = None, origin: str | None = None, dest: str | None = None, min_delay: float | None = None):
    return StreamingResponse(store.export(q(carrier, origin, dest, min_delay)), media_type="application/json")
