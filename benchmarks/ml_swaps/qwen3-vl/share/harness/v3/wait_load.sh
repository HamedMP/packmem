#!/bin/bash
# usage: wait_load.sh LOG LABEL   waits until the 1-minute load is <= 4 (max 10 min); logs the outcome
LOG=$1; LABEL=$2; t0=$(date +%s)
while :; do
  l1=$(sysctl -n vm.loadavg | awk '{print $2}')
  w=$(( $(date +%s) - t0 ))
  if awk "BEGIN{exit !($l1 <= 4.0)}"; then echo "$LABEL ok load1=$l1 waited=${w}s" >> "$LOG"; exit 0; fi
  if [ $w -ge 600 ]; then echo "$LABEL TIMEOUT load1=$l1 waited=${w}s" >> "$LOG"; exit 0; fi
  sleep 5
done
