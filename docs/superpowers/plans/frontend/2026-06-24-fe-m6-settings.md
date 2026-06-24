# FE-M6 설정·프로필 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 프로필(이름·이메일·역할)을 보고, 이름·비밀번호를 바꾸고, 로그아웃하는 설정 화면.

**Architecture:** BE는 `/auth/me`(토큰)는 두고, 설정 전용 DB 기반 `GET/PATCH /auth/profile`·`PATCH /auth/password`를 추가. User 엔티티는 불변이라 `rename`/`changePassword`가 새 인스턴스를 반환. FE는 `(app)/settings` 페이지에 프로필 표시 + 이름 폼 + 비번 폼 + 로그아웃을 두고, 헤더 아바타를 설정 링크로 연결.

**Tech Stack:** NestJS·Prisma·Jest(BE) / Next.js 16 App Router·React 19·react-hook-form·zod·Vitest(FE).

**스펙:** `docs/superpowers/specs/frontend/2026-06-24-fe-m6-settings-design.md`

## Global Constraints

- `.ts`/`.tsx`만. Server Component 기본, `"use client"`는 폼/버튼 등 상호작용에만.
- 매직 스트링 금지: 경로 `PAGE_ROUTES`/`API_ROUTES`, 문구 `MESSAGES`, 역할 `ROLE`/`ROLE_LABEL`(`lib/constants.ts`).
- 폼은 react-hook-form + zod(`lib/schemas.ts`) + `zodResolver`. 필드 에러는 `Field`의 `error`, 서버 에러는 폼 상단.
- `enum` 금지(FE, as const) / `as any` 금지 / index signature 금지. BE는 기존 `const`/DDD 패턴 따른다.
- BE Swagger 필수: 신규/변경 라우트에 `@ApiOperation`+성공 `@ApiResponse`, 4xx는 `ErrorResponseDto`. 요청 DTO 필드에 `@ApiProperty`.
- 테스트: BE `npm test`(Jest), FE `npm run test`(Vitest). lint: BE `npm run lint:check`, FE `npm run lint`. build: 각 `npm run build`.
- 레포: BE=`../estate-server`(현재 cwd 기준), FE=`estate-web`.
- 커밋 형식: `type: 내용`(feature/fix/refactor/test/docs).

**Before you start:** BE는 estate-server `feature/m6-settings`(이미 생성, origin/main 기준, 스펙 커밋 포함). FE는 estate-web `feature/fe-m6-settings`(origin/main 기준 — M5 머지 완료). Task 1~2(BE) 먼저, Task 3~5(FE).

---

### Task 1: (BE) 프로필 조회·이름 수정 — `GET/PATCH /auth/profile`

**레포: `../estate-server`** (branch `feature/m6-settings`)

**Files:**
- Modify: `src/auth/auth.errors.ts`
- Modify: `src/auth/domain/user.entity.ts`
- Modify: `src/auth/domain/user.repository.ts`
- Modify: `src/auth/infrastructure/prisma-user.repository.ts`
- Create: `src/auth/application/get-profile.use-case.ts`
- Create: `src/auth/application/update-profile.use-case.ts`
- Create: `src/auth/application/profile.use-cases.spec.ts`
- Create: `src/auth/interface/dto/profile.dto.ts`
- Modify: `src/auth/interface/auth.controller.ts`
- Modify: `src/auth/auth.module.ts`

**Interfaces:**
- Produces: `UserRepository.findById(id): Promise<User | null>`, `UserRepository.update(user): Promise<User>`
- Produces: `User.rename(name): User`
- Produces: `GetProfileUseCase.execute(userId): Promise<User>`, `UpdateProfileUseCase.execute(userId, name): Promise<User>`
- Produces (REST): `GET /auth/profile` → `{id, email, name, role}`, `PATCH /auth/profile` body `{name}` → `{id, email, name, role}`

- [ ] **Step 1: USER_NOT_FOUND 에러 추가** — `src/auth/auth.errors.ts`

`AuthError` 객체에 추가(`INVALID_ROLE` 뒤):
```ts
  USER_NOT_FOUND: {
    code: 'AUTH_USER_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '사용자를 찾을 수 없습니다.',
  },
```

