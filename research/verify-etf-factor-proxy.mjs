#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG,
  PRIMARY_CANDIDATES,
  calculateEndWeights,
  calculateMaxDrawdown,
  calculateMetrics,
  calculateOneWayTurnover,
  selectTrailingTop
} from "./etf-factor-proxy-backtest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const resultPath = path.join(HERE, "results", "etf-factor-proxy-2026-07-15.json");

assert.equal(calculateMaxDrawdown([100, 120, 90, 110]), 0.25);
assert.equal(calculateOneWayTurnover(new Map([["A", 1]]), new Map([["B", 1]])), 1);
assert.ok(
  Math.abs(
    calculateOneWayTurnover(new Map([["A", 0.6], ["B", 0.4]]), new Map([["A", 0.5], ["B", 0.5]])) -
      0.1
  ) < 1e-12
);

const fixtureMonths = [...Array.from({ length: 12 }, (_, index) => `2024${String(index + 1).padStart(2, "0")}`), "202501"];
const fixtureReturns = {
  A: new Map(fixtureMonths.map((month, index) => [month, index === 12 ? -0.9 : 0.03])),
  B: new Map(fixtureMonths.map((month, index) => [month, index === 12 ? -0.8 : 0.02])),
  C: new Map(fixtureMonths.map((month, index) => [month, index === 12 ? 5 : -0.01]))
};
assert.deepEqual(
  selectTrailingTop(["A", "B", "C"], fixtureReturns, fixtureMonths, 12, 12, 2),
  ["A", "B"],
  "현재 월의 미래 수익률이 ETF 순위에 유출됐습니다."
);

const endWeights = calculateEndWeights(
  new Map([["A", 0.5], ["B", 0.5]]),
  { A: new Map([["202501", 0.1]]), B: new Map([["202501", 0]]) },
  "202501",
  0.05
);
assert.ok(Math.abs(endWeights.get("A") - 0.55 / 1.05) < 1e-12, "월말 드리프트 비중이 잘못됐습니다.");

const metrics = calculateMetrics([
  { month: "202501", equity: 110_000, monthlyReturn: 0.1 },
  { month: "202502", equity: 88_000, monthlyReturn: -0.2 }
], 100_000);
assert.equal(metrics.endingEquity, 88_000);
assert.equal(metrics.maxDrawdownPct, 20);

const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
assert.equal(result.primary.candidates.length, PRIMARY_CANDIDATES.length);
assert.equal(result.primary.simulationTo, CONFIG.endMonth);
assert.ok(result.primary.simulationMonths >= 120, "ETF 핵심 프록시 이력이 10년보다 짧습니다.");
assert.equal(result.primary.scenarios.base.candidates.length, PRIMARY_CANDIDATES.length);
assert.equal(result.primary.scenarios.stress.candidates.length, PRIMARY_CANDIDATES.length);
assert.equal(result.secondary.selection, null, "짧은 4프록시 표본에 합격 판정을 부여했습니다.");
const expectedSpyEnding =
  CONFIG.initialCapital *
  (1 - CONFIG.baseCostPerOneWayPct / 100) *
  result.primary.benchmarkSanity.finalClose /
  result.primary.benchmarkSanity.initialClose;
assert.ok(
  Math.abs(expectedSpyEnding - result.primary.scenarios.base.benchmark.overall.endingEquity) < 2,
  "SPY 수정종가 복리와 벤치마크 결과가 일치하지 않습니다."
);

for (const diagnostic of Object.values(result.dataDiagnostics)) {
  assert.match(diagnostic.sha256, /^[a-f0-9]{64}$/);
  assert.ok(diagnostic.months >= 100);
}

for (const candidate of result.primary.scenarios.base.candidates) {
  const stressed = result.primary.scenarios.stress.candidates.find((item) => item.id === candidate.id);
  assert.ok(stressed, `${candidate.id} 스트레스 결과가 없습니다.`);
  assert.ok(stressed.overall.endingEquity <= candidate.overall.endingEquity + 0.01);
  assert.equal(
    candidate.relativeToSpy.rollingFiveYearWindows,
    result.primary.simulationMonths - CONFIG.rollingWindowMonths + 1
  );
  assert.ok(Number.isFinite(candidate.relativeToSpy.activeReturnTStat));
  const totalWeight = Object.values(candidate.averageWeightsPct).reduce((total, weight) => total + weight, 0);
  assert.ok(Math.abs(totalWeight - 100) < 0.02);
}

const selectedIds = result.primary.selection.rows.filter((row) => row.passed).map((row) => row.id);
assert.deepEqual(selectedIds, result.primary.selection.survivors);
assert.deepEqual(selectedIds, [], "ETF 핵심 프록시의 고정 결과에서 생존 후보가 바뀌었습니다.");
for (const row of result.primary.selection.rows) {
  assert.deepEqual(
    Object.entries(row.checks).filter(([, passed]) => !passed).map(([key]) => key),
    ["positiveValidation", "rollingFiveYearConsistency"],
    `${row.id}의 탈락 근거가 보고서와 다릅니다.`
  );
}
assert.deepEqual(
  [...result.primary.selection.survivors, ...result.primary.selection.rejected].sort(),
  PRIMARY_CANDIDATES.map((candidate) => candidate.id).sort()
);

process.stdout.write("ETF 팩터 프록시 백테스트 검증 통과\n");
