// outbox 행 상태. 매직스트링 금지 — store·relay가 단일 출처로 참조.
export const enum OutboxStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
}
