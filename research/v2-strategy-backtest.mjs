#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNIVERSE_PATH = path.join(HERE, "sp100-current-2026-07-15.json");
const CACHE_DIR = path.join(os.tmpdir(), "toss-invest-v2-backtest-cache");

const CONFIG = {
  initialCapital: 100_000,
  range: "10y",
  costPerSide: 0.001,
  maxPositions: 8,
  maxPositionPct: 0.1,
  maxGrossPct: 0.6,
  maxSectorPct: 0.2,
  riskPerTradePct: 0.005,
  minStopPct: 0.04,
  maxStopPct: 0.1,
  startDate: "2017-01-01",
  segments: [
    { id: "development", start: "2017-01-01", end: "2020-12-31" },
    { id: "validation", start: "2021-01-01", end: "2023-12-31" },
    { id: "holdout", start: "2024-01-01", end: "9999-12-31" }
  ]
};

const ALL_CORE_STRATEGIES = [
  {
    id: "rsi2_pullback",
    label: "RSI(2) 반등 + SMA200",
    description: "RSI(2)가 5 이하로 급락한 뒤 가격과 RSI가 반등하고 장기 추세 위일 때 진입",
    entry(candle, previous) {
      return Boolean(
        previous &&
          previous.rsi2 !== null &&
          previous.rsi2 <= 5 &&
          candle.rsi2 > previous.rsi2 &&
          candle.close > previous.close &&
          candle.close > candle.sma200
      );
    },
    entryScore(candle) {
      return 100 - candle.rsi2;
    },
    exit(candle, previous, position) {
      return candle.close > candle.sma5 || candle.rsi2 >= 70 || position.holdDays >= 7;
    }
  },
  {
    id: "rsi14_recovery",
    label: "RSI(14) 30 회복 -> 70 청산",
    description: "전통적인 RSI 과매도 회복 규칙을 시장 추세와 공통 위험관리 아래 검증",
    entry(candle, previous) {
      return Boolean(previous && previous.rsi14 < 30 && candle.rsi14 >= 30);
    },
    entryScore(candle) {
      return 100 - candle.rsi14;
    },
    exit(candle, previous, position) {
      return candle.rsi14 >= 70 || position.holdDays >= 40;
    }
  },
  {
    id: "bollinger_reentry",
    label: "볼린저 하단 재진입 + SMA200",
    description: "하단 밴드를 이탈한 상승 추세 종목이 밴드 안으로 복귀할 때 진입",
    entry(candle, previous) {
      return Boolean(
        previous &&
          previous.close < previous.bbLower &&
          candle.close >= candle.bbLower &&
          candle.close > candle.sma200
      );
    },
    entryScore(candle) {
      return -candle.bbZ;
    },
    exit(candle, previous, position) {
      return candle.close >= candle.sma20 || position.holdDays >= 10;
    }
  },
  {
    id: "ema_trend",
    label: "EMA20/100 추세 + ATR",
    description: "중기 이동평균 상향 교차 후 추세를 보유하고 ATR 추적선으로 청산",
    entry(candle, previous) {
      return Boolean(previous && previous.ema20 <= previous.ema100 && candle.ema20 > candle.ema100);
    },
    entryScore(candle) {
      return (candle.ema20 / candle.ema100 - 1) + (candle.mom63 ?? 0);
    },
    exit(candle, previous, position) {
      return candle.ema20 < candle.ema100 || candle.close < position.trailingStop;
    }
  },
  {
    id: "donchian_breakout",
    label: "Donchian 55일 돌파 + ATR",
    description: "55일 신고가 돌파에 진입하고 20일 저가 또는 ATR 추적선으로 청산",
    entry(candle, previous) {
      return Boolean(
        previous &&
          candle.close > candle.donchianHigh55 &&
          previous.close <= previous.donchianHigh55
      );
    },
    entryScore(candle) {
      return candle.mom126 ?? 0;
    },
    exit(candle, previous, position) {
      return candle.close < candle.donchianLow20 || candle.close < position.trailingStop;
    }
  },
  {
    id: "cross_sectional_momentum",
    label: "12-1개월 상대 모멘텀",
    description: "월말마다 장기 추세 위의 12-1개월 모멘텀 상위 종목을 선택",
    monthly: true
  }
];

