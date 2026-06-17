# 부하테스트 (k6)

성격이 다른 핵심 엔드포인트의 성능 baseline(p95·RPS·에러율)을 측정한다.

## 사전 준비
1. k6 설치: `brew install k6` (또는 https://k6.io/docs/get-started/installation/)
2. 인프라: `docker compose up -d`
3. 앱: `npm run build && node dist/main.js` (글작성 부하 시 `npm run start:worker:outbox`도 함께)
4. 시드: `npm run load:seed`

## 실행
| 명령 | 시나리오 |
|---|---|
| `npm run load:smoke` | 전체 smoke(정상성) |
| `npm run load:read` | GET 게시글 목록 |
| `npm run load:create` | POST 글작성 |
| `npm run load:login` | POST 로그인 |
| `npm run load:ratelimit` | 429 경계 |
| `npm run load:stress` | stress(create-post, DB 풀 고갈 knee 탐색) |
| `npm run load:spike` | spike(급증 시 rate limit 방어·회복) |

프로파일/규모: `PROFILE=load VUS=20 k6 run load/scenarios/read-posts.js`

## rate limit 주의
부하가 rate limit에 걸리므로, 측정 시 한도를 크게 띄운다:
`RATE_LIMIT_USER_MAX=100000 RATE_LIMIT_IP_MAX=100000 node dist/main.js`
rate-limit 시나리오는 반대로 낮은 한도로 띄워 429를 검증한다.

## stress/spike 실행 전제 (M8)

open(arrival-rate) 모델이라 closed(VU)와 띄우는 법이 다르다. 로컬 단일 머신에선
"머신이 먼저 한계"라 의미가 흐려지므로, **자원을 일부러 좁혀 앱이 먼저 터지게** 한다.

- **stress (DB 풀 병목 보기):** DB 커넥션 풀을 좁히고 rate limit은 풀어 띄운다.
  `DATABASE_URL="...&connection_limit=5" RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js`
  (+ `npm run start:worker:outbox`) → RPS를 올리면 풀 고갈 knee에서 5xx + 앱 로그에 Prisma 풀 타임아웃.
- **spike (방어·회복 보기):** rate limit을 **정상/유한 한도**로 띄운다(상향 X). window를 짧게 두면 회복을 빨리 본다.
  `RATE_LIMIT_WINDOW_SEC=10 RATE_LIMIT_USER_MAX=200 RATE_LIMIT_IP_MAX=200 node dist/main.js`

## 결과 기록
> 환경: 로컬 단일 머신(앱+PG+Redis+Kafka 동시 구동) — 절대치가 아니라 **상대 비교·회귀 감지**용.

| 일자 | 시나리오 | 프로파일 | p95(ms) | RPS | 에러율 | 비고 |
|---|---|---|---|---|---|---|
| 2026-06-16 | read-posts (GET 목록) | load 20VU | 6.89 | 16.0 | 0% | Redis read-through 캐시 경로(단일 building → 캐시 hit 최상) |
| 2026-06-16 | create-post (POST) | load 20VU | 19.6 | 15.9 | 0% | DB+Outbox 한 트랜잭션 쓰기 |
| 2026-06-16 | login (순수 bcrypt) | smoke 1VU | 114.5 | 0.9 | 0% | bcrypt rounds=10 검증 = CPU 바운드(읽기의 ~17배) |
| 2026-06-16 | login (부하) | load 20VU | 4.2 | 16.0 | 98.8% | `@RateLimit({ipMax:10})`에 막혀 대부분 429 — "측정이 측정을 방해"(아래) |
| 2026-06-16 | rate-limit (429 경계) | iter 20 | — | — | — | ipMax=10 → 429 관측 10회. 부하 하에서도 한도 정확 |

### 읽어둘 발견
- **login은 데코레이터 rate limit 때문에 부하 측정이 막힌다.** `@RateLimit({ipMax:10})`은 라우트에 하드코딩이라 `RATE_LIMIT_*` env 상향으로 안 풀린다 → load에서 ~99% 429. **순수 bcrypt baseline은 smoke(윈도우당 ≤10회)로** 잰다. (이건 보안이 의도대로 동작한다는 증거이기도 하다.)
- **read 수치는 캐시 최상 시나리오다.** 모든 VU가 같은 building을 읽어 Redis hit이 100%에 가깝다. 실제론 여러 키를 섞어야 현실적 hit/miss가 나온다.
- **bcrypt가 가장 무겁다**(p95 114ms vs 읽기 7ms). 인증이 CPU 바운드라는 걸 숫자로 확인.
