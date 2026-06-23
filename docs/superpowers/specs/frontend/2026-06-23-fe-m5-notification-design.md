# FE-M5: 알림 센터 (실시간 · 단건/전체 읽음 · 딥링크) 설계

- 작성일: 2026-06-23
- 대상 레포: `estate-server`(BE: 단건 읽음 + 알림 buildingId) + `estate-web`(FE, 주)
- 참조
  - BE 알림 도메인: `docs/superpowers/specs/2026-06-15-m5-notification-design.md`
  - FE-M4 채팅(토큰 prop 소켓 패턴): `docs/superpowers/specs/frontend/2026-06-23-fe-m4-chat-design.md`
  - 디자인 시스템: `docs/superpowers/specs/frontend/2026-06-22-design-system-design.md`

## 1. 목표 / 성공 기준

건물주·입주자가 인앱 알림을 실시간으로 받고, 읽고, 관련 화면으로 이동한다.

- [ ] `/notifications` — 알림 목록(최신순, 미읽음 표시)
- [ ] 앱 전체 헤더 벨에 **실시간 미읽음 배지**(socket.io `/notifications`)
- [ ] **단건 읽음**(항목 클릭) + **전체 읽음**(버튼)
- [ ] **딥링크**: 메시지→채팅방, 게시글/댓글→해당 게시글
- [ ] BE: 단건 읽음 엔드포인트 + 알림 `buildingId` 추가
- [ ] 순수 로직 Vitest + BE Jest 통과, `build`/`lint` 통과

## 2. 기존 BE 알림 계약 (estate-server, 기구현)

