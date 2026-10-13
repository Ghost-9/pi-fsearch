import test, { after } from "node:test";
import assert from "node:assert/strict";
import { FSearchClient } from "../src/client.ts";

const client = new FSearchClient();

after(() => {
  client.close();
});

test("CI Gate: Deterministic sub-10ms p95 search latency", async () => {
  const iterations = 50;
  const latencies: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = await client.search("package.json", {
      in: process.cwd(),
      limit: 10,
    });
    const elapsed = performance.now() - start;
    assert.equal(res.ok, true);
    latencies.push(elapsed);
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(iterations * 0.5)];
  const p95 = latencies[Math.floor(iterations * 0.95)];

  // Assert sub-10ms p95 latency threshold
  assert.ok(p95 < 10.0, `Expected p95 latency < 10.0ms, got ${p95.toFixed(2)}ms (p50: ${p50.toFixed(2)}ms)`);
});

test("CI Gate: Deterministic sub-5ms p95 trigram grep latency", async () => {
  const iterations = 50;
  const latencies: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = await client.grep("FSearchClient", {
      in: process.cwd(),
      limit: 10,
    });
    const elapsed = performance.now() - start;
    assert.equal(res.ok, true);
    latencies.push(elapsed);
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(iterations * 0.5)];
  const p95 = latencies[Math.floor(iterations * 0.95)];

  // Assert sub-5ms p95 trigram grep threshold
  assert.ok(p95 < 5.0, `Expected p95 grep latency < 5.0ms, got ${p95.toFixed(2)}ms (p50: ${p50.toFixed(2)}ms)`);
});
