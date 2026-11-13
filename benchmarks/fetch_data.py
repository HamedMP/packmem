"""Build the benchmark inputs in the current directory.

flights.jsonl / flights.json / flights.csv / flights.db: nycflights13 (336,776 rows), from the
`nycflights13` PyPI package. nginx.jsonl: 51,462 access-log records from elastic/examples.
"""
import importlib.util, json, pathlib, sqlite3, urllib.request, zipfile
import pandas as pd

NGINX = "https://raw.githubusercontent.com/elastic/examples/master/Common%20Data%20Formats/nginx_json_logs/nginx_json_logs"

pkg = pathlib.Path(importlib.util.find_spec("nycflights13").origin).parent / "data"
with zipfile.ZipFile(pkg / "flights.csv.zip") as z:
    df = pd.read_csv(z.open(z.namelist()[0]))
df.to_json("flights.jsonl", orient="records", lines=True)
df.to_json("flights.json", orient="records")
df.to_csv("flights.csv", index=False)
pathlib.Path("flights.db").unlink(missing_ok=True)
with sqlite3.connect("flights.db") as con:
    df.to_sql("flights", con, index=False)

if not pathlib.Path("nginx.jsonl").exists():
    urllib.request.urlretrieve(NGINX, "nginx.jsonl")

for p in ("flights.jsonl", "flights.json", "flights.csv", "flights.db", "nginx.jsonl"):
    print(p, round(pathlib.Path(p).stat().st_size / 1e6, 1), "MB")
print("flights rows", len(df), "| nginx rows", sum(1 for _ in open("nginx.jsonl")))
print("nginx sample", json.loads(open("nginx.jsonl").readline()))
