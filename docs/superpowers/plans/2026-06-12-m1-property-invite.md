# M1 — Property(건물·호실·입주) + 초대코드(Redis TTL) + RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 건물주(OWNER)가 건물→호실을 만들고 **초대코드를 발급**하면, 입주자(TENANT)가 코드를 입력해 **자신의 호실에 자동 연결(Lease 생성)** 되는 흐름을 만든다. 그 과정에서 Prisma 관계(Building→Unit→Lease), Redis TTL(초대코드 만료·단일 사용), RBAC(RolesGuard + 리소스 소유권 검사)를 익힌다.

**Architecture:** M0의 DDD 레이어드 구조를 그대로 따른다 — `interface → application → domain → infrastructure` 단방향, 도메인은 인터페이스만 알고 Prisma·Redis 구현은 infrastructure에 두고 DI로 주입(의존성 역전). Property 컨텍스트는 소유권·상태가 있어 도메인 레이어를 M0보다 약간 두텁게(엔티티에 `isOwnedBy` 같은 규칙) 가져간다. RBAC는 Auth 컨텍스트가 소유한다(스펙 5.1).

**Tech Stack:** NestJS 11, TypeScript, Prisma + PostgreSQL, **ioredis**(신규), class-validator, Jest.

**선행:** M0 완료(머지) 상태. `src/auth/`(JWT 인증·Role enum)와 전역 `PrismaModule`이 존재한다고 가정한다.

---

## 핵심 설계 결정 (M1 한정)

- **초대코드는 Redis 단독 저장(TTL 네이티브).** `invite:{code}` → `{unitId, issuedBy}` JSON을 `EX 24h`로 저장. 사용 시 **`GETDEL`(원자적 단일 사용)** 로 읽고 즉시 삭제 → Lease 생성. **InviteCode Postgres 테이블은 만들지 않는다.** 발급/사용 감사 이력은 M3 Kafka `membership-events` + audit-worker로 분리(스펙 4절). M1 학습 목표(Prisma 관계 + Redis TTL)에 정확히 집중하고 dual-write를 피한다.
- **만료/사용/존재하지 않음을 구분하지 않는다.** `GETDEL`이 `null`을 반환하면(만료·이미 사용·오타 무엇이든) 동일하게 **404**로 응답한다 — 어떤 코드가 "존재했었는지"를 누설하지 않는다(보안).
- **RBAC = 역할 가드 + 소유권 검사 이중.** `RolesGuard`는 JWT의 `role`만 본다. "이 건물이 내 것인가"는 역할로 판단 불가하므로 **유스케이스(application)에서 리소스 소유권을 검사**한다(스펙 6절: 역할만 보고 소유를 안 보면 다른 건물 데이터 우회 경로가 열림).
- **OWNER 프로비저닝은 M1 범위 밖.** M0 회원가입은 기본 TENANT만 만든다. 누가 OWNER가 되는가(온보딩)는 별도 관심사라 M1에서 다루지 않는다. e2e·수동 검증에서는 **테스트가 DB에서 직접 role을 OWNER로 승격**시켜 RBAC를 검증한다.

---

## M1 파일 구조

```
src/redis/redis.service.ts                              Create  ioredis 생명주기 (전역)
src/redis/redis.module.ts                               Create  전역 RedisModule
src/auth/interface/roles.decorator.ts                   Create  @Roles 메타데이터
src/auth/interface/roles.guard.ts                       Create  RolesGuard (역할 검사)
src/property/domain/lease-status.enum.ts                Create  ACTIVE|ENDED
src/property/domain/building.entity.ts                  Create  Building 엔티티(+isOwnedBy)
src/property/domain/unit.entity.ts                      Create  Unit 엔티티
src/property/domain/lease.entity.ts                     Create  Lease 엔티티
src/property/domain/building.repository.ts              Create  인터페이스 + DI 토큰
src/property/domain/unit.repository.ts                  Create  인터페이스 + DI 토큰
src/property/domain/lease.repository.ts                 Create  인터페이스 + DI 토큰
src/property/domain/invite-code.store.ts                Create  인터페이스 + DI 토큰(Redis 추상화)
src/property/infrastructure/prisma-building.repository.ts  Create
src/property/infrastructure/prisma-unit.repository.ts      Create
src/property/infrastructure/prisma-lease.repository.ts     Create
src/property/infrastructure/redis-invite-code.store.ts     Create  GETDEL 단일 사용
src/property/application/create-building.use-case.ts    Create
src/property/application/create-unit.use-case.ts        Create  소유권 검사
src/property/application/issue-invite-code.use-case.ts  Create  소유권 검사 + Redis 발급
src/property/application/redeem-invite-code.use-case.ts Create  GETDEL + Lease 생성
src/property/application/list-my-buildings.use-case.ts  Create  얇은 조회
src/property/application/list-my-leases.use-case.ts     Create  얇은 조회
src/property/interface/dto/create-building.dto.ts       Create
src/property/interface/dto/create-unit.dto.ts           Create
src/property/interface/dto/redeem-invite.dto.ts         Create
src/property/interface/property.controller.ts           Create  /buildings · /units · /invite-codes · /me/leases
src/property/property.module.ts                         Create  컨텍스트 모듈 조립
prisma/schema.prisma                                    Modify  Building/Unit/Lease + LeaseStatus + User 역관계
src/app.module.ts                                       Modify  RedisModule·PropertyModule 등록
test/property.e2e-spec.ts                               Create  발급→가입→연결 + RBAC/만료/소유권 부정
```

> **의존성 역전 메모(M0와 동일):** `application/`·`domain/`은 `infrastructure/`를 import 하지 않는다. Prisma·Redis 구현 바인딩은 `property.module.ts`의 provider에서만 한다.

---

## Task 1: ioredis 의존성 + 전역 RedisModule

**Files:**
- Modify: `package.json` (npm이 자동 수정)
- Create: `src/redis/redis.service.ts`, `src/redis/redis.module.ts`

- [ ] **Step 1: ioredis 설치**

Run:
```bash
npm install ioredis
```

- [ ] **Step 2: `src/redis/redis.service.ts` 작성 (PrismaService와 동일한 생명주기 패턴)**

```typescript
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super(config.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
```

- [ ] **Step 3: `src/redis/redis.module.ts` 작성 (전역)**

```typescript
import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
```

- [ ] **Step 4: 컴파일 + Redis 연결 스모크 확인**

