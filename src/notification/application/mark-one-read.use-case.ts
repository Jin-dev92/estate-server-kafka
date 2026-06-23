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
  async execute(userId: string, id: string): Promise<void> {
    const transitioned = await this.repo.markOneRead(userId, id);
    if (transitioned) await this.counter.decrement(userId);
  }
}