- [ ] **Step 2: 엔티티 rename** — `src/auth/domain/user.entity.ts`

`get passwordHash()` getter 아래(클래스 내부)에 추가:
```ts
  // 불변: 이름만 바꾼 새 인스턴스를 반환한다.
  rename(name: string): User {
    if (!name) throw new DomainError('이름은 필수입니다.');
    return new User({ ...this.props, name });
  }
```

- [ ] **Step 3: 레포 포트 확장** — `src/auth/domain/user.repository.ts`

`UserRepository` 인터페이스에 추가:
```ts
  findById(id: string): Promise<User | null>;
  update(user: User): Promise<User>;
```

- [ ] **Step 4: Prisma 레포 구현** — `src/auth/infrastructure/prisma-user.repository.ts`

`findByEmail` 아래에 추가(`save`는 그대로 둔다):
```ts
  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) return null;
    return User.reconstitute({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      role: row.role as Role,
    });
  }

  async update(user: User): Promise<User> {
    const row = await this.prisma.user.update({
      where: { id: user.id! },
      data: { name: user.name, passwordHash: user.passwordHash },
    });
    return User.reconstitute({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      role: row.role as Role,
    });
  }
```

- [ ] **Step 5: 실패 테스트 작성** — `src/auth/application/profile.use-cases.spec.ts`

```ts
import { GetProfileUseCase } from './get-profile.use-case';
import { UpdateProfileUseCase } from './update-profile.use-case';
import { UserRepository } from '../domain/user.repository';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';

function sampleUser(name = '김철수'): User {
  return User.reconstitute({
    id: 'u1',
    email: 'a@b.com',
    name,
    passwordHash: 'hash',
    role: Role.TENANT,
  });
}

describe('프로필 유스케이스', () => {
  it('GetProfile: findById 결과를 반환', async () => {
    const repo: Partial<UserRepository> = {
      findById: () => Promise.resolve(sampleUser()),
    };
    const useCase = new GetProfileUseCase(repo as UserRepository);
    const user = await useCase.execute('u1');
    expect(user.name).toBe('김철수');
  });

  it('GetProfile: 없으면 USER_NOT_FOUND', async () => {
    const repo: Partial<UserRepository> = {
      findById: () => Promise.resolve(null),
    };
    const useCase = new GetProfileUseCase(repo as UserRepository);
    await expect(useCase.execute('u1')).rejects.toMatchObject({
      code: 'AUTH_USER_NOT_FOUND',
    });
  });

  it('UpdateProfile: 이름을 바꿔 update를 호출', async () => {
    const updated: string[] = [];
    const repo: Partial<UserRepository> = {
      findById: () => Promise.resolve(sampleUser()),
      update: (u) => {
        updated.push(u.name);
        return Promise.resolve(u);
      },
    };
    const useCase = new UpdateProfileUseCase(repo as UserRepository);
    const result = await useCase.execute('u1', '이영희');
    expect(result.name).toBe('이영희');
    expect(updated).toEqual(['이영희']);
  });
});
```

- [ ] **Step 6: 테스트 실패 확인**

Run: `cd ../estate-server && npm test -- profile.use-cases`
Expected: FAIL (use-case 모듈 없음)

- [ ] **Step 7: GetProfileUseCase** — `src/auth/application/get-profile.use-case.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import { User } from '../domain/user.entity';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';

@Injectable()
export class GetProfileUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async execute(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
    return user;
  }
}
```

- [ ] **Step 8: UpdateProfileUseCase** — `src/auth/application/update-profile.use-case.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import { User } from '../domain/user.entity';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';

@Injectable()
export class UpdateProfileUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async execute(userId: string, name: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
    return this.users.update(user.rename(name));
  }
}
```

- [ ] **Step 9: DTO** — `src/auth/interface/dto/profile.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';
import { Role } from '../../domain/role.enum';

export class UpdateProfileDto {
  @ApiProperty({ example: '김철수' })
  @IsNotEmpty()
  name: string;
}

export class ProfileResponseDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'a@b.com' }) email: string;
  @ApiProperty({ example: '김철수' }) name: string;
  @ApiProperty({ enum: Role, enumName: 'Role' }) role: Role;
}
```