Run:
```bash
npx tsc --noEmit
docker compose exec -T redis redis-cli ping
```
Expected: tsc 에러 없음, `PONG`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/redis
git commit -m "feat(m1): add ioredis + global RedisModule"
```

---

## Task 2: Prisma 스키마 확장 (Building/Unit/Lease) + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: `prisma/schema.prisma`에 모델·enum 추가 + User 역관계**

기존 `User` 모델에 역관계 두 줄(`buildings`, `leases`)을 추가하고, 파일 끝에 모델/enum을 추가한다.

`User` 모델을 다음으로 교체(역관계 2줄 추가):
```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  name         String
  role         Role     @default(TENANT)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  buildings Building[]
  leases    Lease[]
}
```

파일 끝에 추가:
```prisma
enum LeaseStatus {
  ACTIVE
  ENDED
}

model Building {
  id        String   @id @default(cuid())
  ownerId   String
  owner     User     @relation(fields: [ownerId], references: [id])
  name      String
  address   String
  createdAt DateTime @default(now())

  units Unit[]
}

model Unit {
  id         String   @id @default(cuid())
  buildingId String
  building   Building @relation(fields: [buildingId], references: [id])
  name       String
  floor      Int
  createdAt  DateTime @default(now())

  leases Lease[]
}

model Lease {
  id        String      @id @default(cuid())
  unitId    String
  unit      Unit        @relation(fields: [unitId], references: [id])
  tenantId  String
  tenant    User        @relation(fields: [tenantId], references: [id])
  status    LeaseStatus @default(ACTIVE)
  startDate DateTime    @default(now())
  endDate   DateTime?
  createdAt DateTime    @default(now())
}
```

- [ ] **Step 2: 마이그레이션 생성·적용 + 클라이언트 재생성**

Run:
```bash
npx prisma migrate dev --name add_property
```
Expected: `prisma/migrations/<ts>_add_property/` 생성, "Your database is now in sync", `@prisma/client` 재생성(이제 `prisma.building`·`prisma.unit`·`prisma.lease` 사용 가능).

- [ ] **Step 3: 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: Commit**

```bash
git add prisma
git commit -m "feat(m1): add Building/Unit/Lease schema + migration"
```

---

## Task 3: RBAC — @Roles 데코레이터 + RolesGuard (Auth 컨텍스트)

RBAC는 Auth 컨텍스트가 소유한다(스펙 5.1). Guard는 cross-cutting이라 별도 spec으로 분리한다(프로젝트 테스트 규칙).

**Files:**
- Create: `src/auth/interface/roles.decorator.ts`
- Create: `src/auth/interface/roles.guard.ts`
- Test: `src/auth/interface/roles.guard.spec.ts`

- [ ] **Step 1: `roles.decorator.ts` 작성**

```typescript
import { SetMetadata } from '@nestjs/common';
import { Role } from '../domain/role.enum';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 2: 실패 테스트 작성 — RolesGuard**

`src/auth/interface/roles.guard.spec.ts`:
```typescript
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Role } from '../domain/role.enum';

function contextWithUser(role: Role | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

function reflectorReturning(required: Role[] | undefined): Reflector {
  return {
    getAllAndOverride: () => required,
  } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('필요 역할이 없으면(메타데이터 없음) 통과', () => {
    const guard = new RolesGuard(reflectorReturning(undefined));

    expect(guard.canActivate(contextWithUser(Role.TENANT))).toBe(true);
  });

  it('역할이 일치하면 통과', () => {
    const guard = new RolesGuard(reflectorReturning([Role.OWNER]));

    expect(guard.canActivate(contextWithUser(Role.OWNER))).toBe(true);
  });

  it('역할이 부족하면 ForbiddenException', () => {
    const guard = new RolesGuard(reflectorReturning([Role.OWNER]));

    expect(() => guard.canActivate(contextWithUser(Role.TENANT))).toThrow(
      ForbiddenException,
    );
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/auth/interface/roles.guard.spec.ts`
Expected: FAIL — "Cannot find module './roles.guard'".

- [ ] **Step 4: `roles.guard.ts` 작성**

```typescript
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { Role } from '../domain/role.enum';
import { TokenPayload } from '../domain/token-issuer';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: TokenPayload }>();
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}
```

> **메모:** `RolesGuard`는 `@UseGuards(JwtAuthGuard, RolesGuard)` 순서로 써야 한다. 먼저 `JwtAuthGuard`가 `request.user`(TokenPayload)를 채운 뒤 `RolesGuard`가 그 `role`을 읽는다. RolesGuard는 클래스 참조만으로 Nest가 DI(Reflector는 전역)로 인스턴스화하므로 별도 provider 등록이 필요 없다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/auth/interface/roles.guard.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add src/auth/interface/roles.decorator.ts src/auth/interface/roles.guard.ts src/auth/interface/roles.guard.spec.ts
git commit -m "feat(m1): RBAC @Roles decorator + RolesGuard"
```

---

## Task 4: Property 도메인 레이어 (엔티티 + 인터페이스)

도메인은 순수 TS만 사용한다(NestJS·Prisma·ioredis import 금지).

**Files:**
- Create: `src/property/domain/lease-status.enum.ts`
- Create: `src/property/domain/building.entity.ts`
- Create: `src/property/domain/unit.entity.ts`
- Create: `src/property/domain/lease.entity.ts`
- Create: `src/property/domain/building.repository.ts`
- Create: `src/property/domain/unit.repository.ts`
- Create: `src/property/domain/lease.repository.ts`
- Create: `src/property/domain/invite-code.store.ts`
- Test: `src/property/domain/building.entity.spec.ts`

- [ ] **Step 1: 실패 테스트 작성 — Building 불변식 + 소유권**

`src/property/domain/building.entity.spec.ts`:
```typescript
import { Building } from './building.entity';

