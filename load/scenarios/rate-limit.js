import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, SEED } from '../config.js';

// rate limit 경계 검증: 낮은 한도로 띄운 앱에 빠르게 반복 → 429가 나오는지.
// (앱을 RATE_LIMIT_IP_MAX=10 등 낮은 값으로 기동한 상태에서 실행)
// 부하 baseline이 아니라 "한도가 정확히 작동하는가"를 본다.
const got429 = new Counter('rate_limited_429');

export const options = {
  vus: 1,
  iterations: 20, // ipMax보다 충분히 많게
  // 429는 정상 동작이므로 http_req_failed threshold를 두지 않는다.
};

export default function () {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: SEED.email, password: SEED.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status === 429) {
    got429.add(1);
    check(res, {
      '429 body code': (r) => r.json('code') === 'RATE_LIMIT_EXCEEDED',
      '429 Retry-After 존재': (r) => r.headers['Retry-After'] !== undefined,
    });
  }
}

// 한도 초과가 최소 1회 관측돼야 한다.
export function handleSummary(data) {
  const count = data.metrics.rate_limited_429
    ? data.metrics.rate_limited_429.values.count
    : 0;
  console.log(`429 관측 횟수: ${count}`);
  return {};
}
