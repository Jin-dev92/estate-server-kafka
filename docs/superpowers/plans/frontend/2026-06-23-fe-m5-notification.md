# FE-M5 알림 센터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 실시간 인앱 알림 센터 — 헤더 라이브 배지, 단건/전체 읽음, 채팅·게시판 딥링크.

**Architecture:** BE는 단건 읽음 엔드포인트와 알림 `buildingId`를 추가(딥링크용). FE는 인증 페이지를 라우트 그룹 `app/(app)/`로 묶고 layout에 헤더+`NotificationProvider`(socket.io `/notifications` 1회 연결)를 둬 벨·목록·읽음이 미읽음 상태를 공유한다. 토큰은 Server Component(layout)가 httpOnly 쿠키에서 읽어 prop으로 전달.

**Tech Stack:** Next.js 16 App Router · React 19 · TS · socket.io-client · Vitest(FE) / NestJS · Prisma · Jest(BE).

**스펙:** `docs/superpowers/specs/frontend/2026-06-23-fe-m5-notification-design.md`

## Global Constraints

- `.ts`/`.tsx`만. Server Component 기본, `"use client"`는 상호작용 컴포넌트(Provider·Bell·List·버튼)에만.
- 매직 스트링 금지: 경로 `PAGE_ROUTES`/`API_ROUTES`(`lib/constants.ts`), 문구 `MESSAGES`(`lib/messages.ts`), 도메인 값 `NOTIFICATION_TYPE`.
- `enum` 금지(as const), `as any` 금지, index signature 금지. `useEffect` deps 원시값만.
- BE 호출은 `lib/api/<domain>.ts` + 배럴. 민감 키 `NEXT_PUBLIC_` 금지(WS_URL은 공개 호스트라 허용).
- BE: NestJS DDD 레이어. Swagger 필수(신규/변경 라우트에 `@ApiOperation`+성공 `@ApiResponse`, 4xx는 `ErrorResponseDto`). `const enum` 금지 아님(BE는 `const enum` 사용 중) — 기존 패턴 따른다.
- 테스트: FE `npm run test`(Vitest), BE `npm test`(Jest). lint: FE `npm run lint`, BE `npm run lint:check`. 빌드: FE `npm run build`, BE `npm run build`.
- 커밋 형식: `type: 내용`(feature/fix/refactor/test/docs/chore).
- 레포: BE=`../estate-server`(현재 cwd 기준), FE=`estate-web`.

**Before you start:** BE는 estate-server `feature/m5-notification`(이미 생성, origin/main 기준, 스펙 커밋 포함). FE는 estate-web에서 `feature/fe-m5-notification`(origin/main 기준 — M4 머지 완료). Task 1~2(BE) 먼저, Task 3~8(FE).

---

### Task 1: (BE) 단건 읽음 — `PATCH /notifications/:id/read`

**레포: `../estate-server`** (branch `feature/m5-notification`)

**Files:**
- Modify: `src/notification/domain/notification-counter.ts`
- Modify: `src/notification/infrastructure/redis-notification-counter.ts`
- Modify: `src/notification/domain/notification.repository.ts`
- Modify: `src/notification/infrastructure/prisma-notification.repository.ts`
- Create: `src/notification/application/mark-one-read.use-case.ts`
- Create: `src/notification/application/mark-one-read.use-case.spec.ts`
- Modify: `src/notification/interface/notification.controller.ts`
- Modify: `src/notification/notification.module.ts`

**Interfaces:**
- Produces: `NotificationCounter.decrement(userId): Promise<void>`
- Produces: `NotificationRepository.markOneRead(userId, id): Promise<boolean>` (true=신규 읽음 전이)
- Produces: `MarkOneReadUseCase.execute(userId, id): Promise<void>`
- Produces (REST): `PATCH /notifications/:id/read` → `{ ok: true }`

- [ ] **Step 1: 카운터 포트에 decrement 추가** — `src/notification/domain/notification-counter.ts`

`NotificationCounter` 인터페이스에 메서드 추가:
```ts
  decrement(userId: string): Promise<void>;
```

- [ ] **Step 2: Redis 카운터 구현** — `src/notification/infrastructure/redis-notification-counter.ts`

`reset` 메서드 위/아래에 추가(0 하한):
```ts
  async decrement(userId: string): Promise<void> {
    // 단건 읽음 시 1 감소. 드리프트로 음수가 되면 0으로 보정.
    const v = await this.redis.decr(unreadKey(userId));
    if (v < 0) await this.redis.set(unreadKey(userId), '0');
  }
```
> `RedisService`에 `decr`가 없으면 `incrby(key, -1)` 또는 추가. 확인: `src/redis/redis.service.ts`에 `decr`가 없으면 `async decr(k: string){ return this.client.decr(k); }`를 추가하고 `set`도 있는지 확인(없으면 `set(k,v){ return this.client.set(k,v); }`).

- [ ] **Step 3: 레포 포트에 markOneRead 추가** — `src/notification/domain/notification.repository.ts`

