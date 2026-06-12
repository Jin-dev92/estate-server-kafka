# M2 — 게시판(Board) CRUD + Redis read-through 캐시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **문서 규칙:** 예시 코드는 **구현 단계 동안 참고용으로 유지**하고, M2 PR 작성 직전에 제거한다(산문·시그니처·명령만 남김).

**Goal:** 같은 건물 멤버끼리 쓰는 건물 단위 게시판(글·댓글 CRUD)을 만들고, 목록/상세를 **Redis read-through 캐시**로 읽되 쓰기(작성·수정·삭제·댓글) 시 해당 키를 **명시적으로 무효화**한다. 핵심 학습은 **캐시 무효화 패턴**이다.

**Architecture:** M0~M1의 DDD 레이어드를 그대로 따른다. Board는 스펙 5.3 "규칙 없는 CRUD는 얇게" 원칙에 맞춰 도메인을 가볍게 두고, **캐시·멤버십은 application 포트**로 둔다(도메인 리포지토리와 구분). 인가는 **건물 멤버십**(건물주 또는 ACTIVE 입주자) + **작성자 소유권** 이중. `PostCreated` 이벤트 발행은 Kafka 도입(M3) 전이라 M2에서는 다루지 않는다.

**Tech Stack:** NestJS 11, TypeScript, Prisma + PostgreSQL, ioredis(RedisService), class-validator, Jest.

**선행:** M1 완료(머지) 상태. `src/redis/RedisService`, `src/auth/`(JwtAuthGuard·CurrentUser·TokenPayload), Property(Building·Unit·Lease) 스키마가 존재한다고 가정한다.

---

## 핵심 설계 결정 (M2 한정)

- **건물 단위 스코프 + 멤버십 인가.** 글 읽기/작성/댓글은 해당 건물의 **멤버**(건물주 `Building.ownerId == userId` 또는 그 건물 호실에 **ACTIVE Lease**를 가진 입주자)만 가능하다. 멤버십 검사는 `MembershipChecker` 포트로 추상화하고 infrastructure에서 Prisma로 조회한다(스펙 6절: 앱 계층 인가).
- **글 수정/삭제는 작성자만.** `Post.isAuthoredBy(userId)`로 검사(리소스 소유권). 모더레이션(건물주가 남의 글 삭제)은 범위 밖.
- **read-through 캐시 + 명시적 무효화 + 짧은 TTL 안전망.**
  - 목록 키 `board:list:{buildingId}` ← 건물 글 목록(요약 DTO 배열).
  - 상세 키 `board:detail:{postId}` ← 글 본문 + 댓글.
  - 읽기: 캐시 hit이면 반환, miss면 DB 조회 후 캐시에 `SET ... EX(TTL)`.
  - 쓰기: 작성→목록 무효화, 수정/삭제→상세+목록 무효화, 댓글 작성→상세 무효화. TTL(예: 120s)은 무효화 누락 대비 안전망.
- **캐시는 도메인 엔티티가 아니라 읽기모델 DTO를 저장한다.** 직렬화·역직렬화가 단순하고 응답 형태와 1:1.
- **category는 enum(NOTICE|FREE), 역할 게이팅은 범위 밖.** M2는 멤버면 누구나 작성 가능(NOTICE를 건물주로 제한하는 건 추후). 캐시에 집중.
- **분산 환경 + Lua 기반 마련.** 멀티 인스턴스 배포를 전제로, *여러 Redis 명령을 원자로 묶어야 하는* 연산은 서버측 Lua 스크립트로 처리한다. 단, 게시판 캐시의 read-through **stale-set 레이스**(reader가 DB를 읽는 사이 writer가 무효화 → reader가 옛 값 SET)는 `GET → (DB 조회) → SET` 사이에 DB 조회가 끼어 **단일 Lua 스크립트로 막을 수 없으므로 짧은 TTL 안전망으로 수용**한다. Lua의 실제 적용처는 진짜 원자성이 필요한 곳(M5 미읽음 카운터, M6 레이트리밋)이며, M2에서는 `RedisService`에 **스크립트 실행 기반(runScript)만** 마련한다(Task 11). 초대코드(M1)는 이미 `GETDEL`로 원자적이라 Lua 불필요.

---

## M2 파일 구조

```
src/board/domain/post-category.enum.ts                  Create  NOTICE|FREE
src/board/domain/post.entity.ts                         Create  Post 엔티티(+isAuthoredBy, edit)
src/board/domain/comment.entity.ts                      Create  Comment 엔티티
src/board/domain/post.repository.ts                     Create  인터페이스 + DI 토큰
src/board/domain/comment.repository.ts                  Create  인터페이스 + DI 토큰
src/board/application/board-cache.ts                    Create  캐시 포트 + 읽기모델 DTO + 토큰
src/board/application/membership.ts                     Create  멤버십 포트 + 토큰
src/board/application/create-post.use-case.ts           Create  멤버십 검사 + 목록 무효화
src/board/application/list-posts.use-case.ts            Create  read-through 캐시
src/board/application/get-post.use-case.ts              Create  상세 캐시(+댓글)
src/board/application/update-post.use-case.ts           Create  작성자 + 상세·목록 무효화
src/board/application/delete-post.use-case.ts           Create  작성자 + 상세·목록 무효화
src/board/application/create-comment.use-case.ts        Create  멤버십 + 상세 무효화
src/board/infrastructure/prisma-post.repository.ts      Create
src/board/infrastructure/prisma-comment.repository.ts   Create
src/board/infrastructure/redis-board-cache.ts           Create  read-through 직렬화 + 무효화
src/board/infrastructure/prisma-membership.checker.ts   Create  owner | ACTIVE 입주자
src/board/interface/dto/create-post.dto.ts              Create
src/board/interface/dto/update-post.dto.ts              Create
src/board/interface/dto/create-comment.dto.ts           Create
src/board/interface/board.controller.ts                 Create  /buildings/:id/posts · /posts/:id · /comments
src/board/board.module.ts                               Create  컨텍스트 모듈 조립
src/redis/redis.service.ts                              Modify  Lua 스크립트 실행(runScript) 추가 [Task 11]
prisma/schema.prisma                                    Modify  Post/Comment + PostCategory + 역관계
src/app.module.ts                                       Modify  BoardModule 등록
test/board.e2e-spec.ts                                  Create  CRUD + 캐시 hit/무효화 + 멤버십/작성자
test/redis-script.e2e-spec.ts                           Create  runScript Lua 원자 실행 통합 테스트 [Task 11]
```

> **레이어 메모:** 리포지토리 인터페이스는 `domain/`(M0~M1과 동일), **캐시·멤버십 포트는 `application/`**에 둔다 — 둘 다 도메인 개념이 아니라 애플리케이션 협력자(인프라 추상화)이기 때문. 구현 바인딩은 `board.module.ts`에서.

---

## Task 1: Prisma 스키마 (Post/Comment + PostCategory) + 마이그레이션

**Files:** Modify `prisma/schema.prisma`.

- [ ] **Step 1: 모델·enum 추가 + 역관계**

기존 `User`에 `posts Post[]`·`comments Comment[]`, 기존 `Building`에 `posts Post[]` 역관계를 추가하고, 파일 끝에 추가한다.