- [ ] **Step 10: 컨트롤러 라우트** — `src/auth/interface/auth.controller.ts`

import 추가:
```ts
import { Body, Patch } from '@nestjs/common'; // 이미 있으면 생략, 없으면 병합
import { GetProfileUseCase } from '../application/get-profile.use-case';
import { UpdateProfileUseCase } from '../application/update-profile.use-case';
import { UpdateProfileDto, ProfileResponseDto } from './dto/profile.dto';
```
생성자에 주입 추가: `private readonly getProfile: GetProfileUseCase,` `private readonly updateProfile: UpdateProfileUseCase,`
`me()` 아래에 추가:
```ts
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '프로필 조회(DB, name 포함)' })
  @ApiResponse({ status: 200, type: ProfileResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto })
  async profile(@CurrentUser() user: TokenPayload): Promise<ProfileResponseDto> {
    const u = await this.getProfile.execute(user.sub);
    return { id: u.id!, email: u.email, name: u.name, role: u.role };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '프로필(이름) 수정' })
  @ApiResponse({ status: 200, type: ProfileResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto })
  async editProfile(
    @CurrentUser() user: TokenPayload,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    const u = await this.updateProfile.execute(user.sub, dto.name);
    return { id: u.id!, email: u.email, name: u.name, role: u.role };
  }
```

- [ ] **Step 11: 모듈 등록** — `src/auth/auth.module.ts`

import 추가 후 providers 배열에 `GetProfileUseCase,` `UpdateProfileUseCase,` 추가(`LoginUseCase,` 옆):
```ts
import { GetProfileUseCase } from './application/get-profile.use-case';
import { UpdateProfileUseCase } from './application/update-profile.use-case';
```

- [ ] **Step 12: 테스트·lint·build**

Run: `cd ../estate-server && npm test -- profile.use-cases && npm run lint:check && npm run build`
Expected: 3 PASS, lint 클린, build 성공.

- [ ] **Step 13: 커밋**

```bash
cd ../estate-server
git add src/auth/
git commit -m "feature: 프로필 조회·이름 수정(GET/PATCH /auth/profile)"
```

---

### Task 2: (BE) 비밀번호 변경 — `PATCH /auth/password`

**레포: `../estate-server`**

**Files:**
- Modify: `src/auth/domain/user.entity.ts`
- Create: `src/auth/application/change-password.use-case.ts`
- Create: `src/auth/application/change-password.use-case.spec.ts`
- Modify: `src/auth/interface/dto/profile.dto.ts`
- Modify: `src/auth/interface/auth.controller.ts`
- Modify: `src/auth/auth.module.ts`

**Interfaces:**
- Consumes: `UserRepository.findById/update`(Task 1), `PasswordHasher.compare/hash`, `AuthError.INVALID_CREDENTIALS/USER_NOT_FOUND`
- Produces: `User.changePassword(newHash): User`, `ChangePasswordUseCase.execute(userId, current, next): Promise<void>`
- Produces (REST): `PATCH /auth/password` body `{currentPassword, newPassword}` → `{ ok: true }`

- [ ] **Step 1: 엔티티 changePassword** — `src/auth/domain/user.entity.ts`

`rename` 메서드(Task 1) 아래에 추가:
```ts
  // 불변: 비밀번호 해시만 바꾼 새 인스턴스를 반환한다.
  changePassword(newHash: string): User {
    return new User({ ...this.props, passwordHash: newHash });
  }
```

- [ ] **Step 2: 실패 테스트 작성** — `src/auth/application/change-password.use-case.spec.ts`

