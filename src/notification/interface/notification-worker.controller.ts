import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KafkaTopic } from '../../events/event-type.enum';
import { DomainEvent } from '../../events/domain-event';
import { HandleEventUseCase } from '../application/handle-event.use-case';

// notification-worker: chat-events·board-events를 독립 그룹으로 구독해 알림을 생성한다.
@Controller()
export class NotificationWorkerController {
  constructor(private readonly handle: HandleEventUseCase) {}

  @EventPattern(KafkaTopic.ChatEvents)
  async onChatEvent(@Payload() event: DomainEvent): Promise<void> {
    await this.handle.execute(event);
  }

  @EventPattern(KafkaTopic.BoardEvents)
  async onBoardEvent(@Payload() event: DomainEvent): Promise<void> {
    await this.handle.execute(event);
  }
}
