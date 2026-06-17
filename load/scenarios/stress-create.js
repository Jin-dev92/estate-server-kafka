// 시나리오 ⑤(M8): stress — 한계점·병목(DB 커넥션 풀) 탐색
// 무엇을 보나: POST 글작성의 도착률(RPS)을 단계적으로 올릴 때, 어느 지점에서 p95가
//   급증하고 5xx가 시작되는가(=knee). 그 순간 앱 로그에 Prisma 풀 타임아웃이 찍히면
//   "병목 = DB 커넥션 풀"이라는 증거다.
// 실행 전제(중요): 앱을 DB 풀을 좁혀 띄운다 → 머신보다 풀이 먼저 고갈돼 통제된 실험이 된다.
//   DATABASE_URL="...?...&connection_limit=5" \
//   RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js
//   (+ npm run start:worker:outbox — 글작성은 Outbox 경로를 함께 쓴다)
// 실행: STRESS_PEAK_RATE=100 k6 run load/scenarios/stress-create.js
// (k6 생명주기·open/closed 모델 설명은 ../config.js 맨 위 주석 참고)

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL } from '../config.js';
import { login, firstBuildingId, authHeaders } from '../lib/auth.js';

// 단계별 도착률(초당 요청수). __ENV로 조절(하드코딩 금지). 기본은 10→30→60→PEAK.
const PEAK_RATE = Number(__ENV.STRESS_PEAK_RATE) || 100;
const STAGE = __ENV.STRESS_STAGE || '30s'; // 각 단계 유지 시간

// 5xx(서버 에러) 누적 카운터 — knee에서 몇 건이나 터졌는지 숫자로 본다.
const errors5xx = new Counter('server_errors_5xx');

export const options = {
  scenarios: {
    stress: {
      // open 모델: 도착률을 고정해 시스템이 느려져도 부하를 안 줄인다 → 한계가 드러난다.
      executor: 'ramping-arrival-rate',
      startRate: 10, // 초당 10건으로 시작
      timeUnit: '1s', // 'target/timeUnit' = 초당 도착률
      preAllocatedVUs: 50, // 미리 잡아둘 VU(요청이 느려지면 더 필요)
      maxVUs: 500, // 상한. 부족하면 k6가 "Insufficient VUs" 경고
      stages: [
        { target: 10, duration: STAGE },
        { target: 30, duration: STAGE },
        { target: 60, duration: STAGE },
        { target: PEAK_RATE, duration: STAGE },
      ],
    },
  },
  // stress는 합격/불합격 게이트가 아니라 knee 탐색 → threshold를 두지 않는다(곡선을 기록).
};

// setup(): 토큰·건물id를 1번만 준비(로그인 비용이 측정에 섞이지 않게).
export function setup() {
  const token = login();
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

export default function (data) {
  const payload = JSON.stringify({
    category: 'FREE',
    title: `stress ${Date.now()}`,
    content: 'load test',
  });
  const res = http.post(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    payload,
    authHeaders(data.token),
  );
  // 201=성공. 5xx면 병목 도달 신호 → 카운터를 올린다.
  check(res, { 'create 201': (r) => r.status === 201 });
  if (res.status >= 500) errors5xx.add(1);
  // arrival-rate는 executor가 페이싱하므로 sleep(think time)을 넣지 않는다.
}

// 끝나면 5xx 누적을 찍어 knee 규모를 요약한다.
export function handleSummary(data) {
  const count = data.metrics.server_errors_5xx
    ? data.metrics.server_errors_5xx.values.count
    : 0;
  console.log(`5xx(병목 도달) 관측 횟수: ${count}`);
  return {};
}
