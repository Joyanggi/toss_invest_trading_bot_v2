#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(os.tmpdir(), "toss-invest-v2-benchmark-cache");

const CONFIG = Object.freeze({
  initialCapital: 100_000,
  startDate: "2008-07-01",
  endDate: "2026-07-13",
  costPerSide: 0.001,
  doubleCostPerSide: 0.002,
  rollingWindowDays: 252 * 5,
  selection: {
    minimumOverallExcessCagrPct: 1,
    minimumSegmentExcessCagrPct: 0,
    minimumDoubleCostExcessCagrPct: 0,
    minimumRollingFiveYearBeatRatePct: 60,
    maximumDrawdownPenaltyPct: 5
  },
  segments: [
    { id: "development", start: "2008-07-01", end: "2013-12-31" },
    { id: "validation", start: "2014-01-01", end: "2019-12-31" },
    { id: "holdout", start: "2020-01-01", end: "9999-12-31" }
  ]
});

const SECTOR_SYMBOLS = Object.freeze(["XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY"]);
const STYLE_SYMBOLS = Object.freeze(["SPY", "QQQ", "IWM", "MDY", "IWD", "IWF"]);
const RISK_ON_SYMBOLS = Object.freeze(["SPY", "QQQ", "IWM"]);
const DEFENSIVE_SYMBOLS = Object.freeze(["IEF", "GLD", "BIL"]);
const REQUIRED_SYMBOLS = Object.freeze(
  [...new Set(["SPY", "BIL", "SSO", ...SECTOR_SYMBOLS, ...STYLE_SYMBOLS, ...DEFENSIVE_SYMBOLS])].sort()
);
const EQUITY_SYMBOLS = new Set(["SPY", "SSO", ...SECTOR_SYMBOLS, ...STYLE_SYMBOLS]);

const BENCHMARK = Object.freeze({
  id: "spy_buy_hold",
  label: "SPY 100% 매수보유",
  description: "배당이 반영된 SPY를 첫 거래일부터 계속 보유",
  allocate() {
    return new Map([["SPY", 1]]);
  }
});