```prisma
enum PostCategory {
  NOTICE
  FREE
}

model Post {
  id         String       @id @default(cuid())
  buildingId String
  building   Building     @relation(fields: [buildingId], references: [id])
  authorId   String
  author     User         @relation(fields: [authorId], references: [id])
  category   PostCategory @default(FREE)
  title      String
  content    String
  createdAt  DateTime     @default(now())
  updatedAt  DateTime     @updatedAt

  comments Comment[]
}

model Comment {
  id        String   @id @default(cuid())
  postId    String
  post      Post     @relation(fields: [postId], references: [id], onDelete: Cascade)
  authorId  String
  author    User     @relation(fields: [authorId], references: [id])
  content   String
  createdAt DateTime @default(now())
}
```

> `Comment.post`에 `onDelete: Cascade` — 글 삭제 시 댓글이 함께 지워져 FK 제약 없이 삭제된다.
> `User`/`Building` 역관계 추가 예: `User { ... posts Post[]  comments Comment[] }`, `Building { ... posts Post[] }`.

- [ ] **Step 2: 마이그레이션 생성·적용 + 클라이언트 재생성**

Run:
```bash
npx prisma migrate dev --name add_board
```
Expected: `prisma/migrations/<ts>_add_board/` 생성, "Your database is now in sync", `@prisma/client` 재생성(`prisma.post`·`prisma.comment` 사용 가능).

- [ ] **Step 3: 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: Commit**

```bash
git add prisma
git commit -m "[M2]feat: Post/Comment 스키마 및 마이그레이션 추가"
```

---

## Task 2: Board 도메인 레이어 (엔티티 + 리포지토리 인터페이스)

도메인은 순수 TS만 사용한다(NestJS·Prisma·ioredis import 금지).

**Files:** Create `post-category.enum.ts`, `post.entity.ts`, `comment.entity.ts`, `post.repository.ts`, `comment.repository.ts` (모두 `src/board/domain/`), Test `post.entity.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — Post 불변식 + edit + 작성자**

`src/board/domain/post.entity.spec.ts`:
```typescript
import { Post } from './post.entity';
import { PostCategory } from './post-category.enum';

