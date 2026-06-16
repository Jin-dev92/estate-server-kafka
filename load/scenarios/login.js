import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, SEED, THRESHOLDS, profileOptions } from '../config.js';

// 인증 경로: POST 로그인. bcrypt 검증(CPU 바운드) 응답시간을 본다.
// 주의: login에는 @RateLimit({ipMax:10}) 데코레이터가 하드코딩이라 env 한도로 못 푼다.
// → load 프로파일에선 대부분 429(보안 정상 동작). 순수 bcrypt는 smoke로 측정.
export const options = { ...profileOptions(), thresholds: THRESHOLDS.login };

export default function () {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: SEED.email, password: SEED.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  // 429도 예상된 응답(rate limit)이므로 허용해 check 실패로 잡지 않는다.
  check(res, {
    'login 200/201/429': (r) =>
      r.status === 200 || r.status === 201 || r.status === 429,
  });
  sleep(1);
}
