#!/bin/bash
# Before/after runs of two unmodified-otherwise tools with one line swapped for packmem.
# usage: apps.sh <data_dir> <venv_original> <venv_patched> > app_results.jsonl
# Patches (applied to the second environment only):
#   sqlite_utils/cli.py:  docs = json.load(decoded)                         ->  docs = packmem.load_json(decoded)
#   jello/lib.py:         [json.loads(i) for i in data.splitlines() if ...] ->  packmem.load_jsonl(data.splitlines())
set -e
here=$(cd "$(dirname "$0")" && pwd); data=$1; orig=$(cd "$2" && pwd); patched=$(cd "$3" && pwd); py=${PYTHON:-python3}
cd "$data"
for kind in original patched; do
  bin=$orig/bin; [ $kind = patched ] && bin=$patched/bin
  for rep in 1 2 3; do
    rm -f out-$kind.db
    $py "$here/runapp.py" "sqlite-utils insert flights.json ($kind)" "$bin/sqlite-utils insert out-$kind.db flights flights.json"
    $py "$here/runapp.py" "jello flights: count delayed over 60 by carrier ($kind)" "$bin/jello -l -c 'c={}
for r in _:
    if r[\"dep_delay\"] is not None and r[\"dep_delay\"] > 60: c[r[\"carrier\"]] = c.get(r[\"carrier\"], 0) + 1
c' < flights.jsonl | shasum | cut -c1-12"
    $py "$here/runapp.py" "jello nginx: total bytes of 404s ($kind)" "$bin/jello -l 'sum(r[\"bytes\"] for r in _ if r[\"response\"] == 404)' < nginx.jsonl"
  done
done
