"""Scale the jaffle-shop demo's raw_product_events.csv to N rows, deterministically.

Copy k of the original rows (k = 0, 1, 2, ...) keeps every column, with event ids renumbered 1..N, user ids
offset by k * 1,000,000, session ids suffixed with `_k`, and timestamps moved k * 28 days later, so the copies
are distinct users and sessions with the same funnel shape. No randomness: the same input gives the same file.

usage: python3 seed.py <original csv> <output csv> <rows>
"""

import csv
import hashlib
import sys
from datetime import datetime, timedelta

src, out, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(src, newline="") as f:
    reader = csv.DictReader(f)
    fields = reader.fieldnames
    rows = list(reader)

with open(out, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
    w.writeheader()
    for i in range(n):
        k, r = divmod(i, len(rows))
        row = dict(rows[r])
        row["event_id"] = str(i + 1)
        if k:
            row["user_id"] = str(int(row["user_id"]) + k * 1_000_000)
            row["session_id"] = f"{row['session_id']}_{k}"
            ts = datetime.strptime(row["event_timestamp"], "%Y-%m-%d %H:%M:%S") + timedelta(days=28 * k)
            row["event_timestamp"] = ts.strftime("%Y-%m-%d %H:%M:%S")
        w.writerow(row)

h = hashlib.sha256(open(out, "rb").read()).hexdigest()
print(f"source_rows={len(rows)} rows={n} sha256={h}")