describe('Post entity', () => {
  it('create()로 만들면 id는 null, 기본 category는 FREE, 작성자가 설정된다', () => {
    const post = Post.create({
      buildingId: 'b1',
      authorId: 'u1',
      title: '공지',
      content: '내용',
    });

    expect(post.id).toBeNull();
    expect(post.category).toBe(PostCategory.FREE);
    expect(post.isAuthoredBy('u1')).toBe(true);
    expect(post.isAuthoredBy('other')).toBe(false);
  });

  it('제목이 비면 예외', () => {
    expect(() =>
      Post.create({ buildingId: 'b1', authorId: 'u1', title: '', content: '내용' }),
    ).toThrow('title is required');
  });

  it('edit()는 제목·본문이 바뀐 새 Post를 반환하고 id는 유지한다', () => {
    const post = Post.reconstitute({
      id: 'p1',
      buildingId: 'b1',
      authorId: 'u1',
      category: PostCategory.FREE,
      title: '원래',
      content: '원래본문',
    });

    const edited = post.edit({ title: '수정', content: '수정본문' });

    expect(edited.id).toBe('p1');
    expect(edited.title).toBe('수정');
    expect(edited.content).toBe('수정본문');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/board/domain/post.entity.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `post-category.enum.ts` 작성**

```typescript
export enum PostCategory {
  NOTICE = 'NOTICE',
  FREE = 'FREE',
}
```

- [ ] **Step 4: `post.entity.ts` 작성**

```typescript
import { PostCategory } from './post-category.enum';

interface PostProps {
  id: string | null;
  buildingId: string;
  authorId: string;
  category: PostCategory;
  title: string;
  content: string;
}

export class Post {
  private constructor(private readonly props: PostProps) {}

  static create(input: {
    buildingId: string;
    authorId: string;
    category?: PostCategory;
    title: string;
    content: string;
  }): Post {
    if (!input.buildingId) throw new Error('buildingId is required');
    if (!input.authorId) throw new Error('authorId is required');
    if (!input.title) throw new Error('title is required');
    if (!input.content) throw new Error('content is required');
    return new Post({
      id: null,
      buildingId: input.buildingId,
      authorId: input.authorId,
      category: input.category ?? PostCategory.FREE,
      title: input.title,
      content: input.content,
    });
  }

  static reconstitute(props: PostProps): Post {
    return new Post(props);
  }

  edit(input: { title: string; content: string }): Post {
    if (!input.title) throw new Error('title is required');
    if (!input.content) throw new Error('content is required');
    return new Post({
      ...this.props,
      title: input.title,
      content: input.content,
    });
  }

  isAuthoredBy(userId: string): boolean {
    return this.props.authorId === userId;
  }

  get id(): string | null {
    return this.props.id;
  }
  get buildingId(): string {
    return this.props.buildingId;
  }
  get authorId(): string {
    return this.props.authorId;
  }
  get category(): PostCategory {
    return this.props.category;
  }
  get title(): string {
    return this.props.title;
  }
  get content(): string {
    return this.props.content;
  }
}
```

- [ ] **Step 5: `comment.entity.ts` 작성**

```typescript
interface CommentProps {
  id: string | null;
  postId: string;
  authorId: string;
  content: string;
}

export class Comment {
  private constructor(private readonly props: CommentProps) {}

  static create(input: {
    postId: string;
    authorId: string;
    content: string;
  }): Comment {
    if (!input.postId) throw new Error('postId is required');
    if (!input.authorId) throw new Error('authorId is required');
    if (!input.content) throw new Error('content is required');
    return new Comment({
      id: null,
      postId: input.postId,
      authorId: input.authorId,
      content: input.content,
    });
  }

  static reconstitute(props: CommentProps): Comment {
    return new Comment(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get postId(): string {
    return this.props.postId;
  }
  get authorId(): string {
    return this.props.authorId;
  }
  get content(): string {
    return this.props.content;
  }
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npx jest src/board/domain/post.entity.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 7: 리포지토리 인터페이스 작성**

`src/board/domain/post.repository.ts`:
```typescript
import { Post } from './post.entity';

export const POST_REPOSITORY = Symbol('POST_REPOSITORY');

export interface PostRepository {
  create(post: Post): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  findByBuilding(buildingId: string): Promise<Post[]>;
  update(post: Post): Promise<Post>;
  delete(id: string): Promise<void>;
}
```

`src/board/domain/comment.repository.ts`:
```typescript
import { Comment } from './comment.entity';

export const COMMENT_REPOSITORY = Symbol('COMMENT_REPOSITORY');

export interface CommentRepository {
  create(comment: Comment): Promise<Comment>;
  findByPost(postId: string): Promise<Comment[]>;
}
```

- [ ] **Step 8: Commit**

```bash
git add src/board/domain
git commit -m "[M2]feat: Board 도메인 레이어 추가 (Post/Comment 엔티티 및 리포지토리 인터페이스)"
```

---

## Task 3: 애플리케이션 포트 (BoardCache + 읽기모델, MembershipChecker)

**Files:** Create `src/board/application/board-cache.ts`, `src/board/application/membership.ts`.

- [ ] **Step 1: `board-cache.ts` 작성 (캐시 포트 + 읽기모델 DTO)**

```typescript
import { PostCategory } from '../domain/post-category.enum';

export const BOARD_CACHE = Symbol('BOARD_CACHE');

export interface PostSummary {
  id: string;
  category: PostCategory;
  title: string;
  authorId: string;
}

export interface CommentView {
  id: string;
  authorId: string;
  content: string;
}

export interface PostDetail {
  id: string;
  buildingId: string;
  category: PostCategory;
  title: string;
  content: string;
  authorId: string;
  comments: CommentView[];
}

export interface BoardCache {
  getList(buildingId: string): Promise<PostSummary[] | null>;
  setList(buildingId: string, posts: PostSummary[]): Promise<void>;
  getDetail(postId: string): Promise<PostDetail | null>;
  setDetail(postId: string, detail: PostDetail): Promise<void>;
  invalidateList(buildingId: string): Promise<void>;
  invalidateDetail(postId: string): Promise<void>;
}
```

- [ ] **Step 2: `membership.ts` 작성 (멤버십 포트)**

```typescript
export const MEMBERSHIP_CHECKER = Symbol('MEMBERSHIP_CHECKER');

export interface MembershipChecker {
  // 건물주이거나 해당 건물 호실의 ACTIVE 입주자면 true
  isMember(userId: string, buildingId: string): Promise<boolean>;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/board/application/board-cache.ts src/board/application/membership.ts
git commit -m "[M2]feat: Board 캐시·멤버십 포트(읽기모델 DTO 포함) 추가"
```

---

## Task 4: 인프라 레이어 (Prisma 리포지토리 + Redis 캐시 + 멤버십 체커)

**Files:** Create `prisma-post.repository.ts`, `prisma-comment.repository.ts`, `redis-board-cache.ts`, `prisma-membership.checker.ts` (모두 `src/board/infrastructure/`).

> 인프라 구현은 실제 DB/Redis가 필요하므로 단위 spec 없이 **Task 10 e2e로 검증**한다. 단위 테스트는 Task 5~8에서 인메모리 가짜로 커버.

- [ ] **Step 1: `prisma-post.repository.ts` 작성**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';

@Injectable()
export class PrismaPostRepository implements PostRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string;
    buildingId: string;
    authorId: string;
    category: string;
    title: string;
    content: string;
  }): Post {
    return Post.reconstitute({
      id: row.id,
      buildingId: row.buildingId,
      authorId: row.authorId,
      category: row.category as PostCategory,
      title: row.title,
      content: row.content,
    });
  }

  async create(post: Post): Promise<Post> {
    const row = await this.prisma.post.create({
      data: {
        buildingId: post.buildingId,
        authorId: post.authorId,
        category: post.category,
        title: post.title,
        content: post.content,
      },
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<Post | null> {
    const row = await this.prisma.post.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByBuilding(buildingId: string): Promise<Post[]> {
    const rows = await this.prisma.post.findMany({
      where: { buildingId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async update(post: Post): Promise<Post> {
    const row = await this.prisma.post.update({
      where: { id: post.id! },
      data: { title: post.title, content: post.content },
    });
    return this.toDomain(row);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.post.delete({ where: { id } });
  }
}
```

- [ ] **Step 2: `prisma-comment.repository.ts` 작성**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Comment } from '../domain/comment.entity';
import { CommentRepository } from '../domain/comment.repository';

@Injectable()
export class PrismaCommentRepository implements CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(comment: Comment): Promise<Comment> {
    const row = await this.prisma.comment.create({
      data: {
        postId: comment.postId,
        authorId: comment.authorId,
        content: comment.content,
      },
    });
    return Comment.reconstitute({
      id: row.id,
      postId: row.postId,
      authorId: row.authorId,
      content: row.content,
    });
  }

  async findByPost(postId: string): Promise<Comment[]> {
    const rows = await this.prisma.comment.findMany({
      where: { postId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) =>
      Comment.reconstitute({
        id: row.id,
        postId: row.postId,
        authorId: row.authorId,
        content: row.content,
      }),
    );
  }
}
```

- [ ] **Step 3: `redis-board-cache.ts` 작성 (직렬화 + TTL 안전망)**

```typescript
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  BoardCache,
  PostDetail,
  PostSummary,
} from '../application/board-cache';

const CACHE_TTL_SEC = 120; // 무효화 누락 대비 안전망

@Injectable()
export class RedisBoardCache implements BoardCache {
  constructor(private readonly redis: RedisService) {}

  private listKey(buildingId: string): string {
    return `board:list:${buildingId}`;
  }
  private detailKey(postId: string): string {
    return `board:detail:${postId}`;
  }

  async getList(buildingId: string): Promise<PostSummary[] | null> {
    const raw = await this.redis.get(this.listKey(buildingId));
    return raw ? (JSON.parse(raw) as PostSummary[]) : null;
  }

  async setList(buildingId: string, posts: PostSummary[]): Promise<void> {
    await this.redis.set(
      this.listKey(buildingId),
      JSON.stringify(posts),
      'EX',
      CACHE_TTL_SEC,
    );
  }

  async getDetail(postId: string): Promise<PostDetail | null> {
    const raw = await this.redis.get(this.detailKey(postId));
    return raw ? (JSON.parse(raw) as PostDetail) : null;
  }

  async setDetail(postId: string, detail: PostDetail): Promise<void> {
    await this.redis.set(
      this.detailKey(postId),
      JSON.stringify(detail),
      'EX',
      CACHE_TTL_SEC,
    );
  }

  async invalidateList(buildingId: string): Promise<void> {
    await this.redis.del(this.listKey(buildingId));
  }

  async invalidateDetail(postId: string): Promise<void> {
    await this.redis.del(this.detailKey(postId));
  }
}
```

> **분산 메모:** 위 캐시는 멀티 인스턴스에서 read-through **stale-set 레이스**(reader가 DB를 읽는 사이 writer가 `DEL` → reader가 옛 값 `SET`)가 가능하다. `GET → (DB 조회) → SET` 사이의 DB 조회는 Redis 밖이라 단일 Lua로 묶을 수 없으므로 **`CACHE_TTL_SEC`(120s) 안전망으로 수용**한다(저빈도·저위험). 무효화(`DEL`)는 이미 원자적이다. 진짜 원자 연산이 필요한 곳을 위한 Lua 기반은 Task 11에서 마련한다.

- [ ] **Step 4: `prisma-membership.checker.ts` 작성**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipChecker } from '../application/membership';

@Injectable()
export class PrismaMembershipChecker implements MembershipChecker {
  constructor(private readonly prisma: PrismaService) {}

  async isMember(userId: string, buildingId: string): Promise<boolean> {
    const owned = await this.prisma.building.findFirst({
      where: { id: buildingId, ownerId: userId },
      select: { id: true },
    });
    if (owned) return true;

    const lease = await this.prisma.lease.findFirst({
      where: {
        tenantId: userId,
        status: 'ACTIVE',
        unit: { buildingId },
      },
      select: { id: true },
    });
    return lease !== null;
  }
}
```

- [ ] **Step 5: 컴파일 확인 후 Commit**

Run: `npx tsc --noEmit`
Expected: 에러 없음.
```bash
git add src/board/infrastructure
git commit -m "[M2]feat: Board 인프라 레이어 추가 (Prisma 리포지토리, Redis 캐시, 멤버십 체커)"
```

---

## Task 5: CreatePost + ListPosts 유스케이스 (멤버십 + read-through 캐시)

**Files:** Create `create-post.use-case.ts`, `list-posts.use-case.ts`, Test `list-posts.use-case.spec.ts`.

- [ ] **Step 1: `create-post.use-case.ts` 작성**

```typescript
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';

export interface CreatePostInput {
  userId: string;
  buildingId: string;
  category?: PostCategory;
  title: string;
  content: string;
}

@Injectable()
export class CreatePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
  ) {}

  async execute(input: CreatePostInput): Promise<Post> {
    const ok = await this.membership.isMember(input.userId, input.buildingId);
    if (!ok) throw new ForbiddenException('not a building member');

    const post = Post.create({
      buildingId: input.buildingId,
      authorId: input.userId,
      category: input.category,
      title: input.title,
      content: input.content,
    });
    const saved = await this.posts.create(post);
    await this.cache.invalidateList(input.buildingId);
    return saved;
  }
}
```

- [ ] **Step 2: 실패 테스트 작성 — ListPosts read-through**

`src/board/application/list-posts.use-case.spec.ts`:
```typescript
import { ForbiddenException } from '@nestjs/common';
import { ListPostsUseCase } from './list-posts.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache, PostSummary } from './board-cache';
import { MembershipChecker } from './membership';

const BUILDING_ID = 'b1';
const USER_ID = 'u1';

function membershipReturning(value: boolean): MembershipChecker {
  return { isMember: () => Promise.resolve(value) };
}

const samplePost = Post.reconstitute({
  id: 'p1',
  buildingId: BUILDING_ID,
  authorId: USER_ID,
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

function repoWithPosts(posts: Post[]): PostRepository {
  return {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(null),
    findByBuilding: () => Promise.resolve(posts),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
}

class FakeCache implements BoardCache {
  public list: PostSummary[] | null = null;
  public setListCalls = 0;
  getList() {
    return Promise.resolve(this.list);
  }
  setList(_b: string, posts: PostSummary[]) {
    this.setListCalls += 1;
    this.list = posts;
    return Promise.resolve();
  }
  getDetail() {
    return Promise.resolve(null);
  }
  setDetail() {
    return Promise.resolve();
  }
  invalidateList() {
    return Promise.resolve();
  }
  invalidateDetail() {
    return Promise.resolve();
  }
}

describe('ListPostsUseCase', () => {
  it('캐시 miss면 repo를 조회하고 캐시에 채운다', async () => {
    const cache = new FakeCache();
    const repo = repoWithPosts([samplePost]);
    const useCase = new ListPostsUseCase(repo, cache, membershipReturning(true));

    const result = await useCase.execute({ userId: USER_ID, buildingId: BUILDING_ID });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
    expect(cache.setListCalls).toBe(1);
  });

  it('캐시 hit이면 repo를 건너뛰고 캐시 값을 반환한다', async () => {
    const cache = new FakeCache();
    cache.list = [{ id: 'cached', category: PostCategory.FREE, title: 'c', authorId: 'x' }];
    const repo = repoWithPosts([samplePost]);
    const findSpy = jest.spyOn(repo, 'findByBuilding');
    const useCase = new ListPostsUseCase(repo, cache, membershipReturning(true));

    const result = await useCase.execute({ userId: USER_ID, buildingId: BUILDING_ID });

    expect(result[0].id).toBe('cached');
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('멤버가 아니면 ForbiddenException', async () => {
    const useCase = new ListPostsUseCase(
      repoWithPosts([]),
      new FakeCache(),
      membershipReturning(false),
    );

    await expect(
      useCase.execute({ userId: USER_ID, buildingId: BUILDING_ID }),
    ).rejects.toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/board/application/list-posts.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 4: `list-posts.use-case.ts` 작성**

```typescript
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache, PostSummary } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';

export interface ListPostsInput {
  userId: string;
  buildingId: string;
}

@Injectable()
export class ListPostsUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
  ) {}

  async execute(input: ListPostsInput): Promise<PostSummary[]> {
    const ok = await this.membership.isMember(input.userId, input.buildingId);
    if (!ok) throw new ForbiddenException('not a building member');

    const cached = await this.cache.getList(input.buildingId);
    if (cached) return cached;

    const posts = await this.posts.findByBuilding(input.buildingId);
    const summaries: PostSummary[] = posts.map((p) => ({
      id: p.id!,
      category: p.category,
      title: p.title,
      authorId: p.authorId,
    }));
    await this.cache.setList(input.buildingId, summaries);
    return summaries;
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/board/application/list-posts.use-case.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add src/board/application/create-post.use-case.ts src/board/application/list-posts.use-case.ts src/board/application/list-posts.use-case.spec.ts
git commit -m "[M2]feat: CreatePost/ListPosts 유스케이스 추가 (멤버십, read-through 캐시)"
```

---

## Task 6: GetPost 유스케이스 (상세 캐시 + 댓글)

**Files:** Create `get-post.use-case.ts`, Test `get-post.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — GetPost 캐시/멤버십/404**

`src/board/application/get-post.use-case.spec.ts`:
```typescript
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GetPostUseCase } from './get-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { CommentRepository } from '../domain/comment.repository';
import { Comment } from '../domain/comment.entity';
import { BoardCache, PostDetail } from './board-cache';
import { MembershipChecker } from './membership';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const USER_ID = 'u1';

function membershipReturning(value: boolean): MembershipChecker {
  return { isMember: () => Promise.resolve(value) };
}

function postRepoWith(post: Post | null): PostRepository {
  return {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(post),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
}

const commentRepo: CommentRepository = {
  create: (c) => Promise.resolve(c),
  findByPost: () =>
    Promise.resolve([
      Comment.reconstitute({ id: 'c1', postId: POST_ID, authorId: 'u2', content: '댓글' }),
    ]),
};

class FakeCache implements BoardCache {
  public detail: PostDetail | null = null;
  public setDetailCalls = 0;
  getList() {
    return Promise.resolve(null);
  }
  setList() {
    return Promise.resolve();
  }
  getDetail() {
    return Promise.resolve(this.detail);
  }
  setDetail(_p: string, detail: PostDetail) {
    this.setDetailCalls += 1;
    this.detail = detail;
    return Promise.resolve();
  }
  invalidateList() {
    return Promise.resolve();
  }
  invalidateDetail() {
    return Promise.resolve();
  }
}

const samplePost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: USER_ID,
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

describe('GetPostUseCase', () => {
  it('캐시 miss면 글+댓글을 모아 상세를 만들고 캐시에 채운다', async () => {
    const cache = new FakeCache();
    const useCase = new GetPostUseCase(
      postRepoWith(samplePost),
      commentRepo,
      cache,
      membershipReturning(true),
    );

    const detail = await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(detail.id).toBe(POST_ID);
    expect(detail.comments).toHaveLength(1);
    expect(cache.setDetailCalls).toBe(1);
  });

  it('없는 글이면 NotFoundException', async () => {
    const useCase = new GetPostUseCase(
      postRepoWith(null),
      commentRepo,
      new FakeCache(),
      membershipReturning(true),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  it('멤버가 아니면 ForbiddenException', async () => {
    const useCase = new GetPostUseCase(
      postRepoWith(samplePost),
      commentRepo,
      new FakeCache(),
      membershipReturning(false),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/board/application/get-post.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `get-post.use-case.ts` 작성**

```typescript
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { COMMENT_REPOSITORY, CommentRepository } from '../domain/comment.repository';
import { BOARD_CACHE, BoardCache, PostDetail } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';

export interface GetPostInput {
  userId: string;
  postId: string;
}

@Injectable()
export class GetPostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
  ) {}

  async execute(input: GetPostInput): Promise<PostDetail> {
    const cached = await this.cache.getDetail(input.postId);
    if (cached) {
      await this.authorize(input.userId, cached.buildingId);
      return cached;
    }

    const post = await this.posts.findById(input.postId);
    if (!post) throw new NotFoundException('post not found');
    await this.authorize(input.userId, post.buildingId);

    const comments = await this.comments.findByPost(input.postId);
    const detail: PostDetail = {
      id: post.id!,
      buildingId: post.buildingId,
      category: post.category,
      title: post.title,
      content: post.content,
      authorId: post.authorId,
      comments: comments.map((c) => ({
        id: c.id!,
        authorId: c.authorId,
        content: c.content,
      })),
    };
    await this.cache.setDetail(input.postId, detail);
    return detail;
  }

  private async authorize(userId: string, buildingId: string): Promise<void> {
    const ok = await this.membership.isMember(userId, buildingId);
    if (!ok) throw new ForbiddenException('not a building member');
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/board/application/get-post.use-case.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/board/application/get-post.use-case.ts src/board/application/get-post.use-case.spec.ts
git commit -m "[M2]feat: GetPost 유스케이스 추가 (상세 캐시 + 댓글)"
```

---

## Task 7: UpdatePost + DeletePost 유스케이스 (작성자 + 무효화)

**Files:** Create `update-post.use-case.ts`, `delete-post.use-case.ts`, Test `update-post.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — UpdatePost 작성자 + 무효화**

`src/board/application/update-post.use-case.spec.ts`:
```typescript
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UpdatePostUseCase } from './update-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache } from './board-cache';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const AUTHOR_ID = 'author';

function postRepoWith(post: Post | null): PostRepository {
  return {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(post),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
}

class SpyCache implements BoardCache {
  public invalidatedDetail: string | null = null;
  public invalidatedList: string | null = null;
  getList() {
    return Promise.resolve(null);
  }
  setList() {
    return Promise.resolve();
  }
  getDetail() {
    return Promise.resolve(null);
  }
  setDetail() {
    return Promise.resolve();
  }
  invalidateList(buildingId: string) {
    this.invalidatedList = buildingId;
    return Promise.resolve();
  }
  invalidateDetail(postId: string) {
    this.invalidatedDetail = postId;
    return Promise.resolve();
  }
}

const ownedPost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: AUTHOR_ID,
  category: PostCategory.FREE,
  title: '원래',
  content: '원래본문',
});

describe('UpdatePostUseCase', () => {
  it('작성자가 수정하면 저장하고 상세·목록 캐시를 무효화한다', async () => {
    const cache = new SpyCache();
    const useCase = new UpdatePostUseCase(postRepoWith(ownedPost), cache);

    const updated = await useCase.execute({
      userId: AUTHOR_ID,
      postId: POST_ID,
      title: '수정',
      content: '수정본문',
    });

    expect(updated.title).toBe('수정');
    expect(cache.invalidatedDetail).toBe(POST_ID);
    expect(cache.invalidatedList).toBe(BUILDING_ID);
  });

  it('작성자가 아니면 ForbiddenException', async () => {
    const useCase = new UpdatePostUseCase(postRepoWith(ownedPost), new SpyCache());

    await expect(
      useCase.execute({ userId: 'other', postId: POST_ID, title: 't', content: 'c' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('없는 글이면 NotFoundException', async () => {
    const useCase = new UpdatePostUseCase(postRepoWith(null), new SpyCache());

    await expect(
      useCase.execute({ userId: AUTHOR_ID, postId: POST_ID, title: 't', content: 'c' }),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/board/application/update-post.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `update-post.use-case.ts` 작성**

```typescript
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Post } from '../domain/post.entity';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';

export interface UpdatePostInput {
  userId: string;
  postId: string;
  title: string;
  content: string;
}

@Injectable()
export class UpdatePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
  ) {}

  async execute(input: UpdatePostInput): Promise<Post> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new NotFoundException('post not found');
    if (!post.isAuthoredBy(input.userId)) {
      throw new ForbiddenException('not the author');
    }
    const updated = await this.posts.update(
      post.edit({ title: input.title, content: input.content }),
    );
    await this.cache.invalidateDetail(input.postId);
    await this.cache.invalidateList(post.buildingId);
    return updated;
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/board/application/update-post.use-case.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: `delete-post.use-case.ts` 작성**

