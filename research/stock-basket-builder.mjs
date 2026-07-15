#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEC_CACHE_DIR = path.join(os.tmpdir(), "toss-invest-v2-sec-companyfacts-cache");
const PRICE_CACHE_DIR = path.join(os.tmpdir(), "toss-invest-v2-backtest-cache");
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "Joyanggi Research codex@openai.com";

const CONFIG = Object.freeze({
  asOfDate: "2026-07-15",
  priceAsOfMonth: "202606",
  targetHoldings: 30,
  maximumSectorWeightPct: 20,
  retentionRank: 45,
  factorSleeveFraction: 0.2,
  maximumFactAgeDays: 550,
  factors: Object.freeze(["momentum", "profitability", "value", "investment"])
});

const TAGS = Object.freeze({
  equity: Object.freeze([
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
  ]),
  profitability: Object.freeze(["OperatingIncomeLoss", "NetIncomeLoss"]),
  assets: Object.freeze(["Assets"]),
  shares: Object.freeze(["EntityCommonStockSharesOutstanding"]),
  sharesFallback: Object.freeze(["WeightedAverageNumberOfDilutedSharesOutstanding"])
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const universePath = path.resolve(args.universe || path.join(HERE, "sp100-current-2026-07-15.json"));
  const outputPath = path.resolve(
    args.output || path.join(HERE, "results", "stock-basket-snapshot-2026-07-15.json")
  );
  const asOfDate = args.asOf || CONFIG.asOfDate;
  const priceAsOfMonth = args.priceMonth || CONFIG.priceAsOfMonth;
  validateDate(asOfDate);
  validateMonth(priceAsOfMonth);

  const universeRows = JSON.parse(await fs.readFile(universePath, "utf8"));
  const universe = universeRows.map(([symbol, sector]) => ({ symbol, sector }));
  validateUniverse(universe);
  const currentHoldings = args.current
    ? JSON.parse(await fs.readFile(path.resolve(args.current), "utf8"))
    : [];

  await fs.mkdir(SEC_CACHE_DIR, { recursive: true });
  const tickerMap = await loadSecTickerMap();
  const records = [];
  const exclusions = [];
  for (const [index, company] of universe.entries()) {
    try {
      const normalized = normalizeTicker(company.symbol);
      const mapping = tickerMap.get(normalized);
      if (!mapping) throw new Error("SEC CIK 매핑 없음");
      const [companyFacts, prices] = await Promise.all([
        loadCompanyFacts(mapping.cik),
        loadMonthlyPrices(company.symbol, priceAsOfMonth)
      ]);
      const built = buildCompanyRecord({
        company,
        mapping,
        companyFacts,
        prices,
        asOfDate,
        priceAsOfMonth
      });
      if (built.eligible) records.push(built.record);
      else exclusions.push({ symbol: company.symbol, sector: company.sector, reasons: built.reasons });
    } catch (error) {
      exclusions.push({ symbol: company.symbol, sector: company.sector, reasons: [error.message] });
    }
    process.stderr.write(`종목 바스켓 데이터 ${index + 1}/${universe.length}\n`);
    await sleep(110);
  }

  if (records.length < CONFIG.targetHoldings * 2) {
    throw new Error(`적격 종목이 너무 적습니다: ${records.length}/${universe.length}`);
  }
  const scored = scoreRecords(records);
  const selected = selectBasket(scored, currentHoldings, {
    targetHoldings: CONFIG.targetHoldings,
    maximumSectorWeightPct: CONFIG.maximumSectorWeightPct,
    retentionRank: CONFIG.retentionRank
  });
  const factorSleeves = buildFactorSleeves(scored, CONFIG.factorSleeveFraction);
  const output = {
    generatedAt: new Date().toISOString(),
    asOfDate,
    priceAsOfMonth,
    approval: {
      researchOnly: true,
      liveTradingApproved: false,
      reason: "실거래 ETF 프록시가 사전 기준을 통과하지 못했고 종목 바스켓의 포인트인타임 백테스트가 아직 없음"
    },
    methodology: {
      universe: "2026-07-15 현재 S&P 100 스냅샷",
      universePath: path.relative(path.dirname(outputPath), universePath),
      pointInTimeRule: "SEC filed 날짜가 asOfDate 이하인 공시값만 사용",
      momentum: "기준월 직전 1개월을 제외한 12-2 수정주가 수익률",
      profitability: "최근 공개 연간 영업이익/자기자본, 영업이익이 없으면 순이익 사용",
      value: "최근 공개 자기자본/기준월 시가총액",
      investment: "최근 두 공개 연간 총자산의 증가율이 낮을수록 높은 점수",
      score: "네 팩터의 전체 유니버스 백분위 점수를 동일비중 평균",
      construction: {
        targetHoldings: CONFIG.targetHoldings,
        weighting: "동일비중",
        maximumSectorWeightPct: CONFIG.maximumSectorWeightPct,
        retentionRank: CONFIG.retentionRank,
        rebalance: "월 1회 연구 스냅샷"
      },
      limitations: [
        "현재 유니버스의 현재 시점 스냅샷이므로 역사적 백테스트에 재사용 금지",
        "SEC XBRL 태그 차이 때문에 수익성은 일부 기업에서 순이익으로 대체",
        "수정주가와 최신 발행주식수의 결합은 현재 시점 근사 시가총액",
        "세금·환율·체결비용·Toss 주문 가능 여부 미반영"
      ]
    },
    dataDiagnostics: {
      requestedCompanies: universe.length,
      eligibleCompanies: scored.length,
      excludedCompanies: exclusions.length,
      selectedCompanies: selected.length,
      secUserAgentDeclared: Boolean(SEC_USER_AGENT),
      source: "SEC Company Facts API and Yahoo Finance adjusted monthly close"
    },
    basket: selected,
    factorSleeves,
    rankedEligible: scored,
    exclusions
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${outputPath}\n`);
}

function buildCompanyRecord({ company, mapping, companyFacts, prices, asOfDate, priceAsOfMonth }) {
  const reasons = [];
  const latestPrice = prices.closeByMonth.get(priceAsOfMonth);
  const momentumEndMonth = offsetMonth(priceAsOfMonth, -1);
  const momentumStartMonth = offsetMonth(priceAsOfMonth, -12);
  const momentumEndPrice = prices.closeByMonth.get(momentumEndMonth);
  const momentumStartPrice = prices.closeByMonth.get(momentumStartMonth);
  if (!(latestPrice > 0)) reasons.push("기준월 수정종가 없음");
  if (!(momentumEndPrice > 0 && momentumStartPrice > 0)) reasons.push("12-2 모멘텀 가격 이력 부족");

  const equityFact = selectLatestInstantFact(companyFacts, TAGS.equity, "USD", asOfDate);
  const annualEquityFact = selectAnnualFacts(companyFacts, TAGS.equity, "USD", asOfDate)[0] ?? null;
  const sharesFact = [
    selectLatestInstantFact(companyFacts, TAGS.shares, "shares", asOfDate, "dei"),
    selectLatestAnnualFact(companyFacts, TAGS.sharesFallback, "shares", asOfDate)
  ].filter(Boolean).sort(compareTaggedFactsLatest)[0] ?? null;
  const profitabilityFact = selectLatestAnnualFact(companyFacts, TAGS.profitability, "USD", asOfDate);
  const annualAssets = selectAnnualFacts(companyFacts, TAGS.assets, "USD", asOfDate).slice(0, 2);
  if (!equityFact) reasons.push("자기자본 공시 없음");
  if (!annualEquityFact) reasons.push("연간 자기자본 공시 없음");
  if (!sharesFact) reasons.push("발행주식수 공시 없음");
  if (!profitabilityFact) reasons.push("연간 수익성 공시 없음");
  if (annualAssets.length < 2) reasons.push("연간 총자산 2개년 공시 부족");

  const factsToCheck = [equityFact, annualEquityFact, sharesFact, profitabilityFact, ...annualAssets].filter(Boolean);
  for (const fact of factsToCheck) {
    if (fact.filed > asOfDate) reasons.push(`${fact.tag} 미래 공시 혼입`);
    if (daysBetween(fact.filed, asOfDate) > CONFIG.maximumFactAgeDays) {
      reasons.push(`${fact.tag} 공시가 ${CONFIG.maximumFactAgeDays}일보다 오래됨`);
    }
  }

  const equity = equityFact?.val;
  const shares = sharesFact?.val;
  const marketCap = latestPrice * shares;
  const momentum = momentumEndPrice / momentumStartPrice - 1;
  const profitability = profitabilityFact?.val / annualEquityFact?.val;
  const value = equity / marketCap;
  const assetGrowth = annualAssets.length === 2
    ? annualAssets[0].val / annualAssets[1].val - 1
    : null;
  if (!(equity > 0)) reasons.push("자기자본이 양수가 아님");
  if (!(shares > 0)) reasons.push("발행주식수가 양수가 아님");
  if (!(marketCap > 0)) reasons.push("시가총액 계산 불가");
  for (const [name, valueToCheck] of Object.entries({ momentum, profitability, value, assetGrowth })) {
    if (!Number.isFinite(valueToCheck)) reasons.push(`${name} 계산 불가`);
  }

  if (reasons.length) return { eligible: false, reasons: [...new Set(reasons)] };
  return {
    eligible: true,
    record: {
      symbol: company.symbol,
      companyName: mapping.title,
      sector: company.sector,
      cik: mapping.cik,
      raw: {
        momentum,
        profitability,
        value,
        assetGrowth,
        marketCap,
        price: latestPrice
      },
      sourceFacts: {
        equity: compactFact(equityFact),
        annualEquity: compactFact(annualEquityFact),
        shares: compactFact(sharesFact),
        profitability: compactFact(profitabilityFact),
        latestAssets: compactFact(annualAssets[0]),
        priorAssets: compactFact(annualAssets[1])
      },
      priceSourceHash: prices.sha256
    }
  };
}

function scoreRecords(records) {
  const factorDefinitions = {
    momentum: { key: "momentum", higherIsBetter: true },
    profitability: { key: "profitability", higherIsBetter: true },
    value: { key: "value", higherIsBetter: true },
    investment: { key: "assetGrowth", higherIsBetter: false }
  };
  const scored = records.map((record) => ({ ...record, factorScores: {} }));
  for (const [factor, definition] of Object.entries(factorDefinitions)) {
    const values = scored.map((record) => record.raw[definition.key]);
    for (const record of scored) {
      const percentile = percentileRank(values, record.raw[definition.key]);
      record.factorScores[factor] = round(definition.higherIsBetter ? percentile : 100 - percentile, 4);
    }
  }
  for (const record of scored) {
    record.compositeScore = round(mean(Object.values(record.factorScores)), 4);
  }
  scored.sort((a, b) => b.compositeScore - a.compositeScore || a.symbol.localeCompare(b.symbol));
  return scored.map((record, index) => ({ ...record, overallRank: index + 1 }));
}

function selectBasket(scored, currentHoldings, options) {
  const current = new Set((currentHoldings ?? []).map((item) => typeof item === "string" ? item : item.symbol));
  const maxSectorCount = Math.floor(options.targetHoldings * options.maximumSectorWeightPct / 100);
  const selected = [];
  const selectedSymbols = new Set();
  const sectorCounts = new Map();
  const canAdd = (record) => (sectorCounts.get(record.sector) ?? 0) < maxSectorCount;
  const add = (record, source) => {
    if (selectedSymbols.has(record.symbol) || !canAdd(record)) return false;
    selected.push({ ...record, selectionSource: source });
    selectedSymbols.add(record.symbol);
    sectorCounts.set(record.sector, (sectorCounts.get(record.sector) ?? 0) + 1);
    return true;
  };

  for (const record of scored) {
    if (current.has(record.symbol) && record.overallRank <= options.retentionRank) add(record, "retained");
  }
  for (const record of scored) {
    if (selected.length >= options.targetHoldings) break;
    add(record, "new_or_ranked");
  }
  if (selected.length !== options.targetHoldings) {
    throw new Error(`업종 한도 안에서 목표 ${options.targetHoldings}종목을 채우지 못했습니다: ${selected.length}`);
  }
  const weight = 100 / selected.length;
  return selected
    .sort((a, b) => a.overallRank - b.overallRank)
    .map((record) => ({
      symbol: record.symbol,
      companyName: record.companyName,
      sector: record.sector,
      targetWeightPct: round(weight, 4),
      overallRank: record.overallRank,
      compositeScore: record.compositeScore,
      factorScores: record.factorScores,
      selectionSource: record.selectionSource,
      sourceFacts: record.sourceFacts
    }));
}

function buildFactorSleeves(scored, fraction) {
  const count = Math.max(1, Math.ceil(scored.length * fraction));
  return Object.fromEntries(
    CONFIG.factors.map((factor) => [
      factor,
      [...scored]
        .sort(
          (a, b) => b.factorScores[factor] - a.factorScores[factor] || a.symbol.localeCompare(b.symbol)
        )
        .slice(0, count)
        .map((record) => record.symbol)
    ])
  );
}

function selectLatestInstantFact(companyFacts, tags, unit, asOfDate, namespace = "us-gaap") {
  return tags
    .flatMap((tag, tagPriority) =>
      factUnits(companyFacts, namespace, tag, unit)
        .filter((fact) => isAllowedFact(fact, asOfDate) && !fact.start)
        .map((fact) => ({ ...fact, tag, namespace, tagPriority }))
    )
    .sort(compareTaggedFactsLatest)[0] ?? null;
}

function selectLatestAnnualFact(companyFacts, tags, unit, asOfDate) {
  return tags
    .flatMap((tag, tagPriority) =>
      factUnits(companyFacts, "us-gaap", tag, unit)
        .filter((fact) => isAnnualFact(fact, asOfDate))
        .map((fact) => ({ ...fact, tag, namespace: "us-gaap", tagPriority }))
    )
    .sort(compareTaggedFactsLatest)[0] ?? null;
}

function selectAnnualFacts(companyFacts, tags, unit, asOfDate) {
  const byEnd = new Map();
  for (const [tagPriority, tag] of tags.entries()) {
    for (const fact of factUnits(companyFacts, "us-gaap", tag, unit).filter((item) => isAnnualInstantFact(item, asOfDate))) {
      const tagged = { ...fact, tag, namespace: "us-gaap", tagPriority };
      const existing = byEnd.get(fact.end);
      if (!existing || compareTaggedFactsLatest(tagged, existing) < 0) byEnd.set(fact.end, tagged);
    }
  }
  return [...byEnd.values()].sort(compareTaggedFactsLatest);
}

function factUnits(companyFacts, namespace, tag, unit) {
  return companyFacts.facts?.[namespace]?.[tag]?.units?.[unit] ?? [];
}

function isAllowedFact(fact, asOfDate) {
  return ["10-K", "10-Q", "20-F", "40-F", "6-K"].includes(fact.form) &&
    fact.filed <= asOfDate && fact.end <= asOfDate && Number.isFinite(fact.val);
}

function isAnnualFact(fact, asOfDate) {
  if (!isAllowedFact(fact, asOfDate) || !fact.start) return false;
  const duration = daysBetween(fact.start, fact.end);
  return ["10-K", "20-F", "40-F"].includes(fact.form) && duration >= 300 && duration <= 430;
}

function isAnnualInstantFact(fact, asOfDate) {
  return isAllowedFact(fact, asOfDate) && ["10-K", "20-F", "40-F"].includes(fact.form) && fact.fp === "FY";
}

function compareFactsLatest(a, b) {
  return b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed);
}

function compareTaggedFactsLatest(a, b) {
  return compareFactsLatest(a, b) || a.tagPriority - b.tagPriority;
}

function compactFact(fact) {
  return {
    tag: fact.tag,
    form: fact.form,
    periodEnd: fact.end,
    filed: fact.filed,
    accession: fact.accn,
    value: fact.val
  };
}

async function loadSecTickerMap() {
  const cachePath = path.join(SEC_CACHE_DIR, "company_tickers.json");
  const payload = await loadCachedJson(
    cachePath,
    "https://www.sec.gov/files/company_tickers.json",
    24 * 60 * 60_000,
    true
  );
  return new Map(
    Object.values(payload).map((entry) => [
      normalizeTicker(entry.ticker),
      { cik: String(entry.cik_str).padStart(10, "0"), title: entry.title }
    ])
  );
}

async function loadCompanyFacts(cik) {
  return loadCachedJson(
    path.join(SEC_CACHE_DIR, `CIK${cik}.json`),
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    24 * 60 * 60_000,
    true
  );
}

async function loadCachedJson(cachePath, url, maximumAgeMs, secRequest = false) {
  try {
    const stat = await fs.stat(cachePath);
    if (Date.now() - stat.mtimeMs <= maximumAgeMs) return JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch {}
  const response = await fetch(url, {
    headers: secRequest
      ? { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate", Accept: "application/json" }
      : { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  const payload = await response.json();
  await fs.writeFile(cachePath, JSON.stringify(payload));
  return payload;
}

async function loadMonthlyPrices(symbol, priceAsOfMonth) {
  const yahooSymbol = normalizeTicker(symbol);
  const existingPath = path.join(PRICE_CACHE_DIR, `${yahooSymbol}-10y.json`);
  let candles;
  try {
    const cached = JSON.parse(await fs.readFile(existingPath, "utf8"));
    candles = cached.candles;
  } catch {}
  if (!candles) {
    const localCache = path.join(SEC_CACHE_DIR, `${yahooSymbol}-prices.json`);
    const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`);
    url.searchParams.set("period1", "0");
    url.searchParams.set("period2", String(Math.floor(Date.now() / 1000)));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "history");
    url.searchParams.set("includeAdjustedClose", "true");
    const payload = await loadCachedJson(localCache, url.toString(), 6 * 60 * 60_000);
    const result = payload.chart?.result?.[0];
    const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    candles = (result?.timestamp ?? [])
      .map((timestamp, index) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        close: Number(adjusted[index])
      }))
      .filter((row) => row.close > 0);
  }
  const closeByMonth = new Map();
  for (const candle of candles) {
    const month = candle.date.slice(0, 7).replace("-", "");
    if (month <= priceAsOfMonth) closeByMonth.set(month, candle.close);
  }
  return {
    closeByMonth,
    sha256: createHash("sha256").update(JSON.stringify([...closeByMonth.entries()])).digest("hex")
  };
}

