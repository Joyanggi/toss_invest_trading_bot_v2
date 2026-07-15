#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATES,
  CONFIG,
  applyAnnualDrag,
  applyImplementationCosts,
  calculateMetrics,
  parseFactorCsv,
  parseFrenchMonthlyCsv,
  selectDynamicFactorWeights
} from "./institutional-factor-backtest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const resultPath = path.join(HERE, "results", "institutional-factor-backtest-2026-07-15.json");

const portfolioFixture = `Header\nAverage Value Weighted Returns -- Monthly\n,BIG HiOP,OTHER\n202501, 2.00, 1.00\n202502, -1.00, 0.50\n\nAnnual`;
assert.deepEqual(parseFrenchMonthlyCsv(portfolioFixture), [
  { month: "202501", values: { "BIG HiOP": 0.02, OTHER: 0.01 } },
  { month: "202502", values: { "BIG HiOP": -0.01, OTHER: 0.005 } }
]);

const factorFixture = `Header\n,Mkt-RF,SMB,HML,RF\n202501, 2.00, 1.00, -1.00, 0.25\n\nAnnual`;
assert.deepEqual(parseFactorCsv(factorFixture), [
  { month: "202501", values: { "Mkt-RF": 0.02, SMB: 0.01, HML: -0.01, RF: 0.0025 } }
]);

const dragged = applyAnnualDrag(new Map([["202501", 0.01]]), 1).get("202501");
assert.ok(dragged < 0.01 && dragged > 0.009, "구현비용 월 차감이 잘못됐습니다.");
const turnoverAdjusted = applyImplementationCosts(
  new Map([["202501", 0.01]]),
  1,
  new Map([["202501", 0.5]]),
  0.2
).get("202501");
assert.ok(turnoverAdjusted < dragged, "팩터 교체 회전율 비용이 차감되지 않았습니다.");

const metricFixture = calculateMetrics([
  { month: "202501", return: 0.1, rf: 0 },
  { month: "202502", return: -0.2, rf: 0 }
]);
assert.equal(metricFixture.endingEquity, 88_000);
assert.equal(metricFixture.maxDrawdownPct, 20);

const months = [...Array.from({ length: 12 }, (_, index) => `2024${String(index + 1).padStart(2, "0")}`), "202501"];
const dynamicSleeves = {
  momentum: new Map(months.map((month, index) => [month, index === 12 ? -0.9 : 0.03])),
  profitability: new Map(months.map((month, index) => [month, index === 12 ? -0.8 : 0.02])),
  value: new Map(months.map((month, index) => [month, index === 12 ? 4 : -0.01])),
  investment: new Map(months.map((month) => [month, 0]))
};
assert.deepEqual(
  [...selectDynamicFactorWeights(dynamicSleeves, months, 12).keys()],
  ["momentum", "profitability"],
  "동적 팩터 선택이 현재 월의 미래 수익률을 참조했습니다."
);

const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
assert.equal(result.candidates.length, CANDIDATES.length, "후보 수가 코드와 결과에서 다릅니다.");
assert.equal(result.scenarios.base.candidates.length, CANDIDATES.length);
assert.equal(result.scenarios.stress.candidates.length, CANDIDATES.length);
assert.equal(result.scenarios.longHistory.candidates.length, CANDIDATES.length);
assert.equal(result.methodology.modernComparison.to, CONFIG.modernEndMonth);
assert.equal(result.dataDiagnostics.missingModernMonths.length, 0, "현대 비교 구간에 누락 월이 있습니다.");
assert.equal(result.dataDiagnostics.missingLongHistoryMonths.length, 0, "장기 진단 구간에 누락 월이 있습니다.");

for (const source of Object.values(result.dataDiagnostics.sources)) {
  assert.match(source.sha256, /^[a-f0-9]{64}$/, "원자료 SHA-256이 잘못됐습니다.");
  assert.ok(source.monthlyRows >= 300, "공식 원자료의 월별 행이 부족합니다.");
}

const spySanity = result.dataDiagnostics.spy.benchmarkSanity;
const expectedSpyEnding = (CONFIG.initialCapital * spySanity.finalClose) / spySanity.initialClose;
assert.ok(
  Math.abs(expectedSpyEnding - result.scenarios.base.benchmark.overall.endingEquity) < 2,
  "SPY 월수익률 복리와 단순 수정종가 비율이 일치하지 않습니다."
);

for (const candidate of result.scenarios.base.candidates) {
  const stressed = result.scenarios.stress.candidates.find((item) => item.id === candidate.id);
  assert.ok(stressed, `${candidate.id} 스트레스 결과가 없습니다.`);
  assert.ok(
    stressed.overall.endingEquity <= candidate.overall.endingEquity,
    `${candidate.id}는 비용을 높였는데 최종자산이 증가했습니다.`
  );
  for (const key of ["endingEquity", "cagrPct", "maxDrawdownPct", "annualizedVolatilityPct"]) {
    assert.ok(Number.isFinite(candidate.overall[key]), `${candidate.id}.${key}가 유한한 숫자가 아닙니다.`);
  }
  assert.equal(
    candidate.relativeToBenchmark.rollingFiveYearWindows,
    result.methodology.modernComparison.months - CONFIG.rollingWindowMonths + 1,
    `${candidate.id}의 5년 이동창 개수가 잘못됐습니다.`
  );
  assert.ok(Number.isFinite(candidate.relativeToBenchmark.activeReturnTStat), `${candidate.id}의 활성수익 t값이 없습니다.`);
  const weightTotal = Object.values(candidate.averageWeightsPct).reduce((total, weight) => total + weight, 0);
  assert.ok(Math.abs(weightTotal - 100) < 0.02, `${candidate.id}의 평균 비중 합계가 100%가 아닙니다.`);
  assert.ok(Number.isFinite(candidate.annualizedSleeveTurnoverPct), `${candidate.id}의 팩터 회전율이 없습니다.`);
}

const selectedIds = result.selection.rows.filter((row) => row.passed).map((row) => row.id);
assert.deepEqual(selectedIds, result.selection.survivors, "합격 판정과 생존 후보 목록이 다릅니다.");
assert.deepEqual(
  selectedIds,
  ["big_momentum", "quality_value_momentum", "balanced_four_factor", "dynamic_factor_top2"],
  "고정된 최종 데이터에서 생존 후보가 예기치 않게 바뀌었습니다."
);
assert.deepEqual(
  [...result.selection.survivors, ...result.selection.rejected].sort(),
  CANDIDATES.map((candidate) => candidate.id).sort(),
  "선별 결과에서 누락되거나 중복된 후보가 있습니다."
);

process.stdout.write("기관식 멀티팩터 백테스트 검증 통과\n");
