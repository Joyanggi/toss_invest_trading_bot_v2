#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_DIR = path.join(os.tmpdir(), "toss-invest-v2-etf-factor-proxy-cache");

const CONFIG = Object.freeze({
  initialCapital: 100_000,
  endMonth: "202606",
  lookbackMonths: 12,
  rollingWindowMonths: 60,
  baseCostPerOneWayPct: 0.1,
  stressCostPerOneWayPct: 0.25,
  selection: {
    minimumOverallExcessCagrPct: 0.5,
    minimumSegmentExcessCagrPct: 0,
    minimumStressExcessCagrPct: 0,
    minimumRollingFiveYearBeatRatePct: 60,
    maximumDrawdownPenaltyPct: 5
  },
  segments: [
    { id: "development", start: "000000", end: "201812" },
    { id: "validation", start: "201901", end: "202212" },
    { id: "holdout", start: "202301", end: "999999" }
  ]
});

const PRIMARY_PROXIES = Object.freeze({
  momentum: Object.freeze({ symbol: "MTUM", label: "미국 모멘텀" }),
  profitability: Object.freeze({ symbol: "QUAL", label: "미국 품질" }),
  value: Object.freeze({ symbol: "VLUE", label: "미국 가치" })
});

const SECONDARY_PROXIES = Object.freeze({
  ...PRIMARY_PROXIES,
  capitalDisciplineApproximation: Object.freeze({
    symbol: "COWZ",
    label: "잉여현금흐름 근사",
    approximation: true
  })
});

const PRIMARY_CANDIDATES = Object.freeze([
  Object.freeze({
    id: "three_factor_equal",
    label: "3팩터 ETF 동일비중",
    type: "equal",
    description: "MTUM·QUAL·VLUE를 매월 1/3씩 리밸런싱"
  }),
  Object.freeze({
    id: "three_factor_top2",
    label: "3팩터 ETF 상위 2개",
    type: "top2",
    description: "직전 12개월 수익 상위 두 ETF를 다음 달 50:50 보유"
  })
]);

