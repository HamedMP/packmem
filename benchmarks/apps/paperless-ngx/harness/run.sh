#!/usr/bin/env bash
# Run every export, one at a time, and append one line per run to
# results/runs.tsv. Safe to rerun: runs already recorded with exit 0 are skipped.
#   ROUNDS=5 bash ~/packmem-paperless/harness/run.sh
source "$(dirname "$0")/env.sh"

ROUNDS=${ROUNDS:-5}
TSV="$RES/runs.tsv"
COLS="label	arm	mode	scale	split	round	start_utc	load_start	load_end	exit	wall_s	user_s	sys_s	maxrss_kb	start_rss_kb	held_rss_kb	done_hwm_kb	table_nbytes	packmem	manifest_sha256	manifest_bytes	files	vs_ref"
[[ -s "$TSV" ]] || echo "$COLS" > "$TSV"
ensure_time > /dev/null

arm_of() { case $1 in off) echo A ;; b) echo B ;; c) echo C ;; d) echo D ;; esac; }
pp_of() { case $1 in b) echo /opt/packmem/0.2.0 ;; c|d) echo /opt/packmem/main ;; esac; }

wall_seconds() { # "h:mm:ss" or "m:ss.ss"
  awk -F: '{ s = 0; for (i = 1; i <= NF; i++) s = s * 60 + $i; printf "%.2f", s }' <<< "$1"
}

probe_field() { # stage field log
  grep "PACKMEM_PROBE stage=$1 " "$3" | tail -1 | tr ' ' '\n' | sed -n "s/^$2=//p"
}

run_one() {
  local label=$1 mode=$2 scale=$3 split=$4 round=$5
  if awk -F'\t' -v l="$label" '$1 == l && $10 == 0 { f = 1 } END { exit !f }' "$TSV"; then
    log "skip $label (recorded)"; return
  fi
  local db=$DB_100K; [[ $scale == 20k ]] && db=$DB_20K
  local target="$EXPORT/$label" logf="$RES/logs/$label.log" pp
  pp=$(pp_of "$mode")
  local args=(--data-only --no-progress-bar)
  [[ $split == 1 ]] && args+=(--split-manifest)
  local envs=(PACKMEM_MODE="$mode" PAPERLESS_DBNAME="$db")
  [[ -n $pp ]] && envs+=(PYTHONPATH="$pp")

  in_web bash -c "rm -rf '$target' && mkdir -p '$target'"
  local l0 l1 t0 rc=0
  l0=$(loadavg); t0=$(date -u +%FT%TZ)
  log "run $label: mode=$mode scale=$scale split=$split load=$l0"
  in_web env "${envs[@]}" nice -n 10 /usr/bin/time -v \
    python3 manage.py document_exporter "$target" "${args[@]}" > "$logf" 2>&1 || rc=$?
  l1=$(loadavg)

  local sha bytes files
  if [[ $split == 1 ]]; then
    read -r sha bytes files < <(in_web bash -c "cd '$target' && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 | tr '\n' ' '; du -sb . | cut -f1 | tr '\n' ' '; find . -type f | wc -l" || echo "- - -")
  else
    read -r sha bytes files < <(in_web bash -c "cd '$target' && sha256sum manifest.json | cut -d' ' -f1 | tr '\n' ' '; stat -c %s manifest.json | tr '\n' ' '; find . -type f | wc -l" || echo "- - -")
  fi

  local ref="$EXPORT/ref-$scale-split$split" refsha="$RES/ref-$scale-split$split.sha256" vs
  if [[ $rc -ne 0 ]]; then
    vs=failed
  elif [[ ! -s $refsha ]]; then
    [[ $mode == off ]] || { echo "first run of $scale split=$split must be arm A" >&2; exit 1; }
    in_web bash -c "rm -rf '$ref' && mv '$target' '$ref'"
    echo "$sha" > "$refsha"; vs=reference
  elif [[ $sha == "$(cat "$refsha")" ]]; then
    vs=identical
  else
    if in_web python3 /harness/compare.py "$ref" "$target" > "$RES/logs/$label.compare.txt" 2>&1; then
      vs=parsed-equal
    else
      vs=DIFFERENT
    fi
  fi
  in_web rm -rf "$target"

  local wall user sys maxrss
  wall=$(wall_seconds "$(sed -n 's/.*Elapsed (wall clock) time (h:mm:ss or m:ss): //p' "$logf")")
  user=$(sed -n 's/.*User time (seconds): //p' "$logf")
  sys=$(sed -n 's/.*System time (seconds): //p' "$logf")
  maxrss=$(sed -n 's/.*Maximum resident set size (kbytes): //p' "$logf")
  printf '%s\n' "$label	$(arm_of "$mode")	$mode	$scale	$split	$round	$t0	$l0	$l1	$rc	$wall	$user	$sys	$maxrss	$(probe_field start rss_kb "$logf")	$(probe_field held rss_kb "$logf")	$(probe_field done hwm_kb "$logf")	$(probe_field held nbytes "$logf")	$(probe_field start packmem "$logf")	$sha	$bytes	$files	$vs" >> "$TSV"
  log "done $label: exit=$rc wall=${wall}s maxrss=${maxrss}kB manifest=$vs load=$l1"
}

rotate() { local k=$1; shift; local a=("$@"); local n=${#a[@]}; for ((i = 0; i < n; i++)); do echo "${a[((i + k) % n)]}"; done; }
MODES=(off b c d)

run_one warmup-100k off 100k 0 0
for ((r = 1; r <= ROUNDS; r++)); do
  for m in $(rotate $((r - 1)) "${MODES[@]}"); do
    run_one "r$r-$(arm_of "$m")-100k" "$m" 100k 0 "$r"
  done
done
for m in "${MODES[@]}"; do run_one "split-$(arm_of "$m")-100k" "$m" 100k 1 1; done
run_one warmup-20k off 20k 0 0
for m in "${MODES[@]}"; do run_one "s20k-$(arm_of "$m")" "$m" 20k 0 1; done

in_web bash -c "du -sh $EXPORT/ref-* 2>/dev/null" > "$RES/env/ref-sizes.txt" || true
log "all runs done: $(($(wc -l < "$TSV") - 1)) lines in $TSV"