```ts
import { ChangePasswordUseCase } from './change-password.use-case';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';

function user(): User {
  return User.reconstitute({
    id: 'u1',
    email: 'a@b.com',
    name: '김철수',
    passwordHash: 'OLD_HASH',
    role: Role.TENANT,
  });
}

function build(compareResult: boolean) {
  const updatedHashes: string[] = [];
  const users: Partial<UserRepository> = {
    findById: () => Promise.resolve(user()),
    update: (u) => {
      updatedHashes.push(u.passwordHash);
      return Promise.resolve(u);
    },
  };
  const hasher: Partial<PasswordHasher> = {
    compare: () => Promise.resolve(compareResult),
    hash: () => Promise.resolve('NEW_HASH'),
  };
  const useCase = new ChangePasswordUseCase(
    users as UserRepository,
    hasher as PasswordHasher,
  );
  return { useCase, updatedHashes };
}

describe('ChangePasswordUseCase', () => {
  it('현재 비번이 맞으면 새 해시로 update', async () => {
    const { useCase, updatedHashes } = build(true);
    await useCase.execute('u1', 'current', 'newpass12');
    expect(updatedHashes).toEqual(['NEW_HASH']);
  });

  it('현재 비번이 틀리면 INVALID_CREDENTIALS, update 안 함', async () => {
    const { useCase, updatedHashes } = build(false);
    await expect(useCase.execute('u1', 'wrong', 'newpass12')).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
    expect(updatedHashes).toEqual([]);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd ../estate-server && npm test -- change-password`
Expected: FAIL (use-case 없음)

- [ ] **Step 4: ChangePasswordUseCase** — `src/auth/application/change-password.use-case.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';

@Injectable()
export class ChangePasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async execute(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
    const ok = await this.hasher.compare(currentPassword, user.passwordHash);
    if (!ok) throw new AppException(AuthError.INVALID_CREDENTIALS);
    const newHash = await this.hasher.hash(newPassword);
    await this.users.update(user.changePassword(newHash));
  }
}
```

- [ ] **Step 5: DTO 추가** — `src/auth/interface/dto/profile.dto.ts`

import에 `MinLength` 추가(`IsNotEmpty`와 병합) 후 클래스 추가:
```ts
export class ChangePasswordDto {
  @ApiProperty()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @MinLength(8)
  newPassword: string;
}
```

- [ ] **Step 6: 컨트롤러 라우트** — `src/auth/interface/auth.controller.ts`

import에 `ChangePasswordUseCase`·`ChangePasswordDto` 추가, 생성자에 `private readonly changePassword: ChangePasswordUseCase,` 주입. `editProfile` 아래에 추가:
```ts
  @UseGuards(JwtAuthGuard)
  @Patch('password')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '비밀번호 변경' })
  @ApiResponse({ status: 200, description: '변경 완료' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: '현재 비밀번호 불일치/인증 필요' })
  async editPassword(
    @CurrentUser() user: TokenPayload,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    await this.changePassword.execute(user.sub, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }
```

- [ ] **Step 7: 모듈 등록** — `src/auth/auth.module.ts`

import 추가 후 providers에 `ChangePasswordUseCase,`:
```ts
import { ChangePasswordUseCase } from './application/change-password.use-case';
```

- [ ] **Step 8: 테스트·lint·build**

Run: `cd ../estate-server && npm test -- change-password && npm run lint:check && npm run build`
Expected: 2 PASS, lint 클린, build 성공.

- [ ] **Step 9: 커밋**

```bash
cd ../estate-server
git add src/auth/
git commit -m "feature: 비밀번호 변경(PATCH /auth/password)"
```

---

### Task 3: (FE) auth API · 스키마 · 상수 · 메시지

**레포: `estate-web`** (branch `feature/fe-m6-settings`, origin/main 기준)

**Files:**
- Modify: `lib/api/auth.ts`
- Modify: `lib/schemas.ts`
- Modify: `lib/constants.ts`
- Modify: `lib/messages.ts`
- Test: `lib/profile-api.test.ts`

**Interfaces:**
- Produces: `Profile = { id; email; name; role: "OWNER"|"TENANT"|"ADMIN" }`
- Produces: `backendProfile(t)`, `backendUpdateProfile(t,{name})`, `backendChangePassword(t,{currentPassword,newPassword})`
- Produces: `profileSchema {name}`, `passwordSchema {currentPassword, newPassword}`
- Produces: `PAGE_ROUTES.settings="/settings"`, `API_ROUTES.profile="/api/profile"`, `API_ROUTES.profilePassword="/api/profile/password"`, `ROLE_LABEL`
- Produces: `MESSAGES.settings.*`

- [ ] **Step 1: 상수** — `lib/constants.ts`

