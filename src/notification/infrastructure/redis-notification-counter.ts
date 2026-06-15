import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { NotificationCounter } from '../domain/notification-counter';

// 사용자별 미읽음 카운터 키.
function unreadKey(userId: string): string {
  return `notif:unread:${userId}`;
}

@Injectable()
export class RedisNotificationCounter implements NotificationCounter {
  constructor(private readonly redis: RedisService) {}

  async increment(userId: string): Promise<void> {
    // 원자적 증가. 동시 알림에도 카운트 유실 없음.
    await this.redis.incr(unreadKey(userId));
  }

  async get(userId: string): Promise<number> {
    const v = await this.redis.get(unreadKey(userId));
    return v ? Number(v) : 0;
  }

  async reset(userId: string): Promise<void> {
    await this.redis.del(unreadKey(userId));
  }
}
