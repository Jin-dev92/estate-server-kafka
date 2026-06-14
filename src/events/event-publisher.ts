import { DomainEvent } from './domain-event';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

// application 레이어가 의존하는 발행 포트. 도메인/유스케이스는 Kafka를 모른다(의존성 역전).
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}
