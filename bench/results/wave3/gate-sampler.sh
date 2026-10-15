#!/bin/bash
# Bounded gate sampler for wave3 ops: one JSON line per 30 s, 60 samples (30 min).
EV=/Users/batra/ultrasearch-waves3/ops/bench/results/wave3
for i in $(seq 1 60); do
  POW=$(pmset -g batt | head -1 | sed -n "s/Now drawing from '\([^']*\)'.*/\1/p")
  L=$(sysctl -n vm.loadavg | awk '{print $2}')
  CARGO=$(pgrep -x cargo | tr '\n' ',' ; pgrep -x rustc | tr '\n' ',')
  printf '{"t":"%s","sample":%d,"power":"%s","load1":%s,"cargo_rustc":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$i" "$POW" "$L" "$CARGO" >> "$EV/gate-samples.jsonl"
  sleep 30
done
