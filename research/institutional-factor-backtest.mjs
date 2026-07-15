#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(os.tmpdir(), "toss-invest-v2-french-factor-cache");
const SOURCE_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

const CONFIG = Object.freeze({
  initialCapital: 100_000,
  modernStartMonth: "199302",
  modernEndMonth: "202605",
  longHistoryStartMonth: "196307",
  longHistoryEndMonth: "199212",
  baseAnnualImplementationDragPct: 0.5,
  stressAnnualImplementationDragPct: 1,
  baseSleeveTurnoverCostPerOneWayPct: 0.1,
  stressSleeveTurnoverCostPerOneWayPct: 0.2,
  rollingWindowMonths: 60,
  selection: {
    minimumOverallExcessCagrPct: 1,
    minimumSegmentExcessCagrPct: 0,
    minimumStressExcessCagrPct: 0,
    minimumLongHistoryExcessCagrPct: 0,
    minimumRollingFiveYearBeatRatePct: 60,
    maximumDrawdownPenaltyPct: 5
  },
  segments: [
    { id: "development", start: "199302", end: "200412" },
    { id: "validation", start: "200501", end: "201412" },
    { id: "holdout", start: "201501", end: "202605" }
  ]
});

const FRENCH_BASE_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp";
const DATASETS = Object.freeze({
  value: {
    filename: "25_Portfolios_5x5_CSV.zip",
    column: "BIG HiBM",
    label: "대형 가치"
  },
  profitability: {
    filename: "25_Portfolios_ME_OP_5x5_CSV.zip",
    column: "BIG HiOP",
    label: "대형 고수익성"
  },
  investment: {
    filename: "25_Portfolios_ME_INV_5x5_CSV.zip",
    column: "BIG LoINV",
    label: "대형 보수적 투자"
  },
  momentum: {
    filename: "25_Portfolios_ME_Prior_12_2_CSV.zip",
    column: "BIG HiPRIOR",
    label: "대형 고모멘텀"
  },
  factors: {
    filename: "F-F_Research_Data_Factors_CSV.zip",
    columns: ["Mkt-RF", "RF"]
  }
});