```typescript
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';

export interface DeletePostInput {
  userId: string;
  postId: string;
}

@Injectable()
export class DeletePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
  ) {}

  async execute(input: DeletePostInput): Promise<void> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new NotFoundException('post not found');
    if (!post.isAuthoredBy(input.userId)) {
      throw new ForbiddenException('not the author');
    }
    await this.posts.delete(input.postId);
    await this.cache.invalidateDetail(input.postId);
    await this.cache.invalidateList(post.buildingId);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/board/application/update-post.use-case.ts src/board/application/delete-post.use-case.ts src/board/application/update-post.use-case.spec.ts
git commit -m "[M2]feat: UpdatePost/DeletePost 유스케이스 추가 (작성자 검사 + 캐시 무효화)"
```

---

## Task 8: CreateComment 유스케이스 (멤버십 + 상세 무효화)

**Files:** Create `create-comment.use-case.ts`, Test `create-comment.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성**

`src/board/application/create-comment.use-case.spec.ts`:
```typescript
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CreateCommentUseCase } from './create-comment.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { Comment } from '../domain/comment.entity';
import { PostRepository } from '../domain/post.repository';
import { CommentRepository } from '../domain/comment.repository';
import { BoardCache } from './board-cache';
import { MembershipChecker } from './membership';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const USER_ID = 'u1';

