# Toss Invest Trading Bot V2

**거래비용 차감 후 S&P 500보다 높은 장기 복리수익**을 재현할 수 있는지 검증하고, 엄격한 기준을 통과한 전략만 자동매매 시스템으로 발전시키는 프로젝트입니다.

> 이 저장소는 기존 `toss_invest_trading_bot`의 리팩터링이나 마이그레이션이 아닙니다. V1의 서버, UI, 주문 엔진, 설정, 운영 데이터, 전략 점수 체계를 가져오지 않는 완전한 V2입니다.

## 현재 단계

현재는 **연구 및 백테스트 단계**입니다. 실제 주문 코드와 Toss OpenAPI 인증 정보는 포함되어 있지 않으며, 백테스트 결과만으로 실거래를 시작하지 않습니다.

- SPY 100% 매수보유를 공식 벤치마크로 사용
- 섹터·스타일·듀얼 모멘텀, 추세·변동성 관리와 앙상블 비교
- 다음 거래일 시가 체결과 거래비용을 반영한 포트폴리오 백테스트
- 개발·검증·홀드아웃과 비용 2배, 5년 구간 승률 검사
- 벤치마크 초과수익이 재현되지 않으면 거래 전략을 채택하지 않음
- 결과 파일의 구조와 핵심 수치를 확인하는 독립 검증 스크립트

현재 목표의 상세 가정과 결과는 [S&P 500 도전자 연구](research/BENCHMARK_CHALLENGER.md)에 정리되어 있습니다. 기존 보조지표 연구는 [초기 비교 기록](research/README.md)으로 보존합니다.

## 예비 결론

2026-07-15 벤치마크 도전자 1차 라운드에서는 여섯 후보 중 사전 기준을 모두 통과한 전략이 없었습니다. 듀얼 모멘텀은 전체 CAGR 13.67%로 SPY의 12.39%를 앞섰지만, 2020년 이후 홀드아웃에서 연 3.36%p 뒤지고 5년 구간 승률도 52.23%라 탈락했습니다.

다음 단계는 가격 타이밍 파라미터를 다시 맞추는 것이 아니라, 과거 시점별 S&P 500 구성 종목과 실제 공시일 데이터를 사용하는 품질·모멘텀·가치 멀티팩터 포트폴리오입니다.

## 실행

요구 환경: Node.js 22 이상

```bash
npm run research:benchmark
npm run research:benchmark:verify
```

초기 보조지표 비교를 재현하려면 다음 명령을 사용합니다.

```bash
npm run research:v2:verify
npm run research:v2
```

민감도 검사를 직접 실행할 수도 있습니다.

```bash
node research/v2-strategy-backtest.mjs \
  --strategy-set sensitivity \
  --cost-per-side 0.002 \
  --require-history-before 2017-01-01 \
  --output research/results/custom.json
```

## 구조

```text
research/
  BENCHMARK_CHALLENGER.md           현재 목표의 연구 가정, 결과, 한계
  benchmark-challenger-backtest.mjs SPY 도전자 백테스트 엔진
  verify-benchmark-challenger.mjs   도전자 결과 검증
  README.md                         초기 보조지표 비교 기록
  sp100-current-2026-07-15.json     유니버스 스냅샷
  v2-strategy-backtest.mjs          백테스트 엔진과 후보 전략
  verify-v2-strategy-backtest.mjs   저장 결과 검증
  results/                          재현 가능한 결과 JSON
WORKLOG.md                          에이전트 작업 이력
AGENTS.md                           협업 및 안전 규칙
```

## 개발 원칙

1. 전략 선택과 종목 선택에 같은 미사용 구간을 반복 사용하지 않습니다.
2. 승률만 보지 않고 CAGR, 최대낙폭, Profit Factor, 비용 민감도, 구간별 일관성을 함께 봅니다.
3. 백테스트와 실거래의 주문 시점, 비용, 종목 유니버스 차이를 숨기지 않습니다.
4. 실제 주문은 데이터 검증, 워크포워드, 모의 운용, 주문 안전장치를 순서대로 통과한 뒤 별도 단계에서 도입합니다.
5. API 키, 계좌 정보, 운영 상태와 체결 데이터는 Git에 커밋하지 않습니다.

## V1과의 관계

기존 공개 저장소와 로컬 `/Users/joyanggi/Documents/toss_invest`는 폐기된 V1 참고본입니다. V2 개발의 소스나 배포 대상으로 사용하지 않으며, 앞으로의 변경과 커밋은 이 저장소에서만 진행합니다.