`API_ROUTES`에 추가:
```ts
  profile: "/api/profile",
  profilePassword: "/api/profile/password",
```
`PAGE_ROUTES`에 추가:
```ts
  settings: "/settings",
```
`ROLE` 정의 아래에 라벨 맵 추가:
```ts
/** 역할 표시 라벨(단일 출처) */
export const ROLE_LABEL: Record<string, string> = {
  OWNER: "건물주",
  TENANT: "입주자",
  ADMIN: "관리자",
};
```

- [ ] **Step 2: 메시지** — `lib/messages.ts`

`MESSAGES`에 추가:
```ts
  settings: {
    title: "설정",
    profile: "프로필",
    name: "이름",
    email: "이메일",
    role: "역할",
    saveName: "이름 저장",
    changePassword: "비밀번호 변경",
    currentPassword: "현재 비밀번호",
    newPassword: "새 비밀번호(8자 이상)",
    passwordChanged: "비밀번호를 변경했어요.",
    updateFailed: "변경하지 못했어요. 잠시 후 다시 시도해주세요.",
    wrongCurrentPassword: "현재 비밀번호가 일치하지 않습니다.",
    logout: "로그아웃",
  },
```

- [ ] **Step 3: 스키마** — `lib/schemas.ts`

파일 끝에 추가:
```ts
export const profileSchema = z.object({
  name: z.string().min(1, MESSAGES.form.invalidInput),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export const passwordSchema = z.object({
  currentPassword: z.string().min(1, MESSAGES.form.invalidInput),
  newPassword: z.string().min(8, MESSAGES.settings.newPassword),
});
export type PasswordInput = z.infer<typeof passwordSchema>;
```

- [ ] **Step 4: 실패 테스트 작성** — `lib/profile-api.test.ts`

```ts
import { vi } from "vitest";
import { backendProfile, backendUpdateProfile, backendChangePassword } from "@/lib/api";

it("backendProfile: GET /auth/profile를 Bearer로", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "u1", email: "a@b.com", name: "김철수", role: "TENANT" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await backendProfile("tok");
  expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/profile$/);
  expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
});

it("backendUpdateProfile: PATCH name", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await backendUpdateProfile("tok", { name: "이영희" });
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe("PATCH");
  expect(JSON.parse(String(init.body))).toEqual({ name: "이영희" });
});

it("backendChangePassword: PATCH /auth/password body", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await backendChangePassword("tok", { currentPassword: "a", newPassword: "newpass12" });
  expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/password$/);
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ currentPassword: "a", newPassword: "newpass12" });
});
```

- [ ] **Step 5: 테스트 실패 확인**

Run: `npm run test -- profile-api`
Expected: FAIL (export 없음)

- [ ] **Step 6: auth API 확장** — `lib/api/auth.ts`

파일 끝(기존 export 뒤)에 추가:
```ts
export type Profile = { id: string; email: string; name: string; role: "OWNER" | "TENANT" | "ADMIN" };

export const backendProfile = (t: string) => authGet<Profile>("/auth/profile", t);

export const backendUpdateProfile = (t: string, body: { name: string }) =>
  call<Profile>("/auth/profile", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${t}` },
    body: JSON.stringify(body),
  }, {});