function membershipReturning(value: boolean): MembershipChecker {
  return { isMember: () => Promise.resolve(value) };
}

function postRepoWith(post: Post | null): PostRepository {
  return {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(post),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
}

const commentRepo: CommentRepository = {
  create: (c) =>
    Promise.resolve(
      Comment.reconstitute({
        id: 'c-generated',
        postId: c.postId,
        authorId: c.authorId,
        content: c.content,
      }),
    ),
  findByPost: () => Promise.resolve([]),
};

class SpyCache implements BoardCache {
  public invalidatedDetail: string | null = null;
  getList() {
    return Promise.resolve(null);
  }
  setList() {
    return Promise.resolve();
  }
  getDetail() {
    return Promise.resolve(null);
  }
  setDetail() {
    return Promise.resolve();
  }
  invalidateList() {
    return Promise.resolve();
  }
  invalidateDetail(postId: string) {
    this.invalidatedDetail = postId;
    return Promise.resolve();
  }
}

const samplePost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: 'author',
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

describe('CreateCommentUseCase', () => {
  it('멤버가 댓글을 달면 저장하고 상세 캐시를 무효화한다', async () => {
    const cache = new SpyCache();
    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(samplePost),
      cache,
      membershipReturning(true),
    );

    const comment = await useCase.execute({
      userId: USER_ID,
      postId: POST_ID,
      content: '댓글',
    });

    expect(comment.id).toBe('c-generated');
    expect(cache.invalidatedDetail).toBe(POST_ID);
  });

  it('없는 글이면 NotFoundException', async () => {
    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(null),
      new SpyCache(),
      membershipReturning(true),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID, content: '댓글' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('멤버가 아니면 ForbiddenException', async () => {
    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(samplePost),
      new SpyCache(),
      membershipReturning(false),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID, content: '댓글' }),
    ).rejects.toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/board/application/create-comment.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `create-comment.use-case.ts` 작성**

```typescript
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Comment } from '../domain/comment.entity';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { COMMENT_REPOSITORY, CommentRepository } from '../domain/comment.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';

export interface CreateCommentInput {
  userId: string;
  postId: string;
  content: string;
}

@Injectable()
export class CreateCommentUseCase {
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
  ) {}

  async execute(input: CreateCommentInput): Promise<Comment> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new NotFoundException('post not found');
    const ok = await this.membership.isMember(input.userId, post.buildingId);
    if (!ok) throw new ForbiddenException('not a building member');

    const saved = await this.comments.create(
      Comment.create({
        postId: input.postId,
        authorId: input.userId,
        content: input.content,
      }),
    );
    await this.cache.invalidateDetail(input.postId);
    return saved;
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/board/application/create-comment.use-case.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/board/application/create-comment.use-case.ts src/board/application/create-comment.use-case.spec.ts
git commit -m "[M2]feat: CreateComment 유스케이스 추가 (멤버십 + 상세 캐시 무효화)"
```

---

## Task 9: 인터페이스 레이어 (DTO·컨트롤러) + 모듈 조립

**Files:** Create `dto/create-post.dto.ts`, `dto/update-post.dto.ts`, `dto/create-comment.dto.ts`, `board.controller.ts` (모두 `src/board/interface/`), `src/board/board.module.ts`. Modify `src/app.module.ts`.

- [ ] **Step 1: DTO 3종 작성**

`src/board/interface/dto/create-post.dto.ts`:
```typescript
import { IsEnum, IsNotEmpty, IsOptional } from 'class-validator';
import { PostCategory } from '../../domain/post-category.enum';

export class CreatePostDto {
  @IsOptional()
  @IsEnum(PostCategory)
  category?: PostCategory;

  @IsNotEmpty()
  title: string;

  @IsNotEmpty()
  content: string;
}
```

`src/board/interface/dto/update-post.dto.ts`:
```typescript
import { IsNotEmpty } from 'class-validator';

export class UpdatePostDto {
  @IsNotEmpty()
  title: string;

  @IsNotEmpty()
  content: string;
}
```

`src/board/interface/dto/create-comment.dto.ts`:
```typescript
import { IsNotEmpty } from 'class-validator';

export class CreateCommentDto {
  @IsNotEmpty()
  content: string;
}
```

- [ ] **Step 2: `board.controller.ts` 작성**

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { CreatePostUseCase } from '../application/create-post.use-case';
import { ListPostsUseCase } from '../application/list-posts.use-case';
import { GetPostUseCase } from '../application/get-post.use-case';
import { UpdatePostUseCase } from '../application/update-post.use-case';
import { DeletePostUseCase } from '../application/delete-post.use-case';
import { CreateCommentUseCase } from '../application/create-comment.use-case';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class BoardController {
  constructor(
    private readonly createPost: CreatePostUseCase,
    private readonly listPosts: ListPostsUseCase,
    private readonly getPost: GetPostUseCase,
    private readonly updatePost: UpdatePostUseCase,
    private readonly deletePost: DeletePostUseCase,
    private readonly createComment: CreateCommentUseCase,
  ) {}

  @Post('buildings/:buildingId/posts')
  async createPostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
    @Body() dto: CreatePostDto,
  ) {
    const post = await this.createPost.execute({
      userId: user.sub,
      buildingId,
      category: dto.category,
      title: dto.title,
      content: dto.content,
    });
    return {
      id: post.id,
      buildingId: post.buildingId,
      category: post.category,
      title: post.title,
    };
  }

  @Get('buildings/:buildingId/posts')
  listPostsHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
  ) {
    return this.listPosts.execute({ userId: user.sub, buildingId });
  }

  @Get('posts/:postId')
  getPostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
  ) {
    return this.getPost.execute({ userId: user.sub, postId });
  }

  @Patch('posts/:postId')
  async updatePostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
    @Body() dto: UpdatePostDto,
  ) {
    const post = await this.updatePost.execute({
      userId: user.sub,
      postId,
      title: dto.title,
      content: dto.content,
    });
    return { id: post.id, title: post.title, content: post.content };
  }

  @Delete('posts/:postId')
  @HttpCode(204)
  async deletePostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
  ): Promise<void> {
    await this.deletePost.execute({ userId: user.sub, postId });
  }

  @Post('posts/:postId/comments')
  async createCommentHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
    @Body() dto: CreateCommentDto,
  ) {
    const comment = await this.createComment.execute({
      userId: user.sub,
      postId,
      content: dto.content,
    });
    return { id: comment.id, postId: comment.postId, content: comment.content };
  }
}
```

- [ ] **Step 3: `board.module.ts` 작성 (DI 바인딩)**

```typescript
import { Module } from '@nestjs/common';
import { BoardController } from './interface/board.controller';
import { CreatePostUseCase } from './application/create-post.use-case';
import { ListPostsUseCase } from './application/list-posts.use-case';
import { GetPostUseCase } from './application/get-post.use-case';
import { UpdatePostUseCase } from './application/update-post.use-case';
import { DeletePostUseCase } from './application/delete-post.use-case';
import { CreateCommentUseCase } from './application/create-comment.use-case';
import { POST_REPOSITORY } from './domain/post.repository';
import { COMMENT_REPOSITORY } from './domain/comment.repository';
import { BOARD_CACHE } from './application/board-cache';
import { MEMBERSHIP_CHECKER } from './application/membership';
import { PrismaPostRepository } from './infrastructure/prisma-post.repository';
import { PrismaCommentRepository } from './infrastructure/prisma-comment.repository';
import { RedisBoardCache } from './infrastructure/redis-board-cache';
import { PrismaMembershipChecker } from './infrastructure/prisma-membership.checker';

