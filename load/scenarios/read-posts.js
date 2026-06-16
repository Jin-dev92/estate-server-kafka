import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, THRESHOLDS, profileOptions } from '../config.js';
import { login, firstBuildingId, authHeaders } from '../lib/auth.js';

// 읽기·캐시 경로: GET 게시글 목록. Redis read-through 캐시 효과를 본다.
export const options = { ...profileOptions(), thresholds: THRESHOLDS.read };

export function setup() {
  const token = login();
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

export default function (data) {
  const res = http.get(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    authHeaders(data.token),
  );
  check(res, { 'list 200': (r) => r.status === 200 });
  sleep(1);
}