const CANDIDATES = Object.freeze([
  {
    id: "sector_momentum_top3",
    label: "9개 섹터 모멘텀 상위 3개",
    description: "12-1개월과 6-1개월 상대 모멘텀 상위 섹터 3개를 동일 비중으로 보유하되 BIL보다 약한 자리는 BIL로 대체",
    allocate(context, date) {
      return allocateRanked(context, date, SECTOR_SYMBOLS, 3, { trendFilter: false });
    }
  },
  {
    id: "sector_momentum_trend",
    label: "섹터 모멘텀 + 200일 추세",
    description: "상위 섹터 3개 중 BIL보다 강하고 200일 이동평균 위에 있는 섹터만 보유하고 나머지는 BIL로 대체",
    allocate(context, date) {
      return allocateRanked(context, date, SECTOR_SYMBOLS, 3, { trendFilter: true });
    }
  },
  {
    id: "style_momentum_top2",
    label: "미국 주식 스타일 모멘텀 상위 2개",
    description: "SPY·QQQ·IWM·MDY·IWD·IWF 중 중기 모멘텀 상위 2개를 동일 비중으로 보유하되 BIL보다 약한 자리는 BIL로 대체",
    allocate(context, date) {
      return allocateRanked(context, date, STYLE_SYMBOLS, 2, { trendFilter: false });
    }
  },
  {
    id: "dual_momentum",
    label: "주식·채권·금 듀얼 모멘텀",
    description: "주식 대표 ETF 중 절대·상대 모멘텀 1위를 보유하고, 주식 모멘텀이 현금보다 낮으면 채권·금·BIL 중 1위로 이동",
    allocate(context, date) {
      return allocateDualMomentum(context, date);
    }
  },
  {
    id: "spy_trend_volatility",
    label: "SPY 추세·변동성 관리",
    description: "SPY가 200일선 위일 때 63일 변동성으로 0.75~1.5배 노출을 정하고, 아래일 때 BIL을 보유",
    allocate(context, date) {
      return allocateTrendVolatility(context, date);
    }
  },
  {
    id: "sector_trend_vol_ensemble",
    label: "섹터 추세 + 변동성 관리 앙상블",
    description: "섹터 모멘텀·추세 포트폴리오와 SPY 추세·변동성 포트폴리오를 절반씩 결합",
    allocate(context, date) {
      return combineWeights(
        allocateRanked(context, date, SECTOR_SYMBOLS, 3, { trendFilter: true }),
        allocateTrendVolatility(context, date),
        0.5
      );
    }
  }
]);

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (outputIndex >= 0 && !outputPath) throw new Error("--output 뒤에 파일 경로가 필요합니다.");

  const data = new Map();
  const failures = [];
  await fs.mkdir(CACHE_DIR, { recursive: true });
  for (const [index, symbol] of REQUIRED_SYMBOLS.entries()) {
    try {
      const candles = await loadCandles(symbol);
      data.set(symbol, addIndicators(candles));
    } catch (error) {
      failures.push({ symbol, error: error.message });
    }
    process.stderr.write(`ETF 가격 데이터 ${index + 1}/${REQUIRED_SYMBOLS.length}\n`);
  }
  if (failures.length) throw new Error(`가격 데이터 수집 실패: ${JSON.stringify(failures)}`);

  const context = createContext(data);
  const base = runScenario(context, CONFIG.costPerSide);
  const doubleCost = runScenario(context, CONFIG.doubleCostPerSide);
  const selection = evaluateCandidates(base, doubleCost);
  const result = {
    generatedAt: new Date().toISOString(),
    methodology: {
      objective: "거래비용 차감 후 SPY 100% 매수보유보다 높은 장기 복리수익",
      universe: {
        sectors: SECTOR_SYMBOLS,
        styles: STYLE_SYMBOLS,
        defensive: DEFENSIVE_SYMBOLS,
        leverageProxy: "SSO"
      },
      biasNotes: {
        individualConstituentSurvivorship: "고정 ETF를 사용하므로 현재 개별 종목 구성원을 과거에 투영하는 편향은 없음",
        etfSelectionBias: "현재까지 생존했고 널리 알려진 ETF를 사후 선택한 편향은 남아 있음"
      },
      priceSource: "Yahoo Finance adjusted daily OHLC",
      dividendsAndFundExpenses: "수정주가에 반영",
      execution: "월말 종가로 신호를 계산하고 다음 거래일 수정 시가에 리밸런싱",
      rebalance: "월 1회",
      initialCapital: CONFIG.initialCapital,
      startDate: CONFIG.startDate,
      endDate: CONFIG.endDate,
      segments: CONFIG.segments,
      omitted: ["세금", "환율", "호가 스프레드의 시간대별 차이", "대차·공매도", "실제 Toss 주문 제약"]
    },
    selectionPolicy: {
      ...CONFIG.selection,
      segmentRule: "개발·검증·홀드아웃의 SPY 대비 CAGR이 모두 0% 초과",
      note: "결과 확인 전에 고정했으며 이번 결과를 보고 임계값이나 전략 파라미터를 변경하지 않음"
    },
    dataDiagnostics: {
      requestedSymbols: REQUIRED_SYMBOLS.length,
      loadedSymbols: data.size,
      failures,
      firstAvailableBySymbol: Object.fromEntries(
        [...data.entries()].map(([symbol, candles]) => [symbol, candles[0]?.date ?? null])
      ),
      simulationFirstDate: context.dates[0],
      simulationLastDate: context.dates.at(-1),
      tradingDays: context.dates.length,
      benchmarkPriceSanity: {
        firstOpen: context.get("SPY", context.dates[0]).open,
        lastClose: context.get("SPY", context.dates.at(-1)).close
      }
    },
    candidates: CANDIDATES.map(({ id, label, description }) => ({ id, label, description })),
    scenarios: { base, doubleCost },
    selection
  };

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    const absolute = path.resolve(outputPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, serialized);
    process.stdout.write(`${absolute}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

function runScenario(context, costPerSide) {
  const benchmarkRun = simulatePortfolio(BENCHMARK, context, costPerSide);
  const benchmark = summarizeRun(benchmarkRun, null, context, costPerSide);
  const candidates = CANDIDATES.map((strategy) => {
    const run = simulatePortfolio(strategy, context, costPerSide);
    return summarizeRun(run, benchmarkRun, context, costPerSide, strategy);
  });
  return {
    costPerSidePct: costPerSide * 100,
    benchmark,
    candidates
  };
}

function simulatePortfolio(strategy, context, costPerSide) {
  const state = {
    cash: CONFIG.initialCapital,
    positions: new Map(),
    transactionCosts: 0,
    tradedNotional: 0,
    rebalances: 0
  };
  const curve = [];
  const allocationTotals = new Map();
  const firstCalendarIndex = context.allDates.indexOf(context.dates[0]);
  const priorDate = context.allDates[firstCalendarIndex - 1];
  if (!priorDate) throw new Error("시뮬레이션 시작일 이전 신호 날짜가 없습니다.");
  let pending = { signalDate: priorDate, weights: normalizeWeights(strategy.allocate(context, priorDate)) };

  for (let index = 0; index < context.dates.length; index += 1) {
    const date = context.dates[index];
    if (pending) {
      rebalanceAtOpen(state, pending.weights, context, date, costPerSide);
      for (const [symbol, weight] of pending.weights.entries()) {
        allocationTotals.set(symbol, (allocationTotals.get(symbol) ?? 0) + weight);
      }
      pending = null;
    }

    const equity = portfolioValue(state, context, date, "close");
    const equityExposure = positionValue(state, context, date, "close", (symbol) => EQUITY_SYMBOLS.has(symbol));
    curve.push({
      date,
      equity,
      equityExposurePct: equity > 0 ? (equityExposure / equity) * 100 : 0
    });

    const nextDate = context.dates[index + 1];
    if (nextDate && date.slice(0, 7) !== nextDate.slice(0, 7)) {
      pending = { signalDate: date, weights: normalizeWeights(strategy.allocate(context, date)) };
    }
  }

  const allocationDenominator = Math.max(state.rebalances, 1);
  return {
    id: strategy.id,
    label: strategy.label,
    description: strategy.description,
    curve,
    state,
    averageTargetWeights: Object.fromEntries(
      [...allocationTotals.entries()]
        .map(([symbol, total]) => [symbol, round((total / allocationDenominator) * 100, 2)])
        .sort((a, b) => b[1] - a[1])
    )
  };
}

function rebalanceAtOpen(state, rawWeights, context, date, costPerSide) {
  const weights = normalizeWeights(rawWeights);
  const currentValues = new Map();
  for (const [symbol, quantity] of state.positions.entries()) {
    const candle = context.get(symbol, date);
    if (!candle?.open) throw new Error(`${date} ${symbol} 시가가 없습니다.`);
    currentValues.set(symbol, quantity * candle.open);
  }
  const equityBeforeCost = state.cash + sum([...currentValues.values()]);
  let investable = equityBeforeCost;
  let transactionCost = 0;
  let tradedNotional = 0;
  let targetValues = new Map();

  for (let iteration = 0; iteration < 8; iteration += 1) {
    targetValues = new Map([...weights.entries()].map(([symbol, weight]) => [symbol, investable * weight]));
    const symbols = new Set([...currentValues.keys(), ...targetValues.keys()]);
    tradedNotional = sum(
      [...symbols].map((symbol) => Math.abs((targetValues.get(symbol) ?? 0) - (currentValues.get(symbol) ?? 0)))
    );
    transactionCost = tradedNotional * costPerSide;
    const nextInvestable = equityBeforeCost - transactionCost;
    if (Math.abs(nextInvestable - investable) < 0.000001) break;
    investable = nextInvestable;
  }

  const positions = new Map();
  for (const [symbol, targetValue] of targetValues.entries()) {
    const candle = context.get(symbol, date);
    if (!candle?.open) throw new Error(`${date} ${symbol} 시가가 없습니다.`);
    if (targetValue > 0) positions.set(symbol, targetValue / candle.open);
  }
  state.positions = positions;
  state.cash = equityBeforeCost - sum([...targetValues.values()]) - transactionCost;
  if (state.cash < -0.01) throw new Error(`${date} 리밸런싱 후 현금이 음수입니다: ${state.cash}`);
  state.cash = Math.max(0, state.cash);
  state.transactionCosts += transactionCost;
  state.tradedNotional += tradedNotional;
  state.rebalances += 1;
}

function summarizeRun(run, benchmarkRun, context, costPerSide, strategy = BENCHMARK) {
  const overall = calculateMetrics(run.curve, CONFIG.initialCapital);
  const segments = Object.fromEntries(
    CONFIG.segments.map((segment) => {
      const segmentCurve = run.curve.filter((point) => point.date >= segment.start && point.date <= segment.end);
      return [segment.id, calculateMetrics(segmentCurve, segmentCurve[0]?.equity ?? CONFIG.initialCapital)];
    })
  );
  const years = Math.max(daysBetween(run.curve[0].date, run.curve.at(-1).date) / 365.25, 1 / 365.25);
  const averageEquity = mean(run.curve.map((point) => point.equity));
  const summary = {
    id: strategy.id,
    label: strategy.label,
    description: strategy.description,
    overall: {
      ...overall,
      rebalances: run.state.rebalances,
      transactionCosts: round(run.state.transactionCosts, 2),
      annualOneWayTurnoverPct: round(((run.state.tradedNotional * 0.5) / averageEquity / years) * 100, 2),
      averageEquityExposurePct: round(mean(run.curve.map((point) => point.equityExposurePct)), 2)
    },
    segments,
    averageTargetWeightsPct: run.averageTargetWeights,
    costPerSidePct: costPerSide * 100
  };

  if (benchmarkRun) {
    const benchmarkOverall = calculateMetrics(benchmarkRun.curve, CONFIG.initialCapital);
    summary.relativeToSpy = compareCurves(run.curve, benchmarkRun.curve, overall, benchmarkOverall, context);
    for (const segment of CONFIG.segments) {
      summary.segments[segment.id].excessCagrPct = round(
        summary.segments[segment.id].cagrPct -
          calculateMetrics(
            benchmarkRun.curve.filter((point) => point.date >= segment.start && point.date <= segment.end),
            benchmarkRun.curve.find((point) => point.date >= segment.start)?.equity ?? CONFIG.initialCapital
          ).cagrPct,
        2
      );
    }
  }
  return summary;
}

function compareCurves(candidateCurve, benchmarkCurve, candidateMetrics, benchmarkMetrics, context) {
  const activeReturns = [];
  for (let index = 1; index < candidateCurve.length; index += 1) {
    const candidateReturn = candidateCurve[index].equity / candidateCurve[index - 1].equity - 1;
    const benchmarkReturn = benchmarkCurve[index].equity / benchmarkCurve[index - 1].equity - 1;
    activeReturns.push(candidateReturn - benchmarkReturn);
  }
  const trackingError = standardDeviation(activeReturns) * Math.sqrt(252);
  const rolling = calculateRollingBeatRate(candidateCurve, benchmarkCurve, context.monthEndDates);
  return {
    excessCagrPct: round(candidateMetrics.cagrPct - benchmarkMetrics.cagrPct, 2),
    maxDrawdownDifferencePct: round(candidateMetrics.maxDrawdownPct - benchmarkMetrics.maxDrawdownPct, 2),
    trackingErrorPct: round(trackingError * 100, 2),
    informationRatio: trackingError > 0 ? round((mean(activeReturns) * 252) / trackingError, 3) : null,
    rollingFiveYearBeatRatePct: rolling.beatRatePct,
    rollingFiveYearWindows: rolling.windows,
    worstRollingFiveYearExcessPct: rolling.worstExcessPct,
    bestRollingFiveYearExcessPct: rolling.bestExcessPct
  };
}

function evaluateCandidates(base, doubleCost) {
  const rows = base.candidates.map((candidate) => {
    const expensive = doubleCost.candidates.find((item) => item.id === candidate.id);
    const checks = {
      overallExcessCagr:
        candidate.relativeToSpy.excessCagrPct >= CONFIG.selection.minimumOverallExcessCagrPct,
      positiveDevelopment: candidate.segments.development.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      positiveValidation: candidate.segments.validation.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      positiveHoldout: candidate.segments.holdout.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      doubleCostExcess:
        expensive.relativeToSpy.excessCagrPct > CONFIG.selection.minimumDoubleCostExcessCagrPct,
      rollingFiveYearConsistency:
        candidate.relativeToSpy.rollingFiveYearBeatRatePct >=
        CONFIG.selection.minimumRollingFiveYearBeatRatePct,
      drawdownControl:
        candidate.relativeToSpy.maxDrawdownDifferencePct <= CONFIG.selection.maximumDrawdownPenaltyPct
    };
    return {
      id: candidate.id,
      label: candidate.label,
      passed: Object.values(checks).every(Boolean),
      checks,
      evidence: {
        cagrPct: candidate.overall.cagrPct,
        spyCagrPct: base.benchmark.overall.cagrPct,
        excessCagrPct: candidate.relativeToSpy.excessCagrPct,
        validationExcessCagrPct: candidate.segments.validation.excessCagrPct,
        holdoutExcessCagrPct: candidate.segments.holdout.excessCagrPct,
        doubleCostExcessCagrPct: expensive.relativeToSpy.excessCagrPct,
        maxDrawdownPct: candidate.overall.maxDrawdownPct,
        spyMaxDrawdownPct: base.benchmark.overall.maxDrawdownPct,
        rollingFiveYearBeatRatePct: candidate.relativeToSpy.rollingFiveYearBeatRatePct
      }
    };
  });
  return {
    survivors: rows.filter((row) => row.passed).map((row) => row.id),
    rejected: rows.filter((row) => !row.passed).map((row) => row.id),
    rows
  };
}

function allocateRanked(context, date, symbols, count, { trendFilter }) {
  const bil = context.get("BIL", date);
  const ranked = symbols
    .map((symbol) => ({ symbol, candle: context.get(symbol, date) }))
    .filter((item) => hasMomentum(item.candle))
    .sort((a, b) => momentumScore(b.candle) - momentumScore(a.candle))
    .slice(0, count);
  if (ranked.length !== count || !bil) return new Map([["BIL", 1]]);
  const weights = new Map();
  for (const { symbol, candle } of ranked) {
    const passesAbsoluteMomentum = candle.mom252x21 > (bil.mom252x21 ?? 0);
    const passesTrend = !trendFilter || candle.close > candle.sma200;
    addWeight(weights, passesAbsoluteMomentum && passesTrend ? symbol : "BIL", 1 / count);
  }
  return normalizeWeights(weights);
}

function allocateDualMomentum(context, date) {
  const bil = context.get("BIL", date);
  const riskOn = rankByMomentum(context, date, RISK_ON_SYMBOLS)[0];
  if (riskOn && bil && riskOn.candle.mom252x21 > (bil.mom252x21 ?? 0)) {
    return new Map([[riskOn.symbol, 1]]);
  }
  const defensive = rankByMomentum(context, date, DEFENSIVE_SYMBOLS)[0];
  return new Map([[defensive?.symbol ?? "BIL", 1]]);
}

function allocateTrendVolatility(context, date) {
  const spy = context.get("SPY", date);
  if (!spy?.sma200 || !spy?.annualizedVol63 || spy.close <= spy.sma200) return new Map([["BIL", 1]]);
  const targetExposure = clamp(0.18 / spy.annualizedVol63, 0.75, 1.5);
  if (targetExposure <= 1) {
    return normalizeWeights(
      new Map([
        ["SPY", targetExposure],
        ["BIL", 1 - targetExposure]
      ])
    );
  }
  return normalizeWeights(
    new Map([
      ["SPY", 2 - targetExposure],
      ["SSO", targetExposure - 1]
    ])
  );
}

function combineWeights(first, second, firstWeight = 0.5) {
  const output = new Map();
  for (const [symbol, weight] of normalizeWeights(first).entries()) addWeight(output, symbol, weight * firstWeight);
  for (const [symbol, weight] of normalizeWeights(second).entries()) {
    addWeight(output, symbol, weight * (1 - firstWeight));
  }
  return normalizeWeights(output);
}

function rankByMomentum(context, date, symbols) {
  return symbols
    .map((symbol) => ({ symbol, candle: context.get(symbol, date) }))
    .filter((item) => hasMomentum(item.candle))
    .sort((a, b) => momentumScore(b.candle) - momentumScore(a.candle));
}

function hasMomentum(candle) {
  return Boolean(candle && Number.isFinite(candle.mom252x21) && Number.isFinite(candle.mom126x21));
}

function momentumScore(candle) {
  return (candle.mom252x21 + candle.mom126x21) / 2;
}

function normalizeWeights(rawWeights) {
  const entries = [...(rawWeights instanceof Map ? rawWeights : new Map(Object.entries(rawWeights ?? {}))).entries()]
    .map(([symbol, weight]) => [symbol, Number(weight)])
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  const total = sum(entries.map(([, weight]) => weight));
  if (total <= 0) return new Map([["BIL", 1]]);
  return new Map(entries.map(([symbol, weight]) => [symbol, weight / total]));
}

function addWeight(weights, symbol, amount) {
  weights.set(symbol, (weights.get(symbol) ?? 0) + amount);
}

function createContext(data) {
  const bySymbolDate = new Map(
    [...data.entries()].map(([symbol, candles]) => [symbol, new Map(candles.map((candle) => [candle.date, candle]))])
  );
  const allDates = data.get("SPY").map((candle) => candle.date);
  const dates = allDates.filter((date) => date >= CONFIG.startDate && date <= CONFIG.endDate);
  if (dates.length < 252 * 10) throw new Error("시뮬레이션 기간이 10년보다 짧습니다.");
  const monthEndDates = new Set(
    dates.filter((date, index) => !dates[index + 1] || date.slice(0, 7) !== dates[index + 1].slice(0, 7))
  );
  return {
    data,
    bySymbolDate,
    allDates,
    dates,
    monthEndDates,
    get(symbol, date) {
      return bySymbolDate.get(symbol)?.get(date) ?? null;
    }
  };
}

function addIndicators(candles) {
  const closes = candles.map((candle) => candle.close);
  const sma200 = rollingMean(closes, 200);
  const annualizedVol63 = rollingAnnualizedVolatility(closes, 63);
  return candles.map((candle, index) => ({
    ...candle,
    sma200: sma200[index],
    annualizedVol63: annualizedVol63[index],
    mom252x21: index >= 252 ? closes[index - 21] / closes[index - 252] - 1 : null,
    mom126x21: index >= 126 ? closes[index - 21] / closes[index - 126] - 1 : null
  }));
}

function rollingMean(values, period) {
  const output = Array(values.length).fill(null);
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index];
    if (index >= period) total -= values[index - period];
    if (index >= period - 1) output[index] = total / period;
  }
  return output;
}

function rollingAnnualizedVolatility(values, period) {
  const returns = values.map((value, index) => (index ? Math.log(value / values[index - 1]) : null));
  const output = Array(values.length).fill(null);
  for (let index = period; index < values.length; index += 1) {
    output[index] = standardDeviation(returns.slice(index - period + 1, index + 1)) * Math.sqrt(252);
  }
  return output;
}

function calculateMetrics(curve, initialValue) {
  if (!curve.length) return emptyMetrics();
  const firstDate = curve[0].date;
  const lastDate = curve.at(-1).date;
  const endingEquity = curve.at(-1).equity;
  const years = Math.max(daysBetween(firstDate, lastDate) / 365.25, 1 / 365.25);
  const returns = [];
  let previous = initialValue;
  for (const point of curve) {
    returns.push(point.equity / previous - 1);
    previous = point.equity;
  }
  const annualizedVolatility = standardDeviation(returns) * Math.sqrt(252);
  const cagr = endingEquity > 0 ? (endingEquity / initialValue) ** (1 / years) - 1 : -1;
  const maxDrawdown = calculateMaxDrawdown([initialValue, ...curve.map((point) => point.equity)]);
  return {
    from: firstDate,
    to: lastDate,
    endingEquity: round(endingEquity, 2),
    totalReturnPct: round((endingEquity / initialValue - 1) * 100, 2),
    cagrPct: round(cagr * 100, 2),
    maxDrawdownPct: round(maxDrawdown * 100, 2),
    annualizedVolatilityPct: round(annualizedVolatility * 100, 2),
    sharpeZeroRate: annualizedVolatility > 0 ? round((mean(returns) * 252) / annualizedVolatility, 3) : null,
    calmar: maxDrawdown > 0 ? round(cagr / maxDrawdown, 3) : null
  };
}

function calculateRollingBeatRate(candidateCurve, benchmarkCurve, monthEndDates) {
  const outcomes = [];
  for (let index = CONFIG.rollingWindowDays; index < candidateCurve.length; index += 1) {
    if (!monthEndDates.has(candidateCurve[index].date)) continue;
    const candidateReturn = candidateCurve[index].equity / candidateCurve[index - CONFIG.rollingWindowDays].equity - 1;
    const benchmarkReturn = benchmarkCurve[index].equity / benchmarkCurve[index - CONFIG.rollingWindowDays].equity - 1;
    outcomes.push((candidateReturn - benchmarkReturn) * 100);
  }
  return {
    windows: outcomes.length,
    beatRatePct: outcomes.length ? round((outcomes.filter((value) => value > 0).length / outcomes.length) * 100, 2) : 0,
    worstExcessPct: outcomes.length ? round(Math.min(...outcomes), 2) : null,
    bestExcessPct: outcomes.length ? round(Math.max(...outcomes), 2) : null
  };
}

function calculateMaxDrawdown(values) {
  let peak = values[0] ?? 0;
  let maximum = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) maximum = Math.max(maximum, (peak - value) / peak);
  }
  return maximum;
}

function portfolioValue(state, context, date, field) {
  return state.cash + positionValue(state, context, date, field, () => true);
}

function positionValue(state, context, date, field, include) {
  let total = 0;
  for (const [symbol, quantity] of state.positions.entries()) {
    if (!include(symbol)) continue;
    const price = context.get(symbol, date)?.[field];
    if (!price) throw new Error(`${date} ${symbol} ${field} 가격이 없습니다.`);
    total += quantity * price;
  }
  return total;
}

async function loadCandles(symbol) {
  const cachePath = path.join(CACHE_DIR, `${symbol}-daily-max.json`);
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (Date.now() - new Date(cached.createdAt).getTime() < 6 * 60 * 60_000) return cached.candles;
  } catch {}

  const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period1", "0");
  url.searchParams.set("period2", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  url.searchParams.set("includeAdjustedClose", "true");
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
        signal: AbortSignal.timeout(20_000)
      });
      const payload = await response.json();
      if (!response.ok || payload.chart?.error) {
        throw new Error(payload.chart?.error?.description || `HTTP ${response.status}`);
      }
      const result = payload.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0] ?? {};
      const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
      const candles = (result?.timestamp ?? [])
        .map((timestamp, index) => {
          const adjustedClose = Number(adjusted[index] ?? quote.close?.[index]);
          const rawClose = Number(quote.close?.[index]);
          const adjustment = rawClose > 0 && adjustedClose > 0 ? adjustedClose / rawClose : 1;
          return {
            date: new Date(timestamp * 1000).toISOString().slice(0, 10),
            open: Number(quote.open?.[index]) * adjustment,
            high: Number(quote.high?.[index]) * adjustment,
            low: Number(quote.low?.[index]) * adjustment,
            close: adjustedClose,
            volume: Number(quote.volume?.[index] ?? 0)
          };
        })
        .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every((value) => value > 0));
      if (candles.length < 1_000) throw new Error(`일봉 데이터가 부족합니다: ${candles.length}개`);
      const uniqueMonths = new Set(candles.map((candle) => candle.date.slice(0, 7))).size;
      if (candles.length / uniqueMonths < 10) throw new Error("일봉이 아닌 축약 데이터가 반환됐습니다.");
      await fs.writeFile(cachePath, JSON.stringify({ createdAt: new Date().toISOString(), candles }));
      return candles;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

function emptyMetrics() {
  return {
    from: null,
    to: null,
    endingEquity: null,
    totalReturnPct: null,
    cagrPct: null,
    maxDrawdownPct: null,
    annualizedVolatilityPct: null,
    sharpeZeroRate: null,
    calmar: null
  };
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(sum(values.map((value) => (value - average) ** 2)) / values.length);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function daysBetween(start, end) {
  return (new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86_400_000;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  BENCHMARK,
  CANDIDATES,
  CONFIG,
  addIndicators,
  calculateMaxDrawdown,
  combineWeights,
  normalizeWeights,
  rollingMean
};
