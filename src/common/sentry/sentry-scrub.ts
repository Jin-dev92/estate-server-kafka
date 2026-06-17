// Sentry beforeSend 훅에서 민감정보를 제거하는 순수 함수.
// sendDefaultPii:false로 헤더 자동 첨부는 막지만, 혹시 실린 민감 헤더를 한 번 더 막는다.
const SENSITIVE_HEADERS = ['authorization', 'cookie'];

interface ScrubbableEvent {
  request?: { headers?: Record<string, unknown> };
  [key: string]: unknown;
}

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const headers = event.request?.headers;
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
        headers[key] = '***';
      }
    }
  }
  return event;
}