`NotificationRepository`에 추가:
```ts
  // 수신자의 단건을 읽음 처리. unread→read로 실제 전이됐으면 true(멱등·소유자 검증).
  markOneRead(userId: string, id: string): Promise<boolean>;
```

- [ ] **Step 4: Prisma 레포 구현** — `src/notification/infrastructure/prisma-notification.repository.ts`

`markAllRead` 아래에 추가:
```ts
  async markOneRead(userId: string, id: string): Promise<boolean> {
    const res = await this.prisma.notification.updateMany({
      where: { id, recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return res.count === 1;
  }
```

- [ ] **Step 5: 실패 테스트 작성** — `src/notification/application/mark-one-read.use-case.spec.ts`

```ts
import { MarkOneReadUseCase } from './mark-one-read.use-case';
import { NotificationRepository } from '../domain/notification.repository';
import { NotificationCounter } from '../domain/notification-counter';

function build(markResult: boolean) {
  const decrements: string[] = [];
  const repo: Partial<NotificationRepository> = {
    markOneRead: () => Promise.resolve(markResult),
  };
  const counter: Partial<NotificationCounter> = {
    decrement: (u: string) => {
      decrements.push(u);
      return Promise.resolve();
    },
  };
  const useCase = new MarkOneReadUseCase(
    repo as NotificationRepository,
    counter as NotificationCounter,
  );
  return { useCase, decrements };
}

describe('MarkOneReadUseCase', () => {
  it('신규 읽음 전이면 카운터를 1회 감소시킨다', async () => {
    const { useCase, decrements } = build(true);
    await useCase.execute('u1', 'n1');
    expect(decrements).toEqual(['u1']);
  });

  it('이미 읽음(전이 없음)이면 카운터를 건드리지 않는다', async () => {
    const { useCase, decrements } = build(false);
    await useCase.execute('u1', 'n1');
    expect(decrements).toEqual([]);
  });
});
```

- [ ] **Step 6: 테스트 실패 확인**

Run: `cd ../estate-server && npm test -- mark-one-read`
Expected: FAIL (`MarkOneReadUseCase` 없음)

- [ ] **Step 7: 유스케이스 구현** — `src/notification/application/mark-one-read.use-case.ts`

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
export class MarkOneReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
  ) {}

  // 단건 읽음. 실제 unread→read 전이일 때만 카운터를 1 감소(중복 클릭·이미 읽음 안전).
  async execute(userId: string, id: string): Promise<void> {
    const transitioned = await this.repo.markOneRead(userId, id);
    if (transitioned) await this.counter.decrement(userId);
  }
}
```

- [ ] **Step 8: 컨트롤러 라우트 추가** — `src/notification/interface/notification.controller.ts`

import에 `Param` 추가(이미 `Controller, Get, Patch, Query, UseGuards`에서 `Param` 없으면 추가) 및:
```ts
import { MarkOneReadUseCase } from '../application/mark-one-read.use-case';
```
생성자에 주입 추가: `private readonly markOne: MarkOneReadUseCase,`
`readAll` 아래에 라우트 추가:
```ts
  @Patch(':id/read')
  @ApiOperation({ summary: '단건 읽음 처리' })
  @ApiResponse({ status: 200, description: '처리 완료' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: '인증 필요' })
  async readOne(
    @CurrentUser() user: TokenPayload,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.markOne.execute(user.sub, id);
    return { ok: true };
  }
```
> 라우트 순서 주의: `:id/read`가 `read`(전체)·`unread-count`보다 뒤에 와도 `read`/`unread-count`는 정확 매칭이라 충돌 없음.

- [ ] **Step 9: 모듈 등록** — `src/notification/notification.module.ts`

import 추가 `import { MarkOneReadUseCase } from './application/mark-one-read.use-case';` 및 providers 배열에 `MarkOneReadUseCase,` 추가(`MarkAllReadUseCase,` 옆).

- [ ] **Step 10: 테스트·lint·build 확인**

Run: `cd ../estate-server && npm test -- mark-one-read && npm run lint:check && npm run build`
Expected: 테스트 PASS(2), lint 클린, build 성공.

- [ ] **Step 11: 커밋**

```bash
cd ../estate-server
git add src/notification/
git commit -m "feature: 알림 단건 읽음 엔드포인트(PATCH /notifications/:id/read)"
```

---

### Task 2: (BE) 알림 buildingId — 게시판 딥링크용

**레포: `../estate-server`** — 알림에 `buildingId`를 추가해 게시글/댓글 알림이 `/board/:buildingId/:postId`로 딥링크되게 한다.

**Files:**
- Modify: `prisma/schema.prisma` (Notification 모델) + 마이그레이션
- Modify: `src/notification/domain/notification.entity.ts`
- Modify: `src/notification/domain/notification-content.ts`
- Modify: `src/notification/domain/notification-relay.ts`
- Modify: `src/notification/application/handle-event.use-case.ts`
- Modify: `src/notification/infrastructure/prisma-notification.repository.ts`
- Modify: `src/notification/interface/dto/notification-response.dto.ts`
- Modify: `src/notification/interface/notification.controller.ts`
- Modify: `src/board/application/create-comment.use-case.ts`
- Modify: `src/notification/domain/notification-content.spec.ts`, `src/board/application/create-comment.use-case.spec.ts`

**Interfaces:**
- Produces: 알림 객체·푸시 payload·`NotificationResponseDto`에 `buildingId: string | null` 필드.
- Produces: `NotificationContent.buildingId: string | null`.

- [ ] **Step 1: Prisma 모델 + 마이그레이션** — `prisma/schema.prisma`

`Notification` 모델의 `entityId String` 아래에 추가:
```prisma
  buildingId  String? // 게시판 딥링크용(Message 알림은 null)