@Module({
  controllers: [BoardController],
  providers: [
    CreatePostUseCase,
    ListPostsUseCase,
    GetPostUseCase,
    UpdatePostUseCase,
    DeletePostUseCase,
    CreateCommentUseCase,
    { provide: POST_REPOSITORY, useClass: PrismaPostRepository },
    { provide: COMMENT_REPOSITORY, useClass: PrismaCommentRepository },
    { provide: BOARD_CACHE, useClass: RedisBoardCache },
    { provide: MEMBERSHIP_CHECKER, useClass: PrismaMembershipChecker },
  ],
})
export class BoardModule {}
```

- [ ] **Step 4: `src/app.module.ts` 수정 (BoardModule 등록)**

imports 배열에 `BoardModule`을 추가한다(기존 ConfigModule·PrismaModule·RedisModule·AuthModule·PropertyModule 유지).

- [ ] **Step 5: 빌드 + 전체 단위 테스트 통과 확인**

Run:
```bash
npx tsc --noEmit && npx jest
```
Expected: 컴파일 에러 없음, M0~M2 단위 테스트 전부 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/board/interface src/board/board.module.ts src/app.module.ts
git commit -m "[M2]feat: Board 인터페이스 레이어(컨트롤러, DTO) 및 모듈 조립"
```

---

## Task 10: e2e — CRUD + 캐시 hit/무효화 + 멤버십/작성자

**Files:** Create `test/board.e2e-spec.ts`.

