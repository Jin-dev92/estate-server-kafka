import { scrubEvent } from './sentry-scrub';

describe('scrubEvent', () => {
  it('민감 헤더(Authorization·Cookie)를 마스킹한다(대소문자 무관)', () => {
    const event = {
      request: {
        headers: { Authorization: 'Bearer x', cookie: 'a=b', 'x-trace': 'ok' },
      },
    };

    const result = scrubEvent(event);

    expect(result.request?.headers).toEqual({
      Authorization: '***',
      cookie: '***',
      'x-trace': 'ok',
    });
  });

  it('request가 없어도 안전하게 그대로 반환한다', () => {
    const event = { message: 'no request' };
    expect(scrubEvent(event)).toEqual({ message: 'no request' });
  });
});
