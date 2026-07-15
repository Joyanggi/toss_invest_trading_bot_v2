#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATES,
  CONFIG,
  addIndicators,
  calculateMaxDrawdown,
  combineWeights,
  normalizeWeights,
  rollingMean
} from "./benchmark-challenger-backtest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const resultPath = path.join(HERE, "results", "benchmark-challenger-2026-07-15.json");

assert.deepEqual(rollingMean([1, 2, 3, 4], 3), [null, null, 2, 3], "이동평균 계산이 잘못됐습니다.");
assert.equal(calculateMaxDrawdown([100, 120, 90, 110]), 0.25, "최대낙폭 계산이 잘못됐습니다.");

const normalized = normalizeWeights(new Map([["SPY", 2], ["BIL", 1]]));
assert.ok(Math.abs([...normalized.values()].reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
assert.ok(Math.abs(normalized.get("SPY") - 2 / 3) < 1e-12);

const combined = combineWeights(new Map([["SPY", 1]]), new Map([["BIL", 1]]), 0.5);
assert.equal(combined.get("SPY"), 0.5);
assert.equal(combined.get("BIL"), 0.5);

const syntheticCloses = Array.from({ length: 260 }, (_, index) => 100 + index);
const enriched = addIndicators(
  syntheticCloses.map((close, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1
  }))
);
assert.equal(enriched[199].sma200, 199.5);
assert.ok(enriched.at(-1).mom252x21 > 0, "12-1 모멘텀 계산이 잘못됐습니다.");

const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
assert.equal(result.dataDiagnostics.failures.length, 0, "ETF 가격 데이터 수집 실패가 있습니다.");
assert.equal(result.candidates.length, CANDIDATES.length, "후보 전략 수가 코드와 결과에서 다릅니다.");
assert.equal(result.scenarios.base.benchmark.id, "spy_buy_hold");
assert.equal(result.scenarios.base.candidates.length, CANDIDATES.length);
assert.equal(result.scenarios.doubleCost.candidates.length, CANDIDATES.length);
assert.ok(
  result.scenarios.doubleCost.benchmark.overall.endingEquity <=
    result.scenarios.base.benchmark.overall.endingEquity,
  "SPY는 비용을 높였는데 최종자산이 증가했습니다."
);
assert.ok(result.dataDiagnostics.tradingDays >= 4_000, "장기 검증에 필요한 거래일이 부족합니다.");
assert.equal(result.dataDiagnostics.simulationLastDate, CONFIG.endDate, "연구 스냅샷 종료일이 달라졌습니다.");

const expectedSpyEndingEquity =
  (CONFIG.initialCapital * (1 - CONFIG.costPerSide) * result.dataDiagnostics.benchmarkPriceSanity.lastClose) /
  result.dataDiagnostics.benchmarkPriceSanity.firstOpen;
assert.ok(
  Math.abs(expectedSpyEndingEquity - result.scenarios.base.benchmark.overall.endingEquity) < 2,
  "SPY 단순 매수보유 계산과 백테스트 엔진 결과가 다릅니다."
);

for (const candidate of result.scenarios.base.candidates) {
  const expensive = result.scenarios.doubleCost.candidates.find((item) => item.id === candidate.id);
  assert.ok(expensive, `${candidate.id} 비용 2배 결과가 없습니다.`);
  assert.ok(
    expensive.overall.endingEquity <= candidate.overall.endingEquity + 0.01,
    `${candidate.id}는 비용을 높였는데 최종자산이 증가했습니다.`
  );
  for (const key of ["endingEquity", "cagrPct", "maxDrawdownPct", "annualizedVolatilityPct"]) {
    assert.ok(Number.isFinite(candidate.overall[key]), `${candidate.id}.${key}가 유한한 숫자가 아닙니다.`);
  }
  assert.ok(candidate.relativeToSpy.rollingFiveYearWindows >= 100, `${candidate.id}의 5년 구간 표본이 부족합니다.`);
}

const selectedIds = result.selection.rows.filter((row) => row.passed).map((row) => row.id);
assert.deepEqual(selectedIds, result.selection.survivors, "합격 판정과 생존 후보 목록이 다릅니다.");
assert.deepEqual(result.selection.survivors, [], "2026-07-15 사전 기준을 통과한 후보가 예상과 다릅니다.");
const dualMomentum = result.selection.rows.find((row) => row.id === "dual_momentum");
assert.deepEqual(
  Object.entries(dualMomentum.checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key),
  ["positiveHoldout", "rollingFiveYearConsistency"],
  "듀얼 모멘텀의 탈락 근거가 보고서와 다릅니다."
);
assert.deepEqual(
  [...result.selection.survivors, ...result.selection.rejected].sort(),
  CANDIDATES.map((candidate) => candidate.id).sort(),
  "선별 결과에서 누락되거나 중복된 후보가 있습니다."
);

process.stdout.write("벤치마크 도전자 백테스트 검증 통과\n");
