#!/usr/bin/env bash
# Seed 100,000 documents into the default database and the same first 20,000
# into a second database. Run on the server after setup.sh.
source "$(dirname "$0")/env.sh"

seed() {
  local db=$1 n=$2 label=$3
  log "seeding $n documents into $db"
  in_web env PAPERLESS_DBNAME="$db" PYTHONPATH="$SRC" \
    python3 /harness/seed.py --n "$n" --seed "$SEED" --corpus /harness/corpus \
    > "$RES/seed-$label.json" 2> "$RES/logs/seed-$label.log"
  dc exec -T db psql -U paperless -d "$db" -Atc \
    "select pg_size_pretty(pg_database_size(current_database())), count(*), sum(length(content)) from documents_document" \
    | tee "$RES/seed-$label.db.txt"
}

if [[ ! -s "$RES/seed-100k.json" ]]; then
  seed "$DB_100K" 100000 100k
fi

if [[ ! -s "$RES/seed-20k.json" ]]; then
  if ! dc exec -T db psql -U paperless -d postgres -Atc "select 1 from pg_database where datname='$DB_20K'" | grep -q 1; then
    dc exec -T db createdb -U paperless "$DB_20K"
  fi
  log "migrating $DB_20K"
  in_web env PAPERLESS_DBNAME="$DB_20K" python3 manage.py migrate --no-input > "$RES/logs/migrate-20k.log" 2>&1
  seed "$DB_20K" 20000 20k
fi

python3 - "$RES/seed-100k.json" "$RES/seed-20k.json" <<'EOF'
import json, sys
for p in sys.argv[1:]:
    s = json.load(open(p))
    print(p.rsplit("/", 1)[-1], {k: s[k] for k in ("documents", "content_chars_mean", "content_chars_median",
          "content_chars_p99", "content_chars_max", "content_kinds", "data_sha256", "seconds")})
EOF
