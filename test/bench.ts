import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { FSearchClient } from "../src/client.ts";

async function runBenchmark() {
  const client = new FSearchClient();
  const iterations = 10;
  const targetQuery = "Omnibox.swift";
  const grepPattern = "ultraThinMaterial";
  const cwd = "/Users/batra/Search";

  console.log("=== EMPIRICAL SEARCH BENCHMARK (10 runs, Apple Silicon M1/M4) ===\n");

  // 1. Native find
  const nativeFindTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      execFileSync("find", [cwd, "-name", targetQuery], { encoding: "utf-8" });
    } catch {}
    nativeFindTimes.push(performance.now() - t0);
  }

  // 2. Native ripgrep
  const nativeRgTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      execFileSync("rg", ["-l", grepPattern, cwd], { encoding: "utf-8" });
    } catch {}
    nativeRgTimes.push(performance.now() - t0);
  }

  // 3. FSearch Client Search
  const fsearchFindTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await client.search(targetQuery, { in: cwd, limit: 10 });
    fsearchFindTimes.push(performance.now() - t0);
  }

  // 4. FSearch Client Grep
  const fsearchGrepTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await client.grep(grepPattern, { in: cwd, limit: 10 });
    fsearchGrepTimes.push(performance.now() - t0);
  }

  client.close();

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const p50 = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length * 0.5)];
  const p95 = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length * 0.95)];

  console.log(`Native find (subprocess):        mean: ${avg(nativeFindTimes).toFixed(2)}ms | p50: ${p50(nativeFindTimes).toFixed(2)}ms | p95: ${p95(nativeFindTimes).toFixed(2)}ms`);
  console.log(`pi-ultrasearch search (socket):  mean: ${avg(fsearchFindTimes).toFixed(2)}ms | p50: ${p50(fsearchFindTimes).toFixed(2)}ms | p95: ${p95(fsearchFindTimes).toFixed(2)}ms`);
  console.log(`Speedup (Find):                 ${(avg(nativeFindTimes) / avg(fsearchFindTimes)).toFixed(1)}x faster\n`);

  console.log(`Native ripgrep (subprocess):     mean: ${avg(nativeRgTimes).toFixed(2)}ms | p50: ${p50(nativeRgTimes).toFixed(2)}ms | p95: ${p95(nativeRgTimes).toFixed(2)}ms`);
  console.log(`pi-ultrasearch grep (trigram):   mean: ${avg(fsearchGrepTimes).toFixed(2)}ms | p50: ${p50(fsearchGrepTimes).toFixed(2)}ms | p95: ${p95(fsearchGrepTimes).toFixed(2)}ms`);
  console.log(`Speedup (Grep):                 ${(avg(nativeRgTimes) / avg(fsearchGrepTimes)).toFixed(1)}x faster\n`);
}

runBenchmark().catch(console.error);
