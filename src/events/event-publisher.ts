import { DomainEvent } from './domain-event';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

// application 레이어가 의존하는 발행 포트. 도메인/유스케이스는 Kafka를 모른다(의존성 역전).
export interface EventPublisher {
  // after-commit fire-and-forget(직접 발행). 실패를 삼키고 로깅만 한다(유실 가능 — chat 등 비-Outbox 경로용).
  publish(event: DomainEvent): Promise<void>;
  // 발행 실패를 호출자에게 throw로 알린다(Outbox relay 전용 — 실패 시 markFailed로 재시도해야 하므로).
  publishOrThrow(event: DomainEvent): Promise<void>;
}