describe('Building entity', () => {
  it('create()로 만들면 id는 null, 소유자가 설정된다', () => {
    const building = Building.create({
      ownerId: 'owner1',
      name: '래미안',
      address: '서울시 강남구',
    });

    expect(building.id).toBeNull();
    expect(building.ownerId).toBe('owner1');
    expect(building.isOwnedBy('owner1')).toBe(true);
    expect(building.isOwnedBy('other')).toBe(false);
  });

  it('ownerId가 비면 예외', () => {
    expect(() =>
      Building.create({ ownerId: '', name: '래미안', address: '주소' }),
    ).toThrow('ownerId is required');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/property/domain/building.entity.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `lease-status.enum.ts` 작성**

```typescript
export enum LeaseStatus {
  ACTIVE = 'ACTIVE',
  ENDED = 'ENDED',
}
```

- [ ] **Step 4: `building.entity.ts` 작성**

```typescript
interface BuildingProps {
  id: string | null;
  ownerId: string;
  name: string;
  address: string;
}

export class Building {
  private constructor(private readonly props: BuildingProps) {}

  static create(input: {
    ownerId: string;
    name: string;
    address: string;
  }): Building {
    if (!input.ownerId) throw new Error('ownerId is required');
    if (!input.name) throw new Error('name is required');
    return new Building({
      id: null,
      ownerId: input.ownerId,
      name: input.name,
      address: input.address,
    });
  }

  static reconstitute(props: BuildingProps): Building {
    return new Building(props);
  }

  isOwnedBy(userId: string): boolean {
    return this.props.ownerId === userId;
  }

  get id(): string | null {
    return this.props.id;
  }
  get ownerId(): string {
    return this.props.ownerId;
  }
  get name(): string {
    return this.props.name;
  }
  get address(): string {
    return this.props.address;
  }
}
```

- [ ] **Step 5: `unit.entity.ts` 작성**

```typescript
interface UnitProps {
  id: string | null;
  buildingId: string;
  name: string;
  floor: number;
}

export class Unit {
  private constructor(private readonly props: UnitProps) {}

  static create(input: {
    buildingId: string;
    name: string;
    floor: number;
  }): Unit {
    if (!input.buildingId) throw new Error('buildingId is required');
    if (!input.name) throw new Error('name is required');
    return new Unit({
      id: null,
      buildingId: input.buildingId,
      name: input.name,
      floor: input.floor,
    });
  }

  static reconstitute(props: UnitProps): Unit {
    return new Unit(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get buildingId(): string {
    return this.props.buildingId;
  }
  get name(): string {
    return this.props.name;
  }
  get floor(): number {
    return this.props.floor;
  }
}
```

- [ ] **Step 6: `lease.entity.ts` 작성**

```typescript
import { LeaseStatus } from './lease-status.enum';

interface LeaseProps {
  id: string | null;
  unitId: string;
  tenantId: string;
  status: LeaseStatus;
}

export class Lease {
  private constructor(private readonly props: LeaseProps) {}

  static create(input: { unitId: string; tenantId: string }): Lease {
    if (!input.unitId) throw new Error('unitId is required');
    if (!input.tenantId) throw new Error('tenantId is required');
    return new Lease({
      id: null,
      unitId: input.unitId,
      tenantId: input.tenantId,
      status: LeaseStatus.ACTIVE,
    });
  }

  static reconstitute(props: LeaseProps): Lease {
    return new Lease(props);
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
}
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `npx jest src/property/domain/building.entity.spec.ts`
Expected: PASS (2 passed).

- [ ] **Step 8: 리포지토리 + InviteCodeStore 인터페이스 작성**

`src/property/domain/building.repository.ts`:
```typescript
import { Building } from './building.entity';

export const BUILDING_REPOSITORY = Symbol('BUILDING_REPOSITORY');

export interface BuildingRepository {
  save(building: Building): Promise<Building>;
  findById(id: string): Promise<Building | null>;
  findByOwner(ownerId: string): Promise<Building[]>;
}
```

`src/property/domain/unit.repository.ts`:
```typescript
import { Unit } from './unit.entity';

export const UNIT_REPOSITORY = Symbol('UNIT_REPOSITORY');

export interface UnitRepository {
  save(unit: Unit): Promise<Unit>;
  findById(id: string): Promise<Unit | null>;
}
```

`src/property/domain/lease.repository.ts`:
```typescript
import { Lease } from './lease.entity';

export const LEASE_REPOSITORY = Symbol('LEASE_REPOSITORY');

export interface LeaseRepository {
  save(lease: Lease): Promise<Lease>;
  findByTenant(tenantId: string): Promise<Lease[]>;
}
```

`src/property/domain/invite-code.store.ts`:
```typescript
export const INVITE_CODE_STORE = Symbol('INVITE_CODE_STORE');

export interface InviteCodePayload {
  unitId: string;
  issuedBy: string;
}

export interface IssuedInvite {
  code: string;
  expiresInSec: number;
}

export interface InviteCodeStore {
  issue(payload: InviteCodePayload): Promise<IssuedInvite>;
  // 단일 사용(원자적 GETDEL). 만료·이미 사용·존재하지 않음은 모두 null.
  redeem(code: string): Promise<InviteCodePayload | null>;
}
```

- [ ] **Step 9: Commit**

```bash
git add src/property/domain
git commit -m "feat(m1): property domain layer (Building/Unit/Lease + repo/store interfaces)"
```

---

## Task 5: Property 인프라 레이어 (Prisma 리포지토리 + Redis 초대코드 스토어)

**Files:**
- Create: `src/property/infrastructure/prisma-building.repository.ts`
- Create: `src/property/infrastructure/prisma-unit.repository.ts`
- Create: `src/property/infrastructure/prisma-lease.repository.ts`
- Create: `src/property/infrastructure/redis-invite-code.store.ts`

> 인프라 구현은 실제 DB/Redis가 필요하므로 단위 spec을 따로 두지 않고 **Task 9 e2e로 검증**한다(M0의 PrismaUserRepository와 동일한 방침). 단위 테스트는 Task 6·7에서 인메모리 가짜로 커버한다.

- [ ] **Step 1: `prisma-building.repository.ts` 작성**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Building } from '../domain/building.entity';
import { BuildingRepository } from '../domain/building.repository';

@Injectable()
export class PrismaBuildingRepository implements BuildingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(building: Building): Promise<Building> {
    const row = await this.prisma.building.create({
      data: {
        ownerId: building.ownerId,
        name: building.name,
        address: building.address,
      },
    });
    return Building.reconstitute({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      address: row.address,
    });
  }

  async findById(id: string): Promise<Building | null> {
    const row = await this.prisma.building.findUnique({ where: { id } });
    if (!row) return null;
    return Building.reconstitute({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      address: row.address,
    });
  }

  async findByOwner(ownerId: string): Promise<Building[]> {
    const rows = await this.prisma.building.findMany({ where: { ownerId } });
    return rows.map((row) =>
      Building.reconstitute({
        id: row.id,
        ownerId: row.ownerId,
        name: row.name,
        address: row.address,
      }),
    );
  }
}
```

- [ ] **Step 2: `prisma-unit.repository.ts` 작성**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Unit } from '../domain/unit.entity';
import { UnitRepository } from '../domain/unit.repository';

@Injectable()
export class PrismaUnitRepository implements UnitRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(unit: Unit): Promise<Unit> {
    const row = await this.prisma.unit.create({
      data: {
        buildingId: unit.buildingId,
        name: unit.name,
        floor: unit.floor,
      },
    });
    return Unit.reconstitute({
      id: row.id,
      buildingId: row.buildingId,
      name: row.name,
      floor: row.floor,
    });
  }

  async findById(id: string): Promise<Unit | null> {
    const row = await this.prisma.unit.findUnique({ where: { id } });
    if (!row) return null;
    return Unit.reconstitute({
      id: row.id,
      buildingId: row.buildingId,
      name: row.name,
      floor: row.floor,
    });
  }
}
```

- [ ] **Step 3: `prisma-lease.repository.ts` 작성**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';

@Injectable()
export class PrismaLeaseRepository implements LeaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(lease: Lease): Promise<Lease> {
    const row = await this.prisma.lease.create({
      data: {
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        status: lease.status,
      },
    });
    return Lease.reconstitute({
      id: row.id,
      unitId: row.unitId,
      tenantId: row.tenantId,
      status: row.status as LeaseStatus,
    });
  }

  async findByTenant(tenantId: string): Promise<Lease[]> {
    const rows = await this.prisma.lease.findMany({ where: { tenantId } });
    return rows.map((row) =>
      Lease.reconstitute({
        id: row.id,
        unitId: row.unitId,
        tenantId: row.tenantId,
        status: row.status as LeaseStatus,
      }),
    );
  }
}
```

- [ ] **Step 4: `redis-invite-code.store.ts` 작성 (GETDEL 단일 사용)**

```typescript
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import {
  InviteCodePayload,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

const INVITE_TTL_SEC = 60 * 60 * 24; // 24시간

@Injectable()
export class RedisInviteCodeStore implements InviteCodeStore {
  constructor(private readonly redis: RedisService) {}

  private key(code: string): string {
    return `invite:${code}`;
  }

  async issue(payload: InviteCodePayload): Promise<IssuedInvite> {
    const code = randomBytes(9).toString('base64url');
    await this.redis.set(
      this.key(code),
      JSON.stringify(payload),
      'EX',
      INVITE_TTL_SEC,
    );
    return { code, expiresInSec: INVITE_TTL_SEC };
  }

  async redeem(code: string): Promise<InviteCodePayload | null> {
    // GETDEL: 읽는 즉시 삭제 → 동시 요청이 와도 한 번만 성공(단일 사용 보장)
    const raw = await this.redis.getdel(this.key(code));
    if (!raw) return null;
    return JSON.parse(raw) as InviteCodePayload;
  }
}
```

- [ ] **Step 5: 컴파일 확인 후 Commit**

Run: `npx tsc --noEmit`
Expected: 에러 없음.
```bash
git add src/property/infrastructure
git commit -m "feat(m1): property infra (prisma building/unit/lease repos, redis invite store)"
```

---

## Task 6: 유스케이스 — CreateBuilding / CreateUnit (소유권 검사)

**Files:**
- Create: `src/property/application/create-building.use-case.ts`
- Create: `src/property/application/create-unit.use-case.ts`
- Test: `src/property/application/create-unit.use-case.spec.ts`

- [ ] **Step 1: `create-building.use-case.ts` 작성**

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { Building } from '../domain/building.entity';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';

export interface CreateBuildingInput {
  ownerId: string;
  name: string;
  address: string;
}

@Injectable()
export class CreateBuildingUseCase {
  constructor(
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
  ) {}

  execute(input: CreateBuildingInput): Promise<Building> {
    const building = Building.create(input);
    return this.buildings.save(building);
  }
}
```

- [ ] **Step 2: 실패 테스트 작성 — CreateUnit 소유권**

`src/property/application/create-unit.use-case.spec.ts`:
```typescript
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CreateUnitUseCase } from './create-unit.use-case';
import { Building } from '../domain/building.entity';
import { Unit } from '../domain/unit.entity';
import { BuildingRepository } from '../domain/building.repository';
import { UnitRepository } from '../domain/unit.repository';

const OWNER_ID = 'owner1';
const BUILDING_ID = 'b1';

function buildingRepoWith(building: Building | null): BuildingRepository {
  return {
    save: (b) => Promise.resolve(b),
    findById: (id) =>
      Promise.resolve(id === BUILDING_ID ? building : null),
    findByOwner: () => Promise.resolve([]),
  };
}

const unitRepo: UnitRepository = {
  save: (u) =>
    Promise.resolve(
      Unit.reconstitute({
        id: 'unit-generated',
        buildingId: u.buildingId,
        name: u.name,
        floor: u.floor,
      }),
    ),
  findById: () => Promise.resolve(null),
};

const ownedBuilding = Building.reconstitute({
  id: BUILDING_ID,
  ownerId: OWNER_ID,
  name: '래미안',
  address: '주소',
});

describe('CreateUnitUseCase', () => {
  it('건물 소유자가 호실을 만들면 저장된다', async () => {
    const useCase = new CreateUnitUseCase(
      buildingRepoWith(ownedBuilding),
      unitRepo,
    );

    const unit = await useCase.execute({
      ownerId: OWNER_ID,
      buildingId: BUILDING_ID,
      name: '101호',
      floor: 1,
    });

    expect(unit.id).toBe('unit-generated');
    expect(unit.buildingId).toBe(BUILDING_ID);
  });

  it('소유자가 아니면 ForbiddenException', async () => {
    const useCase = new CreateUnitUseCase(
      buildingRepoWith(ownedBuilding),
      unitRepo,
    );

    await expect(
      useCase.execute({
        ownerId: 'someone-else',
        buildingId: BUILDING_ID,
        name: '101호',
        floor: 1,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('건물이 없으면 NotFoundException', async () => {
    const useCase = new CreateUnitUseCase(buildingRepoWith(null), unitRepo);

    await expect(
      useCase.execute({
        ownerId: OWNER_ID,
        buildingId: BUILDING_ID,
        name: '101호',
        floor: 1,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest src/property/application/create-unit.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 4: `create-unit.use-case.ts` 작성**

```typescript
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Unit } from '../domain/unit.entity';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';

export interface CreateUnitInput {
  ownerId: string;
  buildingId: string;
  name: string;
  floor: number;
}

@Injectable()
export class CreateUnitUseCase {
  constructor(
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
  ) {}

  async execute(input: CreateUnitInput): Promise<Unit> {
    const building = await this.buildings.findById(input.buildingId);
    if (!building) throw new NotFoundException('building not found');
    if (!building.isOwnedBy(input.ownerId)) {
      throw new ForbiddenException('not the building owner');
    }
    const unit = Unit.create({
      buildingId: input.buildingId,
      name: input.name,
      floor: input.floor,
    });
    return this.units.save(unit);
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/property/application/create-unit.use-case.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add src/property/application/create-building.use-case.ts src/property/application/create-unit.use-case.ts src/property/application/create-unit.use-case.spec.ts
git commit -m "feat(m1): CreateBuilding/CreateUnit use cases with ownership check"
```

---

## Task 7: 유스케이스 — IssueInviteCode / RedeemInviteCode

**Files:**
- Create: `src/property/application/issue-invite-code.use-case.ts`
- Create: `src/property/application/redeem-invite-code.use-case.ts`
- Create: `src/property/application/list-my-buildings.use-case.ts`
- Create: `src/property/application/list-my-leases.use-case.ts`
- Test: `src/property/application/issue-invite-code.use-case.spec.ts`
- Test: `src/property/application/redeem-invite-code.use-case.spec.ts`

- [ ] **Step 1: 실패 테스트 작성 — IssueInviteCode 소유권**

`src/property/application/issue-invite-code.use-case.spec.ts`:
```typescript
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { IssueInviteCodeUseCase } from './issue-invite-code.use-case';
import { Building } from '../domain/building.entity';
import { Unit } from '../domain/unit.entity';
import { BuildingRepository } from '../domain/building.repository';
import { UnitRepository } from '../domain/unit.repository';
import {
  InviteCodePayload,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

const OWNER_ID = 'owner1';
const UNIT_ID = 'unit1';
const BUILDING_ID = 'b1';

const unitRepo: UnitRepository = {
  save: (u) => Promise.resolve(u),
  findById: (id) =>
    Promise.resolve(
      id === UNIT_ID
        ? Unit.reconstitute({
            id: UNIT_ID,
            buildingId: BUILDING_ID,
            name: '101호',
            floor: 1,
          })
        : null,
    ),
};

function buildingRepoOwnedBy(ownerId: string): BuildingRepository {
  return {
    save: (b) => Promise.resolve(b),
    findById: (id) =>
      Promise.resolve(
        id === BUILDING_ID
          ? Building.reconstitute({
              id: BUILDING_ID,
              ownerId,
              name: '래미안',
              address: '주소',
            })
          : null,
      ),
    findByOwner: () => Promise.resolve([]),
  };
}

class FakeInviteStore implements InviteCodeStore {
  public lastPayload: InviteCodePayload | null = null;
  issue(payload: InviteCodePayload): Promise<IssuedInvite> {
    this.lastPayload = payload;
    return Promise.resolve({ code: 'CODE123', expiresInSec: 86400 });
  }
  redeem(): Promise<InviteCodePayload | null> {
    return Promise.resolve(null);
  }
}

describe('IssueInviteCodeUseCase', () => {
  it('소유자가 발급하면 코드와 만료시간을 반환', async () => {
    const store = new FakeInviteStore();
    const useCase = new IssueInviteCodeUseCase(
      unitRepo,
      buildingRepoOwnedBy(OWNER_ID),
      store,
    );

    const result = await useCase.execute({ ownerId: OWNER_ID, unitId: UNIT_ID });

    expect(result.code).toBe('CODE123');
    expect(store.lastPayload).toEqual({ unitId: UNIT_ID, issuedBy: OWNER_ID });
  });

  it('소유자가 아니면 ForbiddenException', async () => {
    const useCase = new IssueInviteCodeUseCase(
      unitRepo,
      buildingRepoOwnedBy('someone-else'),
      new FakeInviteStore(),
    );

    await expect(
      useCase.execute({ ownerId: OWNER_ID, unitId: UNIT_ID }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('호실이 없으면 NotFoundException', async () => {
    const useCase = new IssueInviteCodeUseCase(
      unitRepo,
      buildingRepoOwnedBy(OWNER_ID),
      new FakeInviteStore(),
    );

    await expect(
      useCase.execute({ ownerId: OWNER_ID, unitId: 'nope' }),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/property/application/issue-invite-code.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `issue-invite-code.use-case.ts` 작성**

```typescript
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';
import {
  INVITE_CODE_STORE,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

export interface IssueInviteCodeInput {
  ownerId: string;
  unitId: string;
}

@Injectable()
export class IssueInviteCodeUseCase {
  constructor(
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
    @Inject(INVITE_CODE_STORE) private readonly invites: InviteCodeStore,
  ) {}

  async execute(input: IssueInviteCodeInput): Promise<IssuedInvite> {
    const unit = await this.units.findById(input.unitId);
    if (!unit) throw new NotFoundException('unit not found');
    const building = await this.buildings.findById(unit.buildingId);
    if (!building || !building.isOwnedBy(input.ownerId)) {
      throw new ForbiddenException('not the building owner');
    }
    return this.invites.issue({ unitId: unit.id!, issuedBy: input.ownerId });
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/property/application/issue-invite-code.use-case.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: 실패 테스트 작성 — RedeemInviteCode**

`src/property/application/redeem-invite-code.use-case.spec.ts`:
```typescript
import { NotFoundException } from '@nestjs/common';
import { RedeemInviteCodeUseCase } from './redeem-invite-code.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';
import {
  InviteCodePayload,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

const TENANT_ID = 'tenant1';
const UNIT_ID = 'unit1';

class FakeInviteStore implements InviteCodeStore {
  issue(): Promise<IssuedInvite> {
    return Promise.resolve({ code: 'x', expiresInSec: 1 });
  }
  redeem(code: string): Promise<InviteCodePayload | null> {
    return Promise.resolve(
      code === 'GOOD' ? { unitId: UNIT_ID, issuedBy: 'owner1' } : null,
    );
  }
}

class CapturingLeaseRepo implements LeaseRepository {
  public saved: Lease | null = null;
  save(lease: Lease): Promise<Lease> {
    this.saved = Lease.reconstitute({
      id: 'lease-generated',
      unitId: lease.unitId,
      tenantId: lease.tenantId,
      status: lease.status,
    });
    return Promise.resolve(this.saved);
  }
  findByTenant(): Promise<Lease[]> {
    return Promise.resolve([]);
  }
}

describe('RedeemInviteCodeUseCase', () => {
  it('유효한 코드면 입주자를 호실에 연결하는 Lease(ACTIVE)를 만든다', async () => {
    const leaseRepo = new CapturingLeaseRepo();
    const useCase = new RedeemInviteCodeUseCase(new FakeInviteStore(), leaseRepo);

    const lease = await useCase.execute({ tenantId: TENANT_ID, code: 'GOOD' });

    expect(lease.id).toBe('lease-generated');
    expect(lease.unitId).toBe(UNIT_ID);
    expect(lease.tenantId).toBe(TENANT_ID);
    expect(lease.status).toBe(LeaseStatus.ACTIVE);
  });

  it('만료·사용·오타 코드(null)면 NotFoundException', async () => {
    const useCase = new RedeemInviteCodeUseCase(
      new FakeInviteStore(),
      new CapturingLeaseRepo(),
    );

    await expect(
      useCase.execute({ tenantId: TENANT_ID, code: 'EXPIRED' }),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 6: 테스트 실패 확인**

Run: `npx jest src/property/application/redeem-invite-code.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 7: `redeem-invite-code.use-case.ts` 작성**

```typescript
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Lease } from '../domain/lease.entity';
import { LEASE_REPOSITORY, LeaseRepository } from '../domain/lease.repository';
import {
  INVITE_CODE_STORE,
  InviteCodeStore,
} from '../domain/invite-code.store';

export interface RedeemInviteCodeInput {
  tenantId: string;
  code: string;
}

@Injectable()
export class RedeemInviteCodeUseCase {
  constructor(
    @Inject(INVITE_CODE_STORE) private readonly invites: InviteCodeStore,
    @Inject(LEASE_REPOSITORY) private readonly leases: LeaseRepository,
  ) {}

  async execute(input: RedeemInviteCodeInput): Promise<Lease> {
    const payload = await this.invites.redeem(input.code);
    if (!payload) {
      // 만료/이미 사용/존재하지 않음을 구분하지 않는다(코드 존재 여부 미누설)
      throw new NotFoundException('invalid or expired invite code');
    }
    const lease = Lease.create({
      unitId: payload.unitId,
      tenantId: input.tenantId,
    });
    return this.leases.save(lease);
  }
}
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `npx jest src/property/application/redeem-invite-code.use-case.spec.ts`
Expected: PASS (2 passed).

- [ ] **Step 9: 얇은 조회 유스케이스 2종 작성 (규칙 없는 읽기 → 레이어 얇게)**

`src/property/application/list-my-buildings.use-case.ts`:
```typescript
import { Inject, Injectable } from '@nestjs/common';
import { Building } from '../domain/building.entity';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';

@Injectable()
export class ListMyBuildingsUseCase {
  constructor(
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
  ) {}

  execute(ownerId: string): Promise<Building[]> {
    return this.buildings.findByOwner(ownerId);
  }
}
```

`src/property/application/list-my-leases.use-case.ts`:
```typescript
import { Inject, Injectable } from '@nestjs/common';
import { Lease } from '../domain/lease.entity';
import { LEASE_REPOSITORY, LeaseRepository } from '../domain/lease.repository';

@Injectable()
export class ListMyLeasesUseCase {
  constructor(
    @Inject(LEASE_REPOSITORY) private readonly leases: LeaseRepository,
  ) {}

  execute(tenantId: string): Promise<Lease[]> {
    return this.leases.findByTenant(tenantId);
  }
}
```

- [ ] **Step 10: Commit**

```bash
git add src/property/application
git commit -m "feat(m1): IssueInviteCode/RedeemInviteCode + list use cases"
```

---

## Task 8: 인터페이스 레이어 (DTO·컨트롤러) + 모듈 조립

**Files:**
- Create: `src/property/interface/dto/create-building.dto.ts`
- Create: `src/property/interface/dto/create-unit.dto.ts`
- Create: `src/property/interface/dto/redeem-invite.dto.ts`
- Create: `src/property/interface/property.controller.ts`
- Create: `src/property/property.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: DTO 3종 작성**

`src/property/interface/dto/create-building.dto.ts`:
```typescript
import { IsNotEmpty } from 'class-validator';

export class CreateBuildingDto {
  @IsNotEmpty()
  name: string;

  @IsNotEmpty()
  address: string;
}
```

`src/property/interface/dto/create-unit.dto.ts`:
```typescript
import { IsInt, IsNotEmpty } from 'class-validator';

export class CreateUnitDto {
  @IsNotEmpty()
  name: string;

  @IsInt()
  floor: number;
}
```

`src/property/interface/dto/redeem-invite.dto.ts`:
```typescript
import { IsNotEmpty } from 'class-validator';

export class RedeemInviteDto {
  @IsNotEmpty()
  code: string;
}
```

- [ ] **Step 2: `property.controller.ts` 작성**

```typescript
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { RolesGuard } from '../../auth/interface/roles.guard';
import { Roles } from '../../auth/interface/roles.decorator';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { Role } from '../../auth/domain/role.enum';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { CreateBuildingUseCase } from '../application/create-building.use-case';
import { CreateUnitUseCase } from '../application/create-unit.use-case';
import { IssueInviteCodeUseCase } from '../application/issue-invite-code.use-case';
import { RedeemInviteCodeUseCase } from '../application/redeem-invite-code.use-case';
import { ListMyBuildingsUseCase } from '../application/list-my-buildings.use-case';
import { ListMyLeasesUseCase } from '../application/list-my-leases.use-case';
import { CreateBuildingDto } from './dto/create-building.dto';
import { CreateUnitDto } from './dto/create-unit.dto';
import { RedeemInviteDto } from './dto/redeem-invite.dto';

@Controller()
export class PropertyController {
  constructor(
    private readonly createBuilding: CreateBuildingUseCase,
    private readonly createUnit: CreateUnitUseCase,
    private readonly issueInvite: IssueInviteCodeUseCase,
    private readonly redeemInvite: RedeemInviteCodeUseCase,
    private readonly listMyBuildings: ListMyBuildingsUseCase,
    private readonly listMyLeases: ListMyLeasesUseCase,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('buildings')
  async createBuildingHandler(
    @CurrentUser() user: TokenPayload,
    @Body() dto: CreateBuildingDto,
  ) {
    const building = await this.createBuilding.execute({
      ownerId: user.sub,
      name: dto.name,
      address: dto.address,
    });
    return {
      id: building.id,
      name: building.name,
      address: building.address,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Get('buildings')
  async listBuildingsHandler(@CurrentUser() user: TokenPayload) {
    const buildings = await this.listMyBuildings.execute(user.sub);
    return buildings.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
    }));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('buildings/:buildingId/units')
  async createUnitHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
    @Body() dto: CreateUnitDto,
  ) {
    const unit = await this.createUnit.execute({
      ownerId: user.sub,
      buildingId,
      name: dto.name,
      floor: dto.floor,
    });
    return {
      id: unit.id,
      buildingId: unit.buildingId,
      name: unit.name,
      floor: unit.floor,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('units/:unitId/invite-codes')
  async issueInviteHandler(
    @CurrentUser() user: TokenPayload,
    @Param('unitId') unitId: string,
  ) {
    return this.issueInvite.execute({ ownerId: user.sub, unitId });
  }

  @UseGuards(JwtAuthGuard)
  @Post('invite-codes/redeem')
  async redeemInviteHandler(
    @CurrentUser() user: TokenPayload,
    @Body() dto: RedeemInviteDto,
  ) {
    const lease = await this.redeemInvite.execute({
      tenantId: user.sub,
      code: dto.code,
    });
    return { id: lease.id, unitId: lease.unitId, status: lease.status };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/leases')
  async myLeasesHandler(@CurrentUser() user: TokenPayload) {
    const leases = await this.listMyLeases.execute(user.sub);
    return leases.map((l) => ({
      id: l.id,
      unitId: l.unitId,
      status: l.status,
    }));
  }
}
```

- [ ] **Step 3: `property.module.ts` 작성 (DI 바인딩)**

```typescript
import { Module } from '@nestjs/common';
import { PropertyController } from './interface/property.controller';
import { CreateBuildingUseCase } from './application/create-building.use-case';
import { CreateUnitUseCase } from './application/create-unit.use-case';
import { IssueInviteCodeUseCase } from './application/issue-invite-code.use-case';
import { RedeemInviteCodeUseCase } from './application/redeem-invite-code.use-case';
import { ListMyBuildingsUseCase } from './application/list-my-buildings.use-case';
import { ListMyLeasesUseCase } from './application/list-my-leases.use-case';
import { BUILDING_REPOSITORY } from './domain/building.repository';
import { UNIT_REPOSITORY } from './domain/unit.repository';
import { LEASE_REPOSITORY } from './domain/lease.repository';
import { INVITE_CODE_STORE } from './domain/invite-code.store';
import { PrismaBuildingRepository } from './infrastructure/prisma-building.repository';
import { PrismaUnitRepository } from './infrastructure/prisma-unit.repository';
import { PrismaLeaseRepository } from './infrastructure/prisma-lease.repository';
import { RedisInviteCodeStore } from './infrastructure/redis-invite-code.store';

@Module({
  controllers: [PropertyController],
  providers: [
    CreateBuildingUseCase,
    CreateUnitUseCase,
    IssueInviteCodeUseCase,
    RedeemInviteCodeUseCase,
    ListMyBuildingsUseCase,
    ListMyLeasesUseCase,
    { provide: BUILDING_REPOSITORY, useClass: PrismaBuildingRepository },
    { provide: UNIT_REPOSITORY, useClass: PrismaUnitRepository },
    { provide: LEASE_REPOSITORY, useClass: PrismaLeaseRepository },
    { provide: INVITE_CODE_STORE, useClass: RedisInviteCodeStore },
  ],
})
export class PropertyModule {}
```

> **메모:** `PrismaService`(전역 PrismaModule)와 `RedisService`(전역 RedisModule)는 전역 export라 PropertyModule에서 별도 import 없이 주입된다. `JwtAuthGuard`·`RolesGuard`는 클래스 참조로 사용하므로 import만 하면 된다(JWT 전략은 AppModule이 로드한 AuthModule에서 이미 전역 등록됨).

- [ ] **Step 4: `src/app.module.ts` 수정 (RedisModule·PropertyModule 등록)**

`src/app.module.ts` 전체를 다음으로 교체:
```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { PropertyModule } from './property/property.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    AuthModule,
    PropertyModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 5: 빌드 + 전체 단위 테스트 통과 확인**

Run:
```bash
npx tsc --noEmit && npx jest
```
Expected: 컴파일 에러 없음, M0·M1 단위 테스트 전부 PASS(엔티티·RolesGuard·유스케이스).

- [ ] **Step 6: Commit**

```bash
git add src/property/interface src/property/property.module.ts src/app.module.ts
git commit -m "feat(m1): property interface layer (controller, DTOs) + module wiring"
```

---

## Task 9: e2e — 발급→가입→연결 전체 흐름 + RBAC/만료/소유권

**Files:**
- Create: `test/property.e2e-spec.ts`

> **선행:** `docker compose up -d`로 Postgres·Redis가 떠 있고 마이그레이션이 적용된 상태. e2e는 실제 DB·Redis에 쓰므로 정리 로직을 둔다. OWNER 프로비저닝은 M1 범위 밖이라 테스트가 DB에서 직접 role을 승격시킨다.

- [ ] **Step 1: 실패 e2e 테스트 작성**

`test/property.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Property (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ownerEmail = `owner_${Date.now()}@test.com`;
  const tenantEmail = `tenant_${Date.now()}@test.com`;
  let ownerToken: string;
  let tenantToken: string;

  async function signupAndLogin(email: string): Promise<void> {
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
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    prisma = app.get(PrismaService);
    await app.init();

    await signupAndLogin(ownerEmail);
    await signupAndLogin(tenantEmail);
    // OWNER 승격(프로비저닝은 M1 범위 밖) — role을 바꾼 뒤 로그인해야 JWT에 반영됨
    await prisma.user.update({
      where: { email: ownerEmail },
      data: { role: 'OWNER' },
    });
    ownerToken = await login(ownerEmail);
    tenantToken = await login(tenantEmail);
  });

  afterAll(async () => {
    // FK 순서: Lease → Unit → Building → User
    const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (owner) {
      const buildings = await prisma.building.findMany({
        where: { ownerId: owner.id },
        select: { id: true },
      });
      const buildingIds = buildings.map((b) => b.id);
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
      where: { email: { in: [ownerEmail, tenantEmail] } },
    });
    await app.close();
  });

  it('건물주: 건물→호실→초대코드 발급, 입주자: 코드로 가입→호실 자동 연결', async () => {
    const building = await request(app.getHttpServer() as App)
      .post('/buildings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '래미안', address: '서울시 강남구' })
      .expect(201);
    const buildingId = (building.body as { id: string }).id;

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
    expect(typeof code).toBe('string');

    await request(app.getHttpServer() as App)
      .post('/invite-codes/redeem')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ code })
      .expect(201)
      .expect((res) =>
        expect((res.body as { unitId: string }).unitId).toBe(unitId),
      );

    // 입주자의 Lease에 해당 호실이 연결됐는지 확인 (자동 연결 검증)
    await request(app.getHttpServer() as App)
      .get('/me/leases')
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200)
      .expect((res) => {
        const leases = res.body as Array<{ unitId: string; status: string }>;
        expect(leases.some((l) => l.unitId === unitId)).toBe(true);
      });
  });

  it('입주자(TENANT)가 건물 생성 시도 → 403 (RBAC)', async () => {
    await request(app.getHttpServer() as App)
      .post('/buildings')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ name: '무단', address: '주소' })
      .expect(403);
  });

  it('이미 사용된/없는 초대코드 redeem → 404 (단일 사용·만료 불구분)', async () => {
    await request(app.getHttpServer() as App)
      .post('/invite-codes/redeem')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ code: 'definitely-not-a-real-code' })
      .expect(404);
  });

  it('다른 소유자의 건물에 호실 생성 시도 → 403 (소유권 검사)', async () => {
    // owner가 만든 건물 하나를 가져와 tenant를 OWNER로 임시 승격시켜 시도
    const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
    const someBuilding = await prisma.building.findFirst({
      where: { ownerId: owner!.id },
      select: { id: true },
    });
    await prisma.user.update({
      where: { email: tenantEmail },
      data: { role: 'OWNER' },
    });
    const elevatedTenantToken = await login(tenantEmail);

    await request(app.getHttpServer() as App)
      .post(`/buildings/${someBuilding!.id}/units`)
      .set('Authorization', `Bearer ${elevatedTenantToken}`)
      .send({ name: '침입호', floor: 9 })
      .expect(403);

    // 원복
    await prisma.user.update({
      where: { email: tenantEmail },
      data: { role: 'TENANT' },
    });
  });
});
```

- [ ] **Step 2: 인프라 확인 후 e2e 실행**

Run:
```bash
docker compose up -d
npx jest --config ./test/jest-e2e.json
```
Expected: 처음 실행에서 통과. 401/연결 에러 시 `.env`의 `DATABASE_URL`·`REDIS_URL`·`JWT_SECRET`과 마이그레이션 적용 여부를 점검.

- [ ] **Step 3: Commit**

```bash
git add test/property.e2e-spec.ts
git commit -m "test(m1): property e2e (invite issue/redeem→lease, RBAC, single-use, ownership)"
```

---

## Task 10: M1 마무리 검증 & README 상태 갱신

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 전체 검증 (lint·단위·e2e)**

Run:
```bash
npm run lint && npx jest && npx jest --config ./test/jest-e2e.json
```
Expected: lint 0 errors, 모든 단위·e2e PASS.

- [ ] **Step 2: 수동 동작 확인 (서버 기동 후 curl)**

> OWNER 프로비저닝은 M1 범위 밖이므로, 수동 확인 시 가입한 유저를 DB에서 OWNER로 승격한 뒤 로그인한다.

Run(별도 터미널에서 `npm run start:dev` 후):
```bash
# 1) 회원가입
curl -s -X POST localhost:3000/auth/signup -H 'Content-Type: application/json' -d '{"email":"owner1@test.com","name":"건물주","password":"pw123456"}'
# 2) DB에서 OWNER 승격 (psql)
docker compose exec -T postgres psql -U estate -d estate -c "update \"User\" set role='OWNER' where email='owner1@test.com';"
# 3) 로그인 → 토큰 확보
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"owner1@test.com","password":"pw123456"}' | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
# 4) 건물 생성
curl -s -X POST localhost:3000/buildings -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"래미안","address":"서울"}'
```
Expected: 4)에서 `{"id":"...","name":"래미안","address":"서울"}` 반환.

- [ ] **Step 3: README M1 상태 한 줄 갱신**

`README.md` 마일스톤 표의 M1 행 앞에 ✅ 표기를 추가(예: `| **M1** ✅ | 건물/호실/입주 ...`).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(m1): mark M1 complete in milestone table"
```

---

## M1 완료 기준 (Definition of Done)

- [ ] `prisma migrate dev`로 `Building`·`Unit`·`Lease` 테이블 + 관계가 생성됨
- [ ] OWNER가 `POST /buildings` → `POST /buildings/:id/units` → `POST /units/:id/invite-codes`로 초대코드를 발급
- [ ] 초대코드가 Redis에 **TTL(24h)** 로 저장되고, `POST /invite-codes/redeem`이 **GETDEL로 단일 사용** 처리 후 Lease를 생성
- [ ] 입주자가 코드 사용 시 해당 **호실에 자동 연결**(`GET /me/leases`에 unitId 노출)
- [ ] **RBAC:** TENANT가 OWNER 전용 엔드포인트 호출 시 403
- [ ] **소유권 검사:** 다른 소유자의 건물에 호실/코드 생성 시도 시 403
- [ ] 이미 사용/만료/존재하지 않는 코드 redeem 시 404(존재 여부 미누설)
- [ ] 단위 테스트(엔티티·RolesGuard·유스케이스) + e2e 전부 통과, lint 0 errors
- [ ] 도메인/애플리케이션 레이어가 Prisma·ioredis를 직접 import 하지 않음(의존성 역전 유지)

---

## Self-Review 결과

- **스펙 커버리지:** M1 스펙("Building/Unit/Lease + 초대코드(Redis TTL)", 검증="건물주가 코드 발급→입주자 가입 시 호실 자동 연결", 학습="Prisma 관계, Redis TTL, RolesGuard") → Task 2(Prisma 관계 스키마/마이그레이션), Task 3(RBAC), Task 5·7(Redis TTL 초대코드), Task 6·7(소유권), Task 9(전체 흐름 e2e)로 전부 커버. 스펙 6절 보안(RBAC + 리소스 소유권 이중, 코드 존재 여부 미누설) 반영.
- **범위 밖(의도적):** ① InviteCode Postgres 테이블(발급/사용 감사) → 사용자 결정에 따라 Redis 단독, 감사 이력은 M3 Kafka audit-worker로. ② `TenantJoined` 도메인 이벤트 발행 → Kafka 도입(M3) 전이라 M1은 Lease 생성까지만. ③ OWNER 온보딩(프로비저닝) → 별도 관심사라 테스트/수동검증은 DB 직접 승격. ④ rate limit → M6.
- **타입 일관성:** `InviteCodePayload{unitId, issuedBy}`가 발급(IssueInviteCode)·저장(RedisInviteCodeStore)·사용(RedeemInviteCode)에서 동일. `Building.isOwnedBy`가 CreateUnit·IssueInviteCode 소유권 검사에서 일관 사용. 리포지토리 토큰(`BUILDING_REPOSITORY`·`UNIT_REPOSITORY`·`LEASE_REPOSITORY`·`INVITE_CODE_STORE`)이 domain 정의 ↔ module provider 바인딩 ↔ use-case 주입에서 일치. `LeaseStatus.ACTIVE`가 도메인·Prisma 양쪽 동일 문자열.
- **M0 학습 반영:** 테스트 가짜는 `async` 화살표 대신 `Promise.resolve()` 반환(require-await 회피), e2e는 `getHttpServer() as App`·`res.body as {...}` 캐스팅(no-unsafe-* 회피)으로 작성해 lint 0 errors를 선제 보장.
