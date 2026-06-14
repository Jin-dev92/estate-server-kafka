# M3 — Kafka 도입 + audit-worker 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 도메인 이벤트 4종(PostCreated/CommentCreated/TenantJoined/LeaseEnded)을 Kafka로 발행하고, 부작용 없는 audit-worker가 멱등 소비해 `AuditLog`에 적재한다.

**Architecture:** `@nestjs/microservices`(ClientKafka producer + `@EventPattern` consumer, hybrid app). 발행은 application 레이어가 `EventPublisher` 포트로 직접 수행(접근 A). 발행 실패는 `KafkaEventPublisher` 내부에서 잡아 로깅·삼킴(after-commit 한계, 유실 방지는 M6 Outbox). 멱등 소비는 `AuditLog.eventId @unique`로 보장.

**Tech Stack:** NestJS · @nestjs/microservices · kafkajs · Prisma · PostgreSQL · Jest

> 설계 근거: [2026-06-14-m3-kafka-audit-design.md](../specs/2026-06-14-m3-kafka-audit-design.md)

---

## 사전 메모 (구현자 필독)

- **이미 준비된 것:** docker-compose의 Kafka 브로커(M0, 호스트 `9092`), `.env.example`의 `KAFKA_BROKERS="localhost:9092"`, `ConfigKey.KafkaBrokers`. 이들은 **추가 작업 불필요**.
- **발행 실패 캡슐화:** 스펙의 "발행 실패는 에러 로깅만"을 각 유스케이스가 아니라 `KafkaEventPublisher.publish` **내부**에 둔다. `publish`는 절대 throw하지 않는다 → 유스케이스는 `try/catch` 없이 호출만 한다.
- **Lease 도메인 ↔ Prisma 필드명:** 도메인은 `endedAt`, Prisma 모델 컬럼은 `endDate`다. repository에서 매핑한다.
- **`Lease`는 불변 패턴:** 기존 `Post.edit()`처럼 `end()`는 상태를 바꾼 **새 인스턴스를 반환**한다(props가 `readonly`).
- **권한(OWNER) 검사 경로:** `lease.unitId → UnitRepository.findById → unit.buildingId → BuildingRepository.findById → building.isOwnedBy(userId)`. 세 repository 모두 `findById`가 있고(`LeaseRepository`만 없어 Task 6에서 추가), `Building.isOwnedBy`도 존재한다.
- **마이그레이션엔 실행 중 PostgreSQL 필요**(`docker compose up -d`, 이미 healthy).
- **DB mock 캐스팅:** repository/publisher 단위 테스트에서 `PrismaService`·`ClientKafka`는 부분 mock을 `as unknown as T`로 주입한다(테스트 한정, `as any` 금지 규칙 준수). 주석으로 표기.

---

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `src/events/event-type.enum.ts` | EventType·EntityType·KafkaTopic 상수 | **신규** |
| `src/events/domain-event.ts` | `DomainEvent` 봉투 타입 | **신규** |
| `src/events/event-publisher.ts` | `EventPublisher` 포트 + 토큰 | **신규** |
| `src/events/kafka-event.publisher.ts` | ClientKafka 발행 구현 | **신규** |
| `src/events/kafka.module.ts` | `@Global` KafkaModule(ClientKafka + publisher) | **신규** |
| `prisma/schema.prisma` | `AuditLog` 모델 | 수정 |
| `src/board/application/create-post.use-case.ts` | PostCreated 발행 | 수정 |
| `src/board/application/create-comment.use-case.ts` | CommentCreated 발행 | 수정 |
| `src/property/application/redeem-invite-code.use-case.ts` | TenantJoined 발행 | 수정 |
| `src/property/domain/lease.entity.ts` | `endedAt` + `end()` | 수정 |
| `src/property/domain/lease.repository.ts` | `findById`/`update` | 수정 |
| `src/property/infrastructure/prisma-lease.repository.ts` | findById/update 구현 | 수정 |
| `src/property/application/end-lease.use-case.ts` | 계약 종료 + LeaseEnded 발행 | **신규** |
| `src/property/property.errors.ts` | LEASE_NOT_FOUND, LEASE_ALREADY_ENDED | 수정 |
| `src/property/interface/property.controller.ts` | `PATCH /leases/:id/end` | 수정 |
| `src/property/property.module.ts` | EndLeaseUseCase 등록 | 수정 |
| `src/audit/...` | AuditLog 포트·구현·worker·모듈 | **신규** |
| `src/main.ts` | hybrid app(Kafka consumer) | 수정 |
| `src/app.module.ts` | KafkaModule·AuditModule 등록 | 수정 |
| `README.md` | M3 마일스톤·API·설계결정 | 수정 |

---

## Task 1: 이벤트 공통 타입 + 패키지 설치

**Files:**
- Create: `src/events/event-type.enum.ts`, `src/events/domain-event.ts`, `src/events/event-publisher.ts`

- [ ] **Step 1: 패키지 설치**

Run: `npm install @nestjs/microservices kafkajs`
Expected: `package.json`에 두 패키지 추가, 설치 성공.

- [ ] **Step 2: 이벤트·토픽 상수 작성**

Create `src/events/event-type.enum.ts`:
```ts
// 도메인 이벤트 종류. 매직스트링 금지 — 발행·소비·매핑이 이 enum을 단일 출처로 참조한다.
export const enum EventType {
  PostCreated = 'PostCreated',
  CommentCreated = 'CommentCreated',
  TenantJoined = 'TenantJoined',
  LeaseEnded = 'LeaseEnded',
}

// 이벤트가 가리키는 엔티티 종류(AuditLog.entityType).
export const enum EntityType {
  Post = 'Post',
  Comment = 'Comment',
  Lease = 'Lease',
}

// Kafka 토픽 = 바운디드 컨텍스트 경계.
export const enum KafkaTopic {
  BoardEvents = 'board-events',
  MembershipEvents = 'membership-events',
}
```

- [ ] **Step 3: 봉투 타입 작성**

Create `src/events/domain-event.ts`:
```ts
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
```

- [ ] **Step 4: 발행 포트 작성**

