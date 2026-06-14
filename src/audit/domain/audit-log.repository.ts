import { DomainEvent } from '../../events/domain-event';

export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

export interface AuditLogRepository {
  // 멱등: 같은 eventId가 이미 적재돼 있으면 조용히 무시한다.
  record(event: DomainEvent): Promise<void>;
}
