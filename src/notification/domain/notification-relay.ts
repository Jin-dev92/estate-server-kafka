export const NOTIFICATION_RELAY = Symbol('NOTIFICATION_RELAY');

// 워커(별도 프로세스)→main gateway 브리지용 푸시 페이로드.
export interface NotificationPushPayload {
  recipientId: string;
  notification: {
    id: string;
    type: string;
    title: string;
    body: string | null;
    entityType: string;
    entityId: string;
    buildingId: string | null;
    createdAt: string; // ISO 8601
  };
}

export interface NotificationRelay {
  publish(payload: NotificationPushPayload): Promise<void>;
  subscribe(handler: (payload: NotificationPushPayload) => void): Promise<void>;
}
