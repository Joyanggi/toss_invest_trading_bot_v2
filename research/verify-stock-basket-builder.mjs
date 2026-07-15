#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG,
  buildFactorSleeves,
  percentileRank,
  scoreRecords,
  selectAnnualFacts,
  selectBasket,
  selectLatestAnnualFact,
  selectLatestInstantFact
} from "./stock-basket-builder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const resultPath = path.join(HERE, "results", "stock-basket-snapshot-2026-07-15.json");

assert.equal(percentileRank([1, 2, 3], 1), 0);
assert.equal(percentileRank([1, 2, 3], 2), 50);
assert.equal(percentileRank([1, 2, 3], 3), 100);

const syntheticFacts = {
  facts: {
    "us-gaap": {
      Assets: {
        units: {
          USD: [
            { end: "2024-12-31", val: 100, filed: "2025-02-01", form: "10-K", fp: "FY" },
            { end: "2025-12-31", val: 110, filed: "2026-02-01", form: "10-K", fp: "FY" },
            { end: "2026-12-31", val: 120, filed: "2027-02-01", form: "10-K", fp: "FY" }
          ]
        }
      },
      OperatingIncomeLoss: {
        units: {
          USD: [
            {
              start: "2024-01-01",
              end: "2024-12-31",
              val: 10,
              filed: "2025-02-01",
              form: "10-K",
              fp: "FY"
            },
            {
              start: "2025-01-01",
              end: "2025-12-31",
              val: 11,
              filed: "2026-02-01",
              form: "10-K",
              fp: "FY"
            }
          ]
        }
      },
      StockholdersEquity: {
        units: {
          USD: [
            { end: "2025-12-31", val: 50, filed: "2026-02-01", form: "10-K", fp: "FY" },
            { end: "2026-03-31", val: 55, filed: "2026-05-01", form: "10-Q", fp: "Q1" },
            { end: "2026-06-30", val: 60, filed: "2026-08-01", form: "10-Q", fp: "Q2" }
          ]
        }
      }
    }
  }
};
assert.equal(selectAnnualFacts(syntheticFacts, ["Assets"], "USD", "2026-07-15").length, 2);
assert.equal(selectAnnualFacts(syntheticFacts, ["Assets"], "USD", "2026-07-15")[0].val, 110);
assert.equal(
  selectLatestAnnualFact(syntheticFacts, ["OperatingIncomeLoss"], "USD", "2026-07-15").val,
  11
);
assert.equal(
  selectLatestInstantFact(syntheticFacts, ["StockholdersEquity"], "USD", "2026-07-15").val,
  55,
  "기준일 이후 공시가 혼입됐습니다."
);

const tagFallbackFacts = structuredClone(syntheticFacts);
tagFallbackFacts.facts["us-gaap"].NetIncomeLoss = {
  units: {
    USD: [
      {
        start: "2025-01-01",
        end: "2025-12-31",
        val: 9,
        filed: "2026-03-01",
        form: "10-K",
        fp: "FY"
      }
    ]
  }
};
assert.equal(
  selectLatestAnnualFact(
    tagFallbackFacts,
    ["OperatingIncomeLoss", "NetIncomeLoss"],
    "USD",
    "2026-07-15"
  ).tag,
  "NetIncomeLoss",
  "오래된 우선 태그가 최신 보조 태그를 가렸습니다."
);

const syntheticRecords = Array.from({ length: 80 }, (_, index) => ({
  symbol: `S${String(index).padStart(2, "0")}`,
  companyName: `Company ${index}`,
  sector: `Sector ${index % 8}`,
  raw: {
    momentum: index,
    profitability: 80 - index,
    value: index % 17,
    assetGrowth: index % 13
  },
  sourceFacts: {},
  priceSourceHash: "a".repeat(64)
}));
const scored = scoreRecords(syntheticRecords);
const basket = selectBasket(scored, [scored[40].symbol], {
  targetHoldings: 30,
  maximumSectorWeightPct: 20,
  retentionRank: 45
});
assert.equal(basket.length, 30);
assert.ok(basket.some((row) => row.symbol === scored[40].symbol && row.selectionSource === "retained"));
const sectorCounts = Object.groupBy(basket, (row) => row.sector);
assert.ok(Object.values(sectorCounts).every((rows) => rows.length <= 6));
assert.equal(buildFactorSleeves(scored, 0.2).momentum.length, 16);

const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
assert.equal(result.approval.researchOnly, true);
assert.equal(result.approval.liveTradingApproved, false);
assert.equal(result.asOfDate, CONFIG.asOfDate);
assert.equal(result.priceAsOfMonth, CONFIG.priceAsOfMonth);
assert.equal(result.basket.length, CONFIG.targetHoldings);
assert.ok(result.dataDiagnostics.eligibleCompanies >= CONFIG.targetHoldings * 2);
assert.equal(result.dataDiagnostics.selectedCompanies, CONFIG.targetHoldings);
assert.equal(result.dataDiagnostics.eligibleCompanies, 89);
assert.equal(new Set(result.basket.map((row) => row.symbol)).size, CONFIG.targetHoldings);
assert.deepEqual(
  result.basket.map((row) => row.symbol),
  [
    "QCOM", "BMY", "FDX", "AAPL", "GM", "GILD", "CSCO", "TXN", "AMGN", "VZ",
    "COP", "CVS", "UPS", "USB", "PFE", "UNP", "GD", "AMAT", "AVGO", "MMM",
    "CMCSA", "UNH", "GS", "DUK", "DE", "PG", "DIS", "KO", "BAC", "T"
  ],
  "고정 기준일의 연구 바스켓이 예기치 않게 바뀌었습니다."
);
assert.ok(result.basket.every((row) => row.targetWeightPct <= 5));
const actualSectorWeights = Object.groupBy(result.basket, (row) => row.sector);
assert.ok(
  Object.values(actualSectorWeights).every(
    (rows) => rows.reduce((total, row) => total + row.targetWeightPct, 0) <= CONFIG.maximumSectorWeightPct + 0.01
  )
);
for (const record of result.rankedEligible) {
  assert.ok(Object.values(record.sourceFacts).every((fact) => fact.filed <= result.asOfDate));
  assert.equal(
    record.sourceFacts.profitability.periodEnd,
    record.sourceFacts.annualEquity.periodEnd,
    `${record.symbol} 수익성과 자기자본의 연간 결산기간이 다릅니다.`
  );
  assert.match(record.priceSourceHash, /^[a-f0-9]{64}$/);
}
for (const factor of CONFIG.factors) {
  assert.ok(result.factorSleeves[factor].length >= 10);
}

process.stdout.write("포인트인타임 종목 바스켓 검증 통과\n");
