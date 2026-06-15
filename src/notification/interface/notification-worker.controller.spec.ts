import { NotificationWorkerController } from './notification-worker.controller';
import { HandleEventUseCase } from '../application/handle-event.use-case';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

const event: DomainEvent = {
  eventId: 'e1',
  eventType: EventType.CommentCreated,
  occurredAt: '2026-06-15T00:00:00.000Z',
  actorId: 'u1',
  entityType: EntityType.Comment,
  entityId: 'c1',
  payload: { postId: 'p1' },
};

describe('NotificationWorkerController', () => {
  it('chat·board 이벤트를 HandleEventUseCase로 위임한다', async () => {
    const handled: DomainEvent[] = [];
    const useCase = {
      execute: (e: DomainEvent) => {
        handled.push(e);
        return Promise.resolve();
      },
    };
    const controller = new NotificationWorkerController(
      useCase as unknown as HandleEventUseCase,
    );

    await controller.onChatEvent(event);
    await controller.onBoardEvent(event);

    expect(handled).toHaveLength(2);
  });
});
