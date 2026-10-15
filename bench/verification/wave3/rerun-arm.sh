#!/usr/bin/env bash
# bench/verification/wave3/rerun-arm.sh — the VERIFIER's independent re-measurement.
#
#   bash bench/verification/wave3/rerun-arm.sh <arm> <engine-bin> <corpus> <judgments> <runner> <outdir>
#
# Starts an isolated daemon (own ULTRASEARCH_DIR/HOME/SCAN_ROOT, own socket) from
# the given engine binary, waits for the content index to stop growing, runs the
# frozen runner, and stops the daemon. The live daemon is never touched.
#
# arm: label recorded in the output filenames. engine-bin: absolute path.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
export PI_ULTRASEARCH_TEST=1

ARM="$1"; BIN="$2"; CORPUS="$3"; JUDGMENTS="$4"; RUNNER="$5"; OUTDIR="$6"
DIR="$OUTDIR/daemon-$ARM"
rm -rf "$DIR"; mkdir -p "$DIR" "$OUTDIR"
export ULTRASEARCH_ENGINE_BIN="$BIN"

echo "== [$ARM] engine $(shasum -a 256 "$BIN" | cut -c1-16) corpus $(basename "$CORPUS")"
node bench/verification/checks/isolated-daemon.mjs start --dir "$DIR" --corpus "$CORPUS" --warm --timeout 180000
# The daemon answers `status` before the content index is complete; wait for it
# to stop growing (the same predicate measure.mjs uses, done outside the runner).
node -e '
const net=require("net");
const sock=process.argv[1];
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const status=()=>new Promise((res,rej)=>{const s=net.createConnection({path:sock});let b="";const t=setTimeout(()=>{s.destroy();rej(new Error("timeout"))},5000);s.on("connect",()=>s.write(JSON.stringify({id:1,op:"status"})+"\n"));s.on("data",d=>{b+=d.toString();if(b.includes("\n")){clearTimeout(t);s.destroy();try{res(JSON.parse(b.slice(0,b.indexOf("\n"))))}catch(e){rej(e)}}});s.on("error",e=>{clearTimeout(t);rej(e)})});
(async()=>{let last=-1,stable=0,t0=Date.now();
while(Date.now()-t0<180000){const st=await status().catch(()=>null);const d=st&&st.content_docs||0;
 if(d===last&&(st&&st.content_pending||0)===0&&d>0){if(++stable>=4)break}else stable=0;last=d;await wait(400);}
console.log("warm: content_docs="+last);})();
' "$DIR/ultrasearch.sock"

export PI_ULTRASEARCH_SOCKET="$DIR/ultrasearch.sock"
if [ "$RUNNER" = "measure" ]; then
  node bench/wave3/measure.mjs --judgments "$JUDGMENTS" --corpus "$CORPUS" --out "$OUTDIR/measure-$ARM.json" --label "v3-$ARM" --wait-docs 1
elif [ "$RUNNER" = "work" ]; then
  node bench/wave3/work-probe.mjs --judgments "$JUDGMENTS" --corpus "$CORPUS" --out "$OUTDIR/work-$ARM.json" --label "v3-work-$ARM" --rounds 5
elif [ "$RUNNER" = "wave2" ]; then
  node bench/verification/checks/score-wave2.mjs --judgments "$JUDGMENTS" --corpus "$CORPUS" --out "$OUTDIR/wave2-$ARM.json"
elif [ "$RUNNER" = "identity" ]; then
  node bench/wave3/identity-cli-mcp.mjs --corpus "$CORPUS" --query "src/**/*.ts" --limit 20 --out "$OUTDIR/identity-$ARM.json"
else
  echo "unknown runner $RUNNER"; exit 2
fi
RC=$?
node bench/verification/checks/isolated-daemon.mjs stop --dir "$DIR"
echo "== [$ARM] runner=$RUNNER rc=$RC done"
exit $RC
