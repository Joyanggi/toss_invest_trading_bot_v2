#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_STRATEGY_IDS,
  addIndicators,
  calculateMaxDrawdown,
  rollingPreviousExtreme
} from "./v2-strategy-backtest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(HERE, "results");

const closes = [
  100, 101, 99, 102, 103, 100, 98, 99, 104, 105, 103, 106, 108, 107, 109, 110, 108, 111, 112, 110,
  113, 115
];
const candles = closes.map((close, index) => ({
  date: `2026-01-${String(index + 1).padStart(2, "0")}`,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1_000
}));
const enriched = addIndicators(candles);
const expectedRsi14 = 68.57715949032446;
assert.ok(
  Math.abs(enriched.at(-1).rsi14 - expectedRsi14) < 1e-10,
  "Wilder RSI 기준값이 달라졌습니다."
);

const extremes = rollingPreviousExtreme([1, 3, 2, 10, 4], 3, Math.max);
assert.equal(extremes[3], 3, "Donchian 상단에 당일 값이 포함됐습니다.");
assert.equal(extremes[4], 10, "Donchian 이전 구간 계산이 잘못됐습니다.");
assert.equal(calculateMaxDrawdown([100, 120, 90, 110]), 0.25, "최대낙폭 계산이 잘못됐습니다.");

const base = await readResult("v2-strategy-backtest-2026-07-15.json");
const doubleCost = await readResult("v2-strategy-backtest-2026-07-15-double-cost.json");
const longHistory = await readResult("v2-strategy-backtest-2026-07-15-long-history.json");
const sensitivity = await readResult("v2-strategy-sensitivity-2026-07-15.json");

assert.equal(base.strategies.length, 6, "최초 비교 후보 수가 6개가 아닙니다.");
assert.equal(base.dataDiagnostics.failures.length, 0, "가격 수집 실패가 있습니다.");
assert.deepEqual(
  longHistory.dataDiagnostics.insufficientHistorySymbols.sort(),
  ["GEV", "HONA", "PLTR", "UBER"],
  "장기 이력 민감도 제외 종목이 예상과 다릅니다."
);

for (const strategy of base.strategies) {
  assertFiniteMetrics(strategy.overall, strategy.id);
  const expensive = doubleCost.strategies.find((item) => item.id === strategy.id);
  assert.ok(expensive, `${strategy.id} 비용 민감도 결과가 없습니다.`);
  assert.ok(
    expensive.overall.endingEquity <= strategy.overall.endingEquity + 0.01,
    `${strategy.id}는 거래비용을 높였는데 최종자산이 증가했습니다.`
  );
}

const screeningScenarios = [base, doubleCost, longHistory];
const segmentIds = ["development", "validation", "holdout"];
const screenedStrategyIds = base.strategies
  .filter((strategy) =>
    screeningScenarios.every((scenario) => {
      const candidate = scenario.strategies.find((item) => item.id === strategy.id);
      return (
        candidate?.overall.cagrPct > 0 &&
        segmentIds.every((segmentId) => candidate.segments[segmentId]?.cagrPct > 0)
      );
    })
  )
  .map((strategy) => strategy.id);
assert.deepEqual(
  screenedStrategyIds,
  ACTIVE_STRATEGY_IDS,
  "음수 수익 탈락 기준과 활성 후보 목록이 일치하지 않습니다."
);
assert.deepEqual(
  base.strategies.filter((strategy) => !screenedStrategyIds.includes(strategy.id)).map((strategy) => strategy.id),
  ["rsi2_pullback", "bollinger_reentry"],
  "탈락 후보 목록이 예상과 다릅니다."
);

const coreEma = base.strategies.find((item) => item.id === "ema_trend");
const sensitivityEma = sensitivity.strategies.find((item) => item.id === "ema_20_100");
assert.deepEqual(coreEma.overall, sensitivityEma.overall, "핵심 EMA20/100과 민감도 EMA20/100 결과가 다릅니다.");

process.stdout.write("V2 전략 백테스트 검증 통과\n");

async function readResult(filename) {
  return JSON.parse(await fs.readFile(path.join(resultsDir, filename), "utf8"));
}

function assertFiniteMetrics(metrics, id) {
  for (const key of ["endingEquity", "totalReturnPct", "cagrPct", "maxDrawdownPct", "averageExposurePct", "trades"]) {
    assert.ok(Number.isFinite(metrics[key]), `${id}.${key}가 유한한 숫자가 아닙니다.`);
  }
  assert.ok(metrics.endingEquity > 0, `${id} 최종자산이 0 이하입니다.`);
  assert.ok(metrics.maxDrawdownPct >= 0 && metrics.maxDrawdownPct <= 100, `${id} 최대낙폭 범위가 잘못됐습니다.`);
}