```
마이그레이션 생성(도커 인프라 필요):
```bash
cd ../estate-server && npx prisma migrate dev --name add_notification_building_id
```
Expected: `prisma/migrations/*_add_notification_building_id/migration.sql` 생성, 클라이언트 재생성.

- [ ] **Step 2: 엔티티에 buildingId** — `src/notification/domain/notification.entity.ts`

`NotificationProps`에 `entityId: string;` 아래 추가: `buildingId: string | null;`
`create`의 `Omit<..., 'id' | 'readAt' | 'createdAt'>` 입력에 buildingId가 포함되도록(이미 나머지 필드를 받으므로 호출부에서 전달). getter 추가:
```ts
  get buildingId(): string | null {
    return this.props.buildingId;
  }
```

- [ ] **Step 3: content에 buildingId** — `src/notification/domain/notification-content.ts`

`NotificationContent` 인터페이스에 `buildingId: string | null;` 추가. 각 case 반환에 추가:
- `MessageSent` 케이스: `buildingId: null,`
- `CommentCreated` 케이스: payload 타입을 `{ postId: string; buildingId: string }`로 보고 `buildingId: p.buildingId,`
- `PostCreated` 케이스: payload 타입을 `{ title: string; buildingId: string }`로 보고 `buildingId: p.buildingId,`

- [ ] **Step 4: relay payload에 buildingId** — `src/notification/domain/notification-relay.ts`

`NotificationPushPayload.notification`에 `entityId: string;` 아래 추가: `buildingId: string | null;`

- [ ] **Step 5: handle-event 전달** — `src/notification/application/handle-event.use-case.ts`

`Notification.create({...})` 객체에 `entityId: content.entityId,` 아래 `buildingId: content.buildingId,` 추가. `relay.publish({... notification: {...}})`의 notification 객체에도 `entityId: content.entityId,` 아래 `buildingId: content.buildingId,` 추가.

- [ ] **Step 6: prisma 레포 persist/read** — `src/notification/infrastructure/prisma-notification.repository.ts`

`NotificationRow` 타입에 `entityId: string;` 아래 `buildingId: string | null;` 추가. `saveIfNew`의 `data`에 `entityId: notification.entityId,` 아래 `buildingId: notification.buildingId,` 추가. `toEntity`의 `reconstitute`에 `entityId: row.entityId,` 아래 `buildingId: row.buildingId,` 추가.

- [ ] **Step 7: DTO + 컨트롤러 매핑** — `src/notification/interface/dto/notification-response.dto.ts`

`NotificationResponseDto`의 `entityId` 아래 추가:
```ts
  @ApiProperty({ nullable: true }) buildingId!: string | null;
```
`src/notification/interface/notification.controller.ts`의 `listMine` 매핑에 `entityId: r.entityId,` 아래 `buildingId: r.buildingId,` 추가.

- [ ] **Step 8: board create-comment payload** — `src/board/application/create-comment.use-case.ts`

outbox.add의 `payload: { postId: created.postId },`를 다음으로 교체:
```ts
          payload: { postId: created.postId, buildingId: post.buildingId },
```
(`post`는 함수 상단에서 이미 로드됨.)

- [ ] **Step 9: 스펙 갱신**

`src/board/application/create-comment.use-case.spec.ts`: CommentCreated payload 기대를 `expect.objectContaining({ postId: POST_ID, buildingId: BUILDING_ID })`로. (`BUILDING_ID` 상수가 없으면 테스트의 post fixture가 쓰는 buildingId 값으로 맞춘다.)
`src/notification/domain/notification-content.spec.ts`: 각 타입 결과에 `buildingId` 단언 추가 — Message=null, Post/Comment=이벤트 payload의 buildingId.

- [ ] **Step 10: 마이그레이션·테스트·lint·build**

Run: `cd ../estate-server && npm test -- notification-content create-comment && npm run lint:check && npm run build`
Expected: 관련 스펙 PASS, lint 클린, build 성공.
Run(드리프트): `npx prisma migrate status` → up to date.

- [ ] **Step 11: 커밋**

```bash
cd ../estate-server
git add prisma/ src/notification/ src/board/
git commit -m "feature: 알림에 buildingId 추가(게시판 딥링크) + 마이그레이션"
```

---

### Task 3: (FE) 알림 API · 상수 · 메시지 · 딥링크 헬퍼

**레포: `estate-web`** (branch `feature/fe-m5-notification`, origin/main 기준)

**Files:**
- Modify: `lib/api/notification.ts`
- Modify: `lib/constants.ts`
- Modify: `lib/messages.ts`
- Create: `lib/notifications/notification-link.ts`
- Test: `lib/notifications/notification-link.test.ts`, `lib/notification-api.test.ts`

**Interfaces:**
- Produces: `Notification = { id; type; title; body: string|null; entityType; entityId; buildingId: string|null; readAt: string|null; createdAt: string }`
- Produces: `backendMarkAllRead(t)`, `backendMarkOneRead(t, id)`, `backendNotifications`(기존), `backendUnreadCount`(기존)
- Produces: `notificationHref(n): string`
- Produces: `NOTIFICATION_TYPE` as const, `API_ROUTES.notificationsRead`, `API_ROUTES.notificationRead(id)`
- Produces: `MESSAGES.notification.{empty, markAll, markFailed}`

- [ ] **Step 1: 상수 추가** — `lib/constants.ts`

`API_ROUTES` 객체에 추가:
```ts
  notificationsRead: "/api/notifications/read",
  notificationRead: (id: string) => `/api/notifications/${id}/read`,
```
파일에 `NOTIFICATION_TYPE` 추가(LEASE_STATUS 근처):
```ts
/** 알림 종류 (백엔드 NotificationType 동기화) */
export const NOTIFICATION_TYPE = {
  MessageReceived: "MessageReceived",
  CommentAdded: "CommentAdded",
  PostAdded: "PostAdded",
} as const;
export type NotificationType = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];
```

- [ ] **Step 2: 메시지 추가** — `lib/messages.ts`

`MESSAGES` 객체에 `comment` 다음 등 적절한 위치에 추가:
```ts
  notification: {
    empty: "아직 알림이 없어요.",
    markAll: "모두 읽음",
    markFailed: "처리하지 못했어요. 잠시 후 다시 시도해주세요.",
  },
