#!/usr/bin/env python3
"""Build bench/results/wave3/manifest.json from the wave3 ops artifacts.

Every number here is copied from a committed artifact; this script adds no
measurements. Run it from the repo root: python3 bench/results/wave3/make-manifest.py
"""
import datetime
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
P = os.path.join(HERE, "provisional")


def load(name):
    with open(os.path.join(P, name)) as f:
        return json.load(f)


def meta(name):
    with open(os.path.join(P, name + ".meta.json")) as f:
        return json.load(f)


def ci(d):
    return {"point": d.get("point"), "lo": d.get("lo"), "hi": d.get("hi")} if d else None


def med(d):
    return {"median": d.get("median"), "ci": d.get("ci") or d.get("medianCI")} if d else None


scopes = load("scopes-2026-10-15-degraded.json")
tokens = load("tokens-2026-10-15-degraded.json")
lanes = load("lanes-2026-10-15-degraded.json")
fallback = load("fallback-2026-10-15-degraded.json")
boost = load("boost-2026-10-15-degraded.json")
engine_ab = load("wave3-engine-ab.json")
conc = load("concurrency-2026-10-15-degraded.json")

artifacts = [
    {
        "name": "bench:scopes",
        "path": "bench/results/wave3/provisional/scopes-2026-10-15-degraded.json",
        "status": scopes.get("status"),
        "gate": {"ok": scopes["environmentGate"].get("ok"), "reasons": scopes["environmentGate"].get("reasons")},
        "daemon": meta("scopes-2026-10-15-degraded.json")["daemon"],
        "n": 30,
        "summary": {
            scope: [
                {
                    "id": q["id"],
                    "n": q["n"],
                    "ultra_p50_ms": q["ultra"]["p50"],
                    "native_p50_ms": q["native"]["p50"],
                    "delta_ms": ci(q.get("pairedDeltaMs")),
                    "ratio": ci(q.get("pairedRatio")),
                    "significant": q.get("significant"),
                    "equivalent": (q.get("equivalence") or {}).get("pass"),
                    "miss_rate": (q.get("equivalence") or {}).get("missRate"),
                }
                for q in data["queries"]
            ]
            for scope, data in scopes["scopes"].items()
        },
        "known_issue": "relevance arm scored 0.000 because the frozen wave-1 corpus /Users/batra/ultrasearch-waves/advisor is absent on this machine; not a regression (see knownLimits)",
    },
    {
        "name": "bench:tokens",
        "path": "bench/results/wave3/provisional/tokens-2026-10-15-degraded.json",
        "status": tokens.get("status"),
        "gate": {"ok": tokens["environmentGate"].get("ok"), "reasons": tokens["environmentGate"].get("reasons")},
        "daemon": meta("tokens-2026-10-15-degraded.json")["daemon"],
        "n": tokens.get("pairs"),
        "summary": {
            "ultra_tokens": med(tokens["ultraTokens"]),
            "native_tokens": med(tokens["nativeTokens"]),
            "token_delta": ci(tokens["tokenDelta"]),
            "savings_ratio": tokens.get("savingsRatio"),
        },
    },
    {
        "name": "bench:lanes",
        "path": "bench/results/wave3/provisional/lanes-2026-10-15-degraded.json",
        "status": lanes.get("status"),
        "gate": {"ok": lanes["environmentGate"].get("ok"), "reasons": lanes["environmentGate"].get("reasons")},
        "daemon": meta("lanes-2026-10-15-degraded.json")["daemon"],
        "n": lanes.get("pairs"),
        "summary": {
            "pooled_batch": med(lanes["pooled"]),
            "paired_delta_ms": ci(lanes["pairedDeltaMs"]),
            "paired_ratio": ci(lanes.get("pairedRatio")),
            "significant": lanes.get("significant"),
            "concurrency_shape": lanes.get("concurrencyShape"),
        },
    },
    {
        "name": "bench:fallback",
        "path": "bench/results/wave3/provisional/fallback-2026-10-15-degraded.json",
        "status": fallback.get("status"),
        "gate": {"ok": fallback["environmentGate"].get("ok"), "reasons": fallback["environmentGate"].get("reasons")},
        "daemon": meta("fallback-2026-10-15-degraded.json")["daemon"],
        "n": fallback.get("n"),
        "summary": {
            "sync_latency": med(fallback["sync"]["latency"]),
            "async_latency": med(fallback["async"]["latency"]),
            "paired_delta_ms": ci(fallback["pairedDeltaMs"]),
            "event_loop_max_delta_ms": ci(fallback["eventLoopMaxDeltaMs"]),
            "no_leaked_children": fallback.get("noLeakedChildren"),
        },
    },
    {
        "name": "bench:boost",
        "path": "bench/results/wave3/provisional/boost-2026-10-15-degraded.json",
        "status": boost.get("status"),
        "gate": {"ok": boost["environmentGate"].get("ok"), "reasons": boost["environmentGate"].get("reasons")},
        "daemon": meta("boost-2026-10-15-degraded.json")["daemon"],
        "n": boost.get("pairs"),
        "summary": {
            "ndcg_on": med(boost["ndcgOn"]),
            "ndcg_off": med(boost["ndcgOff"]),
            "delta_ndcg10": ci(boost["deltaNdCG10"]),
            "decision": boost.get("decision", {}).get("keepBoost"),
        },
        "known_issue": "both arms scored 0.000 nDCG because the wave-1 judgment corpus is absent; the delta is unmeasurable, not zero",
    },
    {
        "name": "bench:engine (engine-ab)",
        "path": "bench/results/wave3/provisional/wave3-engine-ab.json",
        "status": "degraded" if not engine_ab.get("quotable") else "final",
        "gate": {"ok": bool(engine_ab.get("quotable")), "reasons": [f"load1m {engine_ab.get('load1m')} > 1.5"] if not engine_ab.get("quotable") else []},
        "daemon": meta("wave3-engine-ab.json")["daemon"],
        "n": engine_ab.get("n"),
        "summary": {
            "baseline_ref": engine_ab.get("baseline_ref"),
            "files": engine_ab.get("files"),
            "queries": {
                name: {
                    "a_median_ms": q["a"]["median_ms"],
                    "b_median_ms": q["b"]["median_ms"],
                    "diff_ms": q["diff_median_ms"],
                    "diff_ci": q["diff_ci"],
                    "equivalent": q["equivalent"],
                }
                for name, q in engine_ab["queries"].items()
            },
        },
    },
    {
        "name": "engine-concurrency",
        "path": "bench/results/wave3/provisional/concurrency-2026-10-15-degraded.json",
        "status": conc.get("status"),
        "gate": {"ok": conc["gate"].get("ok"), "reasons": conc["gate"].get("reasons")},
        "daemon": meta("concurrency-2026-10-15-degraded.json")["daemon"],
        "n": conc["summary"]["baseline"].get("n"),
        "summary": {
            "baseline": conc["summary"]["baseline"],
            "treatment": conc["summary"]["treatment"],
            "paired_batch_delta_ms": ci(conc["pairedBatchDeltaMs"]),
            "paired_batch_ratio": ci(conc["pairedBatchRatio"]),
            "significant": conc.get("significant"),
            "note": "baseline = the wave-1 installed engine (app-bundle backup), treatment = the promoted build",
        },
    },
]

