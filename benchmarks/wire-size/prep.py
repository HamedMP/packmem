"""Write the five record sets as JSON lines, 100,000 records each where the source has that many.

flights: nycflights13, the first 100,000 rows.
chat:    LLaVA-v1.5 mix665k conversations, every 6th record so image and text-only sources both appear.
issues:  3,000 public facebook/react issues from the GitHub API, as returned (nested user, labels, reactions).
traces:  synthetic OpenTelemetry-style spans (seeded).
logs:    synthetic structured service logs (seeded).
usage: prep.py <flights.jsonl> <llava.json> <issues.jsonl> <out dir>
"""
import json, random, sys, uuid
from pathlib import Path

flights, llava, issues, out = sys.argv[1:5]
out = Path(out)
N = 100_000


def write(name, rows):
    with open(out / f"{name}.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")


with open(flights) as f:
    write("flights", (json.loads(next(f)) for _ in range(N)))

with open(llava) as f:
    write("chat", json.load(f)[::6][:N])

rows = []
with open(issues) as f:
    for line in f:
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            break  # a download cut short: keep the complete records
write("issues", rows)

rnd = random.Random(7)
services = ["api", "auth", "billing", "search", "checkout", "inventory", "email", "gateway"]
ops = ["GET /v1/items", "POST /v1/orders", "GET /v1/users/{id}", "SELECT orders", "redis GET", "kafka produce",
       "POST /v1/login", "GET /healthz", "render template", "s3 PutObject"]


def hexid(n):
    return "%0*x" % (n, rnd.getrandbits(4 * n))


spans = []
t = 1_731_000_000_000_000_000
while len(spans) < N:
    trace = hexid(32)
    parent = None
    for depth in range(rnd.randint(2, 12)):
        span = hexid(16)
        t += rnd.randint(10_000, 5_000_000)
        dur = int(rnd.lognormvariate(13, 1.5))
        status = "ERROR" if rnd.random() < 0.03 else "OK"
        op = rnd.choice(ops)
        s = {
            "trace_id": trace, "span_id": span, "parent_span_id": parent, "name": op,
            "service": rnd.choice(services), "kind": rnd.choice(["SERVER", "CLIENT", "INTERNAL"]),
            "start_ns": t, "duration_ns": dur, "status": status,
            "attributes": {"http.status_code": 500 if status == "ERROR" else 200, "host": f"node-{rnd.randint(1, 40)}",
                           "region": rnd.choice(["eu-north-1", "us-east-1", "us-west-2"])},
        }
        if status == "ERROR":
            s["attributes"]["error.message"] = rnd.choice(["timeout after 5000 ms", "connection reset by peer",
                                                           "upstream returned 503", "deadlock detected"])
        spans.append(s)
        parent = span
write("traces", spans[:N])

levels = ["DEBUG"] * 20 + ["INFO"] * 70 + ["WARN"] * 8 + ["ERROR"] * 2
templates = [
    "request completed method={m} path={p} status={s} bytes={b}",
    "user {u} logged in from {ip}",
    "cache miss key=item:{i}",
    "retrying payment {i} attempt {a} of 5",
    "slow query took {ms} ms: SELECT * FROM orders WHERE customer_id = {u}",
]
logs = []
ts = 1_731_000_000.0
for i in range(N):
    ts += rnd.expovariate(50)
    tpl = rnd.choice(templates)
    msg = tpl.format(m=rnd.choice(["GET", "POST"]), p=rnd.choice(["/", "/cart", "/api/items", "/login"]),
                     s=rnd.choice([200, 200, 200, 304, 404, 500]), b=rnd.randint(100, 90_000), u=rnd.randint(1, 50_000),
                     ip=f"10.{rnd.randint(0, 255)}.{rnd.randint(0, 255)}.{rnd.randint(1, 254)}",
                     i=rnd.randint(1, 10**6), a=rnd.randint(1, 5), ms=rnd.randint(200, 9000))
    logs.append({
        "ts": f"{ts:.6f}", "level": rnd.choice(levels), "service": rnd.choice(services),
        "host": f"node-{rnd.randint(1, 40)}", "request_id": str(uuid.UUID(int=rnd.getrandbits(128))),
        "latency_ms": round(rnd.lognormvariate(3, 1), 2), "message": msg,
    })
write("logs", logs)
for p in sorted(out.glob("*.jsonl")):
    print(p.name, sum(1 for _ in open(p)), "records", p.stat().st_size, "bytes")