```

- [ ] **Step 3: 실패 테스트 작성(API)** — `lib/notification-api.test.ts`

```ts
import { vi } from "vitest";
import { backendMarkAllRead, backendMarkOneRead } from "@/lib/api";

it("backendMarkAllRead: PATCH /notifications/read를 Bearer로 호출", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await backendMarkAllRead("tok");
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toMatch(/\/notifications\/read$/);
  expect((init as RequestInit).method).toBe("PATCH");
  expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
});

it("backendMarkOneRead: PATCH /notifications/:id/read", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await backendMarkOneRead("tok", "n1");
  expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/notifications\/n1\/read$/);
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
});
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `npm run test -- notification-api`
Expected: FAIL (export 없음)

- [ ] **Step 5: notification API 교체** — `lib/api/notification.ts` 전체 교체

```ts
import { authGet, call } from "./client";
import type { NotificationType } from "../constants";

export type Notification = {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: string;
  entityId: string;
  buildingId: string | null;
  readAt: string | null;
  createdAt: string;
};

export const backendNotifications = (t: string, limit = 50) =>
  authGet<Notification[]>(`/notifications?limit=${limit}`, t);

export const backendUnreadCount = (t: string) =>
  authGet<{ count: number }>("/notifications/unread-count", t);

export const backendMarkAllRead = (t: string) =>
  call<{ ok: true }>("/notifications/read", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${t}` },
  }, {});