Create `src/events/event-publisher.ts`:
```ts
import { DomainEvent } from './domain-event';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

// application 레이어가 의존하는 발행 포트. 도메인/유스케이스는 Kafka를 모른다(의존성 역전).
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}
```

- [ ] **Step 5: 컴파일 확인 + 커밋**

Run: `npx tsc --noEmit`
Expected: 에러 없음.
```bash
git add package.json package-lock.json src/events/event-type.enum.ts src/events/domain-event.ts src/events/event-publisher.ts
git commit -m "[M3]feat: 이벤트 공통 타입·발행 포트 + Kafka 패키지 설치

DomainEvent 봉투, EventType/EntityType/KafkaTopic 상수, EventPublisher 포트 정의.
@nestjs/microservices·kafkajs 설치.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: AuditLog 스키마 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: DB 컨테이너 확인**

Run: `docker compose up -d`
Expected: postgres healthy(이미 떠 있음).

- [ ] **Step 2: `AuditLog` 모델 추가**

`prisma/schema.prisma` 끝에 추가:
```prisma
model AuditLog {
  id         String   @id @default(cuid())
  eventId    String   @unique // 멱등 키 — 중복 소비 시 재적재 방지
  eventType  String
  actorId    String?
  entityType String
  entityId   String
  payload    Json
  occurredAt DateTime // 발행 측 발생 시각
  createdAt  DateTime @default(now()) // 소비 측 적재 시각

  @@index([entityType, entityId])
  @@index([eventType])
}
```

- [ ] **Step 3: 마이그레이션 생성·적용**

Run: `npx prisma migrate dev --name add_audit_log`
Expected: `prisma/migrations/<ts>_add_audit_log/` 생성, "Your database is now in sync", Client 재생성.

- [ ] **Step 4: 유효성 확인 + 커밋**

Run: `npx prisma validate`
Expected: valid.
```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "[M3]feat: AuditLog 모델 + 마이그레이션 추가

감사 로그(eventId @unique 멱등 키, eventType/actorId/entityType/entityId/payload).
다른 모델과 FK 없이 entityType+entityId 문자열로 느슨히 참조.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: KafkaModule + KafkaEventPublisher (TDD)

**Files:**
- Create: `src/events/kafka-event.publisher.ts`, `src/events/kafka-event.publisher.spec.ts`, `src/events/kafka.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `src/events/kafka-event.publisher.spec.ts`:
```ts
import { of, throwError } from 'rxjs';
import { ClientKafka } from '@nestjs/microservices';
import { KafkaEventPublisher } from './kafka-event.publisher';
import { EventType, EntityType, KafkaTopic } from './event-type.enum';
import { DomainEvent } from './domain-event';

function eventOf(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'e1',
    eventType: EventType.PostCreated,
    occurredAt: '2026-06-14T00:00:00.000Z',
    actorId: 'u1',
    entityType: EntityType.Post,
    entityId: 'post1',
    payload: { foo: 'bar' },
    ...overrides,
  };
}

