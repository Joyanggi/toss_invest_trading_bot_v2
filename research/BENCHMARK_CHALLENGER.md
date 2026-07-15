# S&P 500 benchmark challenger research

V2의 목표를 `플러스 수익 전략`에서 **거래비용 차감 후 S&P 500 Total Return보다 높은 장기 복리수익**으로 다시 정의한 첫 독립 백테스트다. 결과가 좋아 보이도록 파라미터를 탐색하지 않고, 학술 연구에서 널리 쓰이는 월간 모멘텀·추세·변동성 관리 규칙을 결과 확인 전에 고정했다.

## 테스트 조건

- 기간: 2008-07-01~2026-07-13, 4,535거래일
- 데이터: Yahoo Finance 수정 일봉
- 벤치마크: SPY 100% 매수보유
- 체결: 월말 종가로 신호 계산, 다음 거래일 수정 시가로 체결
- 비용: 편도 0.1%, 비용 민감도는 편도 0.2%
- 배당과 ETF 운용보수: 수정주가에 반영
- 세금, 원/달러 환율, 실제 호가 스프레드와 Toss 주문 제약: 미반영
- 구간: 개발 2008-07~2013, 검증 2014~2019, 홀드아웃 2020~2026-07

개별 종목의 현재 구성원을 과거에 투영하는 생존편향을 피하기 위해 장기간 상장된 ETF만 사용했다. 다만 현재까지 생존했고 널리 알려진 ETF를 사후 선택한 **ETF 선택 편향**은 남아 있다.

## 사전 고정 후보

1. `sector_momentum_top3`: 9개 전통 섹터의 12-1·6-1개월 모멘텀 상위 3개. BIL보다 약한 자리는 BIL로 대체
2. `sector_momentum_trend`: 상위 섹터 중 BIL보다 강하고 200일선 위인 것만 보유
3. `style_momentum_top2`: SPY·QQQ·IWM·MDY·IWD·IWF 중 모멘텀 상위 2개. BIL보다 약한 자리는 BIL로 대체
4. `dual_momentum`: 주식 ETF의 절대·상대 모멘텀이 약하면 IEF·GLD·BIL로 이동
5. `spy_trend_volatility`: SPY 200일 추세와 63일 변동성으로 SPY·SSO·BIL 조합
6. `sector_trend_vol_ensemble`: 2번과 5번을 50:50으로 결합

## 사전 합격 기준

아래 조건을 전부 만족해야 생존 후보로 인정한다.

- 전체 CAGR이 SPY보다 연 1%p 이상 높음
- 개발·검증·홀드아웃 각각의 초과 CAGR이 모두 양수
- 비용을 두 배로 올려도 전체 초과 CAGR이 양수
- 월별로 측정한 5년 구간의 60% 이상에서 SPY를 이김
- 최대낙폭이 SPY보다 5%p 넘게 나쁘지 않음

## 결과

SPY는 CAGR 12.39%, 최대낙폭 47.17%였다.

| 전략 | CAGR | SPY 대비 | 최대낙폭 | 검증 초과 CAGR | 홀드아웃 초과 CAGR | 5년 승률 | 판정 |
|---|---:|---:|---:|---:|---:|---:|---|
| 섹터 모멘텀 상위 3개 | 8.20% | -4.19%p | 36.48% | -3.53%p | -6.61%p | 1.91% | 탈락 |
| 섹터 모멘텀 + 추세 | 7.51% | -4.88%p | 20.06% | -4.86%p | -8.06%p | 3.18% | 탈락 |
| 스타일 모멘텀 상위 2개 | 11.77% | -0.62%p | 29.73% | -2.63%p | -2.38%p | 7.01% | 탈락 |
| 듀얼 모멘텀 | 13.67% | +1.28%p | 29.72% | +1.52%p | -3.36%p | 52.23% | 탈락 |
| SPY 추세·변동성 관리 | 9.90% | -2.49%p | 30.18% | -4.97%p | -5.73%p | 18.47% | 탈락 |
| 섹터 추세 + 변동성 앙상블 | 8.81% | -3.58%p | 20.91% | -4.80%p | -6.75%p | 1.91% | 탈락 |

### 선별 결론

**사전 기준을 모두 통과한 후보는 0개다.**

듀얼 모멘텀만 전체 CAGR과 비용 2배 조건에서 SPY를 앞섰다. 그러나 평균 목표 비중의 56.68%가 QQQ였고, 2020년 이후 홀드아웃에서 SPY보다 연 3.36%p 뒤졌으며 5년 구간 승률도 52.23%에 그쳤다. 장기적으로 반복 가능한 초과수익이라기보다 특정 기간의 성장주 집중 효과일 가능성을 배제할 수 없어 실전 후보로 올리지 않는다.

낙폭을 크게 줄인 전략들은 대부분 강세장의 시장 노출을 함께 줄여 절대 복리수익이 낮아졌다. 이는 `더 안전한 전략`과 `S&P 500보다 높은 수익 전략`이 같은 목표가 아니라는 점을 다시 보여준다.

## 다음 연구 방향

이번 홀드아웃을 확인했으므로 같은 2020~2026 구간을 보면서 이 여섯 전략의 숫자를 조정하지 않는다. 다음 라운드는 가격 기반 ETF 타이밍을 미세 조정하는 대신, 별도 데이터와 경제적 근거를 가진 다음 가족으로 넘어간다.

1. 과거 시점별 S&P 500 구성 종목을 사용하는 업종중립 품질·모멘텀·가치 멀티팩터
2. 실제 공시일 기준 수익성, 현금흐름, 부채, 회계발생액 데이터
3. 종목 순위 진입·유지 구간을 둔 저회전율 30~80종목 포트폴리오
4. 미국 외 시장 또는 순차적 워크포워드로 재현성을 확인하는 외부 검증

포인트인타임 구성 종목과 공시 데이터가 준비되지 않으면 현재 구성 종목으로 장기 종목선별 백테스트를 만들어 숫자를 부풀리지 않는다.

후속 라운드는 공식 CRSP 기반 포인트인타임 연구 포트폴리오를 사용해 진행했으며, 결과는 [기관식 멀티팩터 연구](INSTITUTIONAL_FACTOR.md)에 정리했다.

## 재현

```bash
npm run research:benchmark
npm run research:benchmark:verify
```

원자료는 [백테스트 결과 JSON](results/benchmark-challenger-2026-07-15.json)에 있다.

## 연구 근거

- [SPIVA U.S. Year-End 2025](https://www.spglobal.com/spdji/en/spiva/article/spiva-us/)
- [Fama and French, A Five-Factor Asset Pricing Model](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2287202)
- [Novy-Marx, The Gross Profitability Premium](https://www.nber.org/papers/w15940)
- [Moskowitz, Ooi and Pedersen, Time Series Momentum](https://w4.stern.nyu.edu/facdir/lpederse/papers/TimeSeriesMomentum.pdf)
- [Kenneth French Data Library, Momentum Factor](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/det_mom_factor_daily.html)
- [Bailey and Lopez de Prado, Backtest Overfitting](https://escholarship.org/uc/item/9tq3327h)