export const backendChangePassword = (t: string, body: { currentPassword: string; newPassword: string }) =>
  call<{ ok: true }>("/auth/password", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${t}` },
    body: JSON.stringify(body),
  }, { 401: MESSAGES.settings.wrongCurrentPassword });
```
> `lib/api/auth.ts`는 이미 `call`·`authGet`·`MESSAGES`를 import한다(없으면 추가).

- [ ] **Step 7: 테스트·lint**

Run: `npm run test -- profile-api && npm run lint`
Expected: 3 PASS, lint 클린.

- [ ] **Step 8: 커밋**

```bash
git add lib/api/auth.ts lib/schemas.ts lib/constants.ts lib/messages.ts lib/profile-api.test.ts
git commit -m "feature: 프로필 API·스키마·상수·메시지 추가"
```

---

### Task 4: (FE) Route Handlers + 폼/로그아웃 컴포넌트

**Files:**
- Create: `app/api/profile/route.ts`
- Create: `app/api/profile/password/route.ts`
- Create: `components/settings/profile-form.tsx`
- Create: `components/settings/password-form.tsx`
- Create: `components/settings/logout-button.tsx`
- Test: `components/settings/password-form.test.tsx`, `components/settings/logout-button.test.tsx`

**Interfaces:**
- Consumes: `backendUpdateProfile`, `backendChangePassword`, `ApiError`(`@/lib/api`); `getToken`; `profileSchema`/`passwordSchema`(`@/lib/schemas`); `API_ROUTES`/`PAGE_ROUTES`; `MESSAGES`; `Field`, `Button`.
- Produces: `PATCH /api/profile`, `PATCH /api/profile/password`. 컴포넌트 `ProfileForm({ defaultName })`, `PasswordForm()`, `LogoutButton()`.

- [ ] **Step 1: 프로필 Route Handler** — `app/api/profile/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/session";
import { backendUpdateProfile, ApiError } from "@/lib/api";

export async function PATCH(req: NextRequest) {
  const token = await getToken();
  if (!token) return NextResponse.json({ message: "인증 필요" }, { status: 401 });
  try {
    const body = await req.json();
    const updated = await backendUpdateProfile(token, body);
    return NextResponse.json(updated, { status: 200 });
  } catch (e) {
    const err = e as ApiError;
    return NextResponse.json({ message: err.message, status: err.status }, { status: err.status ?? 500 });
  }
}
```

- [ ] **Step 2: 비밀번호 Route Handler** — `app/api/profile/password/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/session";
import { backendChangePassword, ApiError } from "@/lib/api";

export async function PATCH(req: NextRequest) {
  const token = await getToken();
  if (!token) return NextResponse.json({ message: "인증 필요" }, { status: 401 });
  try {
    const body = await req.json();
    const r = await backendChangePassword(token, body);
    return NextResponse.json(r, { status: 200 });
  } catch (e) {
    const err = e as ApiError;
    return NextResponse.json({ message: err.message, status: err.status }, { status: err.status ?? 500 });
  }
}
```

- [ ] **Step 3: 프로필 폼** — `components/settings/profile-form.tsx`

```tsx
"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { profileSchema, type ProfileInput } from "@/lib/schemas";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { API_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

export function ProfileForm({ defaultName }: { defaultName: string }) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<ProfileInput>({ resolver: zodResolver(profileSchema), defaultValues: { name: defaultName } });

  async function onValid(v: ProfileInput) {
    const res = await fetch(API_ROUTES.profile, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    });
    if (res.ok) {
      router.refresh();
    } else {
      const json = await res.json().catch(() => ({}));
      setError("root", { message: json.message ?? MESSAGES.settings.updateFailed });
    }
  }

  return (
    <form onSubmit={handleSubmit(onValid)} className="flex flex-col gap-3">
      <Field label={MESSAGES.settings.name} {...register("name")} error={errors.name?.message} />
      {errors.root && <p className="text-[13px] text-danger">{errors.root.message}</p>}
      <Button type="submit" disabled={isSubmitting}>{MESSAGES.settings.saveName}</Button>
    </form>
  );
}
```

- [ ] **Step 4: 비밀번호 폼 실패 테스트** — `components/settings/password-form.test.tsx`

```tsx
import { vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PasswordForm } from "@/components/settings/password-form";

afterEach(() => vi.unstubAllGlobals());

function fill() {
  fireEvent.input(screen.getByLabelText("현재 비밀번호"), { target: { value: "current1" } });
  fireEvent.input(screen.getByLabelText("새 비밀번호(8자 이상)"), { target: { value: "newpass12" } });
}

it("성공 시 성공 메시지 표시", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  render(<PasswordForm />);
  fill();
  fireEvent.click(screen.getByText("비밀번호 변경"));
  await waitFor(() => expect(screen.getByText("비밀번호를 변경했어요.")).toBeInTheDocument());
});

it("401이면 현재 비밀번호 불일치 메시지", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "현재 비밀번호가 일치하지 않습니다." }), { status: 401 })));
  render(<PasswordForm />);
  fill();
  fireEvent.click(screen.getByText("비밀번호 변경"));
  await waitFor(() => expect(screen.getByText("현재 비밀번호가 일치하지 않습니다.")).toBeInTheDocument());
});
```

- [ ] **Step 5: 테스트 실패 확인**

Run: `npm run test -- password-form`
Expected: FAIL (컴포넌트 없음)

- [ ] **Step 6: 비밀번호 폼** — `components/settings/password-form.tsx`

```tsx
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { passwordSchema, type PasswordInput } from "@/lib/schemas";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { API_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

export function PasswordForm() {
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    reset,
  } = useForm<PasswordInput>({ resolver: zodResolver(passwordSchema) });

  async function onValid(v: PasswordInput) {
    setDone(false);
    const res = await fetch(API_ROUTES.profilePassword, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    });
    if (res.ok) {
      reset();
      setDone(true);
    } else {
      const json = await res.json().catch(() => ({}));
      setError("root", { message: json.message ?? MESSAGES.settings.updateFailed });
    }
  }

  return (
    <form onSubmit={handleSubmit(onValid)} className="flex flex-col gap-3">
      <Field label={MESSAGES.settings.currentPassword} type="password" {...register("currentPassword")} error={errors.currentPassword?.message} />
      <Field label={MESSAGES.settings.newPassword} type="password" {...register("newPassword")} error={errors.newPassword?.message} />
      {errors.root && <p className="text-[13px] text-danger">{errors.root.message}</p>}
      {done && <p className="text-[13px] text-brand-600">{MESSAGES.settings.passwordChanged}</p>}
      <Button type="submit" disabled={isSubmitting}>{MESSAGES.settings.changePassword}</Button>
    </form>
  );
}
```

- [ ] **Step 7: 로그아웃 버튼 실패 테스트** — `components/settings/logout-button.test.tsx`

```tsx
import { vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

import { LogoutButton } from "@/components/settings/logout-button";

afterEach(() => { vi.unstubAllGlobals(); push.mockReset(); });

it("DELETE /api/session 후 로그인으로 이동", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<LogoutButton />);
  fireEvent.click(screen.getByText("로그아웃"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
});
```

- [ ] **Step 8: 테스트 실패 확인**

Run: `npm run test -- logout-button`
Expected: FAIL (컴포넌트 없음)

- [ ] **Step 9: 로그아웃 버튼** — `components/settings/logout-button.tsx`

```tsx
"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { API_ROUTES, PAGE_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

export function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch(API_ROUTES.session, { method: "DELETE" });
    router.push(PAGE_ROUTES.login);
    router.refresh();
  }

  return (
    <Button variant="secondary" onClick={logout}>{MESSAGES.settings.logout}</Button>
  );
}
```
> `API_ROUTES.session`은 `lib/constants.ts`에 이미 `"/api/session"`로 존재한다. 없으면 추가.

- [ ] **Step 10: 테스트·빌드·lint**

Run: `npm run test -- password-form logout-button && npm run build && npm run lint`
Expected: 3 PASS, 빌드 성공(`/api/profile`·`/api/profile/password` 라우트 포함), lint 클린.

- [ ] **Step 11: 커밋**

```bash
git add app/api/profile components/settings
git commit -m "feature: 프로필/비밀번호 Route Handler·폼·로그아웃 버튼"
```

---

### Task 5: (FE) 설정 페이지 + 헤더 아바타 링크

**Files:**
- Create: `app/(app)/settings/page.tsx`
- Modify: `app/(app)/layout.tsx` (아바타 → 설정 링크)

**Interfaces:**
- Consumes: `backendProfile`, `Profile`(`@/lib/api`); `getToken`; `ROLE_LABEL`, `PAGE_ROUTES`; `MESSAGES`; `Card`, `ListRow`, `EmptyState`; `ProfileForm`/`PasswordForm`/`LogoutButton`.
- Produces: 라우트 `/settings`.

- [ ] **Step 1: 설정 페이지** — `app/(app)/settings/page.tsx`

```tsx
import { redirect } from "next/navigation";
import { getToken } from "@/lib/session";
import { backendProfile, type Profile } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { EmptyState } from "@/components/ui/empty-state";
import { ProfileForm } from "@/components/settings/profile-form";
import { PasswordForm } from "@/components/settings/password-form";
import { LogoutButton } from "@/components/settings/logout-button";
import { PAGE_ROUTES, ROLE_LABEL } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

export default async function SettingsPage() {
  const token = await getToken();
  if (!token) redirect(PAGE_ROUTES.login);

  let profile: Profile | null = null;
  try {
    profile = await backendProfile(token);
  } catch {
    profile = null;
  }

  if (!profile) {
    return (
      <>
        <h1 className="mb-4 text-[22px] font-extrabold tracking-tight">{MESSAGES.settings.title}</h1>
        <EmptyState text={MESSAGES.common.requestFailed} />
      </>
    );
  }

  return (
    <>
      <h1 className="mb-4 text-[22px] font-extrabold tracking-tight">{MESSAGES.settings.title}</h1>

      <Card className="p-0">
        <div className="divide-y divide-border px-4">
          <ListRow title={MESSAGES.settings.email} meta={profile.email} />
          <ListRow title={MESSAGES.settings.role} meta={ROLE_LABEL[profile.role] ?? profile.role} />
        </div>
      </Card>

      <section className="mt-6">
        <h2 className="mb-2 px-0.5 text-[16px] font-bold">{MESSAGES.settings.profile}</h2>
        <Card>
          <ProfileForm defaultName={profile.name} />
        </Card>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 px-0.5 text-[16px] font-bold">{MESSAGES.settings.changePassword}</h2>
        <Card>
          <PasswordForm />
        </Card>
      </section>

      <section className="mt-6">
        <LogoutButton />
      </section>
    </>
  );
}
```

- [ ] **Step 2: 헤더 아바타 → 설정 링크** — `app/(app)/layout.tsx`

`Link`는 이미 import됨. 헤더의 아바타 `<div ...>{initial}</div>`를 다음으로 감싼다:
```tsx
            <Link href={PAGE_ROUTES.settings} className="grid h-9 w-9 place-items-center rounded-full bg-brand-500 text-[14px] font-bold text-white" aria-label={MESSAGES.settings.title}>
              {initial}
            </Link>
```
(기존 `<div className="grid h-9 w-9 ...">{initial}</div>`를 위 `<Link>`로 교체. `MESSAGES` import가 없으면 추가.)

- [ ] **Step 3: 빌드·lint·전체 테스트**

Run: `npm run test && npm run build && npm run lint`
Expected: 전체 PASS, 빌드 성공(`/settings` 라우트 포함), lint 클린.

- [ ] **Step 4: 커밋**

```bash
git add "app/(app)/settings" "app/(app)/layout.tsx"
git commit -m "feature: 설정 페이지(/settings) + 헤더 아바타 설정 링크"
```

---

## 마무리 (계획 외 후속)

- README 마일스톤 표 FE-M6 ✅ 갱신 + API 표에 `GET/PATCH /auth/profile`·`PATCH /auth/password` 추가(별도 docs 커밋).
- BE PR(estate-server `feature/m6-settings`)·FE PR(estate-web `feature/fe-m6-settings`) 분리. PR 본문에 스펙·플랜 경로 첨부. **BE 먼저(또는 동시) 머지**.
- 머지 후 web 서브모듈 포인터를 estate-web `main` HEAD로 재갱신.

## Self-Review 결과

- **스펙 커버리지:** §4.1 도메인/repo→Task 1·2 / §4.2 유스케이스→Task 1·2 / §4.3 라우트→Task 1·2 / §5.1 페이지·폼→Task 4·5 / §5.2 라우트핸들러→Task 4 / §5.3 lib/상수→Task 3 / §6 에러→각 Task / §7 테스트→Task 1·2·3·4. 모두 매핑.
- **YAGNI:** 이메일/전화/탈퇴/환경설정 제외 유지.
- **플레이스홀더:** 없음(모든 step에 코드/명령).
- **타입 일관성:** `Profile`(Task 3)·`ProfileResponseDto`(Task 1) 필드 `{id,email,name,role}` 일치. `backendProfile/backendUpdateProfile/backendChangePassword`(Task 3) → Task 4·5 사용 일치. `profileSchema`/`passwordSchema`(Task 3) → Task 4 사용. `User.rename`(Task 1)·`changePassword`(Task 2)·`findById`/`update`(Task 1) 시그니처 일관. `MESSAGES.settings.*` 키 Task 3 정의 = Task 4·5 사용 일치. `API_ROUTES.session` 기존 확인 필요(Task 4 Step 9 주석).
