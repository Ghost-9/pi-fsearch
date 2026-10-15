// bench/verification/wave3/warm-poll.mjs — poll an isolated daemon's status until
// the content index stops growing. Prints the final content_docs count.
import * as net from "node:net";
const sock = process.argv[2];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const status = () => new Promise((res, rej) => {
  const s = net.createConnection({ path: sock });
  let b = "";
  const t = setTimeout(() => { s.destroy(); rej(new Error("timeout")); }, 5000);
  s.on("connect", () => s.write(JSON.stringify({ id: 1, op: "status" }) + "\n"));
  s.on("data", (d) => { b += d.toString(); if (b.includes("\n")) { clearTimeout(t); s.destroy(); try { res(JSON.parse(b.slice(0, b.indexOf("\n")))); } catch (e) { rej(e); } } });
  s.on("error", (e) => { clearTimeout(t); rej(e); });
});
let last = -1, stable = 0; const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  const st = await status().catch(() => null);
  const docs = (st && st.content_docs) || 0;
  if (docs === last && ((st && st.content_pending) || 0) === 0 && docs > 0) { if (++stable >= 4) break; } else stable = 0;
  last = docs; await wait(400);
}
console.log(last);
