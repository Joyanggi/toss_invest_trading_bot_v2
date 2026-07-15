# ETF proxy validation and stock basket

기관식 French 연구 포트폴리오의 성과가 실제 주문 가능한 ETF에서도 재현되는지 먼저 확인하고, 그 결과와 별개로 향후 포인트인타임 검증에 사용할 종목 바스켓 엔진을 구축한 후속 연구다.

## 결론부터

- 실제 ETF 핵심 프록시 `MTUM·QUAL·VLUE`로 만든 두 후보는 **사전 기준을 모두 통과하지 못했다.**
- `COWZ`를 추가한 상위 2개 전략은 짧은 기간에 강했지만 COWZ는 French 투자 팩터가 아니며 표본도 102개월뿐이라 선별 대상에서 제외했다.
- 현재 S&P 100에서 30종목 연구 바스켓을 생성하는 엔진은 완성했다.
- 바스켓 결과에는 `liveTradingApproved: false`가 고정되어 있다. 현재 목록은 매수 추천이나 주문 대상이 아니다.

## 1단계: ETF 프록시

### 사전 고정 설계

| 연구 팩터 | 실제 ETF 프록시 | 차이 |
|---|---|---|
| 대형 모멘텀 | [MTUM](https://www.blackrock.com/us/individual/products/251614/ishares-msci-usa-momentum-factor-etf) | MSCI 미국 대형·중형 모멘텀 지수 |
| 수익성 | [QUAL](https://www.blackrock.com/us/individual/products/256101/ishares-msci-usa-quality-factor-etf_1) | ROE·이익 안정성·부채를 결합한 품질 지수 |
| 가치 | [VLUE](https://www.blackrock.com/us/individual/products/251616/ishares-msci-usa-value-factor-etf) | 장부가치 하나가 아닌 복수 가치지표를 사용하는 지수 |
| 보수적 투자 | 직접 대응 없음 | COWZ를 잉여현금흐름·자본규율의 짧은 근사치로만 사용 |

핵심 선별은 3개 ETF만 사용했다. COWZ는 [공식 방법론](https://www.paceretfs.com/products/cowz)상 잉여현금흐름 수익률 중심이며 French의 낮은 자산증가 팩터와 같지 않다.

- 기간: 2014-08~2026-06, 143개월
- 벤치마크: SPY 100% 매수보유
- 신호: 직전 12개 완결 월 수익으로 순위를 정하고 다음 달 보유
- 기본 비용: 단방향 회전금액의 0.10%
- 스트레스 비용: 단방향 회전금액의 0.25%
- ETF 운용보수와 배당: 수정주가에 반영
- 개발: 2014-08~2018-12
- 검증: 2019-01~2022-12
- 홀드아웃: 2023-01~2026-06

합격하려면 전체 SPY 초과 CAGR 0.5%p 이상, 세 구간 초과 CAGR 양수, 비용 스트레스 초과수익 양수, 5년 이동창 승률 60% 이상, SPY 대비 최대낙폭 열위 5%p 이하를 모두 만족해야 한다.

### 핵심 결과

SPY는 CAGR 13.92%, 최대낙폭 23.93%였다.

| 후보 | CAGR | SPY 대비 | 최대낙폭 | 검증 초과 | 홀드아웃 초과 | 비용 스트레스 초과 | 5년 승률 | 판정 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| MTUM·QUAL·VLUE 동일비중 | 14.55% | +0.63%p | 25.95% | -2.10%p | +4.00%p | +0.62%p | 10.71% | 탈락 |
| 직전 12개월 상위 2개 | 15.31% | +1.39%p | 28.44% | -2.60%p | +6.25%p | +1.18%p | 29.76% | 탈락 |

두 후보 모두 전체 수익은 SPY보다 높았지만 2019~2022 검증구간과 5년 일관성 기준에서 실패했다. 최근 2023년 이후 성과가 전체 우위를 크게 끌어올렸으므로, 학술 포트폴리오에서 보였던 장기 재현성이 실제 ETF에서 확인됐다고 볼 수 없다.

### COWZ 민감도

2018-01~2026-06의 짧은 구간에서 `MTUM·QUAL·VLUE·COWZ 상위 2개`는 CAGR 18.53%, SPY 대비 +3.93%p, 5년 승률 74.42%였다. 하지만 표본은 102개월, 5년 창은 43개뿐이고 첫 2018년 구간에서 SPY보다 1.48%p 뒤졌다. 결과 확인 후 COWZ를 핵심 후보로 승격하지 않는다.

## 2단계: 종목 바스켓 엔진

### 현재 스냅샷

- 기준일: 2026-07-15
- 가격 기준월: 2026-06
- 유니버스: 현재 S&P 100 스냅샷 100종목
- 적격: 89종목
- 제외: 11종목
- 선택: 30종목
- 비중: 종목당 약 3.33%
- 업종 상한: 20%, 최대 6종목

SEC Company Facts의 `filed` 날짜가 기준일 이하인 공시만 사용한다. SEC는 Company Facts API가 회사별 XBRL 사실을 한 번에 반환한다고 설명하며, 자동 접근은 선언된 User-Agent와 초당 10회 이하의 공정 접근 규칙을 따라야 한다. [SEC API 문서](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [SEC 공정 접근](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)

### 팩터 정의

1. 모멘텀: 기준월 직전 1개월을 제외한 12-2 수정주가 수익률
2. 수익성: 최근 공개 연간 영업이익/같은 연간 결산 자기자본
3. 가치: 최신 공개 자기자본/기준월 근사 시가총액
4. 보수적 투자: 최근 두 공개 연간 총자산의 증가율이 낮을수록 높은 점수

각 팩터를 적격 유니버스 내 백분위로 바꾸고 네 점수를 동일비중 평균한다. 영업이익 XBRL 태그가 없는 기업은 최근 연간 순이익을 사용하며 결과에 실제 태그와 공시일을 남긴다. 기존 보유목록을 입력하면 종합순위 45위까지 유지하는 버퍼도 지원한다.

### 현재 30종목 연구 바스켓

아래 목록은 엔진 산출물 확인용이며 주문 승인을 뜻하지 않는다.

| 순위 | 종목 | 업종 | 목표비중 |
|---:|---|---|---:|
| 1 | QCOM | Information Technology | 3.3333% |
| 2 | BMY | Health Care | 3.3333% |
| 3 | FDX | Industrials | 3.3333% |
| 4 | AAPL | Information Technology | 3.3333% |
| 5 | GM | Consumer Discretionary | 3.3333% |
| 6 | GILD | Health Care | 3.3333% |
| 7 | CSCO | Information Technology | 3.3333% |
| 8 | TXN | Information Technology | 3.3333% |
| 9 | AMGN | Health Care | 3.3333% |
| 10 | VZ | Communication Services | 3.3333% |
| 11 | COP | Energy | 3.3333% |
| 12 | CVS | Health Care | 3.3333% |
| 13 | UPS | Industrials | 3.3333% |
| 14 | USB | Financials | 3.3333% |
| 15 | PFE | Health Care | 3.3333% |
| 16 | UNP | Industrials | 3.3333% |
| 17 | GD | Industrials | 3.3333% |
| 18 | AMAT | Information Technology | 3.3333% |
| 19 | AVGO | Information Technology | 3.3333% |
| 20 | MMM | Industrials | 3.3333% |
| 21 | CMCSA | Communication Services | 3.3333% |
| 22 | UNH | Health Care | 3.3333% |
| 24 | GS | Financials | 3.3333% |
| 25 | DUK | Utilities | 3.3333% |
| 26 | DE | Industrials | 3.3333% |
| 27 | PG | Consumer Staples | 3.3333% |
| 29 | DIS | Communication Services | 3.3333% |
| 31 | KO | Consumer Staples | 3.3333% |
| 32 | BAC | Financials | 3.3333% |
| 37 | T | Communication Services | 3.3333% |

순위가 23·28·30 등을 건너뛴 것은 정보기술·헬스케어·산업재 업종이 최대 6종목 한도에 도달했기 때문이다.

### 왜 아직 실거래가 아닌가

1. 현재 유니버스는 현재 바스켓 생성에는 쓸 수 있지만 과거 전체에 적용하면 생존편향이 생긴다.
2. 과거 월별 S&P 구성원 스냅샷으로 같은 엔진을 순차 재생한 백테스트가 아직 없다.
3. ETF 구현 검증에서 핵심 후보가 모두 탈락했다.
4. SEC XBRL 태그가 기업마다 달라 11종목은 음의 자기자본, 신규 상장·재편, 오래되거나 누락된 공시 때문에 제외됐다.
5. 실제 주문비용, 세금, 환율, Toss 종목 지원 여부를 아직 적용하지 않았다.

따라서 엔진은 주문 파일을 만들지 않고 결과 JSON에 다음 상태를 고정한다.

```json
{
  "researchOnly": true,
  "liveTradingApproved": false
}
```

## 재현

```bash
npm run research:etf-proxy
npm run research:etf-proxy:verify

SEC_USER_AGENT="Your Name your-email@example.com" npm run research:stock-basket
npm run research:stock-basket:verify
```

- [ETF 프록시 원결과](results/etf-factor-proxy-2026-07-15.json)
- [종목 바스켓 스냅샷](results/stock-basket-snapshot-2026-07-15.json)

## 다음 검증 관문

앞으로 매월 유니버스·공시·가격 스냅샷을 변경 불가능하게 저장하고, 실제로 당시 선택됐을 바스켓의 다음 달 성과를 누적해야 한다. 유료 포인트인타임 과거 구성원·공시 데이터가 확보되기 전에는 현재 구성 종목으로 과거 성과를 꾸며내지 않는다.