export const backendMarkOneRead = (t: string, id: string) =>
  call<{ ok: true }>(`/notifications/${id}/read`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${t}` },
  }, {});
```
> `backendNotifications` 기본 limit을 5→50으로 올린다(센터용). 대시보드는 호출 시 `backendNotifications(token, 5)`로 명시(이미 그렇게 호출 — `lib/dashboard.ts`).

- [ ] **Step 6: 딥링크 헬퍼 테스트** — `lib/notifications/notification-link.test.ts`

```ts
import { notificationHref } from "@/lib/notifications/notification-link";

it("메시지 알림 → 채팅방", () => {
  expect(notificationHref({ type: "MessageReceived", entityId: "room1", buildingId: null })).toBe("/chat/room1");
});

it("게시글 알림 → buildingId 있으면 board post", () => {
  expect(notificationHref({ type: "PostAdded", entityId: "p1", buildingId: "b1" })).toBe("/board/b1/p1");
});

it("게시글 알림 → buildingId 없으면 board 홈 폴백", () => {
  expect(notificationHref({ type: "CommentAdded", entityId: "p1", buildingId: null })).toBe("/board");
});
```

- [ ] **Step 7: 테스트 실패 확인**

Run: `npm run test -- notification-link`
Expected: FAIL (모듈 없음)

- [ ] **Step 8: 딥링크 헬퍼 구현** — `lib/notifications/notification-link.ts`

```ts
import type { Notification } from "@/lib/api";
import { PAGE_ROUTES, NOTIFICATION_TYPE } from "@/lib/constants";

// 알림 → 이동 경로. 메시지=채팅방, 게시글/댓글=해당 글(buildingId 없으면 게시판 홈).
export function notificationHref(
  n: Pick<Notification, "type" | "entityId" | "buildingId">,
): string {
  if (n.type === NOTIFICATION_TYPE.MessageReceived) {
    return PAGE_ROUTES.chatRoom(n.entityId);
  }
  if (n.buildingId) return PAGE_ROUTES.boardPost(n.buildingId, n.entityId);
  return PAGE_ROUTES.boardHome;
}
```

- [ ] **Step 9: 테스트·lint 확인**

Run: `npm run test -- notification-api notification-link && npm run lint`
Expected: 5 PASS, lint 클린.

- [ ] **Step 10: 커밋**

```bash
git add lib/api/notification.ts lib/constants.ts lib/messages.ts lib/notifications/ lib/notification-api.test.ts
git commit -m "feature: 알림 API·상수·메시지·딥링크 헬퍼 추가"
```

---

### Task 4: (FE) NotificationProvider + NotificationBell

**Files:**
- Create: `components/notifications/notification-provider.tsx`
- Create: `components/ui/notification-bell.tsx`

**Interfaces:**
- Consumes: `Notification` (`@/lib/api`), `WS_URL` (`@/lib/chat/ws`), `PAGE_ROUTES` (`@/lib/constants`).
- Produces: `NotificationProvider({ token, initialUnread, children })` (client) + context.
- Produces: `useNotifications(): { unread, liveItems, decrement(), reset() }`
- Produces: `NotificationBell()` (client) — context의 unread 배지 + `/notifications` 링크.

- [ ] **Step 1: Provider 구현** — `components/notifications/notification-provider.tsx`

```tsx
"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Notification } from "@/lib/api";
import { WS_URL } from "@/lib/chat/ws";

type Ctx = {
  unread: number;
  liveItems: Notification[];
  decrement: () => void;
  reset: () => void;
};

const NotificationContext = createContext<Ctx | null>(null);

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationProvider");
  return ctx;
}

export function NotificationProvider({
  token,
  initialUnread,
  children,
}: {
  token: string;
  initialUnread: number;
  children: React.ReactNode;
}) {
  const [unread, setUnread] = useState(initialUnread);
  const [liveItems, setLiveItems] = useState<Notification[]>([]);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(`${WS_URL}/notifications`, {
      auth: { token },
      transports: ["websocket"],
    });
    socketRef.current = socket;
    socket.on("notification", (n: Notification) => {
      setUnread((u) => u + 1);
      setLiveItems((prev) => (prev.some((x) => x.id === n.id) ? prev : [n, ...prev]));
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  const decrement = () => setUnread((u) => Math.max(0, u - 1));
  const reset = () => setUnread(0);

  return (
    <NotificationContext.Provider value={{ unread, liveItems, decrement, reset }}>
      {children}
    </NotificationContext.Provider>
  );
}
```
> 푸시되는 알림 객체는 미읽음이며 `readAt`이 없을 수 있다 → `liveItems`는 항상 미읽음으로 표시한다(Task 6에서 `readAt: null` 취급).

- [ ] **Step 2: Bell 구현** — `components/ui/notification-bell.tsx`

```tsx
"use client";

import Link from "next/link";
import { PAGE_ROUTES } from "@/lib/constants";
import { useNotifications } from "@/components/notifications/notification-provider";

export function NotificationBell() {
  const { unread } = useNotifications();
  return (
    <Link
      href={PAGE_ROUTES.notifications}
      className="relative grid h-10 w-10 place-items-center rounded-xl text-text-2 hover:bg-surface-2"
      aria-label="알림"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M10 20a2 2 0 004 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {unread > 0 && (
        <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-warm px-1 text-[10px] font-bold text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
```

- [ ] **Step 3: 빌드·lint 확인**

Run: `npm run build && npm run lint`
Expected: 성공(아직 미사용 컴포넌트지만 타입/문법 통과).

- [ ] **Step 4: 커밋**

```bash
git add components/notifications/notification-provider.tsx components/ui/notification-bell.tsx
git commit -m "feature: 알림 Provider(소켓 컨텍스트)·헤더 벨 추가"
```

---

### Task 5: (FE) 인증 라우트 그룹 `(app)` + persistent layout

페이지를 `app/(app)/`로 이동하고 헤더+Provider를 layout에 둔다. 헤더가 layout으로 가므로 각 페이지의 `<AppShell>` 래퍼를 제거한다.

**Files:**
- Create: `app/(app)/layout.tsx`
- Move (git mv): `app/dashboard`→`app/(app)/dashboard`, `app/board`→`app/(app)/board`, `app/chat`→`app/(app)/chat`, `app/(owner)`→`app/(app)/(owner)`
- Modify: 위 이동된 모든 page.tsx에서 `<AppShell ...>` 래퍼 제거
- Modify: `components/dashboard/owner-home.test.tsx` 등은 영향 없음(컴포넌트 직접 렌더)

**Interfaces:**
- Consumes: `NotificationProvider`, `NotificationBell`, `getToken`, `backendMe`, `backendUnreadCount`, `PAGE_ROUTES`.
- Produces: 모든 인증 페이지에 헤더+소켓 1회 연결. 페이지는 콘텐츠만 반환.

- [ ] **Step 1: 디렉터리 이동** (URL 불변 — route group)

```bash
cd estate-web
mkdir -p "app/(app)"
git mv app/dashboard "app/(app)/dashboard"
git mv app/board "app/(app)/board"
git mv app/chat "app/(app)/chat"
git mv "app/(owner)" "app/(app)/(owner)"
```

- [ ] **Step 2: 인증 layout 작성** — `app/(app)/layout.tsx`

```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { getToken } from "@/lib/session";
import { backendMe, backendUnreadCount } from "@/lib/api";
import { PAGE_ROUTES } from "@/lib/constants";
import { NotificationProvider } from "@/components/notifications/notification-provider";
import { NotificationBell } from "@/components/ui/notification-bell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const token = await getToken();
  if (!token) redirect(PAGE_ROUTES.login);

  let initial = "";
  let unread = 0;
  try {
    const me = await backendMe(token);
    initial = me.email.charAt(0).toUpperCase();
  } catch {
    redirect(PAGE_ROUTES.login);
  }
  try {
    unread = (await backendUnreadCount(token)).count;
  } catch {
    unread = 0;
  }

  return (
    <NotificationProvider token={token} initialUnread={unread}>
      <div className="min-h-full">
        <header className="sticky top-0 z-20 border-b border-border bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur">
          <div className="mx-auto flex max-w-[760px] items-center gap-3 px-5 py-3.5">
            <Link href={PAGE_ROUTES.dashboard} className="flex items-center gap-2 font-extrabold text-[18px]">
              <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-brand-500 text-white">터</span>터전
            </Link>
            <div className="flex-1" />
            <NotificationBell />
            <div className="grid h-9 w-9 place-items-center rounded-full bg-brand-500 text-[14px] font-bold text-white">{initial}</div>
          </div>
        </header>
        <main className="mx-auto max-w-[760px] px-5 pb-16 pt-6">{children}</main>
      </div>
    </NotificationProvider>
  );
}
```

- [ ] **Step 3: 각 페이지에서 AppShell 래퍼 제거**

이동된 page.tsx들에서 `import { AppShell } from "@/components/ui/app-shell";`를 제거하고, `<AppShell ...>` ~ `</AppShell>`를 React Fragment(`<>` … `</>`)로 교체(내부 콘텐츠 유지). 대상 파일/반환부:
- `app/(app)/dashboard/page.tsx` (1곳)
- `app/(app)/board/page.tsx` (3곳)
- `app/(app)/board/[buildingId]/page.tsx` (1곳)
- `app/(app)/board/[buildingId]/[postId]/page.tsx` (2곳)
- `app/(app)/chat/page.tsx` (1곳)
- `app/(app)/chat/[roomId]/page.tsx` (1곳)
- `app/(app)/(owner)/buildings/page.tsx` (1곳)
- `app/(app)/(owner)/buildings/[id]/page.tsx` (1곳)

예시(dashboard) — 변경 전:
```tsx
  return (
    <AppShell unread={data.unread} userInitial={initial}>
      {data.me.role === ROLE.TENANT ? (...) : (...)}
    </AppShell>
  );
```
변경 후:
```tsx
  return (
    <>
      {data.me.role === ROLE.TENANT ? (...) : (...)}
    </>
  );
```
각 파일에서 더 이상 쓰지 않는 변수(`initial`, `data.unread` 등)는 그대로 두되 미사용 경고가 나면 제거. `userInitial`/`unread`만 쓰던 `me`/`initial` 계산이 페이지 콘텐츠에 더는 필요 없으면 lint 통과를 위해 정리.

- [ ] **Step 4: AppShell 컴포넌트 제거 여부 확인**

`grep -rn "AppShell" app components | grep -v "\.test\."` 결과가 비면(테스트 제외) `components/ui/app-shell.tsx`와 `components/ui/*app-shell*` 미사용. 안전하게 두되, 미사용 export로 lint 경고가 없으면 유지. (삭제는 별도 판단 — 이 태스크에서는 유지.)

- [ ] **Step 5: 빌드·lint 확인 (라우트·페이지 정상)**

Run: `npm run build && npm run lint`
Expected: 빌드 성공, `/dashboard`·`/board`·`/chat`·`/buildings` 라우트가 그대로(URL 불변) 생성, lint 클린.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "refactor: 인증 페이지를 (app) 그룹으로 이동·헤더/소켓 Provider를 layout으로"
```

---

### Task 6: (FE) Route Handlers + 알림 센터 페이지

**Files:**
- Create: `app/api/notifications/read/route.ts`
- Create: `app/api/notifications/[id]/read/route.ts`
- Create: `app/(app)/notifications/page.tsx`
- Create: `components/notifications/notification-list.tsx`
- Create: `components/notifications/mark-all-read-button.tsx`
- Test: `components/notifications/mark-all-read-button.test.tsx`

**Interfaces:**
- Consumes: `backendNotifications`, `backendMarkAllRead`, `backendMarkOneRead`, `Notification`, `ApiError` (`@/lib/api`); `getToken`; `notificationHref`; `useNotifications`; `API_ROUTES`, `PAGE_ROUTES`; `MESSAGES`.
- Produces: 라우트 `/notifications`, `PATCH /api/notifications/read`, `PATCH /api/notifications/:id/read`.

- [ ] **Step 1: 전체 읽음 Route Handler** — `app/api/notifications/read/route.ts`

```ts
import { NextResponse } from "next/server";
import { getToken } from "@/lib/session";
import { backendMarkAllRead, ApiError } from "@/lib/api";

export async function PATCH() {
  const token = await getToken();
  if (!token) return NextResponse.json({ message: "인증 필요" }, { status: 401 });
  try {
    const r = await backendMarkAllRead(token);
    return NextResponse.json(r, { status: 200 });
  } catch (e) {
    const err = e as ApiError;
    return NextResponse.json({ message: err.message, status: err.status }, { status: err.status ?? 500 });
  }
}
```

- [ ] **Step 2: 단건 읽음 Route Handler** — `app/api/notifications/[id]/read/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/session";
import { backendMarkOneRead, ApiError } from "@/lib/api";

export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = await getToken();
  if (!token) return NextResponse.json({ message: "인증 필요" }, { status: 401 });
  try {
    const { id } = await params;
    const r = await backendMarkOneRead(token, id);
    return NextResponse.json(r, { status: 200 });
  } catch (e) {
    const err = e as ApiError;
    return NextResponse.json({ message: err.message, status: err.status }, { status: err.status ?? 500 });
  }
}
```

- [ ] **Step 3: mark-all 버튼 실패 테스트** — `components/notifications/mark-all-read-button.test.tsx`

```tsx
import { vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const reset = vi.fn();
vi.mock("@/components/notifications/notification-provider", () => ({
  useNotifications: () => ({ reset, unread: 3, liveItems: [], decrement: vi.fn() }),
}));

import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";

afterEach(() => { vi.unstubAllGlobals(); refresh.mockReset(); reset.mockReset(); });

it("성공 시 reset과 refresh 호출", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  render(<MarkAllReadButton />);
  fireEvent.click(screen.getByText("모두 읽음"));
  await waitFor(() => expect(reset).toHaveBeenCalled());
  expect(refresh).toHaveBeenCalled();
});

