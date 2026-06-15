import { RedisNotificationCounter } from './redis-notification-counter';
import { RedisService } from '../../redis/redis.service';

describe('RedisNotificationCounter', () => {
  let redis: { incr: jest.Mock; get: jest.Mock; del: jest.Mock };
  let counter: RedisNotificationCounter;

  beforeEach(() => {
    redis = { incr: jest.fn(), get: jest.fn(), del: jest.fn() };
    counter = new RedisNotificationCounter(redis as unknown as RedisService);
  });

  afterEach(() => jest.clearAllMocks());

  it('increment는 사용자 키를 INCR한다', async () => {
    redis.incr.mockResolvedValue(1);

    await counter.increment('u1');

    expect(redis.incr).toHaveBeenCalledWith('notif:unread:u1');
  });

  it('get은 값이 있으면 숫자로 반환한다', async () => {
    redis.get.mockResolvedValue('5');

    await expect(counter.get('u1')).resolves.toBe(5);
  });

  it('get은 키가 없으면 0', async () => {
    redis.get.mockResolvedValue(null);

    await expect(counter.get('u1')).resolves.toBe(0);
  });

  it('reset은 키를 DEL한다', async () => {
    redis.del.mockResolvedValue(1);

    await counter.reset('u1');

    expect(redis.del).toHaveBeenCalledWith('notif:unread:u1');
  });
});