REST (Bearer JWT):

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/notifications?limit=N` | 내 알림 목록(최신순) |
| `GET` | `/notifications/unread-count` | 미읽음 수(Redis 카운터) |
| `PATCH` | `/notifications/read` | 전체 읽음 + 카운터 리셋 |

WebSocket (**socket.io**, 네임스페이스 `/notifications`, `handshake.auth.token`=JWT):
- 연결 시 `user:<id>` 룸 join. 클→서 이벤트 없음(순수 푸시).
- 수신 `notification` → 알림 객체.

알림 1건(현행): `{id, type, title, body, entityType, entityId, readAt, createdAt}`. 타입: `MessageReceived`·`CommentAdded`·`PostAdded`. entityId: Message=roomId, Post/Comment=postId.

## 3. 백엔드 변경 (estate-server)

### 3.1 단건 읽음

- `NotificationCounter` 포트에 `decrement(userId): Promise<void>` 추가. `RedisNotificationCounter`: `DECR` 후 음수면 0으로 보정(하한).
- `NotificationRepository`에 `markOneRead(userId, id): Promise<boolean>`. Prisma: `updateMany({ where: { id, recipientId: userId, readAt: null }, data: { readAt: new Date() } })` → `count === 1`이면 true. (recipientId 조건으로 소유자 검증, 멱등.)
- `MarkOneReadUseCase`: `if (await repo.markOneRead(userId, id)) await counter.decrement(userId)`. 이미 읽음/타인 알림이면 카운터 불변.
- `NotificationController`: `@Patch(':id/read')` → 유스케이스. Swagger `@ApiOperation`+성공 `@ApiResponse`+401 `ErrorResponseDto`. 모듈에 유스케이스 등록.
- 테스트: `MarkOneReadUseCase` spec — 신규 읽음 시 1회 decrement / 이미 읽음(false) 시 decrement 안 함.

### 3.2 알림 buildingId (게시판 딥링크용)

게시판 글 라우트는 `/board/[buildingId]/[postId]`라 buildingId가 필요한데 알림에 없다 → 알림이 buildingId를 보유하도록 한다.

- **마이그레이션**: `Notification`에 `buildingId String?` 컬럼 추가.
- `NotificationProps`·엔티티: `buildingId: string | null` 추가(`create`는 옵션, 기본 null).
- `NotificationContent`에 `buildingId: string | null`. `buildContent`:
  - `MessageReceived` → `buildingId: null`
  - `PostAdded` → `buildingId: (payload as {buildingId}).buildingId`
  - `CommentAdded` → `buildingId: (payload as {buildingId}).buildingId`
- board `create-comment.use-case`: 이벤트 payload에 `buildingId: post.buildingId` 추가(use-case가 이미 `post`를 로드). + 스펙. (`create-post`는 payload에 buildingId 이미 포함.)
- `handle-event.use-case`: `Notification.create(...)`와 `relay.publish(... notification:{...})` 양쪽에 `buildingId: content.buildingId` 전달.
- `NotificationPushPayload.notification`에 `buildingId: string | null` 추가.
- `PrismaNotificationRepository`: `saveIfNew` data·`toEntity`·`NotificationRow`에 buildingId.
- `NotificationResponseDto` + 컨트롤러 `listMine` 매핑에 `buildingId` 추가.
- 테스트: `notification-content.spec`(타입별 buildingId), `create-comment.spec`(payload buildingId).

> 실시간 푸시 객체는 항상 미읽음(readAt 없음)이므로 FE는 푸시 수신분을 미읽음으로 취급한다.

## 4. 프론트엔드 (estate-web) — `main`에서 분기 (M4 머지 완료)

### 4.1 인증 영역 persistent layout + Provider

소켓을 네비게이션 간 1회 연결로 유지하고 벨·목록·읽음이 미읽음 상태를 공유하기 위해, 인증 페이지를 라우트 그룹으로 묶고 헤더+Provider를 layout에 둔다.

- **이동**: `app/dashboard`·`app/board`·`app/chat`·`app/(owner)`와 신규 `app/notifications`를 라우트 그룹 `app/(app)/` 아래로 이동. **URL 불변**(route group), import는 `@/` 절대경로라 무영향. `git mv`로 단계 처리.
- `app/(app)/layout.tsx`(Server): `getToken()`(없으면 `redirect(login)`), `backendMe`·`backendUnreadCount`(실패 0) 페치 → 헤더(로고·`<NotificationBell>`·아바타)와 `<NotificationProvider token initialUnread>`로 children을 감싼다. 기존 `AppShell`의 헤더 마크업을 이 layout으로 이관.
- `NotificationProvider`(client): `io(`${WS_URL}/notifications`, { auth:{ token }, transports:["websocket"] })`로 1회 연결, `notification` 수신 시 미읽음 +1·신규 알림 큐에 push. 컨텍스트로 `{ unread, newItems, decrement(), reset() }` 노출. 연결 실패 시 배지는 `initialUnread` 정적 유지(앱 흐름 막지 않음).
- **페이지**: 각 페이지에서 `<AppShell>` 래퍼 제거 → 콘텐츠만 반환. (페이지는 자체 데이터용 `getToken`/`backendMe` 계속 사용.)

### 4.2 알림 센터 & 벨

- `components/ui/notification-bell.tsx`(client): 컨텍스트 `unread` 표시(배지), `PAGE_ROUTES.notifications`로 링크.
- `app/(app)/notifications/page.tsx`(Server): `backendNotifications` 페치 → `<NotificationList initial={...} />` + `<MarkAllReadButton />`.
- `components/notifications/notification-list.tsx`(client): 컨텍스트 `newItems`를 상단 prepend(중복 messageId/id 가드). 각 항목: 제목·본문·상대시간·미읽음 표시. 클릭 시 **단건 읽음 호출 → 컨텍스트 decrement → `notificationHref`로 이동**.
- `components/notifications/mark-all-read-button.tsx`(client): `PATCH /api/notifications/read` → 컨텍스트 `reset()` + `router.refresh()`.
- Route Handlers: `app/api/notifications/read/route.ts`(PATCH 전체), `app/api/notifications/[id]/read/route.ts`(PATCH 단건) — 쿠키 토큰 프록시(기존 `/api/*` 패턴).

### 4.3 lib / 상수 / 정합성

- `lib/api/notification.ts`(변경): `Notification` 타입을 BE 계약(+`buildingId: string | null`)으로 수정. `backendMarkAllRead(t)`·`backendMarkOneRead(t, id)` 추가.
- `lib/notifications/notification-link.ts`(신규, 순수): `notificationHref(n: { type; entityId; buildingId }): string` — `MessageReceived`→`PAGE_ROUTES.chatRoom(entityId)`; `PostAdded`/`CommentAdded`→ buildingId 있으면 `PAGE_ROUTES.boardPost(buildingId, entityId)`, 없으면 `PAGE_ROUTES.boardHome`.
- `lib/notifications/notification-label.ts`(신규, 순수): `NOTIFICATION_TYPE` 타입→라벨 매핑.
- `lib/constants.ts`: `API_ROUTES.notificationsRead`, `API_ROUTES.notificationRead(id)`, `NOTIFICATION_TYPE` as const.
- `lib/messages.ts`: `MESSAGES.notification`(empty·markAll·markFailed 등).
- `components/dashboard/recent-activity.tsx`(변경): 깨진 라벨/`payload.preview` 제거 → 새 필드(`title`/`body`)·올바른 타입 라벨 사용.

## 5. 에러 처리

| 상황 | 처리 |
|---|---|
| 토큰 없음/만료 | layout/페이지에서 `redirect(login)` |
| 목록·unread 페치 실패 | 빈 배열 / 0 degrade + 안내 |
| 소켓 연결 실패 | 배지 정적(initialUnread) 유지, 앱 흐름 유지 |
| 단건/전체 읽음 실패 | 항목/버튼에 에러 메시지, 카운터 미변경 |

## 6. 테스트

- FE(Vitest): `notificationHref`(타입별 경로·buildingId 폴백), `notification-label`, `lib/api/notification`(mark 함수 path/method/headers), `mark-all-read-button` RTL(성공 reset+refresh / 실패 메시지).
- BE(Jest): `MarkOneReadUseCase`(신규 읽음 decrement / 이미 읽음 no-op), `notification-content`(타입별 buildingId), `create-comment`(payload buildingId).
- 소켓·Provider 부수효과는 단위 테스트 제외(수동 검증).

## 7. 범위 밖 (YAGNI)

- 알림 환경설정/필터/페이지네이션 커서(단순 최신순).
- 외부 푸시(FCM/Web Push).
- 멤버십 이벤트 알림(TenantJoined 등).
- unread 카운터 DB COUNT 재동기화(드리프트 보강) — 후속.

## 8. 알려진 제약 / 트레이드오프

- 단건 읽음 카운터는 Redis `DECR`(0 하한) — `markAllRead`와 동일한 저장소 드리프트 창 한계(학습 범위 허용, 후속 재동기화로 보강).
- 라우트 그룹 이동은 URL 불변·절대 import라 안전하나 diff가 큼 → 계획에서 `git mv` 단계화.
- **머지 순서**: BE(단건 읽음·buildingId)를 먼저(또는 함께) 머지 — FE가 해당 계약에 의존.
- 소켓은 `(app)` layout에 1회 연결되어 인증 세그먼트 내 네비게이션 동안 유지된다(재연결 churn 제거). 로그인/회원가입(그룹 밖)에는 연결되지 않는다.