it("실패 시 에러 메시지 표시", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "처리하지 못했어요. 잠시 후 다시 시도해주세요." }), { status: 500 })));
  render(<MarkAllReadButton />);
  fireEvent.click(screen.getByText("모두 읽음"));
  await waitFor(() => expect(screen.getByText("처리하지 못했어요. 잠시 후 다시 시도해주세요.")).toBeInTheDocument());
  expect(reset).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `npm run test -- mark-all-read-button`
Expected: FAIL (컴포넌트 없음)

- [ ] **Step 5: mark-all 버튼 구현** — `components/notifications/mark-all-read-button.tsx`

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";
import { useNotifications } from "@/components/notifications/notification-provider";

export function MarkAllReadButton() {
  const router = useRouter();
  const { reset } = useNotifications();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function markAll() {
    setLoading(true);
    setError(null);
    const res = await fetch(API_ROUTES.notificationsRead, { method: "PATCH" });
    if (res.ok) {
      reset();
      router.refresh();
    } else {
      const json = await res.json().catch(() => ({}));
      setError(json.message ?? MESSAGES.notification.markFailed);
    }
    setLoading(false);
  }

  return (
    <div className="text-right">
      <button onClick={markAll} disabled={loading} className="text-[13px] font-semibold text-brand-600 disabled:opacity-50">
        {MESSAGES.notification.markAll}
      </button>
      {error && <p className="mt-1 text-[13px] text-danger">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 6: 알림 목록 컴포넌트** — `components/notifications/notification-list.tsx`

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Notification } from "@/lib/api";
import { API_ROUTES } from "@/lib/constants";
import { notificationHref } from "@/lib/notifications/notification-link";
import { useNotifications } from "@/components/notifications/notification-provider";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { MESSAGES } from "@/lib/messages";

export function NotificationList({ initial }: { initial: Notification[] }) {
  const router = useRouter();
  const { liveItems, decrement } = useNotifications();
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  // 실시간 수신분(미읽음)을 상단에 합치고 id 중복 제거.
  const seen = new Set<string>();
  const merged = [...liveItems, ...initial].filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });

  async function open(n: Notification) {
    const wasUnread = !n.readAt && !readIds.has(n.id);
    if (wasUnread) {
      setReadIds((prev) => new Set(prev).add(n.id));
      const res = await fetch(API_ROUTES.notificationRead(n.id), { method: "PATCH" });
      if (res.ok) decrement();
    }
    router.push(notificationHref(n));
  }

  if (merged.length === 0) return <EmptyState text={MESSAGES.notification.empty} />;

  return (
    <Card className="p-0">
      <div className="divide-y divide-border px-4">
        {merged.map((n) => {
          const unread = !n.readAt && !readIds.has(n.id);
          return (
            <button key={n.id} onClick={() => open(n)} className="flex w-full items-start gap-3 py-3.5 text-left hover:bg-surface-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-text">{n.title}</span>
                  {unread && <span className="h-1.5 w-1.5 rounded-full bg-warm" />}
                </div>
                {n.body && <div className="mt-0.5 truncate text-[13px] text-text-2">{n.body}</div>}
              </div>
              <span className="shrink-0 text-[12px] text-text-3">{new Date(n.createdAt).toLocaleDateString("ko-KR")}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
```

- [ ] **Step 7: 알림 센터 페이지** — `app/(app)/notifications/page.tsx`

```tsx
import { redirect } from "next/navigation";
import { getToken } from "@/lib/session";
import { backendNotifications, type Notification } from "@/lib/api";
import { NotificationList } from "@/components/notifications/notification-list";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";
import { PAGE_ROUTES } from "@/lib/constants";

export default async function NotificationsPage() {
  const token = await getToken();
  if (!token) redirect(PAGE_ROUTES.login);

  let items: Notification[];
  try {
    items = await backendNotifications(token, 50);
  } catch {
    items = [];
  }

  return (
    <>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-[22px] font-extrabold tracking-tight">알림</h1>
        <MarkAllReadButton />
      </div>
      <NotificationList initial={items} />
    </>
  );
}
```

- [ ] **Step 8: 테스트·빌드·lint**

Run: `npm run test -- mark-all-read-button && npm run build && npm run lint`
Expected: 2 PASS, 빌드 성공(`/notifications` + `/api/notifications/...` 라우트 포함), lint 클린.

- [ ] **Step 9: 커밋**

```bash
git add app/api/notifications "app/(app)/notifications" components/notifications/notification-list.tsx components/notifications/mark-all-read-button.tsx components/notifications/mark-all-read-button.test.tsx
git commit -m "feature: 알림 센터(/notifications)·단건/전체 읽음·딥링크"
```

---

### Task 7: (FE) 대시보드 최근 소식 정합성 수정

**Files:**
- Modify: `components/dashboard/recent-activity.tsx`

**Interfaces:**
- Consumes: 수정된 `Notification` 타입(`title`/`body`/`readAt`).

- [ ] **Step 1: recent-activity 교체** — `components/dashboard/recent-activity.tsx`

```tsx
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { EmptyState } from "@/components/ui/empty-state";
import type { Notification } from "@/lib/api";

export function RecentActivity({ items }: { items: Notification[] }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 px-0.5 text-[16px] font-bold">최근 소식</h2>
      <Card className="p-0">
        {items.length === 0 ? <EmptyState text="아직 새 소식이 없어요." /> :
          <div className="divide-y divide-border px-4">
            {items.map((n) => (
              <ListRow key={n.id} title={n.title}
                desc={n.body ?? undefined}
                meta={n.readAt ? undefined : "NEW"} />
            ))}
          </div>}
      </Card>
    </section>
  );
}
```

- [ ] **Step 2: 테스트·빌드·lint**

Run: `npm run test && npm run build && npm run lint`
Expected: 전체 테스트 PASS(기존 dashboard 테스트는 notifications=[]라 영향 없음), 빌드·lint 통과.

- [ ] **Step 3: 커밋**

```bash
git add components/dashboard/recent-activity.tsx
git commit -m "fix: 대시보드 최근 소식을 알림 실제 필드(title/body)로 수정"
```

---

## 마무리 (계획 외 후속)

- README 마일스톤 표 FE-M5 ✅ 갱신(별도 docs 커밋).
- BE PR(estate-server `feature/m5-notification`)과 FE PR(estate-web `feature/fe-m5-notification`) 분리. PR 본문에 스펙·플랜 경로 첨부. **BE 먼저(또는 동시) 머지**.
- 머지 후 web 서브모듈 포인터를 estate-web `main` HEAD로 재갱신.
- 배포 환경 `NEXT_PUBLIC_WS_URL` 확인(M4와 동일).

## Self-Review 결과

- **스펙 커버리지:** §3.1 단건 읽음→Task 1 / §3.2 buildingId→Task 2 / §4.1 layout+Provider→Task 4·5 / §4.2 센터·벨→Task 4·6 / §4.3 lib·정합성→Task 3·7 / §5 에러→각 Task / §6 테스트→Task 1·2·3·6. 모두 매핑.
- **YAGNI 반영:** 스펙의 `notification-label` 헬퍼는 BE `title`로 대체(별도 파일 불필요) — Task 6/7에서 `n.title` 직접 사용.
- **플레이스홀더:** 없음(모든 step에 코드/명령).
- **타입 일관성:** `Notification`(+buildingId, Task 3) → Task 6·7 사용 일치. `notificationHref`(Task 3) → Task 6 사용. `useNotifications`/`NotificationProvider`(Task 4) → Task 5·6 사용. BE `markOneRead`/`decrement`/`buildingId` 시그니처 Task 1·2 정의 = 이후 일치.
