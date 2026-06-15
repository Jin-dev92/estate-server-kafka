# M5: notification-worker + 다중 컨슈머 그룹 팬아웃 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 도메인 이벤트 1건을 persistence·notification·audit 세 독립 컨슈머 그룹이 각각 소비하는 진짜 팬아웃을 완성하고, notification-worker가 알림을 멱등 적재 + Redis 미읽음 카운터 + `/notifications` WS 푸시로 처리한다.

**Architecture:** main.ts는 순수 HTTP+WS+producer로 남기고 컨슈머를 워커별 엔트리포인트(`src/workers/*.main.ts`)로 분리한다. 신규 `src/notification/` 도메인 모듈이 이벤트→수신자 해석→알림 N건 멱등 적재→카운터 INCR→Redis 채널 publish를 수행하고, main의 NotificationGateway가 그 채널을 구독해 접속 중인 사용자에게 emit한다.

**Tech Stack:** NestJS(@nestjs/microservices Kafka, @nestjs/websockets socket.io), Prisma/PostgreSQL, ioredis, kafkajs, Jest.

> **설계 스펙:** [docs/superpowers/specs/2026-06-15-m5-notification-design.md](../specs/2026-06-15-m5-notification-design.md)

---

## 사전 준비

- 작업 브랜치: `feat/m5-notification` (이미 `dev`에서 분기됨).
- 인프라 기동 확인: `docker compose up -d` (postgres·redis·kafka). 마이그레이션·부팅 검증에 필요.
- 기존 컨벤션: 매직스트링 금지(ConfigKey/상수 참조), 테스트는 `as any` 금지(`Partial<T>`/`as unknown as T`), 커밋 메시지 `[M5]{타입}: {한글}`.

---

## 파일 구조 (생성/수정 맵)

**생성**
```
src/notification/domain/notification-type.enum.ts        NotificationType const enum
src/notification/domain/notification.entity.ts           Notification 도메인 엔티티
src/notification/domain/notification-content.ts          이벤트 → 알림 표시내용 매핑(순수 함수)
src/notification/domain/notification.repository.ts        NOTIFICATION_REPOSITORY 포트
src/notification/domain/notification-counter.ts           NOTIFICATION_COUNTER 포트
src/notification/domain/notification-relay.ts             NOTIFICATION_RELAY 포트 + push payload 타입
src/notification/domain/recipient-resolver.ts             RECIPIENT_RESOLVER 포트
src/notification/application/handle-event.use-case.ts     이벤트 처리(멱등 팬아웃)
src/notification/application/list-notifications.use-case.ts
src/notification/application/get-unread-count.use-case.ts
src/notification/application/mark-all-read.use-case.ts
src/notification/infrastructure/prisma-notification.repository.ts
src/notification/infrastructure/redis-notification-counter.ts
src/notification/infrastructure/redis-notification-relay.ts
src/notification/infrastructure/prisma-recipient-resolver.ts
src/notification/interface/notification-worker.controller.ts
src/notification/interface/notification.controller.ts
src/notification/interface/notification.gateway.ts
src/notification/notification.module.ts                   HTTP/WS 모듈(AppModule이 임포트)
src/notification/notification-worker.module.ts            notification 워커 모듈
src/workers/persistence-worker.main.ts                    persistence 워커 엔트리포인트
src/workers/persistence-worker.module.ts
src/workers/audit-worker.main.ts                          audit 워커 엔트리포인트
src/workers/audit-worker.module.ts
src/workers/notification-worker.main.ts                   notification 워커 엔트리포인트
(+ 각 *.spec.ts)
```

**수정**
```
prisma/schema.prisma                          Notification 모델 추가
src/audit/interface/audit-worker.controller.ts  chat-events 핸들러 추가(audit=전체)
src/main.ts                                    컨슈머 제거(순수 HTTP+WS+producer)
src/app.module.ts                             NotificationModule 임포트
src/common/swagger/swagger.constants.ts        SWAGGER_TAGS에 'notification' 추가
package.json                                   워커 실행 스크립트 추가
README.md                                      M5 API 표·마일스톤·실행법
```

> **모듈 구성 메모:** `PrismaModule`·`RedisModule`은 `@Global`이라, 워커 모듈이 한 번 import하면 그래프 전체에서 `PrismaService`·`RedisService` 주입이 가능하다. 워커는 `AppModule`을 쓰지 않으므로 각 워커 모듈이 `ConfigModule.forRoot({ isGlobal: true })`와 필요한 글로벌 모듈을 직접 import한다. `KafkaTopicInitializer`는 `ConfigService`만 의존하므로 워커 모듈에 provider로 직접 등록한다(producer용 `KafkaModule`은 import하지 않음).

---

## Task 1: Notification Prisma 모델 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (끝에 모델 추가)

- [ ] **Step 1: 모델 추가**

`prisma/schema.prisma` 맨 끝에 추가:

```prisma
model Notification {
  id          String    @id @default(cuid())
  recipientId String
  type        String // NotificationType 값
  title       String
  body        String?
  entityType  String // EntityType 값(Post/Comment/Message)
  entityId    String
  eventId     String // 원천 도메인 이벤트 id(멱등 키 일부)
  readAt      DateTime?
  createdAt   DateTime  @default(now())

  // 같은 이벤트→같은 수신자 중복 방지(at-least-once 멱등)
  @@unique([eventId, recipientId])
  // 목록·미읽음 조회 최적화
  @@index([recipientId, readAt])
}
```

- [ ] **Step 2: 스키마 검증**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: 마이그레이션 생성·적용** (docker compose 기동 상태)

Run: `npx prisma migrate dev --name add_notification`
Expected: 마이그레이션 파일 생성 + DB 적용 + `Generated Prisma Client` 로그.

- [ ] **Step 4: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "[M5]feat: Notification 모델 추가(멱등 unique·조회 인덱스)"
```

---

## Task 2: NotificationType enum + Notification 도메인 엔티티

**Files:**
- Create: `src/notification/domain/notification-type.enum.ts`
- Create: `src/notification/domain/notification.entity.ts`
- Test: `src/notification/domain/notification.entity.spec.ts`

- [ ] **Step 1: enum 작성**

`src/notification/domain/notification-type.enum.ts`:

```ts
// 알림 종류. 매직스트링 금지 — 생성·표시 매핑이 이 enum을 단일 출처로 참조한다.
export const enum NotificationType {
  MessageReceived = 'MessageReceived',
  CommentAdded = 'CommentAdded',
  PostAdded = 'PostAdded',
}
```

- [ ] **Step 2: 실패 테스트 작성**

`src/notification/domain/notification.entity.spec.ts`:

```ts
import { Notification } from './notification.entity';
import { NotificationType } from './notification-type.enum';
import { EntityType } from '../../events/event-type.enum';

