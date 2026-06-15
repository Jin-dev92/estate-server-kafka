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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 실패 테스트 작성**

`src/notification/domain/notification.entity.spec.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/notification/domain/notification.entity.spec.ts`
Expected: FAIL (`Cannot find module './notification.entity'`)

- [ ] **Step 4: 엔티티 구현**

`src/notification/domain/notification.entity.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

`src/notification/domain/notification-counter.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

`src/notification/domain/notification-relay.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

`src/notification/domain/recipient-resolver.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 내용 매핑 실패 테스트**

`src/notification/domain/notification-content.spec.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/notification/domain/notification-content.spec.ts`
Expected: FAIL (`Cannot find module './notification-content'`)

- [ ] **Step 4: 내용 매핑 구현**

`src/notification/domain/notification-content.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/infrastructure/prisma-notification.repository.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/infrastructure/prisma-notification.repository.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/infrastructure/redis-notification-counter.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/infrastructure/redis-notification-counter.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/infrastructure/redis-notification-relay.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** (chat의 RedisMessageRelay와 동일 패턴)

`src/notification/infrastructure/redis-notification-relay.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/infrastructure/prisma-recipient-resolver.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/infrastructure/prisma-recipient-resolver.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/application/handle-event.use-case.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/application/handle-event.use-case.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/application/read-use-cases.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/application/list-notifications.use-case.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

`src/notification/application/get-unread-count.use-case.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

`src/notification/application/mark-all-read.use-case.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/interface/notification-worker.controller.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/interface/notification-worker.controller.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/notification/interface/notification.gateway.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/notification/interface/notification.gateway.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 컨트롤러 구현**

`src/notification/interface/notification.controller.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 워커 모듈 작성**

`src/notification/notification-worker.module.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

(클래스 주석을 "board·membership·chat 전체를 구독해 AuditLog로 적재한다(audit=전체)"로 수정.)

- [ ] **Step 2: persistence 워커 모듈**

`src/workers/persistence-worker.module.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 3: audit 워커 모듈**

`src/workers/audit-worker.module.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 4: 워커 엔트리포인트 3개**

`src/workers/persistence-worker.main.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

`src/workers/audit-worker.main.ts` (위와 동일하되 모듈·groupId만 변경):

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

`src/workers/notification-worker.main.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: AppModule에 NotificationModule 추가**

`src/app.module.ts`의 import 목록과 `imports` 배열에 `NotificationModule`을 추가한다:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_
그리고 `imports: [...]`의 `ChatModule` 다음 줄에 `NotificationModule,` 추가.

> **주의:** `ChatModule`은 `ChatPersistenceController`를 controllers에 포함하고 있다. main 프로세스에서 이 컨트롤러는 `@EventPattern`이지만 연결된 microservice가 없으므로 동작하지 않는다(핸들러 미바인딩). 영속화는 persistence-worker가 담당하므로 기능상 문제는 없다. 다만 관심사 명확화를 위해 `ChatModule`에서 `ChatPersistenceController`를 controllers에서 제거하는 것은 **이번 범위 밖**(M4 코드 변경 최소화)으로 두고 README 한계에 기록한다.

- [ ] **Step 3: SWAGGER_TAGS에 notification 추가**

`src/common/swagger/swagger.constants.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 4: package.json 워커 스크립트 추가**

`package.json`의 `scripts`에 추가:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

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
