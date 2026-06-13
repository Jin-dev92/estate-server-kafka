import { EntityType, EventType } from './event-type.enum';

// 모든 도메인 이벤트가 공유하는 봉투. payload만 이벤트별로 달라진다.
export interface DomainEvent<T = unknown> {
  eventId: string; // uuid v4 — 멱등 키
  eventType: EventType;
  occurredAt: string; // ISO 8601
  actorId: string | null; // 행위자 userId
  entityType: EntityType;
  entityId: string;
  payload: T;
}