> **선행:** `docker compose up -d`로 Postgres·Redis 기동 + 마이그레이션 적용. e2e는 실제 DB·Redis를 쓰므로 정리 로직을 둔다. 캐시 검증은 `app.get(RedisService)`로 키 존재 여부(`exists`)를 직접 확인한다.

- [ ] **Step 1: 실패 e2e 테스트 작성**

`test/board.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

describe('Board (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  const ownerEmail = `bowner_${Date.now()}@test.com`;
  const tenantEmail = `btenant_${Date.now()}@test.com`;
  const outsiderEmail = `bout_${Date.now()}@test.com`;
  let ownerToken: string;
  let tenantToken: string;
  let outsiderToken: string;
  let buildingId: string;

  async function signup(email: string): Promise<void> {
    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({ email, name: '사용자', password: 'pw123456' })
      .expect(201);
  }
  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ email, password: 'pw123456' })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await app.init();

    await signup(ownerEmail);
    await signup(tenantEmail);
    await signup(outsiderEmail);
    await prisma.user.update({ where: { email: ownerEmail }, data: { role: 'OWNER' } });
    ownerToken = await login(ownerEmail);
    tenantToken = await login(tenantEmail);
    outsiderToken = await login(outsiderEmail);

    // owner가 건물·호실 생성 후 tenant를 입주자로 연결(멤버 자격 확보)
    const building = await request(app.getHttpServer() as App)
      .post('/buildings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '래미안', address: '서울' })
      .expect(201);
    buildingId = (building.body as { id: string }).id;

    const unit = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '101호', floor: 1 })
      .expect(201);
    const unitId = (unit.body as { id: string }).id;

    const invite = await request(app.getHttpServer() as App)
      .post(`/units/${unitId}/invite-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);
    const code = (invite.body as { code: string }).code;

    await request(app.getHttpServer() as App)
      .post('/invite-codes/redeem')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ code })
      .expect(201);
  });

  afterAll(async () => {
    const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (owner) {
      const buildings = await prisma.building.findMany({
        where: { ownerId: owner.id },
        select: { id: true },
      });
      const buildingIds = buildings.map((b) => b.id);
      const posts = await prisma.post.findMany({
        where: { buildingId: { in: buildingIds } },
        select: { id: true },
      });
      const postIds = posts.map((p) => p.id);
      await prisma.comment.deleteMany({ where: { postId: { in: postIds } } });
      await prisma.post.deleteMany({ where: { id: { in: postIds } } });
      const units = await prisma.unit.findMany({
        where: { buildingId: { in: buildingIds } },
        select: { id: true },
      });
      const unitIds = units.map((u) => u.id);
      await prisma.lease.deleteMany({ where: { unitId: { in: unitIds } } });
      await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
      await prisma.building.deleteMany({ where: { id: { in: buildingIds } } });
    }
    await prisma.user.deleteMany({
      where: { email: { in: [ownerEmail, tenantEmail, outsiderEmail] } },
    });
    await app.close();
  });

  it('멤버가 글 작성→목록(캐시 set)→새 글 작성 시 목록 캐시 무효화', async () => {
    const created = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '첫 글', content: '본문' })
      .expect(201);
    const postId = (created.body as { id: string }).id;
    expect(typeof postId).toBe('string');

    await request(app.getHttpServer() as App)
      .get(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200)
      .expect((res) => expect((res.body as unknown[]).length).toBeGreaterThan(0));

    // 목록 GET 후 캐시 키가 존재
    expect(await redis.exists(`board:list:${buildingId}`)).toBe(1);

    // 새 글 작성 → 목록 캐시 무효화
    await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '둘째 글', content: '본문2' })
      .expect(201);
    expect(await redis.exists(`board:list:${buildingId}`)).toBe(0);
  });

  it('상세 GET(캐시 set) 후 댓글 작성 시 상세 캐시 무효화', async () => {
    const created = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '댓글대상', content: '본문' })
      .expect(201);
    const postId = (created.body as { id: string }).id;

    await request(app.getHttpServer() as App)
      .get(`/posts/${postId}`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200);
    expect(await redis.exists(`board:detail:${postId}`)).toBe(1);

    await request(app.getHttpServer() as App)
      .post(`/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ content: '첫 댓글' })
      .expect(201);
    expect(await redis.exists(`board:detail:${postId}`)).toBe(0);

    // 다시 상세 조회하면 댓글이 포함됨
    await request(app.getHttpServer() as App)
      .get(`/posts/${postId}`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200)
      .expect((res) => {
        const body = res.body as { comments: unknown[] };
        expect(body.comments.length).toBe(1);
      });
  });

  it('비멤버(outsider)는 목록 조회·작성 모두 403', async () => {
    await request(app.getHttpServer() as App)
      .get(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .expect(403);

    await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ title: '무단', content: '본문' })
      .expect(403);
  });

  it('작성자가 아닌 멤버는 수정 403, 작성자는 수정 200', async () => {
    const created = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '소유글', content: '본문' })
      .expect(201);
    const postId = (created.body as { id: string }).id;

    // owner도 멤버지만 작성자가 아님 → 403
    await request(app.getHttpServer() as App)
      .patch(`/posts/${postId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '침범', content: 'x' })
      .expect(403);

    // 작성자(tenant)는 수정 가능
    await request(app.getHttpServer() as App)
      .patch(`/posts/${postId}`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '수정됨', content: '수정본문' })
      .expect(200)
      .expect((res) => expect((res.body as { title: string }).title).toBe('수정됨'));
  });
});
```

- [ ] **Step 2: 인프라 확인 후 e2e 실행**

Run:
```bash
docker compose up -d
npx jest --config ./test/jest-e2e.json
```
Expected: auth·property·board e2e 전부 통과. 연결 에러 시 `.env`·마이그레이션 점검.

- [ ] **Step 3: Commit**

```bash
git add test/board.e2e-spec.ts
git commit -m "[M2]test: Board e2e 추가 (CRUD, 캐시 set/무효화, 멤버십/작성자 인가)"
```

---

## Task 11: RedisService Lua 스크립트 실행 지원 (분산 원자 연산 기반)

> 게시판 캐시(Task 4)의 read-through stale-set 레이스는 DB 조회가 끼어 단일 스크립트로 못 막으므로 TTL 안전망으로 수용한다. 대신 *여러 Redis 명령을 원자로 묶어야 하는* 진짜 원자 연산(M5 미읽음 카운터, M6 레이트리밋)을 위해 `RedisService`에 Lua 스크립트 실행 기반을 마련한다. **M2에서 이를 소비하는 기능은 없다(의도적 기반 작업).** EVALSHA로 실행하고 스크립트 캐시가 비워진 경우(`NOSCRIPT`, 페일오버·`SCRIPT FLUSH`) EVAL로 재적재한다.

**Files:**
- Modify: `src/redis/redis.service.ts` (runScript 추가)
- Test: `test/redis-script.e2e-spec.ts` (실제 Redis 통합 — e2e 설정으로 실행. 단위 `npx jest`는 외부 의존 없이 유지)

- [ ] **Step 1: 실패 통합 테스트 작성**

`test/redis-script.e2e-spec.ts`:
```typescript
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/redis/redis.service';