describe('Notification', () => {
  it('create는 readAt=null로 미읽음 상태를 만든다', () => {
    const n = Notification.create({
      recipientId: 'u1',
      type: NotificationType.PostAdded,
      title: '새 게시글',
      body: '공지 제목',
      entityType: EntityType.Post,
      entityId: 'p1',
      eventId: 'e1',
    });

    expect(n.recipientId).toBe('u1');
    expect(n.type).toBe(NotificationType.PostAdded);
    expect(n.readAt).toBeNull();
    expect(n.id).toBeUndefined();
  });

  it('reconstitute는 영속 상태(id·createdAt 포함)를 복원한다', () => {
    const created = new Date('2026-06-15T00:00:00.000Z');
    const n = Notification.reconstitute({
      id: 'n1',
      recipientId: 'u1',
      type: NotificationType.CommentAdded,
      title: '새 댓글',
      body: null,
      entityType: EntityType.Post,
      entityId: 'p1',
      eventId: 'e1',
      readAt: null,
      createdAt: created,
    });

    expect(n.id).toBe('n1');
    expect(n.createdAt).toBe(created);
    expect(n.body).toBeNull();
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/notification/domain/notification.entity.spec.ts`
Expected: FAIL (`Cannot find module './notification.entity'`)

- [ ] **Step 4: 엔티티 구현**

`src/notification/domain/notification.entity.ts`:

```ts
import { EntityType } from '../../events/event-type.enum';
import { NotificationType } from './notification-type.enum';

export interface NotificationProps {
  id?: string;
  recipientId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: EntityType;
  entityId: string;
  eventId: string;
  readAt: Date | null;
  createdAt?: Date;
}

// 한 수신자에게 전달되는 알림 한 건. 멱등 키는 (eventId, recipientId).
export class Notification {
  private constructor(private readonly props: NotificationProps) {}

  // 신규 생성: id·createdAt은 DB가 채우고, 항상 미읽음(readAt=null)으로 시작한다.
  static create(
    props: Omit<NotificationProps, 'id' | 'readAt' | 'createdAt'>,
  ): Notification {
    return new Notification({ ...props, readAt: null });
  }

  static reconstitute(props: NotificationProps): Notification {
    return new Notification(props);
  }

  get id(): string | undefined {
    return this.props.id;
  }
  get recipientId(): string {
    return this.props.recipientId;
  }
  get type(): NotificationType {
    return this.props.type;
  }
  get title(): string {
    return this.props.title;
  }
  get body(): string | null {
    return this.props.body;
  }
  get entityType(): EntityType {
    return this.props.entityType;
  }
  get entityId(): string {
    return this.props.entityId;
  }
  get eventId(): string {
    return this.props.eventId;
  }
  get readAt(): Date | null {
    return this.props.readAt;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/notification/domain/notification.entity.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/notification/domain/notification-type.enum.ts src/notification/domain/notification.entity.ts src/notification/domain/notification.entity.spec.ts
git commit -m "[M5]feat: NotificationType enum + Notification 도메인 엔티티"
```

---

## Task 3: 도메인 포트 + 알림 내용 매핑

**Files:**
- Create: `src/notification/domain/notification.repository.ts`
- Create: `src/notification/domain/notification-counter.ts`
- Create: `src/notification/domain/notification-relay.ts`
- Create: `src/notification/domain/recipient-resolver.ts`
- Create: `src/notification/domain/notification-content.ts`
- Test: `src/notification/domain/notification-content.spec.ts`

- [ ] **Step 1: 포트 작성**

`src/notification/domain/notification.repository.ts`:

```ts
import { Notification } from './notification.entity';

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

export interface NotificationRepository {
  // 멱등 저장: 신규면 영속화된 엔티티(id·createdAt 포함)를, 중복(P2002)이면 null을 반환한다.
  saveIfNew(notification: Notification): Promise<Notification | null>;
  listForUser(userId: string, limit: number): Promise<Notification[]>;
  // 수신자의 미읽음 알림을 모두 읽음 처리. 영향 행 수와 무관하게 멱등.
  markAllRead(userId: string): Promise<void>;
}
```

`src/notification/domain/notification-counter.ts`:

```ts
export const NOTIFICATION_COUNTER = Symbol('NOTIFICATION_COUNTER');

// 사용자별 미읽음 카운트(원자적). Redis INCR/GET/DEL로 구현한다.
export interface NotificationCounter {
  increment(userId: string): Promise<void>;
  get(userId: string): Promise<number>;
  reset(userId: string): Promise<void>;
}
```

`src/notification/domain/notification-relay.ts`:

```ts
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
    createdAt: string; // ISO 8601
  };
}

export interface NotificationRelay {
  publish(payload: NotificationPushPayload): Promise<void>;
  subscribe(handler: (payload: NotificationPushPayload) => void): Promise<void>;
}
```

`src/notification/domain/recipient-resolver.ts`:

```ts
import { DomainEvent } from '../../events/domain-event';

export const RECIPIENT_RESOLVER = Symbol('RECIPIENT_RESOLVER');

// 도메인 이벤트 → 알림 수신자 userId 목록(작성자/발신자 제외)을 해석한다.
export interface RecipientResolver {
  resolve(event: DomainEvent): Promise<string[]>;
}
```

- [ ] **Step 2: 내용 매핑 실패 테스트**

`src/notification/domain/notification-content.spec.ts`:

```ts
import { buildContent } from './notification-content';
import { NotificationType } from './notification-type.enum';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

function event(partial: Partial<DomainEvent>): DomainEvent {
  return {
    eventId: 'e1',
    eventType: EventType.PostCreated,
    occurredAt: '2026-06-15T00:00:00.000Z',
    actorId: 'author1',
    entityType: EntityType.Post,
    entityId: 'p1',
    payload: {},
    ...partial,
  };
}

describe('buildContent', () => {
  it('PostCreated → PostAdded, body는 글 제목', () => {
    const c = buildContent(
      event({
        eventType: EventType.PostCreated,
        entityId: 'p1',
        payload: { buildingId: 'b1', category: 'NOTICE', title: '엘리베이터 점검' },
      }),
    );

    expect(c).toEqual({
      type: NotificationType.PostAdded,
      title: '새 게시글',
      body: '엘리베이터 점검',
      entityType: EntityType.Post,
      entityId: 'p1',
    });
  });

  it('CommentCreated → CommentAdded, entityId는 postId', () => {
    const c = buildContent(
      event({
        eventType: EventType.CommentCreated,
        entityType: EntityType.Comment,
        entityId: 'c1',
        payload: { postId: 'p9' },
      }),
    );

    expect(c).toMatchObject({
      type: NotificationType.CommentAdded,
      entityType: EntityType.Post,
      entityId: 'p9',
    });
  });

  it('MessageSent → MessageReceived, body는 본문 50자, entityId는 roomId', () => {
    const long = 'a'.repeat(80);
    const c = buildContent(
      event({
        eventType: EventType.MessageSent,
        entityType: EntityType.Message,
        entityId: 'r1',
        payload: {
          roomId: 'r1',
          messageId: 'm1',
          senderId: 's1',
          content: long,
          createdAt: '2026-06-15T00:00:00.000Z',
        },
      }),
    );

    expect(c?.type).toBe(NotificationType.MessageReceived);
    expect(c?.entityId).toBe('r1');
    expect(c?.body).toHaveLength(50);
  });

  it('지원하지 않는 이벤트는 null', () => {
    expect(buildContent(event({ eventType: EventType.TenantJoined }))).toBeNull();
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/notification/domain/notification-content.spec.ts`
Expected: FAIL (`Cannot find module './notification-content'`)

- [ ] **Step 4: 내용 매핑 구현**

`src/notification/domain/notification-content.ts`:

```ts
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';
import { ChatMessagePayload } from '../../chat/domain/chat-message';
import { NotificationType } from './notification-type.enum';

// 알림에 저장·표시할 내용. entityType/entityId는 클라이언트 네비게이션 대상.
export interface NotificationContent {
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: EntityType;
  entityId: string;
}

const BODY_MAX = 50;

// 이벤트 payload만으로 결정되는 순수 매핑(DB 접근 없음). 미지원 이벤트는 null.
export function buildContent(event: DomainEvent): NotificationContent | null {
  switch (event.eventType) {
    case EventType.MessageSent: {
      const p = event.payload as ChatMessagePayload;
      return {
        type: NotificationType.MessageReceived,
        title: '새 메시지',
        body: p.content.slice(0, BODY_MAX),
        entityType: EntityType.Message,
        entityId: p.roomId,
      };
    }
    case EventType.CommentCreated: {
      const p = event.payload as { postId: string };
      return {
        type: NotificationType.CommentAdded,
        title: '새 댓글',
        body: '회원님의 글에 새 댓글이 달렸습니다',
        entityType: EntityType.Post,
        entityId: p.postId,
      };
    }
    case EventType.PostCreated: {
      const p = event.payload as { title: string };
      return {
        type: NotificationType.PostAdded,
        title: '새 게시글',
        body: p.title,
        entityType: EntityType.Post,
        entityId: event.entityId,
      };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/notification/domain/notification-content.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/notification/domain
git commit -m "[M5]feat: 알림 도메인 포트(repository·counter·relay·resolver) + 내용 매핑"
```

---

## Task 4: PrismaNotificationRepository (멱등 저장·목록·읽음)

**Files:**
- Create: `src/notification/infrastructure/prisma-notification.repository.ts`
- Test: `src/notification/infrastructure/prisma-notification.repository.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/notification/infrastructure/prisma-notification.repository.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import { PrismaNotificationRepository } from './prisma-notification.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { Notification } from '../domain/notification.entity';
import { NotificationType } from '../domain/notification-type.enum';
import { EntityType } from '../../events/event-type.enum';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

const newNotification = Notification.create({
  recipientId: 'u1',
  type: NotificationType.PostAdded,
  title: '새 게시글',
  body: '제목',
  entityType: EntityType.Post,
  entityId: 'p1',
  eventId: 'e1',
});

describe('PrismaNotificationRepository', () => {
  let prisma: {
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let repo: PrismaNotificationRepository;

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    repo = new PrismaNotificationRepository(prisma as unknown as PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('saveIfNew: 신규면 영속 엔티티(id·createdAt)를 반환한다', async () => {
    const created = new Date('2026-06-15T00:00:00.000Z');
    prisma.notification.create.mockResolvedValue({
      id: 'n1',
      recipientId: 'u1',
      type: 'PostAdded',
      title: '새 게시글',
      body: '제목',
      entityType: 'Post',
      entityId: 'p1',
      eventId: 'e1',
      readAt: null,
      createdAt: created,
    });

    const saved = await repo.saveIfNew(newNotification);

    expect(saved?.id).toBe('n1');
    expect(saved?.createdAt).toBe(created);
  });

  it('saveIfNew: 중복(P2002)이면 null', async () => {
    prisma.notification.create.mockRejectedValue(p2002());

    await expect(repo.saveIfNew(newNotification)).resolves.toBeNull();
  });

  it('saveIfNew: 그 외 에러는 다시 던진다', async () => {
    prisma.notification.create.mockRejectedValue(new Error('db down'));

    await expect(repo.saveIfNew(newNotification)).rejects.toThrow('db down');
  });

  it('markAllRead: 미읽음 행만 readAt 갱신', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });

    await repo.markAllRead('u1');

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientId: 'u1', readAt: null },
      data: { readAt: expect.any(Date) as Date },
    });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/infrastructure/prisma-notification.repository.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/infrastructure/prisma-notification.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntityType } from '../../events/event-type.enum';
import { NotificationRepository } from '../domain/notification.repository';
import { Notification } from '../domain/notification.entity';
import { NotificationType } from '../domain/notification-type.enum';

type NotificationRow = {
  id: string;
  recipientId: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string;
  entityId: string;
  eventId: string;
  readAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async saveIfNew(notification: Notification): Promise<Notification | null> {
    try {
      const row = await this.prisma.notification.create({
        data: {
          recipientId: notification.recipientId,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          entityType: notification.entityType,
          entityId: notification.entityId,
          eventId: notification.eventId,
        },
      });
      return this.toEntity(row);
    } catch (err) {
      // at-least-once 중복: (eventId, recipientId) 유니크 위반(P2002) → 이미 처리됨.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return null;
      }
      throw err;
    }
  }

  async listForUser(userId: string, limit: number): Promise<Notification[]> {
    const rows = await this.prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.toEntity(r));
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  private toEntity(row: NotificationRow): Notification {
    return Notification.reconstitute({
      id: row.id,
      recipientId: row.recipientId,
      type: row.type as NotificationType,
      title: row.title,
      body: row.body,
      entityType: row.entityType as EntityType,
      entityId: row.entityId,
      eventId: row.eventId,
      readAt: row.readAt,
      createdAt: row.createdAt,
    });
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/notification/infrastructure/prisma-notification.repository.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/notification/infrastructure/prisma-notification.repository.ts src/notification/infrastructure/prisma-notification.repository.spec.ts
git commit -m "[M5]feat: PrismaNotificationRepository(멱등 저장·목록·전체읽음)"
```

---

## Task 5: RedisNotificationCounter (원자적 미읽음)

**Files:**
- Create: `src/notification/infrastructure/redis-notification-counter.ts`
- Test: `src/notification/infrastructure/redis-notification-counter.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/notification/infrastructure/redis-notification-counter.spec.ts`:

```ts
import { RedisNotificationCounter } from './redis-notification-counter';
import { RedisService } from '../../redis/redis.service';

describe('RedisNotificationCounter', () => {
  let redis: { incr: jest.Mock; get: jest.Mock; del: jest.Mock };
  let counter: RedisNotificationCounter;

  beforeEach(() => {
    redis = { incr: jest.fn(), get: jest.fn(), del: jest.fn() };
    counter = new RedisNotificationCounter(redis as unknown as RedisService);
  });

  afterEach(() => jest.clearAllMocks());

  it('increment는 사용자 키를 INCR한다', async () => {
    redis.incr.mockResolvedValue(1);

    await counter.increment('u1');

    expect(redis.incr).toHaveBeenCalledWith('notif:unread:u1');
  });

  it('get은 값이 있으면 숫자로 반환한다', async () => {
    redis.get.mockResolvedValue('5');

    await expect(counter.get('u1')).resolves.toBe(5);
  });

  it('get은 키가 없으면 0', async () => {
    redis.get.mockResolvedValue(null);

    await expect(counter.get('u1')).resolves.toBe(0);
  });

  it('reset은 키를 DEL한다', async () => {
    redis.del.mockResolvedValue(1);

    await counter.reset('u1');

    expect(redis.del).toHaveBeenCalledWith('notif:unread:u1');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/infrastructure/redis-notification-counter.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/infrastructure/redis-notification-counter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { NotificationCounter } from '../domain/notification-counter';

// 사용자별 미읽음 카운터 키.
function unreadKey(userId: string): string {
  return `notif:unread:${userId}`;
}

@Injectable()
export class RedisNotificationCounter implements NotificationCounter {
  constructor(private readonly redis: RedisService) {}

  async increment(userId: string): Promise<void> {
    // 원자적 증가. 동시 알림에도 카운트 유실 없음.
    await this.redis.incr(unreadKey(userId));
  }

  async get(userId: string): Promise<number> {
    const v = await this.redis.get(unreadKey(userId));
    return v ? Number(v) : 0;
  }

  async reset(userId: string): Promise<void> {
    await this.redis.del(unreadKey(userId));
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/notification/infrastructure/redis-notification-counter.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/notification/infrastructure/redis-notification-counter.ts src/notification/infrastructure/redis-notification-counter.spec.ts
git commit -m "[M5]feat: RedisNotificationCounter(원자적 미읽음 INCR/GET/DEL)"
```

---

## Task 6: RedisNotificationRelay (프로세스 간 pub/sub 브리지)

**Files:**
- Create: `src/notification/infrastructure/redis-notification-relay.ts`
- Test: `src/notification/infrastructure/redis-notification-relay.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/notification/infrastructure/redis-notification-relay.spec.ts`:

```ts
import { RedisNotificationRelay } from './redis-notification-relay';
import { RedisService } from '../../redis/redis.service';
import { NotificationPushPayload } from '../domain/notification-relay';

const payload: NotificationPushPayload = {
  recipientId: 'u1',
  notification: {
    id: 'n1',
    type: 'PostAdded',
    title: '새 게시글',
    body: '제목',
    entityType: 'Post',
    entityId: 'p1',
    createdAt: '2026-06-15T00:00:00.000Z',
  },
};

describe('RedisNotificationRelay', () => {
  it('publish는 notifications 채널에 JSON을 발행한다', async () => {
    const redis = { publish: jest.fn() };
    const relay = new RedisNotificationRelay(redis as unknown as RedisService);

    await relay.publish(payload);

    expect(redis.publish).toHaveBeenCalledWith(
      'notifications',
      JSON.stringify(payload),
    );
  });

  it('subscribe는 전용 연결에서 수신 메시지를 파싱해 핸들러로 전달한다', async () => {
    const handlers: Record<string, (ch: string, raw: string) => void> = {};
    const sub = {
      subscribe: jest.fn(),
      on: jest.fn((evt: string, cb: (ch: string, raw: string) => void) => {
        handlers[evt] = cb;
      }),
    };
    const redis = { duplicate: jest.fn().mockReturnValue(sub) };
    const relay = new RedisNotificationRelay(redis as unknown as RedisService);

    const received: NotificationPushPayload[] = [];
    await relay.subscribe((p) => received.push(p));
    handlers['message']('notifications', JSON.stringify(payload));

    expect(sub.subscribe).toHaveBeenCalledWith('notifications');
    expect(received).toEqual([payload]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/infrastructure/redis-notification-relay.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** (chat의 RedisMessageRelay와 동일 패턴)

`src/notification/infrastructure/redis-notification-relay.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  NotificationRelay,
  NotificationPushPayload,
} from '../domain/notification-relay';

// 모든 main 인스턴스가 구독하는 단일 채널. 워커가 발행하면 gateway가 받아 emit한다.
const CHANNEL = 'notifications';

@Injectable()
export class RedisNotificationRelay implements NotificationRelay {
  private readonly logger = new Logger(RedisNotificationRelay.name);

  constructor(private readonly redis: RedisService) {}

  async publish(payload: NotificationPushPayload): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify(payload));
  }

  async subscribe(
    handler: (payload: NotificationPushPayload) => void,
  ): Promise<void> {
    // 구독 모드 연결은 일반 명령을 못 쓰므로 전용 연결(duplicate)을 만든다.
    const sub = this.redis.duplicate();
    await sub.subscribe(CHANNEL);
    sub.on('message', (_channel: string, raw: string) => {
      try {
        handler(JSON.parse(raw) as NotificationPushPayload);
      } catch (err) {
        this.logger.warn(`알림 중계 파싱 실패: ${(err as Error).message}`);
      }
    });
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/notification/infrastructure/redis-notification-relay.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/notification/infrastructure/redis-notification-relay.ts src/notification/infrastructure/redis-notification-relay.spec.ts
git commit -m "[M5]feat: RedisNotificationRelay(notifications 채널 pub/sub 브리지)"
```

---

## Task 7: PrismaRecipientResolver (이벤트 3종 수신자 해석)

**Files:**
- Create: `src/notification/infrastructure/prisma-recipient-resolver.ts`
- Test: `src/notification/infrastructure/prisma-recipient-resolver.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/notification/infrastructure/prisma-recipient-resolver.spec.ts`:

```ts
import { PrismaRecipientResolver } from './prisma-recipient-resolver';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

describe('PrismaRecipientResolver', () => {
  let prisma: {
    chatRoom: { findUnique: jest.Mock };
    post: { findFirst: jest.Mock };
    building: { findUnique: jest.Mock };
    lease: { findMany: jest.Mock };
  };
  let resolver: PrismaRecipientResolver;

  beforeEach(() => {
    prisma = {
      chatRoom: { findUnique: jest.fn() },
      post: { findFirst: jest.fn() },
      building: { findUnique: jest.fn() },
      lease: { findMany: jest.fn() },
    };
    resolver = new PrismaRecipientResolver(prisma as unknown as PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('MessageSent: 방 참가자 중 발신자를 제외', async () => {
    prisma.chatRoom.findUnique.mockResolvedValue({
      ownerId: 'owner1',
      tenantId: 'tenant1',
    });
    const event: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.MessageSent,
      occurredAt: '2026-06-15T00:00:00.000Z',
      actorId: 'tenant1',
      entityType: EntityType.Message,
      entityId: 'r1',
      payload: {
        roomId: 'r1',
        messageId: 'm1',
        senderId: 'tenant1',
        content: 'hi',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    };

    await expect(resolver.resolve(event)).resolves.toEqual(['owner1']);
  });

  it('CommentCreated: 글 작성자에게, 단 본인 댓글이면 제외', async () => {
    prisma.post.findFirst.mockResolvedValue({ authorId: 'author1' });
    const base: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.CommentCreated,
      occurredAt: '2026-06-15T00:00:00.000Z',
      actorId: 'commenter1',
      entityType: EntityType.Comment,
      entityId: 'c1',
      payload: { postId: 'p1' },
    };

    await expect(resolver.resolve(base)).resolves.toEqual(['author1']);
    await expect(
      resolver.resolve({ ...base, actorId: 'author1' }),
    ).resolves.toEqual([]);
  });

  it('PostCreated: 건물주 + ACTIVE 입주자, 작성자 제외, 중복 제거', async () => {
    prisma.building.findUnique.mockResolvedValue({ ownerId: 'owner1' });
    prisma.lease.findMany.mockResolvedValue([
      { tenantId: 'tenantA' },
      { tenantId: 'tenantB' },
      { tenantId: 'owner1' }, // 건물주가 입주자이기도 한 경우 → 중복 제거
    ]);
    const event: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.PostCreated,
      occurredAt: '2026-06-15T00:00:00.000Z',
      actorId: 'tenantA', // 작성자 제외
      entityType: EntityType.Post,
      entityId: 'p1',
      payload: { buildingId: 'b1', category: 'NOTICE', title: 't' },
    };

    const result = await resolver.resolve(event);

    expect(result.sort()).toEqual(['owner1', 'tenantB']);
  });

  it('대상이 없으면 빈 배열', async () => {
    prisma.chatRoom.findUnique.mockResolvedValue(null);
    const event: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.MessageSent,
      occurredAt: '2026-06-15T00:00:00.000Z',
      actorId: 's1',
      entityType: EntityType.Message,
      entityId: 'r1',
      payload: {
        roomId: 'r1',
        messageId: 'm1',
        senderId: 's1',
        content: 'x',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    };

    await expect(resolver.resolve(event)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/infrastructure/prisma-recipient-resolver.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/infrastructure/prisma-recipient-resolver.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEvent } from '../../events/domain-event';
import { EventType } from '../../events/event-type.enum';
import { ChatMessagePayload } from '../../chat/domain/chat-message';
import { RecipientResolver } from '../domain/recipient-resolver';

@Injectable()
export class PrismaRecipientResolver implements RecipientResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(event: DomainEvent): Promise<string[]> {
    switch (event.eventType) {
      case EventType.MessageSent:
        return this.forMessage(event.payload as ChatMessagePayload);
      case EventType.CommentCreated:
        return this.forComment(
          event.payload as { postId: string },
          event.actorId,
        );
      case EventType.PostCreated:
        return this.forPost(
          event.payload as { buildingId: string },
          event.actorId,
        );
      default:
        return [];
    }
  }

  // 방 참가자(owner·tenant) 중 발신자 제외.
  private async forMessage(payload: ChatMessagePayload): Promise<string[]> {
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: payload.roomId },
      select: { ownerId: true, tenantId: true },
    });
    if (!room) return [];
    return [room.ownerId, room.tenantId].filter(
      (id) => id !== payload.senderId,
    );
  }

  // 글 작성자에게. 단 본인이 단 댓글이면 제외. 삭제된 글은 무시.
  private async forComment(
    payload: { postId: string },
    actorId: string | null,
  ): Promise<string[]> {
    const post = await this.prisma.post.findFirst({
      where: { id: payload.postId, deletedAt: null },
      select: { authorId: true },
    });
    if (!post) return [];
    return post.authorId === actorId ? [] : [post.authorId];
  }

  // 건물주 + ACTIVE 리스 입주자. 작성자 제외, 중복 제거.
  private async forPost(
    payload: { buildingId: string },
    actorId: string | null,
  ): Promise<string[]> {
    const building = await this.prisma.building.findUnique({
      where: { id: payload.buildingId },
      select: { ownerId: true },
    });
    if (!building) return [];
    const leases = await this.prisma.lease.findMany({
      where: { status: 'ACTIVE', unit: { buildingId: payload.buildingId } },
      select: { tenantId: true },
    });
    const members = new Set<string>([
      building.ownerId,
      ...leases.map((l) => l.tenantId),
    ]);
    if (actorId) members.delete(actorId);
    return [...members];
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/notification/infrastructure/prisma-recipient-resolver.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/notification/infrastructure/prisma-recipient-resolver.ts src/notification/infrastructure/prisma-recipient-resolver.spec.ts
git commit -m "[M5]feat: PrismaRecipientResolver(채팅·댓글·게시글 수신자 해석)"
```

---

## Task 8: HandleEventUseCase (멱등 팬아웃)

**Files:**
- Create: `src/notification/application/handle-event.use-case.ts`
- Test: `src/notification/application/handle-event.use-case.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/notification/application/handle-event.use-case.spec.ts`:

```ts
import { HandleEventUseCase } from './handle-event.use-case';
import { RecipientResolver } from '../domain/recipient-resolver';
import { NotificationRepository } from '../domain/notification.repository';
import { NotificationCounter } from '../domain/notification-counter';
import {
  NotificationRelay,
  NotificationPushPayload,
} from '../domain/notification-relay';
import { Notification } from '../domain/notification.entity';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

const POST_EVENT: DomainEvent = {
  eventId: 'e1',
  eventType: EventType.PostCreated,
  occurredAt: '2026-06-15T00:00:00.000Z',
  actorId: 'author1',
  entityType: EntityType.Post,
  entityId: 'p1',
  payload: { buildingId: 'b1', category: 'NOTICE', title: '공지' },
};

// saveIfNew가 입력 엔티티를 그대로 영속본처럼 반환하도록 흉내낸다(id 부여).
function persisted(n: Notification, id: string): Notification {
  return Notification.reconstitute({
    id,
    recipientId: n.recipientId,
    type: n.type,
    title: n.title,
    body: n.body,
    entityType: n.entityType,
    entityId: n.entityId,
    eventId: n.eventId,
    readAt: null,
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
  });
}

function deps(recipients: string[]) {
  const resolver: RecipientResolver = {
    resolve: () => Promise.resolve(recipients),
  };
  const saved: Notification[] = [];
  const repo: NotificationRepository = {
    saveIfNew: (n) => {
      saved.push(n);
      return Promise.resolve(persisted(n, `n${saved.length}`));
    },
    listForUser: () => Promise.resolve([]),
    markAllRead: () => Promise.resolve(),
  };
  const incremented: string[] = [];
  const counter: NotificationCounter = {
    increment: (u) => {
      incremented.push(u);
      return Promise.resolve();
    },
    get: () => Promise.resolve(0),
    reset: () => Promise.resolve(),
  };
  const pushed: NotificationPushPayload[] = [];
  const relay: NotificationRelay = {
    publish: (p) => {
      pushed.push(p);
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve(),
  };
  return { resolver, repo, counter, relay, saved, incremented, pushed };
}

describe('HandleEventUseCase', () => {
  it('수신자별로 적재·INCR·push한다(팬아웃)', async () => {
    const { resolver, repo, counter, relay, saved, incremented, pushed } = deps(
      ['owner1', 'tenantB'],
    );
    const useCase = new HandleEventUseCase(resolver, repo, counter, relay);

    await useCase.execute(POST_EVENT);

    expect(saved.map((n) => n.recipientId)).toEqual(['owner1', 'tenantB']);
    expect(incremented).toEqual(['owner1', 'tenantB']);
    expect(pushed.map((p) => p.recipientId)).toEqual(['owner1', 'tenantB']);
    expect(pushed[0].notification.id).toBe('n1');
  });

  it('중복(saveIfNew=null)이면 INCR·push를 건너뛴다(멱등)', async () => {
    const { resolver, counter, relay, incremented, pushed } = deps(['owner1']);
    const repo: NotificationRepository = {
      saveIfNew: () => Promise.resolve(null), // 이미 처리됨
      listForUser: () => Promise.resolve([]),
      markAllRead: () => Promise.resolve(),
    };
    const useCase = new HandleEventUseCase(resolver, repo, counter, relay);

    await useCase.execute(POST_EVENT);

    expect(incremented).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('지원하지 않는 이벤트는 아무 것도 하지 않는다', async () => {
    const { resolver, repo, counter, relay, saved } = deps(['owner1']);
    const useCase = new HandleEventUseCase(resolver, repo, counter, relay);

    await useCase.execute({ ...POST_EVENT, eventType: EventType.TenantJoined });

    expect(saved).toEqual([]);
  });

  it('수신자가 없으면 no-op', async () => {
    const { resolver, repo, counter, relay, saved } = deps([]);
    const useCase = new HandleEventUseCase(resolver, repo, counter, relay);

    await useCase.execute(POST_EVENT);

    expect(saved).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/application/handle-event.use-case.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/application/handle-event.use-case.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainEvent } from '../../events/domain-event';
import { buildContent } from '../domain/notification-content';
import { Notification } from '../domain/notification.entity';
import {
  RECIPIENT_RESOLVER,
  RecipientResolver,
} from '../domain/recipient-resolver';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../domain/notification.repository';
import {
  NOTIFICATION_COUNTER,
  NotificationCounter,
} from '../domain/notification-counter';
import { NOTIFICATION_RELAY, NotificationRelay } from '../domain/notification-relay';

// 컨슈머가 받은 도메인 이벤트 1건을 수신자별 알림으로 팬아웃한다.
// 멱등: saveIfNew가 신규 행을 반환할 때만 카운터 증가·푸시한다(중복 소비 안전).
@Injectable()
export class HandleEventUseCase {
  private readonly logger = new Logger(HandleEventUseCase.name);

  constructor(
    @Inject(RECIPIENT_RESOLVER) private readonly resolver: RecipientResolver,
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
    @Inject(NOTIFICATION_RELAY) private readonly relay: NotificationRelay,
  ) {}

  async execute(event: DomainEvent): Promise<void> {
    const content = buildContent(event);
    if (!content) return; // 알림 대상 아닌 이벤트

    const recipients = await this.resolver.resolve(event);
    for (const recipientId of recipients) {
      const created = await this.repo.saveIfNew(
        Notification.create({
          recipientId,
          type: content.type,
          title: content.title,
          body: content.body,
          entityType: content.entityType,
          entityId: content.entityId,
          eventId: event.eventId,
        }),
      );
      if (!created) continue; // 이미 처리된 수신자 → 카운터·푸시 스킵

      await this.counter.increment(recipientId);
      // 푸시는 best-effort: 실패해도 적재·카운터(진실 원천)를 막지 않는다.
      try {
        await this.relay.publish({
          recipientId,
          notification: {
            id: created.id!,
            type: content.type,
            title: content.title,
            body: content.body,
            entityType: content.entityType,
            entityId: content.entityId,
            createdAt: (created.createdAt ?? new Date()).toISOString(),
          },
        });
      } catch (err) {
        this.logger.warn(`알림 푸시 실패: ${(err as Error).message}`);
      }
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/notification/application/handle-event.use-case.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/notification/application/handle-event.use-case.ts src/notification/application/handle-event.use-case.spec.ts
git commit -m "[M5]feat: HandleEventUseCase(수신자별 멱등 팬아웃·INCR·푸시)"
```

---

## Task 9: 읽기 유스케이스 3종 (목록·미읽음수·전체읽음)

**Files:**
- Create: `src/notification/application/list-notifications.use-case.ts`
- Create: `src/notification/application/get-unread-count.use-case.ts`
- Create: `src/notification/application/mark-all-read.use-case.ts`
- Test: `src/notification/application/read-use-cases.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/notification/application/read-use-cases.spec.ts`:

```ts
import { ListNotificationsUseCase } from './list-notifications.use-case';
import { GetUnreadCountUseCase } from './get-unread-count.use-case';
import { MarkAllReadUseCase } from './mark-all-read.use-case';
import { NotificationRepository } from '../domain/notification.repository';
import { NotificationCounter } from '../domain/notification-counter';
import { Notification } from '../domain/notification.entity';
import { NotificationType } from '../domain/notification-type.enum';
import { EntityType } from '../../events/event-type.enum';

const sample = Notification.reconstitute({
  id: 'n1',
  recipientId: 'u1',
  type: NotificationType.PostAdded,
  title: '새 게시글',
  body: '제목',
  entityType: EntityType.Post,
  entityId: 'p1',
  eventId: 'e1',
  readAt: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
});

describe('알림 읽기 유스케이스', () => {
  it('ListNotifications: repo.listForUser 결과를 반환', async () => {
    const calls: Array<[string, number]> = [];
    const repo: Partial<NotificationRepository> = {
      listForUser: (u, n) => {
        calls.push([u, n]);
        return Promise.resolve([sample]);
      },
    };
    const useCase = new ListNotificationsUseCase(
      repo as NotificationRepository,
    );

    const result = await useCase.execute('u1', 20);

    expect(result).toEqual([sample]);
    expect(calls).toEqual([['u1', 20]]);
  });

  it('GetUnreadCount: counter.get 위임', async () => {
    const counter: Partial<NotificationCounter> = {
      get: () => Promise.resolve(7),
    };
    const useCase = new GetUnreadCountUseCase(counter as NotificationCounter);

    await expect(useCase.execute('u1')).resolves.toBe(7);
  });

  it('MarkAllRead: 행 읽음 + 카운터 reset', async () => {
    const marked: string[] = [];
    const reset: string[] = [];
    const repo: Partial<NotificationRepository> = {
      markAllRead: (u) => {
        marked.push(u);
        return Promise.resolve();
      },
    };
    const counter: Partial<NotificationCounter> = {
      reset: (u) => {
        reset.push(u);
        return Promise.resolve();
      },
    };
    const useCase = new MarkAllReadUseCase(
      repo as NotificationRepository,
      counter as NotificationCounter,
    );

    await useCase.execute('u1');

    expect(marked).toEqual(['u1']);
    expect(reset).toEqual(['u1']);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/application/read-use-cases.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/application/list-notifications.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../domain/notification.repository';
import { Notification } from '../domain/notification.entity';

@Injectable()
export class ListNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
  ) {}

  execute(userId: string, limit: number): Promise<Notification[]> {
    return this.repo.listForUser(userId, limit);
  }
}
```

`src/notification/application/get-unread-count.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_COUNTER,
  NotificationCounter,
} from '../domain/notification-counter';

@Injectable()
export class GetUnreadCountUseCase {
  constructor(
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
  ) {}

  execute(userId: string): Promise<number> {
    return this.counter.get(userId);
  }
}
```

`src/notification/application/mark-all-read.use-case.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../domain/notification.repository';
import {
  NOTIFICATION_COUNTER,
  NotificationCounter,
} from '../domain/notification-counter';

@Injectable()
export class MarkAllReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
  ) {}

  // 행을 읽음 처리하고 미읽음 카운터를 0으로 리셋한다.
  async execute(userId: string): Promise<void> {
    await this.repo.markAllRead(userId);
    await this.counter.reset(userId);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/notification/application/read-use-cases.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/notification/application/list-notifications.use-case.ts src/notification/application/get-unread-count.use-case.ts src/notification/application/mark-all-read.use-case.ts src/notification/application/read-use-cases.spec.ts
git commit -m "[M5]feat: 알림 읽기 유스케이스(목록·미읽음수·전체읽음)"
```

---

## Task 10: NotificationWorkerController (@EventPattern)

**Files:**
- Create: `src/notification/interface/notification-worker.controller.ts`
- Test: `src/notification/interface/notification-worker.controller.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/notification/interface/notification-worker.controller.spec.ts`:

```ts
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/interface/notification-worker.controller.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/interface/notification-worker.controller.ts`:

```ts
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/notification/interface/notification-worker.controller.spec.ts`
Expected: PASS (1 test)

- [ ] **Step 5: 커밋**

```bash
git add src/notification/interface/notification-worker.controller.ts src/notification/interface/notification-worker.controller.spec.ts
git commit -m "[M5]feat: NotificationWorkerController(chat·board 이벤트 구독)"
```

---

## Task 11: NotificationGateway (WS `/notifications` 네임스페이스)

**Files:**
- Create: `src/notification/interface/notification.gateway.ts`
- Test: `src/notification/interface/notification.gateway.spec.ts`

> **참고:** `src/chat/interface/chat.gateway.ts`의 핸드셰이크 인증·`OnModuleInit` 구독 패턴을 그대로 따른다. 차이는 ① namespace `notifications`, ② 연결 시 `user:{userId}` 룸 자동 join, ③ relay 구독 시 `server.to('user:'+recipientId).emit('notification', …)`.

- [ ] **Step 1: 실패 테스트 작성**

`src/notification/interface/notification.gateway.spec.ts`:

```ts
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotificationGateway } from './notification.gateway';
import {
  NotificationRelay,
  NotificationPushPayload,
} from '../domain/notification-relay';
import { Socket } from 'socket.io';

const SECRET = 'test-secret';

function makeGateway(relay: NotificationRelay) {
  const config = {
    getOrThrow: () => SECRET,
  } as unknown as ConfigService;
  const jwt = new JwtService({ secret: SECRET });
  return { gateway: new NotificationGateway(jwt, config, relay), jwt };
}

describe('NotificationGateway', () => {
  it('유효 토큰이면 user 룸에 join한다', () => {
    const relay: NotificationRelay = {
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(),
    };
    const { gateway, jwt } = makeGateway(relay);
    const token = jwt.sign({ sub: 'u1' });
    const joined: string[] = [];
    const client = {
      handshake: { auth: { token } },
      data: {},
      join: (room: string) => {
        joined.push(room);
        return Promise.resolve();
      },
      disconnect: jest.fn(),
    } as unknown as Socket;

    gateway.handleConnection(client);

    expect(joined).toEqual(['user:u1']);
  });

  it('잘못된 토큰이면 disconnect', () => {
    const relay: NotificationRelay = {
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(),
    };
    const { gateway } = makeGateway(relay);
    const disconnect = jest.fn();
    const client = {
      handshake: { auth: { token: 'bad' } },
      data: {},
      join: () => Promise.resolve(),
      disconnect,
    } as unknown as Socket;

    gateway.handleConnection(client);

    expect(disconnect).toHaveBeenCalled();
  });

  it('onModuleInit: relay 수신 시 user 룸으로 emit', async () => {
    let handler: ((p: NotificationPushPayload) => void) | undefined;
    const relay: NotificationRelay = {
      publish: () => Promise.resolve(),
      subscribe: (h) => {
        handler = h;
        return Promise.resolve();
      },
    };
    const { gateway } = makeGateway(relay);
    const emitted: Array<{ room: string; payload: unknown }> = [];
    // server.to(room).emit('notification', payload) 체이닝 흉내
    gateway.server = {
      to: (room: string) => ({
        emit: (_evt: string, payload: unknown) =>
          emitted.push({ room, payload }),
      }),
    } as unknown as NotificationGateway['server'];

    await gateway.onModuleInit();
    handler?.({
      recipientId: 'u1',
      notification: {
        id: 'n1',
        type: 'PostAdded',
        title: '새 게시글',
        body: '제목',
        entityType: 'Post',
        entityId: 'p1',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe('user:u1');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/interface/notification.gateway.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/interface/notification.gateway.ts`:

```ts
import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ConfigKey } from '../../config/config-keys';
import { TokenPayload } from '../../auth/domain/token-issuer';
import {
  NOTIFICATION_RELAY,
  NotificationRelay,
} from '../domain/notification-relay';

// 알림 전용 WS. 채팅과 namespace를 분리(/notifications)해 핸들러 간섭을 막는다.
// 워커가 Redis로 발행한 알림을 받아 접속 중인 수신자에게만 emit한다.
@WebSocketGateway({ namespace: 'notifications', cors: true })
export class NotificationGateway
  implements OnGatewayConnection, OnModuleInit
{
  private readonly logger = new Logger(NotificationGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(NOTIFICATION_RELAY) private readonly relay: NotificationRelay,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.relay.subscribe((payload) => {
      this.server
        .to(`user:${payload.recipientId}`)
        .emit('notification', payload.notification);
    });
  }

  // 핸드셰이크 JWT 검증 후 사용자 전용 룸에 join. 실패 시 연결 거부.
  handleConnection(client: Socket): void {
    try {
      const token = (client.handshake.auth?.token ?? '') as string;
      const payload = this.jwt.verify<TokenPayload>(token, {
        secret: this.config.getOrThrow<string>(ConfigKey.JwtSecret),
      });
      (client.data as { userId?: string }).userId = payload.sub;
      void client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/notification/interface/notification.gateway.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/notification/interface/notification.gateway.ts src/notification/interface/notification.gateway.spec.ts
git commit -m "[M5]feat: NotificationGateway(/notifications WS 푸시 브리지)"
```

---

## Task 12: NotificationController (HTTP API) + Swagger

**Files:**
- Create: `src/notification/interface/notification.controller.ts`
- Create: `src/notification/interface/dto/notification-response.dto.ts`

> **참고:** `src/chat/interface/chat.controller.ts`의 가드·`@CurrentUser`·Swagger 데코레이터 패턴을 따른다. 컨트롤러 단위 테스트는 생략(가드/DI 통합은 부팅 검증 Task 16에서 확인) — 로직은 유스케이스에 있고 컨트롤러는 위임만 한다.

- [ ] **Step 1: 응답 DTO 작성(Swagger 스키마용)**

`src/notification/interface/dto/notification-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';

// 알림 목록 응답 1건의 형태(Swagger 노출용).
export class NotificationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) body!: string | null;
  @ApiProperty() entityType!: string;
  @ApiProperty() entityId!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  readAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class UnreadCountResponseDto {
  @ApiProperty({ example: 3 }) count!: number;
}
```

- [ ] **Step 2: 컨트롤러 구현**

`src/notification/interface/notification.controller.ts`:

```ts
import { Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';
import { ListNotificationsUseCase } from '../application/list-notifications.use-case';
import { GetUnreadCountUseCase } from '../application/get-unread-count.use-case';
import { MarkAllReadUseCase } from '../application/mark-all-read.use-case';
import {
  NotificationResponseDto,
  UnreadCountResponseDto,
} from './dto/notification-response.dto';

// 목록 기본/최대 개수(매직넘버 금지).
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@ApiTags('notification')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly list: ListNotificationsUseCase,
    private readonly unread: GetUnreadCountUseCase,
    private readonly markRead: MarkAllReadUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: '내 알림 목록(최신순)' })
  @ApiResponse({ status: 200, type: [NotificationResponseDto] })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: '인증 필요' })
  async listMine(
    @CurrentUser() user: TokenPayload,
    @Query('limit') limit?: string,
  ): Promise<NotificationResponseDto[]> {
    const n = Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const rows = await this.list.execute(user.sub, n);
    return rows.map((r) => ({
      id: r.id!,
      type: r.type,
      title: r.title,
      body: r.body,
      entityType: r.entityType,
      entityId: r.entityId,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: (r.createdAt ?? new Date()).toISOString(),
    }));
  }

  @Get('unread-count')
  @ApiOperation({ summary: '미읽음 알림 수(Redis 카운터)' })
  @ApiResponse({ status: 200, type: UnreadCountResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: '인증 필요' })
  async unreadCount(
    @CurrentUser() user: TokenPayload,
  ): Promise<UnreadCountResponseDto> {
    return { count: await this.unread.execute(user.sub) };
  }

  @Patch('read')
  @ApiOperation({ summary: '전체 읽음 처리(카운터 리셋)' })
  @ApiResponse({ status: 200, description: '처리 완료' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: '인증 필요' })
  async readAll(
    @CurrentUser() user: TokenPayload,
  ): Promise<{ ok: true }> {
    await this.markRead.execute(user.sub);
    return { ok: true };
  }
}
```

- [ ] **Step 3: 타입 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음(모듈 미연결 단계라 런타임 미검증, 타입만 확인)

- [ ] **Step 4: 커밋**

```bash
git add src/notification/interface/notification.controller.ts src/notification/interface/dto
git commit -m "[M5]feat: NotificationController(목록·미읽음수·전체읽음) + Swagger DTO"
```

---

## Task 13: 모듈 구성 (HTTP/WS + 워커)

**Files:**
- Create: `src/notification/notification.module.ts`
- Create: `src/notification/notification-worker.module.ts`

- [ ] **Step 1: HTTP/WS 모듈 작성**

`src/notification/notification.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConfigKey } from '../config/config-keys';
import { NotificationController } from './interface/notification.controller';
import { NotificationGateway } from './interface/notification.gateway';
import { ListNotificationsUseCase } from './application/list-notifications.use-case';
import { GetUnreadCountUseCase } from './application/get-unread-count.use-case';
import { MarkAllReadUseCase } from './application/mark-all-read.use-case';
import { NOTIFICATION_REPOSITORY } from './domain/notification.repository';
import { NOTIFICATION_COUNTER } from './domain/notification-counter';
import { NOTIFICATION_RELAY } from './domain/notification-relay';
import { PrismaNotificationRepository } from './infrastructure/prisma-notification.repository';
import { RedisNotificationCounter } from './infrastructure/redis-notification-counter';
import { RedisNotificationRelay } from './infrastructure/redis-notification-relay';

// main 프로세스: 알림 읽기 HTTP API + WS 푸시 게이트웨이. (컨슈머 없음)
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>(ConfigKey.JwtSecret),
      }),
    }),
  ],
  controllers: [NotificationController],
  providers: [
    NotificationGateway,
    ListNotificationsUseCase,
    GetUnreadCountUseCase,
    MarkAllReadUseCase,
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
    { provide: NOTIFICATION_COUNTER, useClass: RedisNotificationCounter },
    { provide: NOTIFICATION_RELAY, useClass: RedisNotificationRelay },
  ],
})
export class NotificationModule {}
```

- [ ] **Step 2: 워커 모듈 작성**

`src/notification/notification-worker.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { NotificationWorkerController } from './interface/notification-worker.controller';
import { HandleEventUseCase } from './application/handle-event.use-case';
import { RECIPIENT_RESOLVER } from './domain/recipient-resolver';
import { NOTIFICATION_REPOSITORY } from './domain/notification.repository';
import { NOTIFICATION_COUNTER } from './domain/notification-counter';
import { NOTIFICATION_RELAY } from './domain/notification-relay';
import { PrismaRecipientResolver } from './infrastructure/prisma-recipient-resolver';
import { PrismaNotificationRepository } from './infrastructure/prisma-notification.repository';
import { RedisNotificationCounter } from './infrastructure/redis-notification-counter';
import { RedisNotificationRelay } from './infrastructure/redis-notification-relay';

// notification-worker 프로세스 전용 모듈. AppModule을 쓰지 않으므로
// 전역 인프라(Config/Prisma/Redis)를 직접 import한다.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
  ],
  controllers: [NotificationWorkerController],
  providers: [
    KafkaTopicInitializer,
    HandleEventUseCase,
    { provide: RECIPIENT_RESOLVER, useClass: PrismaRecipientResolver },
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
    { provide: NOTIFICATION_COUNTER, useClass: RedisNotificationCounter },
    { provide: NOTIFICATION_RELAY, useClass: RedisNotificationRelay },
  ],
})
export class NotificationWorkerModule {}
```

- [ ] **Step 3: 타입 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 4: 커밋**

```bash
git add src/notification/notification.module.ts src/notification/notification-worker.module.ts
git commit -m "[M5]feat: NotificationModule(HTTP/WS) + NotificationWorkerModule"
```

---

## Task 14: persistence·audit 워커 분리 + audit chat 구독

**Files:**
- Create: `src/workers/persistence-worker.module.ts`
- Create: `src/workers/persistence-worker.main.ts`
- Create: `src/workers/audit-worker.module.ts`
- Create: `src/workers/audit-worker.main.ts`
- Create: `src/workers/notification-worker.main.ts`
- Modify: `src/audit/interface/audit-worker.controller.ts` (chat-events 핸들러 추가)

> **부트스트랩 공통 메모:** `NestFactory.create(<Module>)`로 앱을 만들되 `listen()`을 호출하지 않는다 → HTTP 포트를 바인딩하지 않는 컨슈머 전용 프로세스가 된다. `ConfigService`에서 brokers를 읽어 `connectMicroservice`에 전달하고, `startAllMicroservices()` 전에 `ensureTopics()`를 await한다(콜드스타트 토픽 race 방지). 이는 기존 `src/main.ts`의 hybrid 패턴과 동일하다.

- [ ] **Step 1: audit 컨트롤러에 chat-events 핸들러 추가**

`src/audit/interface/audit-worker.controller.ts` — `onMembershipEvent` 아래에 메서드 추가하고 클래스 주석을 업데이트한다:

```ts
  @EventPattern(KafkaTopic.ChatEvents)
  async onChatEvent(@Payload() event: DomainEvent): Promise<void> {
    await this.audit.record(event);
  }
```

(클래스 주석을 "board·membership·chat 전체를 구독해 AuditLog로 적재한다(audit=전체)"로 수정.)

- [ ] **Step 2: persistence 워커 모듈**

`src/workers/persistence-worker.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { ChatPersistenceController } from '../chat/infrastructure/chat-persistence.controller';
import { MESSAGE_REPOSITORY } from '../chat/domain/message.repository';
import { PrismaMessageRepository } from '../chat/infrastructure/prisma-message.repository';

// persistence-worker 프로세스 전용 모듈. chat-events → Message 멱등 INSERT.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  controllers: [ChatPersistenceController],
  providers: [
    KafkaTopicInitializer,
    { provide: MESSAGE_REPOSITORY, useClass: PrismaMessageRepository },
  ],
})
export class PersistenceWorkerModule {}
```

- [ ] **Step 3: audit 워커 모듈**

`src/workers/audit-worker.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { AuditWorkerController } from '../audit/interface/audit-worker.controller';
import { AUDIT_LOG_REPOSITORY } from '../audit/domain/audit-log.repository';
import { PrismaAuditLogRepository } from '../audit/infrastructure/prisma-audit-log.repository';

// audit-worker 프로세스 전용 모듈. chat·board·membership 전체 → AuditLog.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  controllers: [AuditWorkerController],
  providers: [
    KafkaTopicInitializer,
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
  ],
})
export class AuditWorkerModule {}
```

- [ ] **Step 4: 워커 엔트리포인트 3개**

`src/workers/persistence-worker.main.ts`:

```ts
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigKey } from '../config/config-keys';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { PersistenceWorkerModule } from './persistence-worker.module';

// chat-events를 독립 consumer group으로 소비한다(영속화).
async function bootstrap() {
  const app = await NestFactory.create(PersistenceWorkerModule);
  const config = app.get(ConfigService);
  await app.get(KafkaTopicInitializer).ensureTopics();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'persistence-worker' },
    },
  });
  await app.startAllMicroservices();
  // listen() 호출하지 않음 → HTTP 포트 미바인딩(컨슈머 전용 프로세스)
}
void bootstrap();
```

`src/workers/audit-worker.main.ts` (위와 동일하되 모듈·groupId만 변경):

```ts
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigKey } from '../config/config-keys';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { AuditWorkerModule } from './audit-worker.module';

// chat·board·membership 전체를 독립 consumer group으로 소비한다(감사).
async function bootstrap() {
  const app = await NestFactory.create(AuditWorkerModule);
  const config = app.get(ConfigService);
  await app.get(KafkaTopicInitializer).ensureTopics();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'audit-worker' },
    },
  });
  await app.startAllMicroservices();
}
void bootstrap();
```

`src/workers/notification-worker.main.ts`:

```ts
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigKey } from '../config/config-keys';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { NotificationWorkerModule } from '../notification/notification-worker.module';

// chat·board 이벤트를 독립 consumer group으로 소비한다(알림 생성·푸시).
async function bootstrap() {
  const app = await NestFactory.create(NotificationWorkerModule);
  const config = app.get(ConfigService);
  await app.get(KafkaTopicInitializer).ensureTopics();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'notification-worker' },
    },
  });
  await app.startAllMicroservices();
}
void bootstrap();
```

- [ ] **Step 5: 타입 컴파일 + audit 테스트 회귀 확인**

Run: `npx tsc --noEmit && npx jest src/audit`
Expected: 타입 에러 없음, audit 테스트 통과.

- [ ] **Step 6: 커밋**

```bash
git add src/workers src/audit/interface/audit-worker.controller.ts
git commit -m "[M5]feat: persistence·audit·notification 워커 엔트리포인트 분리 + audit chat 구독"
```

---

## Task 15: main.ts 컨슈머 제거 + 앱/스크립트/Swagger 배선

**Files:**
- Modify: `src/main.ts`
- Modify: `src/app.module.ts`
- Modify: `src/common/swagger/swagger.constants.ts`
- Modify: `package.json`

- [ ] **Step 1: main.ts에서 컨슈머 제거**

`src/main.ts`를 다음으로 교체(producer용 토픽 보장은 유지, consumer 연결·`startAllMicroservices` 제거):

```ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { KafkaTopicInitializer } from './events/kafka-topic-initializer';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // producer가 발행할 토픽이 존재하도록 사전생성(auto-create off).
  // 컨슈머는 별도 워커 프로세스(src/workers/*)에서 독립 consumer group으로 구동한다.
  await app.get(KafkaTopicInitializer).ensureTopics();

  // 프로덕션에서는 전체 API 표면을 인증 없이 노출하지 않도록 /docs 를 끈다.
  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    setupSwagger(app);
  }

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

- [ ] **Step 2: AppModule에 NotificationModule 추가**

`src/app.module.ts`의 import 목록과 `imports` 배열에 `NotificationModule`을 추가한다:

```ts
import { NotificationModule } from './notification/notification.module';
```
그리고 `imports: [...]`의 `ChatModule` 다음 줄에 `NotificationModule,` 추가.

> **주의:** `ChatModule`은 `ChatPersistenceController`를 controllers에 포함하고 있다. main 프로세스에서 이 컨트롤러는 `@EventPattern`이지만 연결된 microservice가 없으므로 동작하지 않는다(핸들러 미바인딩). 영속화는 persistence-worker가 담당하므로 기능상 문제는 없다. 다만 관심사 명확화를 위해 `ChatModule`에서 `ChatPersistenceController`를 controllers에서 제거하는 것은 **이번 범위 밖**(M4 코드 변경 최소화)으로 두고 README 한계에 기록한다.

- [ ] **Step 3: SWAGGER_TAGS에 notification 추가**

`src/common/swagger/swagger.constants.ts`:

```ts
export const SWAGGER_TAGS = ['auth', 'property', 'board', 'notification'] as const;
```

- [ ] **Step 4: package.json 워커 스크립트 추가**

`package.json`의 `scripts`에 추가:

```jsonc
"start:worker:persistence": "nest start --entryFile workers/persistence-worker.main",
"start:worker:audit": "nest start --entryFile workers/audit-worker.main",
"start:worker:notification": "nest start --entryFile workers/notification-worker.main",
"start:prod:persistence": "node dist/workers/persistence-worker.main",
"start:prod:audit": "node dist/workers/audit-worker.main",
"start:prod:notification": "node dist/workers/notification-worker.main"
```

- [ ] **Step 5: 빌드 + 전체 테스트**

Run: `npm run build && npx jest`
Expected: 빌드 성공, 전체 테스트 통과(신규 알림 스펙 포함).

- [ ] **Step 6: lint + 포맷**

Run: `npx prettier --write "src/**/*.ts" && npx eslint src`
Expected: eslint 0 에러.

- [ ] **Step 7: 커밋**

```bash
git add src/main.ts src/app.module.ts src/common/swagger/swagger.constants.ts package.json
git commit -m "[M5]refactor: main 컨슈머 제거(순수 HTTP+WS+producer) + 알림 모듈·워커 스크립트 배선"
```

---

## Task 16: 부팅 검증 + README 갱신

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 인프라 + 마이그레이션 확인**

Run: `docker compose up -d && npx prisma migrate deploy`
Expected: 컨테이너 healthy, 마이그레이션 적용.

- [ ] **Step 2: main + 워커 3개 부팅 검증** (각각 별도 터미널, 또는 백그라운드)

Run:
```bash
npm run start:dev &                 # main: HTTP 3000 + /notifications WS
npm run start:worker:persistence &
npm run start:worker:audit &
npm run start:worker:notification &
```
Expected 로그:
- 각 워커: `토픽이 모두 존재함(생성 건너뜀)` 또는 `토픽 생성 완료`, consumer 파티션 할당 로그(`Subscribed`/partitions assigned), "Topic creation errors" **없음**.
- main: Nest 부팅, `/docs` 노출, 컨슈머 로그 없음.

- [ ] **Step 3: 팬아웃 수동 검증(글 작성 1건 → 3그룹 소비)**

회원가입·로그인으로 토큰을 얻고(README의 auth 예시 참조), 건물 OWNER로 글을 작성한다:
```bash
# 토큰 발급 후
curl -X POST localhost:3000/buildings/<buildingId>/posts \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"category":"NOTICE","title":"엘리베이터 점검","content":"내일 오전"}'
```
검증:
- DB `AuditLog`에 PostCreated 1행(audit-worker).
- DB `Notification`에 건물 멤버(작성자 제외) 각 1행(notification-worker).
- `GET localhost:3000/notifications/unread-count`(수신자 토큰) → count ≥ 1.
- `GET localhost:3000/notifications`(수신자 토큰) → 방금 알림 포함.
- `PATCH localhost:3000/notifications/read` 후 unread-count → 0.

- [ ] **Step 4: README 갱신**

다음을 README에 반영:
1. **API 표(notification 컨텍스트)** 추가:
   | 메서드·경로 | 기능 | 인가 |
   |---|---|---|
   | `GET /notifications` | 내 알림 목록(최신순) | 인증(본인) |
   | `GET /notifications/unread-count` | 미읽음 수(Redis 카운터) | 인증(본인) |
   | `PATCH /notifications/read` | 전체 읽음 + 카운터 리셋 | 인증(본인) |
   | WS `/notifications` (`notification` 이벤트) | 실시간 알림 푸시 | 핸드셰이크 JWT |
2. **마일스톤 표 M5 완료** 표기.
3. **설계 결정 추가**: "12. 워커별 엔트리포인트로 컨슈머 그룹 분리 — main은 HTTP+WS+producer, persistence/audit/notification은 독립 프로세스·독립 group. 같은 이벤트를 3 group이 독립 소비하는 팬아웃 완성."
4. **실행법**: docker compose + `npm run start:dev`(main) + `npm run start:worker:*` 3개.
5. **알려진 한계 갱신**: M4의 "단일 group" 한계 해소를 명시. 새 한계 — ① main에 남은 `ChatPersistenceController`는 microservice 미연결로 비활성(영속화는 워커가 담당), ② PostCreated 1:N 동기 생성 비용, ③ dual-write 유실은 여전히 M6 Outbox 대상.

- [ ] **Step 5: 커밋**

```bash
git add README.md
git commit -m "[M5]docs: 알림 API 표·마일스톤 M5·워커 분리 결정·실행법 갱신"
```

- [ ] **Step 6: 최종 점검**

Run: `npx jest && npm run build && npx eslint src`
Expected: 전체 테스트 통과, 빌드 성공, lint 0.

---

## 완료 기준 체크리스트

- [ ] `chat-events`/`board-events` 1건이 persistence·notification·audit **세 group에 각각** 소비됨(부팅 로그·DB로 확인).
- [ ] `MessageSent`·`CommentCreated`·`PostCreated`로 수신자별 `Notification` 행 생성(작성자/발신자 제외, PostCreated는 건물 멤버 N명).
- [ ] 중복 소비 시 `@@unique([eventId, recipientId])`로 행·카운터 미중복(멱등).
- [ ] 접속 중 수신자는 `/notifications` WS로 `notification` 이벤트 수신.
- [ ] `GET /notifications`·`GET /notifications/unread-count`·`PATCH /notifications/read` 동작, 읽음 후 카운터 0.
- [ ] 전체 테스트 통과 + 빌드 + lint 0 + Swagger에 notification 노출.

---

## 실행 핸드오프

이 계획은 **superpowers:subagent-driven-development**로 task 단위 실행을 권장한다(태스크별 fresh 서브에이전트 + 2단계 리뷰). 또는 **superpowers:executing-plans**로 인라인 실행.