const ACTIVE_STRATEGY_IDS = Object.freeze([
  "rsi14_recovery",
  "ema_trend",
  "donchian_breakout",
  "cross_sectional_momentum"
]);
const ACTIVE_STRATEGY_ID_SET = new Set(ACTIVE_STRATEGY_IDS);
const ACTIVE_STRATEGIES = ALL_CORE_STRATEGIES.filter((strategy) => ACTIVE_STRATEGY_ID_SET.has(strategy.id));

const SENSITIVITY_STRATEGIES = [
  makeEmaTrendStrategy(10, 50),
  makeEmaTrendStrategy(20, 100),
  makeEmaTrendStrategy(50, 200),
  makeDonchianStrategy(20, 10),
  makeDonchianStrategy(55, 20),
  makeDonchianStrategy(100, 40)
];

async function main() {
  const outputArg = process.argv.indexOf("--output");
  const outputPath = outputArg >= 0 ? process.argv[outputArg + 1] : null;
  const costArg = process.argv.indexOf("--cost-per-side");
  if (costArg >= 0) {
    const cost = Number(process.argv[costArg + 1]);
    if (!Number.isFinite(cost) || cost < 0 || cost > 0.02) throw new Error("--cost-per-side 값이 올바르지 않습니다.");
    CONFIG.costPerSide = cost;
  }
  const historyArg = process.argv.indexOf("--require-history-before");
  const requireHistoryBefore = historyArg >= 0 ? process.argv[historyArg + 1] : null;
  if (requireHistoryBefore && !/^\d{4}-\d{2}-\d{2}$/.test(requireHistoryBefore)) {
    throw new Error("--require-history-before 값은 YYYY-MM-DD 형식이어야 합니다.");
  }
  const strategySetArg = process.argv.indexOf("--strategy-set");
  const strategySet = strategySetArg >= 0 ? process.argv[strategySetArg + 1] : "active";
  if (!new Set(["active", "archive", "sensitivity"]).has(strategySet)) {
    throw new Error("--strategy-set 값은 active, archive 또는 sensitivity여야 합니다.");
  }
  const universeRows = JSON.parse(await fs.readFile(UNIVERSE_PATH, "utf8"));
  const universe = universeRows.map(([symbol, sector]) => ({ symbol, sector }));
  const symbols = [...new Set(["SPY", ...universe.map((item) => item.symbol)])];
  const failures = [];
  const data = new Map();

  await fs.mkdir(CACHE_DIR, { recursive: true });
  for (const [index, symbol] of symbols.entries()) {
    try {
      const candles = await loadCandles(symbol);
      data.set(symbol, addIndicators(candles));
    } catch (error) {
      failures.push({ symbol, error: error.message });
    }
    if ((index + 1) % 10 === 0 || index === symbols.length - 1) {
      process.stderr.write(`가격 데이터 ${index + 1}/${symbols.length}\n`);
    }
  }

  const spy = data.get("SPY");
  if (!spy?.length) throw new Error("SPY 가격 데이터를 가져오지 못했습니다.");
  const sectorBySymbol = new Map(universe.map((item) => [item.symbol, item.sector]));
  const eligibleSymbols = universe
    .map((item) => item.symbol)
    .filter((symbol) => {
      const candles = data.get(symbol) ?? [];
      return candles.length >= 260 && (!requireHistoryBefore || candles[0].date <= requireHistoryBefore);
    });
  const context = createContext({ data, spy, eligibleSymbols, sectorBySymbol });
  const selectedStrategies =
    strategySet === "sensitivity"
      ? SENSITIVITY_STRATEGIES
      : strategySet === "archive"
        ? ALL_CORE_STRATEGIES
        : ACTIVE_STRATEGIES;
  const strategies = selectedStrategies.map((strategy) => simulateStrategy(strategy, context));
  const benchmarks = [simulateSpyBenchmark(spy, 0.6), simulateSpyBenchmark(spy, 1)];
  const result = {
    generatedAt: new Date().toISOString(),
    methodology: {
      universe: "2026-07-15 현재 S&P 100 구성 종목 스냅샷(Alphabet 중복 주식 종류 제외)",
      survivorshipBias: true,
      priceSource: "Yahoo Finance adjusted daily OHLC",
      execution: "종가 신호 후 다음 거래일 시가 체결",
      costPerSidePct: CONFIG.costPerSide * 100,
      commonRisk: {
        maxPositions: CONFIG.maxPositions,
        maxPositionPct: CONFIG.maxPositionPct * 100,
        maxGrossPct: CONFIG.maxGrossPct * 100,
        maxSectorPct: CONFIG.maxSectorPct * 100,
        riskPerTradePct: CONFIG.riskPerTradePct * 100,
        stop: `2.5 ATR, ${CONFIG.minStopPct * 100}%~${CONFIG.maxStopPct * 100}% 범위`
      },
      commonEntryRegime: "SPY 종가 > SPY SMA200",
      strategySet,
      candidatePolicy:
        strategySet === "active"
          ? "기본·개발·검증·홀드아웃 CAGR과 비용 2배·장기 이력 제한 검사의 같은 지표가 모두 0% 초과"
          : null,
      requireHistoryBefore,
      dividendTreatment: "Yahoo adjusted OHLC에 반영",
      omitted: ["현금 이자", "실적발표 필터", "세금", "과거 시점별 S&P 100 편입 이력"]
    },
    dataDiagnostics: {
      requestedSymbols: symbols.length,
      loadedSymbols: data.size,
      eligibleStocks: eligibleSymbols.length,
      insufficientHistorySymbols: universe
        .map((item) => item.symbol)
        .filter((symbol) => {
          const candles = data.get(symbol) ?? [];
          return candles.length < 260 || (requireHistoryBefore && candles[0].date > requireHistoryBefore);
        }),
      failures,
      firstDate: context.dates[0],
      lastDate: context.dates.at(-1)
    },
    strategies,
    benchmarks
  };

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await fs.writeFile(outputPath, serialized);
    process.stdout.write(`${path.resolve(outputPath)}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

function createContext({ data, spy, eligibleSymbols, sectorBySymbol }) {
  const dates = spy
    .filter((item) => item.sma200 !== null)
    .map((item) => item.date)
    .filter((date) => date >= CONFIG.startDate && date <= new Date().toISOString().slice(0, 10));
  const bySymbolDate = new Map();
  for (const [symbol, candles] of data.entries()) {
    bySymbolDate.set(symbol, new Map(candles.map((item) => [item.date, item])));
  }
  return {
    dates,
    bySymbolDate,
    eligibleSymbols,
    sectorBySymbol,
    spyByDate: bySymbolDate.get("SPY")
  };
}

function simulateStrategy(strategy, context) {
  let cash = CONFIG.initialCapital;
  const positions = new Map();
  const trades = [];
  const curve = [];
  let pendingEntries = [];
  let pendingExits = new Map();

  for (let dateIndex = 0; dateIndex < context.dates.length; dateIndex += 1) {
    const date = context.dates[dateIndex];
    const previousDate = context.dates[dateIndex - 1] ?? null;

    for (const [symbol, reason] of pendingExits.entries()) {
      const position = positions.get(symbol);
      const candle = context.bySymbolDate.get(symbol)?.get(date);
      if (!position || !candle?.open) continue;
      const sellPrice = candle.open * (1 - CONFIG.costPerSide);
      const proceeds = position.quantity * sellPrice;
      cash += proceeds;
      trades.push({
        symbol,
        sector: position.sector,
        entryDate: position.entryDate,
        exitDate: date,
        entryPrice: position.entryPrice,
        exitPrice: sellPrice,
        returnPct: (proceeds / position.entryCost - 1) * 100,
        pnl: proceeds - position.entryCost,
        holdDays: position.holdDays,
        exitReason: reason
      });
      positions.delete(symbol);
    }
    pendingExits = new Map();

    const openEquity = portfolioValue(cash, positions, context, date, "open");
    const grossAtOpen = grossValue(positions, context, date, "open");
    const sectorValues = getSectorValues(positions, context, date, "open");
    let reservedGross = grossAtOpen;

    for (const candidate of pendingEntries.sort((a, b) => b.score - a.score)) {
      if (positions.has(candidate.symbol) || positions.size >= CONFIG.maxPositions) continue;
      const candle = context.bySymbolDate.get(candidate.symbol)?.get(date);
      if (!candle?.open || !candle.atr14) continue;
      const stopPct = clamp((2.5 * candle.atr14) / candle.open, CONFIG.minStopPct, CONFIG.maxStopPct);
      const riskSizedValue = (openEquity * CONFIG.riskPerTradePct) / stopPct;
      const maxPositionValue = openEquity * CONFIG.maxPositionPct;
      const grossCapacity = openEquity * CONFIG.maxGrossPct - reservedGross;
      const sector = context.sectorBySymbol.get(candidate.symbol) ?? "Unknown";
      const sectorCapacity = openEquity * CONFIG.maxSectorPct - (sectorValues.get(sector) ?? 0);
      const positionValue = Math.min(riskSizedValue, maxPositionValue, grossCapacity, sectorCapacity, cash);
      if (positionValue < openEquity * 0.01) continue;
      const buyPrice = candle.open * (1 + CONFIG.costPerSide);
      const quantity = positionValue / buyPrice;
      const entryCost = quantity * buyPrice;
      cash -= entryCost;
      positions.set(candidate.symbol, {
        symbol: candidate.symbol,
        sector,
        quantity,
        entryDate: date,
        entryPrice: buyPrice,
        entryCost,
        stopPrice: candle.open * (1 - stopPct),
        highestClose: candle.close,
        trailingStop: candle.close - 3 * candle.atr14,
        holdDays: 0
      });
      reservedGross += positionValue;
      sectorValues.set(sector, (sectorValues.get(sector) ?? 0) + positionValue);
    }
    pendingEntries = [];

    for (const [symbol, position] of positions.entries()) {
      const candle = context.bySymbolDate.get(symbol)?.get(date);
      if (!candle) continue;
      position.holdDays += 1;
      position.highestClose = Math.max(position.highestClose, candle.close);
      position.trailingStop = Math.max(position.trailingStop, position.highestClose - 3 * candle.atr14);
    }

    const closeEquity = portfolioValue(cash, positions, context, date, "close");
    const closeGross = grossValue(positions, context, date, "close");
    curve.push({ date, equity: closeEquity, exposurePct: closeEquity > 0 ? (closeGross / closeEquity) * 100 : 0 });

    for (const [symbol, position] of positions.entries()) {
      const candle = context.bySymbolDate.get(symbol)?.get(date);
      const previous = previousDate ? context.bySymbolDate.get(symbol)?.get(previousDate) : null;
      if (!candle) continue;
      if (candle.close <= position.stopPrice) {
        pendingExits.set(symbol, "common_atr_stop");
      } else if (!strategy.monthly && strategy.exit(candle, previous, position)) {
        pendingExits.set(symbol, "strategy_exit");
      }
    }

    const spyCandle = context.spyByDate.get(date);
    const marketAllowsEntry = spyCandle?.sma200 && spyCandle.close > spyCandle.sma200;
    if (!marketAllowsEntry) continue;

    if (strategy.monthly) {
      const nextDate = context.dates[dateIndex + 1] ?? null;
      if (!nextDate || date.slice(0, 7) === nextDate.slice(0, 7)) continue;
      const ranked = context.eligibleSymbols
        .map((symbol) => ({ symbol, candle: context.bySymbolDate.get(symbol)?.get(date) }))
        .filter(
          ({ candle }) =>
            candle && candle.mom252x21 !== null && candle.sma200 !== null && candle.close > candle.sma200
        )
        .sort((a, b) => b.candle.mom252x21 - a.candle.mom252x21)
        .slice(0, CONFIG.maxPositions);
      const desired = new Set(ranked.map((item) => item.symbol));
      for (const symbol of positions.keys()) {
        if (!desired.has(symbol)) pendingExits.set(symbol, "monthly_rebalance");
      }
      pendingEntries = ranked
        .filter((item) => !positions.has(item.symbol))
        .map((item) => ({ symbol: item.symbol, score: item.candle.mom252x21 }));
      continue;
    }

    for (const symbol of context.eligibleSymbols) {
      if (positions.has(symbol) || pendingExits.has(symbol)) continue;
      const candle = context.bySymbolDate.get(symbol)?.get(date);
      const previous = previousDate ? context.bySymbolDate.get(symbol)?.get(previousDate) : null;
      if (!hasRequiredIndicators(candle) || !strategy.entry(candle, previous)) continue;
      pendingEntries.push({ symbol, score: strategy.entryScore(candle) });
    }
  }

  const lastDate = context.dates.at(-1);
  for (const [symbol, position] of positions.entries()) {
    const candle = context.bySymbolDate.get(symbol)?.get(lastDate);
    if (!candle) continue;
    const sellPrice = candle.close * (1 - CONFIG.costPerSide);
    const proceeds = position.quantity * sellPrice;
    cash += proceeds;
    trades.push({
      symbol,
      sector: position.sector,
      entryDate: position.entryDate,
      exitDate: lastDate,
      entryPrice: position.entryPrice,
      exitPrice: sellPrice,
      returnPct: (proceeds / position.entryCost - 1) * 100,
      pnl: proceeds - position.entryCost,
      holdDays: position.holdDays,
      exitReason: "end_of_data"
    });
    positions.delete(symbol);
  }
  if (curve.length) curve[curve.length - 1] = { ...curve.at(-1), equity: cash, exposurePct: 0 };

  return {
    id: strategy.id,
    label: strategy.label,
    description: strategy.description,
    overall: summarize(curve, trades),
    segments: Object.fromEntries(
      CONFIG.segments.map((segment) => [segment.id, summarizeSegment(curve, trades, segment.start, segment.end)])
    ),
    diagnostics: tradeDiagnostics(trades)
  };
}

function simulateSpyBenchmark(spy, weight) {
  const candles = spy.filter((item) => item.date >= CONFIG.startDate && item.sma200 !== null);
  const entry = candles[0].open * (1 + CONFIG.costPerSide);
  const invested = CONFIG.initialCapital * weight;
  const quantity = invested / entry;
  const cash = CONFIG.initialCapital - invested;
  const curve = candles.map((candle) => ({
    date: candle.date,
    equity: cash + quantity * candle.close,
    exposurePct: ((quantity * candle.close) / (cash + quantity * candle.close)) * 100
  }));
  const last = candles.at(-1);
  const proceeds = quantity * last.close * (1 - CONFIG.costPerSide);
  const trades = [{
    symbol: "SPY",
    entryDate: candles[0].date,
    exitDate: last.date,
    returnPct: (proceeds / invested - 1) * 100,
    pnl: proceeds - invested,
    holdDays: candles.length,
    exitReason: "end_of_data"
  }];
  return {
    id: `spy_${Math.round(weight * 100)}`,
    label: `SPY ${Math.round(weight * 100)}% + 현금 ${Math.round((1 - weight) * 100)}%`,
    overall: summarize(curve, trades),
    segments: Object.fromEntries(
      CONFIG.segments.map((segment) => [segment.id, summarizeSegment(curve, [], segment.start, segment.end)])
    )
  };
}

function summarizeSegment(curve, trades, start, end) {
  const segmentCurve = curve.filter((item) => item.date >= start && item.date <= end);
  if (segmentCurve.length < 2) return null;
  const base = segmentCurve[0].equity;
  const normalized = segmentCurve.map((item) => ({ ...item, equity: (item.equity / base) * CONFIG.initialCapital }));
  return summarize(normalized, trades.filter((trade) => trade.exitDate >= start && trade.exitDate <= end));
}

function summarize(curve, trades) {
  if (curve.length < 2) return null;
  const first = curve[0];
  const last = curve.at(-1);
  const years = Math.max(1 / 252, daysBetween(first.date, last.date) / 365.25);
  const totalReturn = last.equity / first.equity - 1;
  const cagr = Math.pow(last.equity / first.equity, 1 / years) - 1;
  const dailyReturns = [];
  for (let i = 1; i < curve.length; i += 1) dailyReturns.push(curve[i].equity / curve[i - 1].equity - 1);
  const dailyMean = mean(dailyReturns);
  const dailyStd = standardDeviation(dailyReturns);
  const maxDrawdown = calculateMaxDrawdown(curve.map((item) => item.equity));
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const grossProfit = sum(wins.map((trade) => trade.pnl));
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.pnl)));
  return {
    from: first.date,
    to: last.date,
    endingEquity: round(last.equity, 2),
    totalReturnPct: round(totalReturn * 100, 2),
    cagrPct: round(cagr * 100, 2),
    maxDrawdownPct: round(maxDrawdown * 100, 2),
    calmar: maxDrawdown > 0 ? round(cagr / maxDrawdown, 3) : null,
    annualizedVolatilityPct: round(dailyStd * Math.sqrt(252) * 100, 2),
    sharpeZeroRate: dailyStd > 0 ? round((dailyMean / dailyStd) * Math.sqrt(252), 3) : null,
    averageExposurePct: round(mean(curve.map((item) => item.exposurePct)), 2),
    trades: trades.length,
    winRatePct: trades.length ? round((wins.length / trades.length) * 100, 2) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 3) : grossProfit > 0 ? null : 0,
    averageTradePct: trades.length ? round(mean(trades.map((trade) => trade.returnPct)), 3) : null,
    averageWinPct: wins.length ? round(mean(wins.map((trade) => trade.returnPct)), 3) : null,
    averageLossPct: losses.length ? round(mean(losses.map((trade) => trade.returnPct)), 3) : null,
    worstTradePct: trades.length ? round(Math.min(...trades.map((trade) => trade.returnPct)), 3) : null,
    medianHoldDays: trades.length ? round(median(trades.map((trade) => trade.holdDays)), 1) : null
  };
}

function tradeDiagnostics(trades) {
  const byExitReason = {};
  const byYear = {};
  const bySymbol = {};
  for (const trade of trades) {
    byExitReason[trade.exitReason] = (byExitReason[trade.exitReason] ?? 0) + 1;
    const year = trade.exitDate.slice(0, 4);
    byYear[year] = (byYear[year] ?? 0) + trade.pnl;
    bySymbol[trade.symbol] = (bySymbol[trade.symbol] ?? 0) + trade.pnl;
  }
  const totalAbsPnl = sum(Object.values(bySymbol).map(Math.abs));
  const largestSymbolContributionPct = totalAbsPnl
    ? (Math.max(...Object.values(bySymbol).map(Math.abs)) / totalAbsPnl) * 100
    : null;
  return {
    byExitReason,
    pnlByYear: Object.fromEntries(Object.entries(byYear).map(([year, pnl]) => [year, round(pnl, 2)])),
    profitableYears: Object.values(byYear).filter((pnl) => pnl > 0).length,
    observedYears: Object.keys(byYear).length,
    largestAbsoluteSymbolContributionPct: largestSymbolContributionPct === null ? null : round(largestSymbolContributionPct, 2),
    topAbsoluteSymbolContributors: Object.entries(bySymbol)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 5)
      .map(([symbol, pnl]) => ({ symbol, pnl: round(pnl, 2) }))
  };
}

function portfolioValue(cash, positions, context, date, field) {
  return cash + grossValue(positions, context, date, field);
}

function grossValue(positions, context, date, field) {
  let total = 0;
  for (const [symbol, position] of positions.entries()) {
    const candle = context.bySymbolDate.get(symbol)?.get(date);
    const price = candle?.[field] ?? candle?.close ?? position.entryPrice;
    total += position.quantity * price;
  }
  return total;
}

function getSectorValues(positions, context, date, field) {
  const values = new Map();
  for (const [symbol, position] of positions.entries()) {
    const candle = context.bySymbolDate.get(symbol)?.get(date);
    const price = candle?.[field] ?? candle?.close ?? position.entryPrice;
    values.set(position.sector, (values.get(position.sector) ?? 0) + position.quantity * price);
  }
  return values;
}

function hasRequiredIndicators(candle) {
  return Boolean(
    candle &&
      candle.atr14 !== null &&
      candle.rsi2 !== null &&
      candle.rsi14 !== null &&
      candle.sma200 !== null &&
      candle.sma20 !== null &&
      candle.sma5 !== null &&
      candle.ema20 !== null &&
      candle.ema100 !== null &&
      candle.bbLower !== null &&
      candle.donchianHigh55 !== null &&
      candle.donchianLow20 !== null
  );
}

function addIndicators(candles) {
  const closes = candles.map((item) => item.close);
  const sma5 = rollingMean(closes, 5);
  const sma20 = rollingMean(closes, 20);
  const sma200 = rollingMean(closes, 200);
  const std20 = rollingStd(closes, 20);
  const ema10 = exponentialMovingAverage(closes, 10);
  const ema20 = exponentialMovingAverage(closes, 20);
  const ema50 = exponentialMovingAverage(closes, 50);
  const ema100 = exponentialMovingAverage(closes, 100);
  const ema200 = exponentialMovingAverage(closes, 200);
  const rsi2 = wilderRsi(closes, 2);
  const rsi14 = wilderRsi(closes, 14);
  const atr14 = wilderAtr(candles, 14);
  const highs = candles.map((item) => item.high);
  const lows = candles.map((item) => item.low);
  const donchianHigh20 = rollingPreviousExtreme(highs, 20, Math.max);
  const donchianHigh55 = rollingPreviousExtreme(highs, 55, Math.max);
  const donchianHigh100 = rollingPreviousExtreme(highs, 100, Math.max);
  const donchianLow10 = rollingPreviousExtreme(lows, 10, Math.min);
  const donchianLow20 = rollingPreviousExtreme(lows, 20, Math.min);
  const donchianLow40 = rollingPreviousExtreme(lows, 40, Math.min);
  return candles.map((item, index) => {
    const bbLower = sma20[index] === null ? null : sma20[index] - 2 * std20[index];
    const bbUpper = sma20[index] === null ? null : sma20[index] + 2 * std20[index];
    return {
      ...item,
      sma5: sma5[index],
      sma20: sma20[index],
      sma200: sma200[index],
      ema10: ema10[index],
      ema20: ema20[index],
      ema50: ema50[index],
      ema100: ema100[index],
      ema200: ema200[index],
      rsi2: rsi2[index],
      rsi14: rsi14[index],
      atr14: atr14[index],
      bbLower,
      bbUpper,
      bbZ: std20[index] ? (item.close - sma20[index]) / std20[index] : null,
      donchianHigh20: donchianHigh20[index],
      donchianHigh55: donchianHigh55[index],
      donchianHigh100: donchianHigh100[index],
      donchianLow10: donchianLow10[index],
      donchianLow20: donchianLow20[index],
      donchianLow40: donchianLow40[index],
      mom63: index >= 63 ? item.close / closes[index - 63] - 1 : null,
      mom126: index >= 126 ? item.close / closes[index - 126] - 1 : null,
      mom252x21: index >= 252 ? closes[index - 21] / closes[index - 252] - 1 : null
    };
  });
}

function makeEmaTrendStrategy(fast, slow) {
  const fastKey = `ema${fast}`;
  const slowKey = `ema${slow}`;
  return {
    id: `ema_${fast}_${slow}`,
    label: `EMA${fast}/${slow} 추세 + ATR`,
    description: `EMA${fast}이 EMA${slow}을 상향 교차하면 진입`,
    entry(candle, previous) {
      return Boolean(
        previous &&
          previous[fastKey] !== null &&
          previous[slowKey] !== null &&
          previous[fastKey] <= previous[slowKey] &&
          candle[fastKey] > candle[slowKey]
      );
    },
    entryScore(candle) {
      return candle[fastKey] / candle[slowKey] - 1 + (candle.mom63 ?? 0);
    },
    exit(candle, previous, position) {
      return candle[fastKey] < candle[slowKey] || candle.close < position.trailingStop;
    }
  };
}

function makeDonchianStrategy(entryPeriod, exitPeriod) {
  const highKey = `donchianHigh${entryPeriod}`;
  const lowKey = `donchianLow${exitPeriod}`;
  return {
    id: `donchian_${entryPeriod}_${exitPeriod}`,
    label: `Donchian ${entryPeriod}/${exitPeriod} + ATR`,
    description: `${entryPeriod}일 고가 돌파에 진입하고 ${exitPeriod}일 저가 또는 ATR 추적선으로 청산`,
    entry(candle, previous) {
      return Boolean(
        previous &&
          candle[highKey] !== null &&
          previous[highKey] !== null &&
          candle.close > candle[highKey] &&
          previous.close <= previous[highKey]
      );
    },
    entryScore(candle) {
      return candle.mom126 ?? 0;
    },
    exit(candle, previous, position) {
      return candle[lowKey] !== null && (candle.close < candle[lowKey] || candle.close < position.trailingStop);
    }
  };
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

function rollingStd(values, period) {
  const means = rollingMean(values, period);
  const output = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    output[index] = standardDeviation(window, means[index]);
  }
  return output;
}

function exponentialMovingAverage(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;
  let current = mean(values.slice(0, period));
  output[period - 1] = current;
  const alpha = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = values[index] * alpha + current * (1 - alpha);
    output[index] = current;
  }
  return output;
}

function wilderRsi(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  output[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return output;
}

function wilderAtr(candles, period) {
  const output = Array(candles.length).fill(null);
  if (candles.length <= period) return output;
  const trueRanges = Array(candles.length).fill(null);
  for (let index = 1; index < candles.length; index += 1) {
    trueRanges[index] = Math.max(
      candles[index].high - candles[index].low,
      Math.abs(candles[index].high - candles[index - 1].close),
      Math.abs(candles[index].low - candles[index - 1].close)
    );
  }
  let current = mean(trueRanges.slice(1, period + 1));
  output[period] = current;
  for (let index = period + 1; index < candles.length; index += 1) {
    current = (current * (period - 1) + trueRanges[index]) / period;
    output[index] = current;
  }
  return output;
}

function rollingPreviousExtreme(values, period, comparator) {
  const output = Array(values.length).fill(null);
  for (let index = period; index < values.length; index += 1) {
    output[index] = values.slice(index - period, index).reduce((current, value) => comparator(current, value));
  }
  return output;
}

async function loadCandles(symbol) {
  const yahooSymbol = symbol.replaceAll(".", "-");
  const cachePath = path.join(CACHE_DIR, `${yahooSymbol}-${CONFIG.range}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (Date.now() - new Date(cached.createdAt).getTime() < 6 * 60 * 60_000) return cached.candles;
  } catch {}

  const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`);
  url.searchParams.set("range", CONFIG.range);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  url.searchParams.set("includeAdjustedClose", "true");
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
        signal: AbortSignal.timeout(15_000)
      });
      const data = await response.json();
      if (!response.ok || data.chart?.error) throw new Error(data.chart?.error?.description || `HTTP ${response.status}`);
      const result = data.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0] ?? {};
      const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
      const candles = (result?.timestamp ?? [])
        .map((timestamp, index) => {
          const close = Number(adjusted[index] ?? quote.close?.[index]);
          const rawClose = Number(quote.close?.[index]);
          const adjustment = rawClose > 0 && close > 0 ? close / rawClose : 1;
          return {
            date: new Date(timestamp * 1000).toISOString().slice(0, 10),
            open: Number(quote.open?.[index]) * adjustment,
            high: Number(quote.high?.[index]) * adjustment,
            low: Number(quote.low?.[index]) * adjustment,
            close,
            volume: Number(quote.volume?.[index] ?? 0)
          };
        })
        .filter((item) => [item.open, item.high, item.low, item.close].every((value) => Number.isFinite(value) && value > 0));
      if (!candles.length) throw new Error("가격 데이터가 비어 있습니다.");
      await fs.writeFile(cachePath, JSON.stringify({ createdAt: new Date().toISOString(), candles }));
      return candles;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

function calculateMaxDrawdown(values) {
  let peak = values[0];
  let maxDrawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  return maxDrawdown;
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function standardDeviation(values, knownMean = mean(values)) {
  if (values.length < 2) return 0;
  return Math.sqrt(sum(values.map((value) => (value - knownMean) ** 2)) / values.length);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
  ACTIVE_STRATEGY_IDS,
  addIndicators,
  calculateMaxDrawdown,
  rollingPreviousExtreme,
  wilderAtr,
  wilderRsi
};