describe('KafkaEventPublisher', () => {
  let client: { emit: jest.Mock; connect: jest.Mock };
  let publisher: KafkaEventPublisher;

  beforeEach(() => {
    // ClientKafka는 큰 타입이라 emit/connect만 mock하고 as unknown as 로 주입한다(테스트 한정).
    client = { emit: jest.fn().mockReturnValue(of(undefined)), connect: jest.fn() };
    publisher = new KafkaEventPublisher(client as unknown as ClientKafka);
  });

  afterEach(() => jest.clearAllMocks());

  it('PostCreated/CommentCreated는 board-events 토픽에 entityId 키로 발행한다', async () => {
    await publisher.publish(eventOf({ eventType: EventType.PostCreated, entityId: 'post1' }));

    expect(client.emit).toHaveBeenCalledWith(KafkaTopic.BoardEvents, {
      key: 'post1',
      value: eventOf({ eventType: EventType.PostCreated, entityId: 'post1' }),
    });
  });

  it('TenantJoined/LeaseEnded는 membership-events 토픽에 발행한다', async () => {
    await publisher.publish(eventOf({ eventType: EventType.LeaseEnded, entityType: EntityType.Lease, entityId: 'lease1' }));

    expect(client.emit).toHaveBeenCalledWith(KafkaTopic.MembershipEvents, {
      key: 'lease1',
      value: eventOf({ eventType: EventType.LeaseEnded, entityType: EntityType.Lease, entityId: 'lease1' }),
    });
  });

  it('발행이 실패해도 throw하지 않는다(after-commit 한계, 로깅만)', async () => {
    client.emit.mockReturnValue(throwError(() => new Error('broker down')));

    await expect(
      publisher.publish(eventOf()),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/events/kafka-event.publisher.spec.ts`
Expected: FAIL — `KafkaEventPublisher` 미존재.

- [ ] **Step 3: publisher 구현**

Create `src/events/kafka-event.publisher.ts`:
```ts
import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { EventPublisher } from './event-publisher';
import { DomainEvent } from './domain-event';
import { EventType, KafkaTopic } from './event-type.enum';

// 이벤트 종류 → 토픽 매핑의 단일 출처.
const TOPIC_BY_EVENT: Record<EventType, KafkaTopic> = {
  [EventType.PostCreated]: KafkaTopic.BoardEvents,
  [EventType.CommentCreated]: KafkaTopic.BoardEvents,
  [EventType.TenantJoined]: KafkaTopic.MembershipEvents,
  [EventType.LeaseEnded]: KafkaTopic.MembershipEvents,
};

export const KAFKA_CLIENT = 'KAFKA_CLIENT';

@Injectable()
export class KafkaEventPublisher implements EventPublisher, OnModuleInit {
  private readonly logger = new Logger(KafkaEventPublisher.name);

  constructor(@Inject(KAFKA_CLIENT) private readonly client: ClientKafka) {}

  async onModuleInit(): Promise<void> {
    // producer 전용 연결. (consumer는 hybrid app이 별도로 띄운다.)
    await this.client.connect();
  }

  async publish(event: DomainEvent): Promise<void> {
    const topic = TOPIC_BY_EVENT[event.eventType];
    try {
      // 파티션 키 = entityId → 같은 엔티티 이벤트의 순서 보장.
      await firstValueFrom(this.client.emit(topic, { key: event.entityId, value: event }));
    } catch (err) {
      // after-commit 한계: DB는 이미 커밋됐으므로 발행 실패를 삼키고 로깅만 한다.
      // 유실 방지는 M6 Transactional Outbox에서 해결한다.
      this.logger.error(`이벤트 발행 실패: ${event.eventType} ${event.entityId}`, err as Error);
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/events/kafka-event.publisher.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: KafkaModule 작성**

Create `src/events/kafka.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigKey } from '../config/config-keys';
import { EVENT_PUBLISHER } from './event-publisher';
import { KafkaEventPublisher, KAFKA_CLIENT } from './kafka-event.publisher';

// 전역 모듈: 어느 컨텍스트의 유스케이스든 EVENT_PUBLISHER를 주입받을 수 있다.
@Global()
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: KAFKA_CLIENT,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              brokers: config
                .getOrThrow<string>(ConfigKey.KafkaBrokers)
                .split(','),
            },
          },
        }),
      },
    ]),
  ],
  providers: [{ provide: EVENT_PUBLISHER, useClass: KafkaEventPublisher }],
  exports: [EVENT_PUBLISHER],
})
export class KafkaModule {}
```

- [ ] **Step 6: app.module에 KafkaModule 등록**

`src/app.module.ts`의 `imports` 배열에 `KafkaModule`을 추가하고 상단에 import 추가:
```ts
import { KafkaModule } from './events/kafka.module';
```
imports에 `KafkaModule,` 추가(PrismaModule·RedisModule과 같은 줄 그룹).

- [ ] **Step 7: 컴파일 + 테스트 + 커밋**

Run: `npx tsc --noEmit && npx jest src/events`
Expected: 컴파일 OK, PASS.
```bash
git add src/events/kafka-event.publisher.ts src/events/kafka-event.publisher.spec.ts src/events/kafka.module.ts src/app.module.ts
git commit -m "[M3]feat: KafkaEventPublisher + 전역 KafkaModule

ClientKafka producer로 eventType→topic 매핑 발행(키=entityId).
발행 실패는 내부에서 로깅·삼킴(never throws, after-commit 한계).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: board 이벤트 발행 (CreatePost, CreateComment) (TDD)

**Files:**
- Modify: `src/board/application/create-post.use-case.ts`, `src/board/application/create-comment.use-case.ts`
- Create: `src/board/application/create-post.use-case.spec.ts`
- Modify (if exists): `src/board/application/create-comment.use-case.spec.ts`

- [ ] **Step 1: CreatePost 발행 테스트 작성**

Create `src/board/application/create-post.use-case.spec.ts`:
```ts
import { CreatePostUseCase } from './create-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache } from './board-cache';
import { MembershipChecker } from './membership';
import { EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

const USER_ID = 'u1';
const BUILDING_ID = 'b1';
const POST_ID = 'p1';

function deps(isMember: boolean) {
  const saved = Post.reconstitute({
    id: POST_ID,
    buildingId: BUILDING_ID,
    authorId: USER_ID,
    category: PostCategory.FREE,
    title: '제목',
    content: '본문',
  });
  const posts: PostRepository = {
    create: () => Promise.resolve(saved),
    findById: () => Promise.resolve(null),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
  const cache: Partial<BoardCache> = { invalidateList: () => Promise.resolve() };
  const membership: MembershipChecker = { isMember: () => Promise.resolve(isMember) };
  const published: unknown[] = [];
  const events: EventPublisher = {
    publish: (e) => {
      published.push(e);
      return Promise.resolve();
    },
  };
  return { posts, cache, membership, events, published };
}

describe('CreatePostUseCase', () => {
  it('멤버가 작성하면 PostCreated 이벤트를 발행한다', async () => {
    const { posts, cache, membership, events, published } = deps(true);
    const useCase = new CreatePostUseCase(posts, cache as BoardCache, membership, events);

    await useCase.execute({ userId: USER_ID, buildingId: BUILDING_ID, title: '제목', content: '본문' });

    expect(published).toEqual([
      expect.objectContaining({
        eventType: EventType.PostCreated,
        entityType: EntityType.Post,
        entityId: POST_ID,
        actorId: USER_ID,
        payload: expect.objectContaining({ buildingId: BUILDING_ID }),
      }),
    ]);
  });

  it('멤버가 아니면 NOT_BUILDING_MEMBER로 거부하고 발행하지 않는다', async () => {
    const { posts, cache, membership, events, published } = deps(false);
    const useCase = new CreatePostUseCase(posts, cache as BoardCache, membership, events);

    await expect(
      useCase.execute({ userId: USER_ID, buildingId: BUILDING_ID, title: 't', content: 'c' }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
    expect(published).toEqual([]);
  });
});
```

> 에러 코드 `BOARD_NOT_BUILDING_MEMBER`는 `src/board/board.errors.ts`와 대조해 실제 값으로 맞춘다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/board/application/create-post.use-case.spec.ts`
Expected: FAIL — 생성자 인자 수 불일치(아직 events 미주입).

- [ ] **Step 3: CreatePostUseCase에 발행 추가**

`src/board/application/create-post.use-case.ts`를 수정한다. import 추가:
```ts
import { randomUUID } from 'node:crypto';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';
```
생성자에 publisher 주입(마지막 파라미터):
```ts
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
```
`execute`의 `return saved;` 직전에 발행 추가:
```ts
    await this.events.publish({
      eventId: randomUUID(),
      eventType: EventType.PostCreated,
      occurredAt: new Date().toISOString(),
      actorId: input.userId,
      entityType: EntityType.Post,
      entityId: saved.id!,
      payload: {
        buildingId: saved.buildingId,
        category: saved.category,
        title: saved.title,
      },
    });
    return saved;
```

- [ ] **Step 4: CreatePost 테스트 통과 확인**

Run: `npx jest src/board/application/create-post.use-case.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: CreateComment에 발행 추가**

`src/board/application/create-comment.use-case.ts`에 동일 import를 추가하고, 생성자 마지막에 `@Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,`를 추가한 뒤, `return saved;` 직전에 발행 추가:
```ts
    await this.events.publish({
      eventId: randomUUID(),
      eventType: EventType.CommentCreated,
      occurredAt: new Date().toISOString(),
      actorId: input.userId,
      entityType: EntityType.Comment,
      entityId: saved.id!,
      payload: { postId: saved.postId },
    });
    return saved;
```

- [ ] **Step 6: 기존 create-comment 테스트 보정**

`src/board/application/create-comment.use-case.spec.ts`가 있으면 `CreateCommentUseCase` 생성자 호출에 `EventPublisher` mock을 마지막 인자로 추가한다(없으면 새로 만들지 않는다 — 이 단계는 컴파일/회귀 통과가 목적):
```ts
const events: EventPublisher = { publish: () => Promise.resolve() };
// new CreateCommentUseCase(comments, posts, cache, membership, events)
```
`import { EventPublisher } from '../../events/event-publisher';` 추가.

- [ ] **Step 7: board 전체 테스트 + 커밋**

Run: `npx jest src/board`
Expected: PASS(무회귀).
```bash
git add src/board/application/create-post.use-case.ts src/board/application/create-comment.use-case.ts src/board/application/create-post.use-case.spec.ts src/board/application/create-comment.use-case.spec.ts
git commit -m "[M3]feat: 게시글·댓글 생성 시 PostCreated/CommentCreated 발행

CreatePost/CreateComment 유스케이스에 EventPublisher 주입, DB 저장 성공 후 발행.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: TenantJoined 발행 (RedeemInviteCode) (TDD)

**Files:**
- Modify: `src/property/application/redeem-invite-code.use-case.ts`
- Create: `src/property/application/redeem-invite-code.use-case.spec.ts`

- [ ] **Step 1: 테스트 작성**

Create `src/property/application/redeem-invite-code.use-case.spec.ts`:
```ts
import { RedeemInviteCodeUseCase } from './redeem-invite-code.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';
import { InviteCodeStore } from '../domain/invite-code.store';
import { EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

const TENANT_ID = 't1';
const UNIT_ID = 'unit1';
const LEASE_ID = 'lease1';
const CODE = 'ABC123';

function deps(redeemResult: { unitId: string } | null) {
  const saved = Lease.reconstitute({
    id: LEASE_ID,
    unitId: UNIT_ID,
    tenantId: TENANT_ID,
    status: LeaseStatus.ACTIVE,
    endedAt: null,
  });
  const invites: InviteCodeStore = {
    issue: () => Promise.resolve(''),
    redeem: () => Promise.resolve(redeemResult),
  };
  const leases: Partial<LeaseRepository> = { save: () => Promise.resolve(saved) };
  const published: unknown[] = [];
  const events: EventPublisher = {
    publish: (e) => {
      published.push(e);
      return Promise.resolve();
    },
  };
  return { invites, leases, events, published };
}

describe('RedeemInviteCodeUseCase', () => {
  it('초대코드 사용 시 TenantJoined를 발행한다', async () => {
    const { invites, leases, events, published } = deps({ unitId: UNIT_ID });
    const useCase = new RedeemInviteCodeUseCase(invites, leases as LeaseRepository, events);

    await useCase.execute({ tenantId: TENANT_ID, code: CODE });

    expect(published).toEqual([
      expect.objectContaining({
        eventType: EventType.TenantJoined,
        entityType: EntityType.Lease,
        entityId: LEASE_ID,
        actorId: TENANT_ID,
        payload: expect.objectContaining({ unitId: UNIT_ID }),
      }),
    ]);
  });

  it('유효하지 않은 코드면 발행하지 않는다', async () => {
    const { invites, leases, events, published } = deps(null);
    const useCase = new RedeemInviteCodeUseCase(invites, leases as LeaseRepository, events);

    await expect(
      useCase.execute({ tenantId: TENANT_ID, code: CODE }),
    ).rejects.toMatchObject({ code: 'PROPERTY_INVALID_INVITE_CODE' });
    expect(published).toEqual([]);
  });
});
```

> `InviteCodeStore` 인터페이스의 실제 메서드 시그니처를 `src/property/domain/invite-code.store.ts`에서 확인해 mock을 맞춘다(`issue`/`redeem` 이름·반환형이 다르면 조정).

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/property/application/redeem-invite-code.use-case.spec.ts`
Expected: FAIL — 생성자 인자 수 불일치.

- [ ] **Step 3: 발행 추가**

`src/property/application/redeem-invite-code.use-case.ts`에 import 추가:
```ts
import { randomUUID } from 'node:crypto';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';
```
생성자 마지막에 주입:
```ts
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
```
`execute`를 수정해 save 결과를 변수로 받고 발행 후 반환:
```ts
    const saved = await this.leases.save(lease);
    await this.events.publish({
      eventId: randomUUID(),
      eventType: EventType.TenantJoined,
      occurredAt: new Date().toISOString(),
      actorId: input.tenantId,
      entityType: EntityType.Lease,
      entityId: saved.id!,
      payload: { unitId: saved.unitId },
    });
    return saved;
```

- [ ] **Step 4: 테스트 통과 + 커밋**

Run: `npx jest src/property/application/redeem-invite-code.use-case.spec.ts`
Expected: PASS (2 tests).
```bash
git add src/property/application/redeem-invite-code.use-case.ts src/property/application/redeem-invite-code.use-case.spec.ts
git commit -m "[M3]feat: 초대코드 사용 시 TenantJoined 발행

RedeemInviteCode 유스케이스에 EventPublisher 주입, 입주 생성 후 발행.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Lease 도메인 end() + repository 확장 (TDD)

**Files:**
- Modify: `src/property/domain/lease.entity.ts`, `src/property/domain/lease.repository.ts`, `src/property/infrastructure/prisma-lease.repository.ts`
- Create: `src/property/domain/lease.entity.spec.ts`

- [ ] **Step 1: 도메인 테스트 작성**

Create `src/property/domain/lease.entity.spec.ts`:
```ts
import { Lease } from './lease.entity';
import { LeaseStatus } from './lease-status.enum';
import { DomainError } from '../../common/errors/domain-error';

function activeLease(): Lease {
  return Lease.reconstitute({
    id: 'lease1',
    unitId: 'unit1',
    tenantId: 't1',
    status: LeaseStatus.ACTIVE,
    endedAt: null,
  });
}

describe('Lease.end', () => {
  it('ACTIVE 계약을 종료하면 status=ENDED, endedAt이 채워진 새 인스턴스를 반환한다', () => {
    const lease = activeLease();

    const ended = lease.end();

    expect(ended.status).toBe(LeaseStatus.ENDED);
    expect(ended.endedAt).toBeInstanceOf(Date);
  });

  it('이미 종료된 계약을 다시 종료하면 DomainError', () => {
    const ended = activeLease().end();

    expect(() => ended.end()).toThrow(DomainError);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/property/domain/lease.entity.spec.ts`
Expected: FAIL — `endedAt` prop·`end()` 미존재(타입 에러 포함).

- [ ] **Step 3: Lease 엔티티 수정**

`src/property/domain/lease.entity.ts`를 아래로 교체한다:
```ts
import { LeaseStatus } from './lease-status.enum';
import { DomainError } from '../../common/errors/domain-error';

interface LeaseProps {
  id: string | null;
  unitId: string;
  tenantId: string;
  status: LeaseStatus;
  endedAt: Date | null;
}

export class Lease {
  private constructor(private readonly props: LeaseProps) {}

  static create(input: { unitId: string; tenantId: string }): Lease {
    if (!input.unitId) throw new DomainError('호실 ID는 필수입니다.');
    if (!input.tenantId) throw new DomainError('입주자 ID는 필수입니다.');
    return new Lease({
      id: null,
      unitId: input.unitId,
      tenantId: input.tenantId,
      status: LeaseStatus.ACTIVE,
      endedAt: null,
    });
  }

  static reconstitute(props: LeaseProps): Lease {
    return new Lease(props);
  }

  // 계약 종료: 상태를 ENDED로, 종료 시각을 채운 새 인스턴스를 반환한다(불변 패턴).
  end(): Lease {
    if (this.props.status === LeaseStatus.ENDED) {
      throw new DomainError('이미 종료된 계약입니다.');
    }
    return new Lease({
      ...this.props,
      status: LeaseStatus.ENDED,
      endedAt: new Date(),
    });
  }

  get id(): string | null {
    return this.props.id;
  }
  get unitId(): string {
    return this.props.unitId;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get status(): LeaseStatus {
    return this.props.status;
  }
  get endedAt(): Date | null {
    return this.props.endedAt;
  }
}
```

- [ ] **Step 4: 도메인 테스트 통과 확인**

Run: `npx jest src/property/domain/lease.entity.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: LeaseRepository 포트 확장**

`src/property/domain/lease.repository.ts`의 인터페이스에 두 메서드 추가:
```ts
export interface LeaseRepository {
  save(lease: Lease): Promise<Lease>;
  findByTenant(tenantId: string): Promise<Lease[]>;
  findById(id: string): Promise<Lease | null>;
  update(lease: Lease): Promise<Lease>;
}
```

- [ ] **Step 6: PrismaLeaseRepository 구현**

`src/property/infrastructure/prisma-lease.repository.ts`를 수정한다. 기존 `reconstitute` 호출들에 `endedAt: row.endDate`를 추가하고(`save`/`findByTenant` 포함), `findById`·`update`를 추가한다. 매핑 헬퍼를 두면 DRY하다:
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';

@Injectable()
export class PrismaLeaseRepository implements LeaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Prisma 행(endDate) ↔ 도메인(endedAt) 매핑 단일 출처.
  private toDomain(row: {
    id: string;
    unitId: string;
    tenantId: string;
    status: string;
    endDate: Date | null;
  }): Lease {
    return Lease.reconstitute({
      id: row.id,
      unitId: row.unitId,
      tenantId: row.tenantId,
      status: row.status as LeaseStatus,
      endedAt: row.endDate,
    });
  }

  async save(lease: Lease): Promise<Lease> {
    const row = await this.prisma.lease.create({
      data: {
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        status: lease.status,
      },
    });
    return this.toDomain(row);
  }

  async findByTenant(tenantId: string): Promise<Lease[]> {
    const rows = await this.prisma.lease.findMany({ where: { tenantId } });
    return rows.map((row) => this.toDomain(row));
  }

  async findById(id: string): Promise<Lease | null> {
    const row = await this.prisma.lease.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async update(lease: Lease): Promise<Lease> {
    const row = await this.prisma.lease.update({
      where: { id: lease.id! },
      data: { status: lease.status, endDate: lease.endedAt },
    });
    return this.toDomain(row);
  }
}
```

- [ ] **Step 7: 컴파일 + property 테스트 + 커밋**

Run: `npx tsc --noEmit && npx jest src/property`
Expected: OK, PASS.
```bash
git add src/property/domain/lease.entity.ts src/property/domain/lease.entity.spec.ts src/property/domain/lease.repository.ts src/property/infrastructure/prisma-lease.repository.ts
git commit -m "[M3]feat: Lease.end() + LeaseRepository findById/update

계약 종료 도메인 메서드(불변, ACTIVE→ENDED+endedAt) 및 조회/갱신 추가.
Prisma endDate ↔ 도메인 endedAt 매핑.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: EndLeaseUseCase + 엔드포인트 (TDD)

**Files:**
- Create: `src/property/application/end-lease.use-case.ts`, `src/property/application/end-lease.use-case.spec.ts`
- Modify: `src/property/property.errors.ts`, `src/property/interface/property.controller.ts`, `src/property/property.module.ts`

- [ ] **Step 1: 에러 스펙 추가**

`src/property/property.errors.ts`의 `PropertyError` 객체에 두 항목 추가:
```ts
  LEASE_NOT_FOUND: {
    code: 'PROPERTY_LEASE_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '계약을 찾을 수 없습니다.',
  },
  LEASE_ALREADY_ENDED: {
    code: 'PROPERTY_LEASE_ALREADY_ENDED',
    status: HttpStatus.CONFLICT,
    message: '이미 종료된 계약입니다.',
  },
```

- [ ] **Step 2: 유스케이스 테스트 작성**

Create `src/property/application/end-lease.use-case.spec.ts`:
```ts
import { EndLeaseUseCase } from './end-lease.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { Unit } from '../domain/unit.entity';
import { Building } from '../domain/building.entity';
import { LeaseRepository } from '../domain/lease.repository';
import { UnitRepository } from '../domain/unit.repository';
import { BuildingRepository } from '../domain/building.repository';
import { EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

const OWNER_ID = 'owner1';
const TENANT_ID = 't1';
const LEASE_ID = 'lease1';
const UNIT_ID = 'unit1';
const BUILDING_ID = 'b1';

function deps(opts: { lease?: Lease | null; ownerId?: string } = {}) {
  const lease =
    opts.lease === undefined
      ? Lease.reconstitute({ id: LEASE_ID, unitId: UNIT_ID, tenantId: TENANT_ID, status: LeaseStatus.ACTIVE, endedAt: null })
      : opts.lease;
  const unit = Unit.reconstitute({ id: UNIT_ID, buildingId: BUILDING_ID, name: '101', floor: 1 });
  const building = Building.reconstitute({ id: BUILDING_ID, ownerId: opts.ownerId ?? OWNER_ID, name: '빌딩', address: '주소' });

  const updated: Lease[] = [];
  const leases: LeaseRepository = {
    save: (l) => Promise.resolve(l),
    findByTenant: () => Promise.resolve([]),
    findById: () => Promise.resolve(lease),
    update: (l) => {
      updated.push(l);
      return Promise.resolve(l);
    },
  };
  const units: UnitRepository = { save: (u) => Promise.resolve(u), findById: () => Promise.resolve(unit) };
  const buildings: Partial<BuildingRepository> = { findById: () => Promise.resolve(building) };
  const published: unknown[] = [];
  const events: EventPublisher = {
    publish: (e) => {
      published.push(e);
      return Promise.resolve();
    },
  };
  return { leases, units, buildings, events, updated, published };
}

describe('EndLeaseUseCase', () => {
  it('건물 OWNER가 종료하면 update 후 LeaseEnded를 발행한다', async () => {
    const { leases, units, buildings, events, updated, published } = deps();
    const useCase = new EndLeaseUseCase(leases, units, buildings as BuildingRepository, events);

    await useCase.execute({ userId: OWNER_ID, leaseId: LEASE_ID });

    expect(updated[0].status).toBe(LeaseStatus.ENDED);
    expect(published).toEqual([
      expect.objectContaining({ eventType: EventType.LeaseEnded, entityType: EntityType.Lease, entityId: LEASE_ID }),
    ]);
  });

  it('OWNER가 아니면 NOT_BUILDING_OWNER로 거부하고 발행하지 않는다', async () => {
    const { leases, units, buildings, events, published } = deps({ ownerId: 'someone-else' });
    const useCase = new EndLeaseUseCase(leases, units, buildings as BuildingRepository, events);

    await expect(
      useCase.execute({ userId: OWNER_ID, leaseId: LEASE_ID }),
    ).rejects.toMatchObject({ code: 'PROPERTY_NOT_BUILDING_OWNER' });
    expect(published).toEqual([]);
  });

  it('없는 계약이면 LEASE_NOT_FOUND', async () => {
    const { leases, units, buildings, events } = deps({ lease: null });
    const useCase = new EndLeaseUseCase(leases, units, buildings as BuildingRepository, events);

    await expect(
      useCase.execute({ userId: OWNER_ID, leaseId: LEASE_ID }),
    ).rejects.toMatchObject({ code: 'PROPERTY_LEASE_NOT_FOUND' });
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/property/application/end-lease.use-case.spec.ts`
Expected: FAIL — `EndLeaseUseCase` 미존재.

- [ ] **Step 4: 유스케이스 구현**

Create `src/property/application/end-lease.use-case.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app-exception';
import { PropertyError } from '../property.errors';
import { Lease } from '../domain/lease.entity';
import { LEASE_REPOSITORY, LeaseRepository } from '../domain/lease.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

export interface EndLeaseInput {
  userId: string;
  leaseId: string;
}

@Injectable()
export class EndLeaseUseCase {
  constructor(
    @Inject(LEASE_REPOSITORY) private readonly leases: LeaseRepository,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
    @Inject(BUILDING_REPOSITORY)
    private readonly buildings: BuildingRepository,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async execute(input: EndLeaseInput): Promise<Lease> {
    const lease = await this.leases.findById(input.leaseId);
    if (!lease) throw new AppException(PropertyError.LEASE_NOT_FOUND);

    // 권한: 계약 → 호실 → 건물 소유자가 요청자인지 확인(건물주만 입주 관리).
    const unit = await this.units.findById(lease.unitId);
    if (!unit) throw new AppException(PropertyError.UNIT_NOT_FOUND);
    const building = await this.buildings.findById(unit.buildingId);
    if (!building || !building.isOwnedBy(input.userId)) {
      throw new AppException(PropertyError.NOT_BUILDING_OWNER);
    }

    // 이미 종료된 계약이면 도메인 DomainError → 409로 변환.
    let ended: Lease;
    try {
      ended = lease.end();
    } catch {
      throw new AppException(PropertyError.LEASE_ALREADY_ENDED);
    }
    const saved = await this.leases.update(ended);

    await this.events.publish({
      eventId: randomUUID(),
      eventType: EventType.LeaseEnded,
      occurredAt: new Date().toISOString(),
      actorId: input.userId,
      entityType: EntityType.Lease,
      entityId: saved.id!,
      payload: { unitId: saved.unitId, endedAt: saved.endedAt?.toISOString() },
    });
    return saved;
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/property/application/end-lease.use-case.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: 컨트롤러 라우트 추가**

`src/property/interface/property.controller.ts`에서:
1. import에 `Patch`를 `@nestjs/common`에서 추가, `EndLeaseUseCase` import 추가.
2. 생성자에 `private readonly endLease: EndLeaseUseCase,` 추가.
3. 라우트 핸들러 추가:
```ts
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Patch('leases/:id/end')
  @ApiOperation({ summary: '계약 종료(건물 OWNER 전용)' })
  @ApiParam({ name: 'id', description: '계약(Lease) ID' })
  @ApiResponse({ status: 200, description: '종료된 계약' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: '건물 소유자 아님' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: '계약 없음' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: '이미 종료된 계약' })
  async endLeaseHandler(
    @CurrentUser() user: TokenPayload,
    @Param('id') id: string,
  ) {
    const lease = await this.endLease.execute({ userId: user.sub, leaseId: id });
    return {
      id: lease.id,
      unitId: lease.unitId,
      status: lease.status,
      endedAt: lease.endedAt,
    };
  }
```

- [ ] **Step 7: 모듈에 유스케이스 등록**

`src/property/property.module.ts`의 `providers`에 `EndLeaseUseCase`를 추가하고 상단 import 추가:
```ts
import { EndLeaseUseCase } from './application/end-lease.use-case';
```

- [ ] **Step 8: 컴파일 + property 전체 + 커밋**

Run: `npx tsc --noEmit && npx jest src/property`
Expected: OK, PASS.
```bash
git add src/property/application/end-lease.use-case.ts src/property/application/end-lease.use-case.spec.ts src/property/property.errors.ts src/property/interface/property.controller.ts src/property/property.module.ts
git commit -m "[M3]feat: 계약 종료 유스케이스 + PATCH /leases/:id/end

건물 OWNER 전용 계약 종료(소유권 체인 검사), 종료 후 LeaseEnded 발행.
Swagger 데코레이터·에러 스펙(LEASE_NOT_FOUND/LEASE_ALREADY_ENDED) 추가.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: AuditModule — audit-worker 소비자 (TDD)

**Files:**
- Create: `src/audit/domain/audit-log.repository.ts`, `src/audit/infrastructure/prisma-audit-log.repository.ts`, `src/audit/infrastructure/prisma-audit-log.repository.spec.ts`, `src/audit/interface/audit-worker.controller.ts`, `src/audit/audit.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: AuditLogRepository 포트**

Create `src/audit/domain/audit-log.repository.ts`:
```ts
import { DomainEvent } from '../../events/domain-event';

export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

export interface AuditLogRepository {
  // 멱등: 같은 eventId가 이미 적재돼 있으면 조용히 무시한다.
  record(event: DomainEvent): Promise<void>;
}
```

- [ ] **Step 2: 멱등 테스트 작성**

Create `src/audit/infrastructure/prisma-audit-log.repository.spec.ts`:
```ts
import { Prisma } from '@prisma/client';
import { PrismaAuditLogRepository } from './prisma-audit-log.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

const event: DomainEvent = {
  eventId: 'e1',
  eventType: EventType.PostCreated,
  occurredAt: '2026-06-14T00:00:00.000Z',
  actorId: 'u1',
  entityType: EntityType.Post,
  entityId: 'p1',
  payload: { buildingId: 'b1' },
};

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('PrismaAuditLogRepository', () => {
  let prisma: { auditLog: { create: jest.Mock } };
  let repo: PrismaAuditLogRepository;

  beforeEach(() => {
    // PrismaService 부분 mock (테스트 한정 as unknown as).
    prisma = { auditLog: { create: jest.fn() } };
    repo = new PrismaAuditLogRepository(prisma as unknown as PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('이벤트를 AuditLog로 적재한다', async () => {
    prisma.auditLog.create.mockResolvedValue({});

    await repo.record(event);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        eventId: 'e1',
        eventType: EventType.PostCreated,
        actorId: 'u1',
        entityType: EntityType.Post,
        entityId: 'p1',
        payload: { buildingId: 'b1' },
        occurredAt: new Date('2026-06-14T00:00:00.000Z'),
      },
    });
  });

  it('중복 eventId(P2002)는 throw하지 않고 무시한다(멱등)', async () => {
    prisma.auditLog.create.mockRejectedValue(p2002());

    await expect(repo.record(event)).resolves.toBeUndefined();
  });

  it('그 외 에러는 다시 던진다(Kafka 재시도 유도)', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));

    await expect(repo.record(event)).rejects.toThrow('db down');
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/audit/infrastructure/prisma-audit-log.repository.spec.ts`
Expected: FAIL — 구현 미존재.

- [ ] **Step 4: Prisma 구현**

Create `src/audit/infrastructure/prisma-audit-log.repository.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogRepository } from '../domain/audit-log.repository';
import { DomainEvent } from '../../events/domain-event';

@Injectable()
export class PrismaAuditLogRepository implements AuditLogRepository {
  private readonly logger = new Logger(PrismaAuditLogRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: DomainEvent): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          eventId: event.eventId,
          eventType: event.eventType,
          actorId: event.actorId,
          entityType: event.entityType,
          entityId: event.entityId,
          payload: event.payload as Prisma.InputJsonValue,
          occurredAt: new Date(event.occurredAt),
        },
      });
    } catch (err) {
      // at-least-once라 같은 이벤트가 또 올 수 있다. eventId @unique 충돌(P2002)은
      // "이미 적재됨"이므로 멱등하게 무시한다. 그 외 오류는 재시도되도록 다시 던진다.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.warn(`중복 이벤트 무시: ${event.eventId}`);
        return;
      }
      throw err;
    }
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/audit/infrastructure/prisma-audit-log.repository.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: audit-worker 컨트롤러**

Create `src/audit/interface/audit-worker.controller.ts`:
```ts
import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KafkaTopic } from '../../events/event-type.enum';
import { DomainEvent } from '../../events/domain-event';
import {
  AUDIT_LOG_REPOSITORY,
  AuditLogRepository,
} from '../domain/audit-log.repository';

// audit-worker: board-events·membership-events를 구독해 AuditLog로 적재한다.
// 부작용 없는 첫 소비자(persistence는 M4, notification은 M5).
@Controller()
export class AuditWorkerController {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly audit: AuditLogRepository,
  ) {}

  @EventPattern(KafkaTopic.BoardEvents)
  async onBoardEvent(@Payload() event: DomainEvent): Promise<void> {
    await this.audit.record(event);
  }

  @EventPattern(KafkaTopic.MembershipEvents)
  async onMembershipEvent(@Payload() event: DomainEvent): Promise<void> {
    await this.audit.record(event);
  }
}
```

- [ ] **Step 7: AuditModule + app.module 등록**

Create `src/audit/audit.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuditWorkerController } from './interface/audit-worker.controller';
import { AUDIT_LOG_REPOSITORY } from './domain/audit-log.repository';
import { PrismaAuditLogRepository } from './infrastructure/prisma-audit-log.repository';

@Module({
  controllers: [AuditWorkerController],
  providers: [
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
  ],
})
export class AuditModule {}
```
`src/app.module.ts`의 `imports`에 `AuditModule` 추가 + 상단 import:
```ts
import { AuditModule } from './audit/audit.module';
```

- [ ] **Step 8: 컴파일 + audit 테스트 + 커밋**

Run: `npx tsc --noEmit && npx jest src/audit`
Expected: OK, PASS.
```bash
git add src/audit src/app.module.ts
git commit -m "[M3]feat: audit-worker 소비자 + AuditLogRepository(멱등)

board-events·membership-events를 @EventPattern으로 구독해 AuditLog 적재.
eventId @unique 충돌(P2002)은 무시해 at-least-once 멱등 소비 보장.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: hybrid app 부트스트랩 + 문서 + 최종 검증

**Files:**
- Modify: `src/main.ts`, `README.md`

- [ ] **Step 1: main.ts를 hybrid app으로**

`src/main.ts`를 아래로 교체한다:
```ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { ConfigKey } from './config/config-keys';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // audit-worker(Kafka consumer)를 같은 프로세스에 띄운다(hybrid app).
  const config = app.get(ConfigService);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'audit-worker' },
    },
  });

  // 프로덕션에서는 전체 API 표면을 인증 없이 노출하지 않도록 /docs 를 끈다.
  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    setupSwagger(app);
  }

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

- [ ] **Step 2: 빌드 + 전체 테스트 + 린트**

Run: `npx tsc --noEmit && npx jest && npx eslint src && npm run build`
Expected: 전부 통과.

- [ ] **Step 3: 실제 Kafka 왕복 수동 검증 (end-to-end)**

Run(별도 터미널): `docker compose up -d && npm run start:dev`
검증 절차:
1. 회원가입·로그인으로 토큰 획득.
2. OWNER로 건물 생성 → 초대코드 발급 → 다른 계정으로 초대코드 사용(TenantJoined) / 건물 멤버로 게시글 작성(PostCreated)·댓글 작성(CommentCreated) / `PATCH /leases/:id/end`(LeaseEnded).
3. DB 확인: `docker compose exec postgres psql -U postgres -d <db> -c 'SELECT "eventType","entityType","entityId" FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT 10;'`
Expected: 4종 이벤트가 `AuditLog`에 적재됨. 서버 로그에 consumer 수신 흔적.

> 자동화된 Kafka 통합테스트는 testcontainers 인프라가 없어 이번 범위 밖이다. 위 수동 절차로 end-to-end를 확인한다.

- [ ] **Step 4: README 갱신**

`README.md`에서:
1. §6 마일스톤 표의 M3 행에 `✅`와 완료 표기.
2. §7 API 레퍼런스 Property 표에 행 추가:
   `| \`PATCH /leases/:id/end\` | 계약 종료 | 인증 + 건물 OWNER |`
3. §5 주요 설계 결정에 **결정 10** 추가:
```markdown
**10. M3 — Kafka 이벤트 발행 + audit-worker(부작용 없는 첫 소비자)**
- *근거:* 도메인 이벤트 4종을 `@nestjs/microservices`로 발행하고, 부작용 없는 audit-worker가 멱등 소비(`eventId @unique`)해 `AuditLog`에 적재한다. 발행 추상화는 application 직접 발행(`EventPublisher` 포트)으로 도메인이 Kafka를 모르게 한다.
- *트레이드오프:* after-commit 단순 발행이라 "DB는 썼는데 발행 직전 크래시" 시 이벤트 유실 창이 있다(의도된 한계). **M6 Transactional Outbox**로 해소한다.
```

- [ ] **Step 5: 최종 커밋**

```bash
git add src/main.ts README.md
git commit -m "[M3]feat: hybrid app으로 audit-worker 기동 + 문서 갱신

main.ts에 Kafka consumer(connectMicroservice/startAllMicroservices) 연결.
README 마일스톤 M3 완료·API(PATCH /leases/:id/end)·설계 결정 10 추가.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (작성자 점검 완료)

- **스펙 커버리지:** §3 AuditLog(Task 2) · §4 봉투/토픽(Task 1·3) · §5 발행 포트·지점 4종(Task 3·4·5·7) · §6 audit-worker·멱등(Task 8) · §6.1 hybrid 부트스트랩(Task 9) · §7 end-lease(Task 6·7) · §8 모듈/설정(Task 1·3) · §9 테스트(각 Task) — 모두 매핑됨.
- **플레이스홀더:** 없음. 모든 코드 블록 완전 기재. 외부 의존(`board.errors`·`invite-code.store` 시그니처)은 "대조해 맞춘다"로 명시하되 기대 코드값을 제공.
- **타입 일관성:** `DomainEvent` 필드(eventId/eventType/occurredAt/actorId/entityType/entityId/payload)가 발행·소비·테스트 전반에서 일치. `EventPublisher.publish` 시그니처 단일. `LeaseRepository`(save/findByTenant/findById/update)가 Task 6 정의 후 Task 7에서 동일 사용. 도메인 `endedAt` ↔ Prisma `endDate` 매핑이 Task 6에 캡슐화.
- **유스케이스 생성자 인자 순서:** CreatePost(posts, cache, membership, **events**) / CreateComment(comments, posts, cache, membership, **events**) / RedeemInviteCode(invites, leases, **events**) / EndLease(leases, units, buildings, events) — 각 Task의 테스트·구현이 동일 순서.