function percentileRank(values, target) {
  if (values.length <= 1) return 50;
  const lower = values.filter((value) => value < target).length;
  const equal = values.filter((value) => value === target).length;
  return (lower + (equal - 1) / 2) / (values.length - 1) * 100;
}

function validateUniverse(universe) {
  if (universe.length < CONFIG.targetHoldings * 2) throw new Error("유니버스가 너무 작습니다.");
  const symbols = new Set();
  for (const company of universe) {
    if (!company.symbol || !company.sector) throw new Error("유니버스 행에 종목 또는 업종이 없습니다.");
    if (symbols.has(company.symbol)) throw new Error(`유니버스 종목 중복: ${company.symbol}`);
    symbols.add(company.symbol);
  }
}

function normalizeTicker(symbol) {
  return symbol.toUpperCase().replaceAll(".", "-");
}

function offsetMonth(month, offset) {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(4, 6));
  const total = year * 12 + value - 1 + offset;
  return `${Math.floor(total / 12)}${String(total % 12 + 1).padStart(2, "0")}`;
}

function daysBetween(first, second) {
  return (new Date(`${second}T00:00:00Z`) - new Date(`${first}T00:00:00Z`)) / 86_400_000;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error(`잘못된 날짜입니다: ${value}`);
  }
}

function validateMonth(value) {
  if (!/^\d{6}$/.test(value) || Number(value.slice(4, 6)) < 1 || Number(value.slice(4, 6)) > 12) {
    throw new Error(`잘못된 월입니다: ${value}`);
  }
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  buildFactorSleeves,
  percentileRank,
  scoreRecords,
  selectAnnualFacts,
  selectBasket,
  selectLatestAnnualFact,
  selectLatestInstantFact
};