gate_samples = []
with open(os.path.join(HERE, "gate-samples.jsonl")) as f:
    for line in f:
        line = line.strip()
        if line:
            gate_samples.append(json.loads(line))

passing = [s for s in gate_samples if s["power"] == "AC Power" and float(s["load1"]) < 1.5 and not s["cargo_rustc"].strip(",")]

engine = meta("scopes-2026-10-15-degraded.json")["engine"]

manifest = {
    "schema": "ultrasearch.wave3.ops-manifest/v1",
    "wave": "wave3/ops",
    "createdAt": datetime.datetime.utcnow().isoformat() + "Z",
    "gitHead": os.popen(f"git -C {ROOT} rev-parse HEAD").read().strip(),
    "engine": {
        **engine,
        "baselineWave1AppBundleSha256": "14bbcc13fd04f37da3170199e010402eb47ee7c69f10388bcdeee8bee082ae02",
        "baselineEngineAbFsearchSha256": "d96cfbcf34e8623f1cc6b2ede508b097c9a7947195d55abfebd2e5a6a103ed62",
        "baselineEngineAbRef": "f84ce92",
    },
    "installedDaemon": {
        "pid": meta("scopes-2026-10-15-degraded.json")["daemon"]["pid"],
        "launchagent": "gui/$(id -u)/com.pi.ultrasearch",
        "binary": "/Applications/UltraSearch.app/Contents/MacOS/UltraSearch",
        "localCopy": os.path.expanduser("~/.local/bin/ultrasearch-daemon"),
    },
    "promotion": {
        "runbook": "docs/engine-rebrand.md",
        "backupStamp": "20261015-wave3ops",
        "backups": {
            "appBundle": "/Applications/UltraSearch.app.bak-20261015-wave3ops",
            "localBin": os.path.expanduser("~/.local/bin/ultrasearch-daemon.bak-20261015-wave3ops"),
            "launchAgent": os.path.expanduser("~/Library/LaunchAgents/com.pi.ultrasearch.plist.bak-20261015-wave3ops"),
        },
        "rollbackScript": "bench/results/wave3/rollback-wave3-ops.sh",
        "restoreDrill": "passed: backup binary served isolated socket, status ok, grep 2 hits (bench/results/wave3/promotion/restore-drill-*)",
        "verified": {
            "full_disk_access": True,
            "newStatusFields": ["pid", "uptime_ms", "socket", "socket_dev", "socket_ino", "lock_pid", "staleness_ms", "compactions", "content_policy"],
            "legacyCompatPing": True,
            "indexReused": True,
            "entriesBefore": 6999615,
            "entriesAfter": 7030442,
            "lockPidEqualsPid": True,
            "socketInodeBefore": 39874674,
            "socketInodeAfter": 41663190,
            "codesignIdentifier": "com.pi.ultrasearch",
            "codesignRequirement": '=designated => identifier "com.pi.ultrasearch"',
        },
        "evidence": "bench/results/wave3/promotion/",
    },
    "gateWait": {
        "method": "30 s sampling, 60 samples (30 min bounded wait), gate = AC + load1 < 1.5 + no cargo/rustc",
        "samples": len(gate_samples),
        "passing": len(passing),
        "minLoad1": min(float(s["load1"]) for s in gate_samples) if gate_samples else None,
        "maxLoad1": max(float(s["load1"]) for s in gate_samples) if gate_samples else None,
        "file": "bench/results/wave3/gate-samples.jsonl",
    },
    "artifacts": artifacts,
    "tests": {
        "test:gate": {"result": "8/8 pass", "artifact": "bench/results/wave3/promotion/test-gate-live.log", "note": "live daemon pid 36122; grep client p50 5.36 ms / raw p50 2.82 ms; search 0.86 / 1.25"},
        "test:engine": {"result": "38/38 pass", "artifact": "bench/results/wave3/promotion/test-engine.log"},
        "statusCapture": "bench/results/wave3/promotion/status-one-line.txt",
    },
    "knownLimits": [
        "No artifact is final: the environment gate never passed during the bounded 30-minute wait (60/60 samples failed; min load1 9.45, max 128.44; AC held; a sibling wave's cargo/rustc ran in 19 samples). All timing rows are provisional and may not be cited as production evidence.",
        "The frozen wave-1 judgment corpus /Users/batra/ultrasearch-waves/advisor is absent on this machine, so bench:scopes' relevance arm and bench:boost scored 0.000. Those rows are unmeasurable here, not a regression of the promoted daemon.",
        "bench:lanes/baseline vs treatment was run on a loaded machine; ratios are provisional.",
        "engine-ab baseline f84ce92 was built from git archive; the wave-1 installed engine is the concurrency baseline.",
        "The live test:gate first failed (client p50 78.88 ms) because the fresh worktree's content index was cold and the scoped grep fell back to source=scan over 7,734 on-disk files; a tracked-file touch made the daemon re-track the path (read 91) and the re-run passed 8/8. This is the documented cold-worktree condition, not a daemon change.",
    ],
    "artifactSha256": {
        p: hashlib.sha256(open(os.path.join(P, p), "rb").read()).hexdigest()
        for p in sorted(os.listdir(P))
        if p.endswith(".json") and not p.endswith(".meta.json")
    },
}

with open(os.path.join(HERE, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print("manifest.json written:", len(manifest["artifacts"]), "artifacts,", len(gate_samples), "gate samples,", len(passing), "passing")
