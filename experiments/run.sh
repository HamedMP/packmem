#!/bin/bash
# usage: run.sh label cmd...
label=$1; shift
"$@" > /tmp/out.$label 2>/dev/null &
pid=$!
for i in $(seq 1 240); do grep -q ready /tmp/out.$label 2>/dev/null && break; sleep 0.5; done
sleep 1
python3 analyze.py $pid $label
kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null
