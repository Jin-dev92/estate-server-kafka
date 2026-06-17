// 시나리오 ⑥(M8): spike — 급증 충격에 rate limit이 막아내고, 끝난 뒤 회복하는가
// 무엇을 보나: 평상시 낮은 RPS를 유지하다 짧게 확 치솟게(급증) 한 뒤 다시 낮춘다.
//   ① 급증분이 429(RATE_LIMIT_EXCEEDED)로 차단되고 앱이 안 죽는가(5xx 없음),
//   ② 급증 후 평상시 구간에서 지표가 baseline 수준으로 회복되는가.
// 실행 전제(중요): 방어가 관심사 → rate limit을 "정상/유한 한도"로 띄운다(상향 X).
//   window를 짧게(10s) 두면 회복(윈도우 리셋)을 빨리 관찰할 수 있다.
//   RATE_LIMIT_WINDOW_SEC=10 RATE_LIMIT_USER_MAX=200 RATE_LIMIT_IP_MAX=200 node dist/main.js
//   (+ npm run start:worker:outbox)
// 실행: SPIKE_PEAK_RATE=300 k6 run load/scenarios/spike-ratelimit.js

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL } from '../config.js';
import { login, firstBuildingId, authHeaders } from '../lib/auth.js';

const BASE_RATE = Number(__ENV.SPIKE_BASE_RATE) || 5; // 평상시 초당 요청
const PEAK_RATE = Number(__ENV.SPIKE_PEAK_RATE) || 300; // 급증 정점
const MAX_VUS = Number(__ENV.SPIKE_MAX_VUS) || 800; // in-flight VU 상한(급증 시 도착률 유지용)

// 차단된 429와 통과한 2xx를 따로 세어 "막은 양 vs 통과한 양"을 숫자로 본다.
const blocked429 = new Counter('blocked_429');
const passed2xx = new Counter('passed_2xx');

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: BASE_RATE,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: MAX_VUS, // 급증 시 도착률 유지를 위해 넉넉히(__ENV.SPIKE_MAX_VUS)
      stages: [
        { target: BASE_RATE, duration: '20s' }, // 평상시(baseline 구간)
        { target: PEAK_RATE, duration: '5s' }, // 급증(확 치솟음)
        { target: PEAK_RATE, duration: '10s' }, // 급증 유지
        { target: BASE_RATE, duration: '5s' }, // 복귀
        { target: BASE_RATE, duration: '30s' }, // 회복 관찰
      ],
    },
  },
};

export function setup() {
  const token = login(); // 로그인은 1회뿐(데코레이터 ipMax:10에 안 걸림)
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

export default function (data) {
  const payload = JSON.stringify({
    category: 'FREE',
    title: `spike ${Date.now()}`,
    content: 'load test',
  });
  const res = http.post(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    payload,
    authHeaders(data.token),
  );
  if (res.status === 429) blocked429.add(1);
  else if (res.status >= 200 && res.status < 300) passed2xx.add(1);
  // 핵심 합격 조건: 급증해도 앱이 죽지 않는다(5xx가 아니다).
  check(res, { 'no server error (<500)': (r) => r.status < 500 });
}

// 요약: p95·실패율과 함께 "막은 양(429) vs 통과한 양(2xx)"을 찍는다.
// ※ k6의 http_req_failed는 429도 '실패'로 본다 → 여기 실패율이 높은 건 정상 방어의 결과다.
export function handleSummary(data) {
  const m = data.metrics;
  const p95 = m.http_req_duration ? m.http_req_duration.values['p(95)'] : 0;
  const failRate = m.http_req_failed ? m.http_req_failed.values.rate : 0;
  const b = m.blocked_429 ? m.blocked_429.values.count : 0;
  const p = m.passed_2xx ? m.passed_2xx.values.count : 0;
  console.log(
    '[spike 요약] p95=' +
      p95.toFixed(1) +
      'ms (429포함)실패율=' +
      (failRate * 100).toFixed(2) +
      '% 차단(429)=' +
      b +
      ' 통과(2xx)=' +
      p,
  );
  return {};
}
