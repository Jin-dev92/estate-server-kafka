import { DomainEvent } from '../../events/domain-event';

export const RECIPIENT_RESOLVER = Symbol('RECIPIENT_RESOLVER');

// 도메인 이벤트 → 알림 수신자 userId 목록(작성자/발신자 제외)을 해석한다.
export interface RecipientResolver {
  resolve(event: DomainEvent): Promise<string[]>;
}
