import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, SEED, THRESHOLDS, profileOptions } from '../config.js';

// 인증 경로: POST 로그인. bcrypt 검증(CPU 바운드) 응답시간을 본다.
export const options = { ...profileOptions(), thresholds: THRESHOLDS.login };

export default function () {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: SEED.email, password: SEED.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'login ok': (r) => r.status === 200 || r.status === 201 });
  sleep(1);
}
