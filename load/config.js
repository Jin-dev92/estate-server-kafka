// 부하 프로파일·threshold·공통 설정. env로 오버라이드한다.
// 예: BASE_URL=http://localhost:3000 PROFILE=load k6 run load/scenarios/read-posts.js
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// 시드(prisma/seed-load.ts)와 공유하는 고정 자격증명.
export const SEED = {
  email: __ENV.LOAD_EMAIL || 'load-owner@example.com',
  password: __ENV.LOAD_PASSWORD || 'load-test-1234',
};

// PROFILE=smoke(정상성) | load(baseline). VUS·DURATION으로 미세 조정.
const PROFILE = __ENV.PROFILE || 'smoke';

const PROFILES = {
  smoke: { vus: Number(__ENV.VUS) || 1, duration: __ENV.DURATION || '30s' },
  load: {
    stages: [
      { duration: '30s', target: Number(__ENV.VUS) || 20 },
      { duration: '1m', target: Number(__ENV.VUS) || 20 },
      { duration: '10s', target: 0 },
    ],
  },
};

export function profileOptions() {
  return PROFILES[PROFILE] || PROFILES.smoke;
}

// 엔드포인트 성격별 threshold(설계 §3).
export const THRESHOLDS = {
  read: { http_req_duration: ['p(95)<300'], http_req_failed: ['rate<0.01'] },
  write: { http_req_duration: ['p(95)<800'], http_req_failed: ['rate<0.01'] },
  // login 라우트는 @RateLimit({ipMax:10})이 하드코딩이라 env 한도 상향으로 못 푼다.
  // → load 프로파일에선 대부분 429(보안이 의도대로 동작). 실패율 threshold를 두면
  //   "rate limit이 막는 게 정상"인데 불합격이 되므로 제외하고, 응답시간만 관측한다.
  //   순수 bcrypt baseline이 필요하면 smoke 프로파일(윈도우당 ≤10회)로 측정한다.
  login: { http_req_duration: ['p(95)<1000'] },
};