const SECONDARY_CANDIDATES = Object.freeze([
  Object.freeze({
    id: "four_proxy_equal",
    label: "4프록시 ETF 동일비중",
    type: "equal",
    description: "MTUM·QUAL·VLUE·COWZ를 매월 1/4씩 리밸런싱"
  }),
  Object.freeze({
    id: "four_proxy_top2",
    label: "4프록시 ETF 상위 2개",
    type: "top2",
    description: "직전 12개월 수익 상위 두 ETF를 다음 달 50:50 보유"
  })
]);

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (outputIndex >= 0 && !outputPath) throw new Error("--output 뒤에 파일 경로가 필요합니다.");

  await fs.mkdir(CACHE_DIR, { recursive: true });
  const symbols = [...new Set([
    "SPY",
    ...Object.values(SECONDARY_PROXIES).map((proxy) => proxy.symbol)
  ])];
  const loaded = new Map();
  for (const [index, symbol] of symbols.entries()) {
    loaded.set(symbol, await loadMonthlyData(symbol));
    process.stderr.write(`ETF 프록시 가격 ${index + 1}/${symbols.length}\n`);
  }

  const primary = runResearchFamily({
    familyId: "primary_three_factor",
    proxies: PRIMARY_PROXIES,
    candidates: PRIMARY_CANDIDATES,
    loaded,
    applySelection: true
  });
  const secondary = runResearchFamily({
    familyId: "secondary_four_proxy",
    proxies: SECONDARY_PROXIES,
    candidates: SECONDARY_CANDIDATES,
    loaded,
    applySelection: false
  });

  const result = {
    generatedAt: new Date().toISOString(),
    methodology: {
      objective: "실제 거래 가능한 미국 ETF로 기관식 팩터 가설의 구현 가능성을 검증",
      benchmark: "SPY 수정주가 매수보유",
      primaryMapping: Object.fromEntries(
        Object.entries(PRIMARY_PROXIES).map(([factor, proxy]) => [factor, proxy.symbol])
      ),
      secondaryApproximation: {
        symbol: "COWZ",
        warning: "French의 보수적 투자 팩터가 아니라 잉여현금흐름·자본규율의 짧은 이력 근사치"
      },
      signalTiming: "직전 12개 완결 월 수익만 사용해 현재 월 시작 목표 비중 결정",
      execution: "월말 신호 후 다음 달 첫 거래일부터 목표 비중을 보유한 것으로 계산",
      costs: {
        basePerOneWayTurnoverPct: CONFIG.baseCostPerOneWayPct,
        stressPerOneWayTurnoverPct: CONFIG.stressCostPerOneWayPct,
        fundExpenses: "ETF 수정주가에 반영",
        firstPurchase: "SPY와 후보 모두 최초 100% 진입 비용 반영"
      },
      segments: CONFIG.segments,
      omitted: ["한국 세금", "원/달러 환율", "장중 스프레드 변화", "시장충격", "Toss 주문 제약"]
    },
    selectionPolicy: {
      ...CONFIG.selection,
      segmentRule: "개발·검증·홀드아웃 SPY 대비 CAGR이 모두 0% 초과",
      note: "ETF·후보·비용·임계값은 결과 확인 전에 고정"
    },
    dataDiagnostics: Object.fromEntries(
      [...loaded.entries()].map(([symbol, data]) => [symbol, {
        source: data.source,
        sha256: data.sha256,
        firstMonth: data.closes[0]?.month ?? null,
        lastMonth: data.closes.at(-1)?.month ?? null,
        months: data.closes.length
      }])
    ),
    primary,
    secondary
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

function runResearchFamily({ familyId, proxies, candidates, loaded, applySelection }) {
  const symbols = Object.values(proxies).map((proxy) => proxy.symbol);
  const returnMaps = Object.fromEntries(symbols.map((symbol) => [symbol, loaded.get(symbol).returns]));
  const allMonths = intersectMonths([loaded.get("SPY").returns, ...Object.values(returnMaps)])
    .filter((month) => month <= CONFIG.endMonth);
  if (allMonths.length <= CONFIG.lookbackMonths + 36) {
    throw new Error(`${familyId}의 공통 월수익 이력이 부족합니다: ${allMonths.length}개월`);
  }
  const simulationMonths = allMonths.slice(CONFIG.lookbackMonths);
  const benchmarkReturns = loaded.get("SPY").returns;
  const base = runScenario({
    candidates,
    symbols,
    returnMaps,
    allMonths,
    simulationMonths,
    benchmarkReturns,
    costPerOneWayPct: CONFIG.baseCostPerOneWayPct
  });
  const stress = runScenario({
    candidates,
    symbols,
    returnMaps,
    allMonths,
    simulationMonths,
    benchmarkReturns,
    costPerOneWayPct: CONFIG.stressCostPerOneWayPct
  });
  const selection = applySelection ? evaluateCandidates(base, stress) : null;
  return {
    familyId,
    role: applySelection ? "primary_selection" : "short_history_sensitivity_only",
    proxies: Object.fromEntries(
      Object.entries(proxies).map(([factor, proxy]) => [factor, { ...proxy }])
    ),
    commonReturnMonths: allMonths.length,
    warmupMonths: CONFIG.lookbackMonths,
    simulationFrom: simulationMonths[0],
    simulationTo: simulationMonths.at(-1),
    simulationMonths: simulationMonths.length,
    benchmarkSanity: {
      initialClose: loaded.get("SPY").closeByMonth.get(previousMonth(simulationMonths[0])),
      finalClose: loaded.get("SPY").closeByMonth.get(simulationMonths.at(-1))
    },
    candidates: candidates.map(({ id, label, description }) => ({ id, label, description })),
    scenarios: { base, stress },
    selection
  };
}

function runScenario({
  candidates,
  symbols,
  returnMaps,
  allMonths,
  simulationMonths,
  benchmarkReturns,
  costPerOneWayPct
}) {
  const benchmarkRun = simulateBenchmark(simulationMonths, benchmarkReturns, costPerOneWayPct);
  const benchmark = summarizeRun(benchmarkRun, null, costPerOneWayPct);
  const candidateSummaries = candidates.map((candidate) => {
    const run = simulateCandidate({
      candidate,
      symbols,
      returnMaps,
      allMonths,
      simulationMonths,
      costPerOneWayPct
    });
    return summarizeRun(run, benchmarkRun, costPerOneWayPct);
  });
  return {
    costPerOneWayPct,
    benchmark,
    candidates: candidateSummaries
  };
}

function simulateBenchmark(months, returns, costPerOneWayPct) {
  let equity = CONFIG.initialCapital;
  const curve = [];
  let transactionCosts = 0;
  for (const [index, month] of months.entries()) {
    const equityBefore = equity;
    if (index === 0) {
      const cost = equity * costPerOneWayPct / 100;
      equity -= cost;
      transactionCosts += cost;
    }
    equity *= 1 + returns.get(month);
    curve.push({ month, equity, monthlyReturn: equity / equityBefore - 1 });
  }
  return {
    id: "spy_buy_hold",
    label: "SPY 매수보유",
    curve,
    transactionCosts,
    oneWayTurnover: 1,
    averageWeightsPct: { SPY: 100 }
  };
}

function simulateCandidate({ candidate, symbols, returnMaps, allMonths, simulationMonths, costPerOneWayPct }) {
  const monthIndex = new Map(allMonths.map((month, index) => [month, index]));
  let equity = CONFIG.initialCapital;
  let previousEndWeights = new Map();
  let transactionCosts = 0;
  let oneWayTurnover = 0;
  const allocationTotals = new Map();
  const curve = [];

  for (const month of simulationMonths) {
    const equityBefore = equity;
    const currentIndex = monthIndex.get(month);
    const targetWeights = buildTargetWeights(candidate, symbols, returnMaps, allMonths, currentIndex);
    const turnover = previousEndWeights.size
      ? calculateOneWayTurnover(previousEndWeights, targetWeights)
      : 1;
    const cost = equity * turnover * costPerOneWayPct / 100;
    equity -= cost;
    transactionCosts += cost;
    oneWayTurnover += turnover;

    const portfolioReturn = sum(
      [...targetWeights.entries()].map(([symbol, weight]) => returnMaps[symbol].get(month) * weight)
    );
    equity *= 1 + portfolioReturn;
    previousEndWeights = calculateEndWeights(targetWeights, returnMaps, month, portfolioReturn);
    curve.push({ month, equity, monthlyReturn: equity / equityBefore - 1, turnover });
    for (const [symbol, weight] of targetWeights.entries()) {
      allocationTotals.set(symbol, (allocationTotals.get(symbol) ?? 0) + weight);
    }
  }

  return {
    id: candidate.id,
    label: candidate.label,
    description: candidate.description,
    curve,
    transactionCosts,
    oneWayTurnover,
    averageWeightsPct: Object.fromEntries(
      [...allocationTotals.entries()]
        .map(([symbol, total]) => [symbol, round(total / simulationMonths.length * 100, 2)])
        .sort((a, b) => b[1] - a[1])
    )
  };
}

function buildTargetWeights(candidate, symbols, returnMaps, allMonths, currentIndex) {
  if (candidate.type === "equal") {
    return new Map(symbols.map((symbol) => [symbol, 1 / symbols.length]));
  }
  if (candidate.type === "top2") {
    const selected = selectTrailingTop(symbols, returnMaps, allMonths, currentIndex, CONFIG.lookbackMonths, 2);
    return new Map(selected.map((symbol) => [symbol, 0.5]));
  }
  throw new Error(`지원하지 않는 후보 유형입니다: ${candidate.type}`);
}

function selectTrailingTop(symbols, returnMaps, allMonths, currentIndex, lookbackMonths, count) {
  if (!Number.isInteger(currentIndex) || currentIndex < lookbackMonths) {
    throw new Error("동적 ETF 선택에 필요한 과거 월수익이 부족합니다.");
  }
  return symbols
    .map((symbol) => {
      let growth = 1;
      for (let index = currentIndex - lookbackMonths; index < currentIndex; index += 1) {
        growth *= 1 + returnMaps[symbol].get(allMonths[index]);
      }
      return { symbol, trailingReturn: growth - 1 };
    })
    .sort((a, b) => b.trailingReturn - a.trailingReturn || a.symbol.localeCompare(b.symbol))
    .slice(0, count)
    .map(({ symbol }) => symbol);
}

function calculateEndWeights(startWeights, returnMaps, month, portfolioReturn) {
  return new Map(
    [...startWeights.entries()].map(([symbol, weight]) => [
      symbol,
      weight * (1 + returnMaps[symbol].get(month)) / (1 + portfolioReturn)
    ])
  );
}

function calculateOneWayTurnover(previousWeights, targetWeights) {
  const symbols = new Set([...previousWeights.keys(), ...targetWeights.keys()]);
  return sum(
    [...symbols].map(
      (symbol) => Math.abs((targetWeights.get(symbol) ?? 0) - (previousWeights.get(symbol) ?? 0))
    )
  ) / 2;
}

function summarizeRun(run, benchmarkRun, costPerOneWayPct) {
  const overall = calculateMetrics(run.curve, CONFIG.initialCapital);
  const segments = Object.fromEntries(
    CONFIG.segments.map((segment) => {
      const subset = run.curve.filter((row) => row.month >= segment.start && row.month <= segment.end);
      const metrics = calculateSegmentMetrics(subset);
      if (benchmarkRun) {
        const benchmarkSubset = benchmarkRun.curve.filter(
          (row) => row.month >= segment.start && row.month <= segment.end
        );
        metrics.excessCagrPct = round(metrics.cagrPct - calculateSegmentMetrics(benchmarkSubset).cagrPct, 2);
      }
      return [segment.id, metrics];
    })
  );
  const years = run.curve.length / 12;
  const summary = {
    id: run.id,
    label: run.label,
    description: run.description ?? null,
    overall: {
      ...overall,
      transactionCosts: round(run.transactionCosts, 2),
      annualOneWayTurnoverPct: round(run.oneWayTurnover / years * 100, 2)
    },
    segments,
    averageWeightsPct: run.averageWeightsPct,
    costPerOneWayPct
  };
  if (benchmarkRun) summary.relativeToSpy = compareCurves(run.curve, benchmarkRun.curve);
  return summary;
}

function calculateMetrics(curve, initialCapital) {
  if (!curve.length) return emptyMetrics();
  const endingEquity = curve.at(-1).equity;
  const years = curve.length / 12;
  const cagr = (endingEquity / initialCapital) ** (1 / years) - 1;
  return {
    from: curve[0].month,
    to: curve.at(-1).month,
    months: curve.length,
    endingEquity: round(endingEquity, 2),
    totalReturnPct: round((endingEquity / initialCapital - 1) * 100, 2),
    cagrPct: round(cagr * 100, 2),
    maxDrawdownPct: round(calculateMaxDrawdown([initialCapital, ...curve.map((row) => row.equity)]) * 100, 2),
    annualizedVolatilityPct: round(standardDeviation(curve.map((row) => row.monthlyReturn)) * Math.sqrt(12) * 100, 2)
  };
}

function calculateSegmentMetrics(curve) {
  if (!curve.length) return emptyMetrics();
  let equity = CONFIG.initialCapital;
  const rebased = curve.map((row) => {
    equity *= 1 + row.monthlyReturn;
    return { ...row, equity };
  });
  return calculateMetrics(rebased, CONFIG.initialCapital);
}

function compareCurves(candidate, benchmark) {
  const candidateMetrics = calculateMetrics(candidate, CONFIG.initialCapital);
  const benchmarkMetrics = calculateMetrics(benchmark, CONFIG.initialCapital);
  const activeReturns = candidate.map((row, index) => row.monthlyReturn - benchmark[index].monthlyReturn);
  const activeStdDev = sampleStandardDeviation(activeReturns);
  const rolling = calculateRollingBeatRate(candidate, benchmark, CONFIG.rollingWindowMonths);
  const trackingError = standardDeviation(activeReturns) * Math.sqrt(12);
  return {
    excessCagrPct: round(candidateMetrics.cagrPct - benchmarkMetrics.cagrPct, 2),
    maxDrawdownDifferencePct: round(candidateMetrics.maxDrawdownPct - benchmarkMetrics.maxDrawdownPct, 2),
    trackingErrorPct: round(trackingError * 100, 2),
    informationRatio: trackingError > 0 ? round(mean(activeReturns) * 12 / trackingError, 3) : null,
    activeReturnTStat:
      activeStdDev > 0 ? round(mean(activeReturns) * Math.sqrt(activeReturns.length) / activeStdDev, 3) : null,
    rollingFiveYearBeatRatePct: rolling.beatRatePct,
    rollingFiveYearWindows: rolling.windows,
    worstRollingFiveYearExcessPct: rolling.worstExcessPct,
    bestRollingFiveYearExcessPct: rolling.bestExcessPct
  };
}

function calculateRollingBeatRate(candidate, benchmark, windowMonths) {
  const outcomes = [];
  for (let index = windowMonths - 1; index < candidate.length; index += 1) {
    let candidateGrowth = 1;
    let benchmarkGrowth = 1;
    for (let offset = index - windowMonths + 1; offset <= index; offset += 1) {
      candidateGrowth *= 1 + candidate[offset].monthlyReturn;
      benchmarkGrowth *= 1 + benchmark[offset].monthlyReturn;
    }
    outcomes.push((candidateGrowth - benchmarkGrowth) * 100);
  }
  return {
    windows: outcomes.length,
    beatRatePct: outcomes.length ? round(outcomes.filter((value) => value > 0).length / outcomes.length * 100, 2) : 0,
    worstExcessPct: outcomes.length ? round(Math.min(...outcomes), 2) : null,
    bestExcessPct: outcomes.length ? round(Math.max(...outcomes), 2) : null
  };
}

function evaluateCandidates(base, stress) {
  const rows = base.candidates.map((candidate) => {
    const stressed = stress.candidates.find((item) => item.id === candidate.id);
    const checks = {
      overallExcessCagr:
        candidate.relativeToSpy.excessCagrPct >= CONFIG.selection.minimumOverallExcessCagrPct,
      positiveDevelopment:
        candidate.segments.development.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      positiveValidation:
        candidate.segments.validation.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      positiveHoldout:
        candidate.segments.holdout.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      stressExcess:
        stressed.relativeToSpy.excessCagrPct > CONFIG.selection.minimumStressExcessCagrPct,
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
        developmentExcessCagrPct: candidate.segments.development.excessCagrPct,
        validationExcessCagrPct: candidate.segments.validation.excessCagrPct,
        holdoutExcessCagrPct: candidate.segments.holdout.excessCagrPct,
        stressExcessCagrPct: stressed.relativeToSpy.excessCagrPct,
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

async function loadMonthlyData(symbol) {
  const cachePath = path.join(CACHE_DIR, `${symbol}-daily-adjusted.json`);
  let candles;
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (Date.now() - new Date(cached.createdAt).getTime() < 6 * 60 * 60_000) candles = cached.candles;
  } catch {}
  if (!candles) {
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
        const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
        candles = (result?.timestamp ?? [])
          .map((timestamp, index) => ({
            date: new Date(timestamp * 1000).toISOString().slice(0, 10),
            close: Number(adjusted[index])
          }))
          .filter((row) => row.close > 0);
        if (candles.length < 500) throw new Error(`${symbol} 일봉 데이터가 부족합니다: ${candles.length}`);
        await fs.writeFile(cachePath, JSON.stringify({ createdAt: new Date().toISOString(), candles }));
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
    if (!candles) throw lastError;
  }
  const closeByMonth = new Map();
  for (const candle of candles) {
    const month = candle.date.slice(0, 7).replace("-", "");
    if (month <= CONFIG.endMonth) closeByMonth.set(month, candle.close);
  }
  const closes = [...closeByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, close]) => ({ month, close }));
  const returns = new Map();
  for (let index = 1; index < closes.length; index += 1) {
    returns.set(closes[index].month, closes[index].close / closes[index - 1].close - 1);
  }
  return {
    source: `Yahoo Finance ${symbol} adjusted daily close aggregated to month-end`,
    sha256: createHash("sha256").update(JSON.stringify(closes)).digest("hex"),
    closes,
    closeByMonth,
    returns
  };
}

function intersectMonths(maps) {
  const [first, ...rest] = maps;
  return [...first.keys()].filter((month) => rest.every((map) => map.has(month))).sort();
}

function previousMonth(month) {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(4, 6));
  return value === 1 ? `${year - 1}12` : `${year}${String(value - 1).padStart(2, "0")}`;
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

function emptyMetrics() {
  return {
    from: null,
    to: null,
    months: 0,
    endingEquity: null,
    totalReturnPct: null,
    cagrPct: null,
    maxDrawdownPct: null,
    annualizedVolatilityPct: null
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

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(sum(values.map((value) => (value - average) ** 2)) / (values.length - 1));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  CONFIG,
  PRIMARY_CANDIDATES,
  PRIMARY_PROXIES,
  calculateEndWeights,
  calculateMaxDrawdown,
  calculateMetrics,
  calculateOneWayTurnover,
  selectTrailingTop
};