const CANDIDATES = Object.freeze([
  staticCandidate("big_momentum", "대형 고모멘텀", { momentum: 1 }),
  staticCandidate("big_profitability", "대형 고수익성", { profitability: 1 }),
  staticCandidate("big_value", "대형 가치", { value: 1 }),
  staticCandidate("big_conservative_investment", "대형 보수적 투자", { investment: 1 }),
  staticCandidate("quality_momentum", "수익성 + 모멘텀", { profitability: 0.5, momentum: 0.5 }),
  staticCandidate("quality_value_momentum", "수익성 + 가치 + 모멘텀", {
    profitability: 1 / 3,
    value: 1 / 3,
    momentum: 1 / 3
  }),
  staticCandidate("balanced_four_factor", "4팩터 동일비중", {
    profitability: 0.25,
    value: 0.25,
    momentum: 0.25,
    investment: 0.25
  }),
  {
    id: "dynamic_factor_top2",
    label: "최근 12개월 상위 2팩터",
    description: "직전 12개월 누적수익이 높은 두 대형주 팩터 포트폴리오를 매월 동일비중으로 보유",
    dynamic: true
  }
]);

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (outputIndex >= 0 && !outputPath) throw new Error("--output 뒤에 파일 경로가 필요합니다.");

  await fs.mkdir(CACHE_DIR, { recursive: true });
  const loaded = {};
  for (const [id, spec] of Object.entries(DATASETS)) {
    loaded[id] = await loadFrenchDataset(id, spec);
    process.stderr.write(`Kenneth French 데이터 ${Object.keys(loaded).length}/${Object.keys(DATASETS).length}\n`);
  }
  const spy = await loadSpyMonthlyReturns();
  const factorData = buildFactorData(loaded);
  const modernMonths = intersectMonths([
    spy.returns,
    factorData.rf,
    ...Object.values(factorData.sleeves)
  ]).filter((month) => month >= CONFIG.modernStartMonth && month <= CONFIG.modernEndMonth);
  const longHistoryMonths = intersectMonths([
    factorData.market,
    factorData.rf,
    ...Object.values(factorData.sleeves)
  ]).filter((month) => month >= CONFIG.longHistoryStartMonth && month <= CONFIG.longHistoryEndMonth);
  if (modernMonths.length < 360) throw new Error(`현대 비교 구간이 너무 짧습니다: ${modernMonths.length}개월`);
  if (longHistoryMonths.length < 300) throw new Error(`장기 외부 진단 구간이 너무 짧습니다: ${longHistoryMonths.length}개월`);

  const modernGross = buildCandidateReturns(CANDIDATES, factorData.sleeves, modernMonths, factorData.allSleeveMonths);
  const longGross = buildCandidateReturns(CANDIDATES, factorData.sleeves, longHistoryMonths, factorData.allSleeveMonths);
  const base = runScenario({
    months: modernMonths,
    benchmarkReturns: spy.returns,
    candidateGrossReturns: modernGross,
    rf: factorData.rf,
    annualDragPct: CONFIG.baseAnnualImplementationDragPct,
    sleeveTurnoverCostPerOneWayPct: CONFIG.baseSleeveTurnoverCostPerOneWayPct,
    benchmarkId: "spy_total_return",
    benchmarkLabel: "SPY 수정주가 매수보유"
  });
  const stress = runScenario({
    months: modernMonths,
    benchmarkReturns: spy.returns,
    candidateGrossReturns: modernGross,
    rf: factorData.rf,
    annualDragPct: CONFIG.stressAnnualImplementationDragPct,
    sleeveTurnoverCostPerOneWayPct: CONFIG.stressSleeveTurnoverCostPerOneWayPct,
    benchmarkId: "spy_total_return",
    benchmarkLabel: "SPY 수정주가 매수보유"
  });
  const longHistory = runScenario({
    months: longHistoryMonths,
    benchmarkReturns: factorData.market,
    candidateGrossReturns: longGross,
    rf: factorData.rf,
    annualDragPct: CONFIG.baseAnnualImplementationDragPct,
    sleeveTurnoverCostPerOneWayPct: CONFIG.baseSleeveTurnoverCostPerOneWayPct,
    benchmarkId: "crsp_us_market",
    benchmarkLabel: "미국 전체시장(Mkt-RF + RF)"
  });
  const selection = evaluateCandidates(base, stress, longHistory);

  const result = {
    generatedAt: new Date().toISOString(),
    methodology: {
      objective: "공식 포인트인타임 대형주 팩터 포트폴리오로 SPY 장기 복리수익 초과",
      source: "Kenneth R. French Data Library, CRSP 기반 미국 연구 포트폴리오",
      portfolioConstruction: "NYSE 크기 5분위의 대형주 그룹과 각 팩터 상위 포트폴리오의 가치가중 월수익률",
      factorDefinitions: {
        momentum: "Size 5 / Prior 12-2 High",
        profitability: "Size 5 / Operating Profitability High",
        value: "Size 5 / Book-to-Market High",
        investment: "Size 5 / Investment Low"
      },
      modernComparison: {
        benchmark: "SPY Yahoo Finance adjusted monthly close returns",
        from: modernMonths[0],
        to: modernMonths.at(-1),
        months: modernMonths.length
      },
      externalLongHistoryDiagnostic: {
        benchmark: "Fama-French U.S. market return, Mkt-RF + RF",
        from: longHistoryMonths[0],
        to: longHistoryMonths.at(-1),
        months: longHistoryMonths.length
      },
      implementationDrag: {
        baseAnnualPct: CONFIG.baseAnnualImplementationDragPct,
        stressAnnualPct: CONFIG.stressAnnualImplementationDragPct,
        baseSleeveTurnoverCostPerOneWayPct: CONFIG.baseSleeveTurnoverCostPerOneWayPct,
        stressSleeveTurnoverCostPerOneWayPct: CONFIG.stressSleeveTurnoverCostPerOneWayPct,
        treatment: "모든 전략에 연율 드래그를 복리 차감하고, 월별 팩터 비중 변화에는 별도 단방향 회전율 비용을 차감",
        warning: "실제 종목별 회전율·스프레드·세금으로 계산한 비용이 아니라 연구 포트폴리오의 비투자성을 보수적으로 보정한 가정"
      },
      timing: "정적 팩터는 월별 동일비중 리밸런싱, 동적 전략은 직전 12개월만 사용해 다음 달 상위 2팩터 보유",
      segments: CONFIG.segments,
      omitted: ["한국 세금", "원/달러 환율", "실제 종목 단위 주문", "개별 종목별 회전율", "시장충격"]
    },
    selectionPolicy: {
      ...CONFIG.selection,
      segmentRule: "개발·검증·홀드아웃에서 SPY 대비 CAGR이 모두 0% 초과",
      longHistoryRule: "1963~1992 미국 전체시장 대비 CAGR이 0% 초과",
      note: "후보·가중치·임계값은 결과 확인 전에 고정"
    },
    dataDiagnostics: {
      sources: Object.fromEntries(
        Object.entries(loaded).map(([id, value]) => [id, {
          url: value.url,
          sha256: value.sha256,
          firstMonth: value.rows[0]?.month ?? null,
          lastMonth: value.rows.at(-1)?.month ?? null,
          monthlyRows: value.rows.length
        }])
      ),
      spy: {
        source: spy.source,
        firstMonth: spy.monthlyCloses[0]?.month ?? null,
        lastMonth: spy.monthlyCloses.at(-1)?.month ?? null,
        months: spy.monthlyCloses.length,
        benchmarkSanity: {
          initialClose: spy.closeByMonth.get(previousMonth(modernMonths[0])),
          finalClose: spy.closeByMonth.get(modernMonths.at(-1))
        }
      },
      missingModernMonths: findMissingMonths(modernMonths),
      missingLongHistoryMonths: findMissingMonths(longHistoryMonths)
    },
    candidates: CANDIDATES.map(({ id, label, description, weights, dynamic }) => ({
      id,
      label,
      description,
      weights: weights ?? null,
      dynamic: Boolean(dynamic)
    })),
    scenarios: { base, stress, longHistory },
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

function staticCandidate(id, label, weights) {
  return {
    id,
    label,
    description: Object.entries(weights)
      .map(([factor, weight]) => `${factor} ${round(weight * 100, 2)}%`)
      .join(" + "),
    weights: Object.freeze(weights),
    dynamic: false
  };
}

function buildFactorData(loaded) {
  const sleeves = {
    value: selectColumn(loaded.value.rows, DATASETS.value.column),
    profitability: selectColumn(loaded.profitability.rows, DATASETS.profitability.column),
    investment: selectColumn(loaded.investment.rows, DATASETS.investment.column),
    momentum: selectColumn(loaded.momentum.rows, DATASETS.momentum.column)
  };
  const rf = selectColumn(loaded.factors.rows, "RF");
  const marketExcess = selectColumn(loaded.factors.rows, "Mkt-RF");
  const market = new Map(
    [...marketExcess.entries()]
      .filter(([month]) => rf.has(month))
      .map(([month, value]) => [month, value + rf.get(month)])
  );
  return {
    sleeves,
    rf,
    market,
    allSleeveMonths: intersectMonths(Object.values(sleeves))
  };
}

function buildCandidateReturns(candidates, sleeves, months, allSleeveMonths) {
  const monthIndex = new Map(allSleeveMonths.map((month, index) => [month, index]));
  return new Map(
    candidates.map((candidate) => {
      const returns = new Map();
      const turnoverByMonth = new Map();
      const allocationCounts = new Map();
      let previousWeights = null;
      for (const month of months) {
        const weights = candidate.dynamic
          ? selectDynamicFactorWeights(sleeves, allSleeveMonths, monthIndex.get(month))
          : new Map(Object.entries(candidate.weights));
        const monthlyReturn = sum(
          [...weights.entries()].map(([factor, weight]) => sleeves[factor].get(month) * weight)
        );
        returns.set(month, monthlyReturn);
        turnoverByMonth.set(month, previousWeights ? calculateOneWayTurnover(previousWeights, weights) : 0);
        previousWeights = weights;
        for (const [factor, weight] of weights.entries()) {
          allocationCounts.set(factor, (allocationCounts.get(factor) ?? 0) + weight);
        }
      }
      return [candidate.id, {
        returns,
        turnoverByMonth,
        annualizedSleeveTurnoverPct: round(
          (sum([...turnoverByMonth.values()]) / (months.length / 12)) * 100,
          2
        ),
        averageWeightsPct: Object.fromEntries(
          [...allocationCounts.entries()]
            .map(([factor, total]) => [factor, round((total / months.length) * 100, 2)])
            .sort((a, b) => b[1] - a[1])
        )
      }];
    })
  );
}

function calculateOneWayTurnover(previousWeights, currentWeights) {
  const factors = new Set([...previousWeights.keys(), ...currentWeights.keys()]);
  return sum(
    [...factors].map(
      (factor) => Math.abs((currentWeights.get(factor) ?? 0) - (previousWeights.get(factor) ?? 0))
    )
  ) / 2;
}

function selectDynamicFactorWeights(sleeves, allMonths, currentIndex) {
  if (!Number.isInteger(currentIndex) || currentIndex < 12) {
    return new Map(Object.keys(sleeves).map((factor) => [factor, 1 / Object.keys(sleeves).length]));
  }
  const ranked = Object.entries(sleeves)
    .map(([factor, returns]) => {
      let growth = 1;
      for (let index = currentIndex - 12; index < currentIndex; index += 1) {
        growth *= 1 + returns.get(allMonths[index]);
      }
      return { factor, trailingReturn: growth - 1 };
    })
    .sort((a, b) => b.trailingReturn - a.trailingReturn)
    .slice(0, 2);
  return new Map(ranked.map(({ factor }) => [factor, 0.5]));
}

function runScenario({
  months,
  benchmarkReturns,
  candidateGrossReturns,
  rf,
  annualDragPct,
  sleeveTurnoverCostPerOneWayPct,
  benchmarkId,
  benchmarkLabel
}) {
  const benchmarkSeries = months.map((month) => ({ month, return: benchmarkReturns.get(month), rf: rf.get(month) ?? 0 }));
  const benchmark = summarizeSeries(benchmarkId, benchmarkLabel, benchmarkSeries, null);
  const candidates = CANDIDATES.map((candidate) => {
    const gross = candidateGrossReturns.get(candidate.id);
    const netReturns = applyImplementationCosts(
      gross.returns,
      annualDragPct,
      gross.turnoverByMonth,
      sleeveTurnoverCostPerOneWayPct
    );
    const series = months.map((month) => ({ month, return: netReturns.get(month), rf: rf.get(month) ?? 0 }));
    return {
      ...summarizeSeries(candidate.id, candidate.label, series, benchmarkSeries),
      averageWeightsPct: gross.averageWeightsPct,
      annualizedSleeveTurnoverPct: gross.annualizedSleeveTurnoverPct,
      annualImplementationDragPct: annualDragPct,
      sleeveTurnoverCostPerOneWayPct
    };
  });
  return { annualImplementationDragPct: annualDragPct, benchmark, candidates };
}

function summarizeSeries(id, label, series, benchmarkSeries) {
  const overall = calculateMetrics(series);
  const segments = Object.fromEntries(
    CONFIG.segments.map((segment) => {
      const subset = series.filter((row) => row.month >= segment.start && row.month <= segment.end);
      const metrics = calculateMetrics(subset);
      if (benchmarkSeries) {
        const benchmarkSubset = benchmarkSeries.filter((row) => row.month >= segment.start && row.month <= segment.end);
        metrics.excessCagrPct = round(metrics.cagrPct - calculateMetrics(benchmarkSubset).cagrPct, 2);
      }
      return [segment.id, metrics];
    })
  );
  const summary = { id, label, overall, segments };
  if (benchmarkSeries) summary.relativeToBenchmark = compareSeries(series, benchmarkSeries, overall);
  return summary;
}

function compareSeries(candidate, benchmark, candidateMetrics) {
  const benchmarkMetrics = calculateMetrics(benchmark);
  const activeReturns = candidate.map((row, index) => row.return - benchmark[index].return);
  const trackingError = standardDeviation(activeReturns) * Math.sqrt(12);
  const activeReturnStdDev = sampleStandardDeviation(activeReturns);
  const rolling = calculateRollingBeatRate(candidate, benchmark);
  return {
    excessCagrPct: round(candidateMetrics.cagrPct - benchmarkMetrics.cagrPct, 2),
    maxDrawdownDifferencePct: round(candidateMetrics.maxDrawdownPct - benchmarkMetrics.maxDrawdownPct, 2),
    trackingErrorPct: round(trackingError * 100, 2),
    informationRatio: trackingError > 0 ? round((mean(activeReturns) * 12) / trackingError, 3) : null,
    activeReturnTStat:
      activeReturnStdDev > 0
        ? round((mean(activeReturns) * Math.sqrt(activeReturns.length)) / activeReturnStdDev, 3)
        : null,
    rollingFiveYearBeatRatePct: rolling.beatRatePct,
    rollingFiveYearWindows: rolling.windows,
    worstRollingFiveYearExcessPct: rolling.worstExcessPct,
    bestRollingFiveYearExcessPct: rolling.bestExcessPct
  };
}

function evaluateCandidates(base, stress, longHistory) {
  const rows = base.candidates.map((candidate) => {
    const stressed = stress.candidates.find((item) => item.id === candidate.id);
    const historical = longHistory.candidates.find((item) => item.id === candidate.id);
    const checks = {
      overallExcessCagr:
        candidate.relativeToBenchmark.excessCagrPct >= CONFIG.selection.minimumOverallExcessCagrPct,
      positiveDevelopment: candidate.segments.development.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      positiveValidation: candidate.segments.validation.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      positiveHoldout: candidate.segments.holdout.excessCagrPct > CONFIG.selection.minimumSegmentExcessCagrPct,
      stressExcess: stressed.relativeToBenchmark.excessCagrPct > CONFIG.selection.minimumStressExcessCagrPct,
      longHistoryExcess:
        historical.relativeToBenchmark.excessCagrPct > CONFIG.selection.minimumLongHistoryExcessCagrPct,
      rollingFiveYearConsistency:
        candidate.relativeToBenchmark.rollingFiveYearBeatRatePct >= CONFIG.selection.minimumRollingFiveYearBeatRatePct,
      drawdownControl:
        candidate.relativeToBenchmark.maxDrawdownDifferencePct <= CONFIG.selection.maximumDrawdownPenaltyPct
    };
    return {
      id: candidate.id,
      label: candidate.label,
      passed: Object.values(checks).every(Boolean),
      checks,
      evidence: {
        cagrPct: candidate.overall.cagrPct,
        spyCagrPct: base.benchmark.overall.cagrPct,
        excessCagrPct: candidate.relativeToBenchmark.excessCagrPct,
        developmentExcessCagrPct: candidate.segments.development.excessCagrPct,
        validationExcessCagrPct: candidate.segments.validation.excessCagrPct,
        holdoutExcessCagrPct: candidate.segments.holdout.excessCagrPct,
        stressExcessCagrPct: stressed.relativeToBenchmark.excessCagrPct,
        longHistoryExcessCagrPct: historical.relativeToBenchmark.excessCagrPct,
        maxDrawdownPct: candidate.overall.maxDrawdownPct,
        spyMaxDrawdownPct: base.benchmark.overall.maxDrawdownPct,
        rollingFiveYearBeatRatePct: candidate.relativeToBenchmark.rollingFiveYearBeatRatePct
      }
    };
  });
  return {
    survivors: rows.filter((row) => row.passed).map((row) => row.id),
    rejected: rows.filter((row) => !row.passed).map((row) => row.id),
    rows
  };
}

function applyAnnualDrag(returns, annualDragPct) {
  return applyImplementationCosts(returns, annualDragPct, new Map(), 0);
}

function applyImplementationCosts(returns, annualDragPct, turnoverByMonth, turnoverCostPerOneWayPct) {
  const monthlyMultiplier = (1 - annualDragPct / 100) ** (1 / 12);
  return new Map(
    [...returns.entries()].map(([month, value]) => {
      const turnoverMultiplier = 1 - (turnoverByMonth.get(month) ?? 0) * turnoverCostPerOneWayPct / 100;
      return [month, (1 + value) * monthlyMultiplier * turnoverMultiplier - 1];
    })
  );
}

function calculateMetrics(series) {
  if (!series.length) return emptyMetrics();
  let equity = CONFIG.initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  const excessReturns = [];
  for (const row of series) {
    equity *= 1 + row.return;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    excessReturns.push(row.return - row.rf);
  }
  const years = series.length / 12;
  const cagr = (equity / CONFIG.initialCapital) ** (1 / years) - 1;
  const annualizedVolatility = standardDeviation(series.map((row) => row.return)) * Math.sqrt(12);
  const excessVolatility = standardDeviation(excessReturns) * Math.sqrt(12);
  return {
    from: series[0].month,
    to: series.at(-1).month,
    months: series.length,
    endingEquity: round(equity, 2),
    totalReturnPct: round((equity / CONFIG.initialCapital - 1) * 100, 2),
    cagrPct: round(cagr * 100, 2),
    maxDrawdownPct: round(maxDrawdown * 100, 2),
    annualizedVolatilityPct: round(annualizedVolatility * 100, 2),
    sharpe: excessVolatility > 0 ? round((mean(excessReturns) * 12) / excessVolatility, 3) : null,
    calmar: maxDrawdown > 0 ? round(cagr / maxDrawdown, 3) : null
  };
}

function calculateRollingBeatRate(candidate, benchmark) {
  const outcomes = [];
  for (let index = CONFIG.rollingWindowMonths - 1; index < candidate.length; index += 1) {
    let candidateGrowth = 1;
    let benchmarkGrowth = 1;
    for (let offset = index - CONFIG.rollingWindowMonths + 1; offset <= index; offset += 1) {
      candidateGrowth *= 1 + candidate[offset].return;
      benchmarkGrowth *= 1 + benchmark[offset].return;
    }
    outcomes.push((candidateGrowth - benchmarkGrowth) * 100);
  }
  return {
    windows: outcomes.length,
    beatRatePct: outcomes.length ? round((outcomes.filter((value) => value > 0).length / outcomes.length) * 100, 2) : 0,
    worstExcessPct: outcomes.length ? round(Math.min(...outcomes), 2) : null,
    bestExcessPct: outcomes.length ? round(Math.max(...outcomes), 2) : null
  };
}

async function loadFrenchDataset(id, spec) {
  const url = `${FRENCH_BASE_URL}/${spec.filename}`;
  const zipPath = path.join(CACHE_DIR, spec.filename);
  let bytes;
  try {
    const stat = await fs.stat(zipPath);
    if (Date.now() - stat.mtimeMs > SOURCE_CACHE_MAX_AGE_MS) throw new Error("stale cache");
    bytes = await fs.readFile(zipPath);
  } catch {
    const response = await fetch(url, {
      headers: { "User-Agent": "Joyanggi toss-invest-v2 research contact: github.com/Joyanggi" },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`${id} 다운로드 실패: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(zipPath, bytes);
  }
  const { stdout } = await execFileAsync("unzip", ["-p", zipPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  const rows = id === "factors" ? parseFactorCsv(stdout) : parseFrenchMonthlyCsv(stdout);
  if (rows.length < 300) throw new Error(`${id} 월별 행이 부족합니다: ${rows.length}`);
  return { id, url, sha256: createHash("sha256").update(bytes).digest("hex"), rows };
}

function parseFrenchMonthlyCsv(text) {
  const lines = text.replaceAll("\r", "").split("\n");
  const marker = lines.findIndex((line) => line.includes("Average Value Weighted Returns -- Monthly"));
  if (marker < 0) throw new Error("가치가중 월수익률 구간을 찾지 못했습니다.");
  const headers = splitCsv(lines[marker + 1]).slice(1);
  const rows = [];
  for (let index = marker + 2; index < lines.length; index += 1) {
    if (!/^\s*\d{6},/.test(lines[index])) break;
    const cells = splitCsv(lines[index]);
    const month = cells[0];
    const values = Object.fromEntries(headers.map((header, offset) => [header, parseFrenchPercent(cells[offset + 1])]));
    rows.push({ month, values });
  }
  return rows;
}

function parseFactorCsv(text) {
  const lines = text.replaceAll("\r", "").split("\n");
  const headerIndex = lines.findIndex((line) => line.includes("Mkt-RF") && line.includes("RF"));
  if (headerIndex < 0) throw new Error("Fama-French 팩터 월수익률 헤더를 찾지 못했습니다.");
  const headers = splitCsv(lines[headerIndex]).slice(1);
  const rows = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (!/^\s*\d{6},/.test(lines[index])) break;
    const cells = splitCsv(lines[index]);
    rows.push({
      month: cells[0],
      values: Object.fromEntries(headers.map((header, offset) => [header, parseFrenchPercent(cells[offset + 1])]))
    });
  }
  return rows;
}

function splitCsv(line) {
  return line.split(",").map((cell) => cell.trim());
}

function parseFrenchPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= -99) return null;
  return number / 100;
}

function selectColumn(rows, column) {
  const output = new Map();
  for (const row of rows) {
    const value = row.values[column];
    if (Number.isFinite(value)) output.set(row.month, value);
  }
  if (!output.size) throw new Error(`${column} 열을 찾지 못했습니다.`);
  return output;
}

async function loadSpyMonthlyReturns() {
  const cachePath = path.join(CACHE_DIR, "SPY-daily-adjusted.json");
  let candles;
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (Date.now() - new Date(cached.createdAt).getTime() < 6 * 60 * 60_000) candles = cached.candles;
  } catch {}
  if (!candles) {
    const url = new URL("https://query2.finance.yahoo.com/v8/finance/chart/SPY");
    url.searchParams.set("period1", "0");
    url.searchParams.set("period2", String(Math.floor(Date.now() / 1000)));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "history");
    url.searchParams.set("includeAdjustedClose", "true");
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
      signal: AbortSignal.timeout(30_000)
    });
    const payload = await response.json();
    if (!response.ok || payload.chart?.error) throw new Error(payload.chart?.error?.description || `SPY HTTP ${response.status}`);
    const result = payload.chart?.result?.[0];
    const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    candles = (result?.timestamp ?? [])
      .map((timestamp, index) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        close: Number(adjusted[index])
      }))
      .filter((row) => row.close > 0);
    await fs.writeFile(cachePath, JSON.stringify({ createdAt: new Date().toISOString(), candles }));
  }
  const closeByMonth = new Map();
  for (const candle of candles) closeByMonth.set(candle.date.slice(0, 7).replace("-", ""), candle.close);
  const monthlyCloses = [...closeByMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, close]) => ({ month, close }));
  const returns = new Map();
  for (let index = 1; index < monthlyCloses.length; index += 1) {
    returns.set(monthlyCloses[index].month, monthlyCloses[index].close / monthlyCloses[index - 1].close - 1);
  }
  return {
    source: "Yahoo Finance SPY adjusted daily close aggregated to month-end",
    monthlyCloses,
    closeByMonth,
    returns
  };
}

function intersectMonths(maps) {
  const [first, ...rest] = maps;
  return [...first.keys()].filter((month) => rest.every((map) => map.has(month))).sort();
}

function findMissingMonths(months) {
  const missing = [];
  for (let index = 1; index < months.length; index += 1) {
    let expected = nextMonth(months[index - 1]);
    while (expected < months[index]) {
      missing.push(expected);
      expected = nextMonth(expected);
    }
  }
  return missing;
}

function nextMonth(month) {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(4, 6));
  return value === 12 ? `${year + 1}01` : `${year}${String(value + 1).padStart(2, "0")}`;
}

function previousMonth(month) {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(4, 6));
  return value === 1 ? `${year - 1}12` : `${year}${String(value - 1).padStart(2, "0")}`;
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
    annualizedVolatilityPct: null,
    sharpe: null,
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
  CANDIDATES,
  CONFIG,
  applyAnnualDrag,
  applyImplementationCosts,
  calculateMetrics,
  parseFactorCsv,
  parseFrenchMonthlyCsv,
  selectDynamicFactorWeights
};
