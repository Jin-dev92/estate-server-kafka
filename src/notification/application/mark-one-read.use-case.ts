import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../domain/notification.repository';
import {
  NOTIFICATION_COUNTER,
  NotificationCounter,
} from '../domain/notification-counter';

@Injectable()
export class MarkOneReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
  ) {}

  // 단건 읽음. 실제 unread→read 전이일 때만 카운터를 1 감소(중복 클릭·이미 읽음 안전).
  // 멱등 설계: 존재하지 않거나 타인 소유 알림이면 markOneRead가 false → 카운터 불변 후
  // 정상 반환(200). recipientId 조건이 소유자 보호를 담당하므로 별도 404/403은 두지 않는다.
  async execute(userId: string, id: string): Promise<void> {
    const transitioned = await this.repo.markOneRead(userId, id);
    if (transitioned) await this.counter.decrement(userId);
  }
}
