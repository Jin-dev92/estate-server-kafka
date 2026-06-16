import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, THRESHOLDS, profileOptions } from '../config.js';
import { login, firstBuildingId, authHeaders } from '../lib/auth.js';

// 쓰기·DB+Outbox 경로: POST 글작성. 트랜잭션(글+outbox 한 커밋) 비용을 본다.
export const options = { ...profileOptions(), thresholds: THRESHOLDS.write };

export function setup() {
  const token = login();
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

export default function (data) {
  const payload = JSON.stringify({
    category: 'FREE',
    title: `부하 글 ${Date.now()}`,
    content: 'load test',
  });
  const res = http.post(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    payload,
    authHeaders(data.token),
  );
  check(res, { 'create 201': (r) => r.status === 201 });
  sleep(1);
}
