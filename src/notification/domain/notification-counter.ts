export const NOTIFICATION_COUNTER = Symbol('NOTIFICATION_COUNTER');

// 사용자별 미읽음 카운트(원자적). Redis INCR/GET/DEL로 구현한다.
export interface NotificationCounter {
  increment(userId: string): Promise<void>;
  get(userId: string): Promise<number>;
  reset(userId: string): Promise<void>;
}