describe('RedisService.runScript (integration)', () => {
  let redis: RedisService;
  const key = `test:script:${Date.now()}`;

  beforeAll(() => {
    redis = new RedisService(
      new ConfigService({
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      }),
    );
  });

  afterAll(async () => {
    await redis.del(key);
    await redis.quit();
  });

  it('Lua 스크립트를 원자 실행한다 (INCR + 최초 1회만 EXPIRE)', async () => {
    const lua = `
      local n = redis.call('INCR', KEYS[1])
      if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      return n
    `;

    const first = await redis.runScript<number>(lua, [key], [60]);
    const second = await redis.runScript<number>(lua, [key], [60]);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run:
```bash
docker compose up -d
npx jest --config ./test/jest-e2e.json test/redis-script.e2e-spec.ts
```
Expected: FAIL — `redis.runScript is not a function`.

- [ ] **Step 3: `redis.service.ts`에 runScript 추가**

`src/redis/redis.service.ts` 전체를 다음으로 교체:
```typescript
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ConfigKey } from '../config/config-keys';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  // Lua 본문 → SHA 캐시 (EVALSHA로 매번 스크립트 본문 전송 회피)
  private readonly scriptShas = new Map<string, string>();

  constructor(config: ConfigService) {
    super(config.getOrThrow<string>(ConfigKey.RedisUrl));
    this.on('error', (err: Error) =>
      this.logger.warn(`Redis error: ${err.message}`),
    );
  }

  /**
   * Lua 스크립트를 서버측에서 원자 실행한다(분산 환경 안전).
   * EVALSHA로 실행하고, 스크립트 캐시가 없으면(NOSCRIPT) EVAL로 재적재한다.
   */
  async runScript<T = unknown>(
    lua: string,
    keys: string[],
    args: (string | number)[] = [],
  ): Promise<T> {
    let sha = this.scriptShas.get(lua);
    if (!sha) {
      sha = (await this.script('LOAD', lua)) as string;
      this.scriptShas.set(lua, sha);
    }
    try {
      return (await this.evalsha(sha, keys.length, ...keys, ...args)) as T;
    } catch (err) {
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        this.scriptShas.delete(lua);
        return (await this.eval(lua, keys.length, ...keys, ...args)) as T;
      }
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run:
```bash
npx jest --config ./test/jest-e2e.json test/redis-script.e2e-spec.ts
```
Expected: PASS (1 passed). 첫 실행은 1, 둘째는 2, TTL > 0.

- [ ] **Step 5: Commit**

```bash
git add src/redis/redis.service.ts test/redis-script.e2e-spec.ts
git commit -m "[M2]feat: RedisService에 Lua 스크립트 실행(runScript) 지원 추가 (분산 원자 연산 기반)"
```

---

## Task 12: M2 마무리 검증 & README 상태 갱신

**Files:** Modify `README.md`.

- [ ] **Step 1: 전체 검증 (lint·단위·e2e)**

Run:
```bash
npm run lint && npx jest && npx jest --config ./test/jest-e2e.json
```
Expected: lint 0 errors, 모든 단위·e2e PASS.

- [ ] **Step 2: 수동 동작 확인 (캐시 hit/무효화 눈으로 확인)**

`npm run start:dev` 후: (M1 방식으로 owner/입주자 셋업) 멤버 토큰으로
1. `POST /buildings/:id/posts` → 글 작성
2. `GET /buildings/:id/posts` → 목록
3. `docker compose exec redis redis-cli exists board:list:<buildingId>` → `1`(캐시됨)
4. 글 하나 더 작성 후 같은 명령 → `0`(무효화됨)

- [ ] **Step 3: README M2 상태 한 줄 갱신** — 마일스톤 표 M2 행에 ✅ 표기 추가.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "[M2]docs: 마일스톤 표에 M2 완료 표기"
```

---

## M2 완료 기준 (Definition of Done)

- [ ] `prisma migrate dev`로 `Post`·`Comment` 테이블 + 관계 생성됨(댓글은 글 삭제 시 cascade)
- [ ] 멤버가 글 작성/목록/상세/수정/삭제 + 댓글 작성 가능
- [ ] 목록(`board:list:{id}`)·상세(`board:detail:{id}`)가 **read-through로 캐시**되고, TTL 안전망이 걸림
- [ ] **쓰기 시 무효화**: 글 작성→목록, 수정/삭제→상세+목록, 댓글→상세 키가 `DEL`됨 (e2e에서 `redis exists`로 검증)
- [ ] **멤버십 인가**: 비멤버는 읽기/작성 403
- [ ] **작성자 인가**: 작성자 아닌 사용자의 글 수정/삭제 403
- [ ] `RedisService.runScript`(EVALSHA + NOSCRIPT 폴백)가 추가되고 통합 테스트(원자 INCR+EXPIRE) 통과 — 분산 원자 연산 기반 마련(M5/M6 소비 예정)
- [ ] 단위(엔티티·유스케이스: read-through hit/miss, 무효화 spy) + e2e 전부 통과, lint 0 errors
- [ ] 도메인/애플리케이션 레이어가 Prisma·ioredis를 직접 import 하지 않음(의존성 역전 유지)

---

## Self-Review 결과

- **스펙 커버리지:** M2 스펙("게시판 CRUD + Redis 캐싱", 검증="목록/상세 캐시 hit, 쓰기 시 무효화 확인", 학습="캐시 무효화 패턴") → Task 1(Post/Comment 스키마), Task 4·5·6(read-through 캐시), Task 5·7·8(무효화), Task 10(캐시 hit/무효화 e2e)로 전부 커버. 스펙 3.1(건물 단위·read-through·쓰기 무효화·TTL 안전망), 5.3(Board는 얇은 레이어), 6절(앱 계층 인가) 반영.
- **분산 환경/Lua 결정:** 멀티 인스턴스 read-through stale-set 레이스는 DB 조회가 끼어 단일 Lua로 못 막으므로 TTL 안전망으로 수용(과설계 회피). 진짜 원자 연산이 필요한 곳을 위해 `RedisService.runScript`(EVALSHA+폴백) 기반만 Task 11에서 마련하고, 실제 Lua 스크립트는 M5(카운터)·M6(레이트리밋)에서 작성한다. M2 기능은 이를 소비하지 않음.
- **범위 밖(의도적):** ① `PostCreated`/`CommentCreated` 도메인 이벤트 발행 → Kafka 도입(M3) 후. ② category 역할 게이팅(NOTICE를 건물주만) → 추후. ③ rate limit(쓰기 엔드포인트) → M6. ④ 글 모더레이션(건물주가 남의 글 삭제) → 추후.
- **타입 일관성:** 캐시 포트 메서드(`getList/setList/getDetail/setDetail/invalidateList/invalidateDetail`)가 정의(`board-cache.ts`)·구현(`RedisBoardCache`)·유스케이스·테스트 fake에서 동일. 읽기모델(`PostSummary`·`PostDetail`·`CommentView`)이 캐시·유스케이스·컨트롤러 응답에서 일관. 리포지토리 토큰(`POST_REPOSITORY`·`COMMENT_REPOSITORY`)·포트 토큰(`BOARD_CACHE`·`MEMBERSHIP_CHECKER`)이 정의 ↔ 모듈 바인딩 ↔ 주입에서 일치. `Post.edit`/`isAuthoredBy` 시그니처가 use-case·test에서 일치.
- **M0~M1 학습 반영:** 테스트 가짜는 `Promise.resolve` 반환(require-await 회피), e2e는 `getHttpServer() as App`·`res.body as {...}` 캐스팅(no-unsafe-* 회피)으로 작성해 lint 0 errors 선제 보장. env 키 하드코딩 없음(이 컨텍스트는 ConfigService 미사용).
```
