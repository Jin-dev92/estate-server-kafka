import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  NotificationRelay,
  NotificationPushPayload,
} from '../domain/notification-relay';

// 모든 main 인스턴스가 구독하는 단일 채널. 워커가 발행하면 gateway가 받아 emit한다.
const CHANNEL = 'notifications';

@Injectable()
export class RedisNotificationRelay implements NotificationRelay {
  private readonly logger = new Logger(RedisNotificationRelay.name);

  constructor(private readonly redis: RedisService) {}

  async publish(payload: NotificationPushPayload): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify(payload));
  }

  async subscribe(
    handler: (payload: NotificationPushPayload) => void,
  ): Promise<void> {
    // 구독 모드 연결은 일반 명령을 못 쓰므로 전용 연결(duplicate)을 만든다.
    const sub = this.redis.duplicate();
    await sub.subscribe(CHANNEL);
    sub.on('message', (_channel: string, raw: string) => {
      try {
        handler(JSON.parse(raw) as NotificationPushPayload);
      } catch (err) {
        this.logger.warn(`알림 중계 파싱 실패: ${(err as Error).message}`);
      }
    });
  }
}
