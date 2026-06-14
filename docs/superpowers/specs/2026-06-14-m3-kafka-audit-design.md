# M3 — Kafka 도입 + audit-worker 설계 스펙

> 작성일: 2026-06-14 · 상태: 설계 확정(구현 계획 미착수)
> 성격: 이벤트 드리븐 아키텍처의 첫걸음. 도메인 이벤트 발행(producer) + 감사 소비(consumer) 왕복.
> 선행: M2.6(Swagger) 머지. 브랜치: `dev`에서 `feat/m3-kafka-audit` 분기.
> 관련: [전체 설계 스펙 §4·§6](2026-06-11-building-owner-platform-design.md) · [README §6 마일스톤](../../../README.md)

---

## 0. 목적

도메인에서 의미 있는 일이 일어날 때(`PostCreated`, `CommentCreated`, `TenantJoined`, `LeaseEnded`) **Kafka로 도메인 이벤트를 발행**하고, 부작용 없는 **audit-worker**가 이를 소비해 `AuditLog`에 적재한다.

M3의 학습 본질은 **"DB 변경 → Kafka 발행 → consumer 적재"의 producer/consumer 왕복**이다. audit는 부작용(읽기 모델 변경·외부 호출)이 없어 실패 비용이 가장 낮으므로 첫 소비자로 적합하다(persistence는 M4, notification은 M5).

---

## 1. 현황 & 문제

- docker-compose에 **Kafka 브로커(cp-kafka, KRaft 단일 노드)는 M0부터 기동** 중. 호스트 포트 `9092`.
- `.env.example`의 `KAFKA_BROKERS="localhost:9092"`, `ConfigKey.KafkaBrokers`는 **이미 정의됨**(M0 준비분).
- 그러나 애플리케이션에는 **Kafka 패키지·KafkaModule·producer·consumer·이벤트 발행 코드가 전무**하고, `AuditLog` 모델도 없다.
- 발행 지점 유스케이스 현황:
  - `CreatePostUseCase`(PostCreated), `CreateCommentUseCase`(CommentCreated), `RedeemInviteCodeUseCase`(TenantJoined) — **존재**.
  - `LeaseEnded`의 발행 지점(계약 종료 기능) — **없음**. `LeaseRepository`도 `save`/`findByTenant`만 있고 `findById`가 없다.

---

## 2. 설계 결정 (트레이드오프)

1. **이벤트 범위: 현재 도메인 전체 4종.** `board-events`(PostCreated, CommentCreated) + `membership-events`(TenantJoined, LeaseEnded). `chat-events`(MessageSent)는 채팅이 없는 단계라 M4 소관.

2. **Kafka 연동: `@nestjs/microservices` (hybrid app).** `ClientKafka` producer + `@EventPattern` consumer. NestJS 표준으로 DI 통합이 깔끔하고 데코레이터 기반이라 간결. 대안인 raw `kafkajs` 직접 제어는 보일러플레이트가 많아 보류(컨슈머 그룹·offset을 직접 다루는 학습은 향후 필요 시).

3. **발행 추상화: 접근 A — application 레이어 직접 발행.** 유스케이스가 DB 저장 성공 후 `EventPublisher` 포트로 직접 발행한다. 도메인 엔티티는 이벤트 수집 메커니즘을 갖지 않는다(현재 순수 엔티티 유지).
   - *근거:* M3 본질(producer/consumer 왕복)에 집중. 도메인 이벤트 수집(record→pull) 패턴은 보일러플레이트가 크고 본질을 흐린다.
   - *트레이드오프:* 유스케이스마다 발행을 수동 호출 → 누락 위험. repository 인터페이스처럼 포트로 캡슐화해 도메인은 Kafka를 모른다(의존성 역전 유지).

4. **정합성: after-commit 단순 발행 + 멱등 소비.** DB 저장 성공 후 Kafka에 발행하고, 발행 실패는 **에러 로깅만** 하고 유스케이스는 성공 반환한다.
   - *한계(의도된 수용):* "DB엔 썼는데 발행 직전 크래시"하면 이벤트가 유실되는 dual-write 창이 존재한다.
   - *해소 경로:* **M6의 Transactional Outbox** 패턴(도메인 변경과 outbox 행을 같은 트랜잭션에 커밋 → relay가 발행)으로 원천 제거한다. M3은 이를 의도적으로 미룬다.
   - *멱등 소비(필수):* Kafka는 at-least-once라 중복 소비가 가능하다. `AuditLog.eventId`에 `@unique`를 걸고, 소비자는 중복(P2002) 발생 시 무시한다.

5. **파티션 키 = `entityId`.** 같은 엔티티에 대한 이벤트가 파티션 내 순서를 유지하도록 한다(Kafka는 파티션 내 순서만 보장).

6. **end-lease 도메인 기능 신규 추가.** `LeaseEnded`의 발행 지점을 만들기 위해 계약 종료 유스케이스·엔드포인트를 함께 도입한다(범위에 포함).

---

## 3. AuditLog 스키마

```prisma
model AuditLog {
  id         String   @id @default(cuid())
  eventId    String   @unique          // 멱등 키 — 중복 소비 시 재적재 방지
  eventType  String                    // PostCreated | CommentCreated | TenantJoined | LeaseEnded
  actorId    String?                   // 행위자(userId). 시스템 이벤트 대비 nullable
  entityType String                    // Post | Comment | Lease
  entityId   String
  payload    Json                      // 이벤트별 추가 데이터
  occurredAt DateTime                  // 발행 측 발생 시각
  createdAt  DateTime @default(now())  // 소비 측 적재 시각
  @@index([entityType, entityId])
  @@index([eventType])
}
```

- 마이그레이션: `prisma migrate dev --name add_audit_log`.
- `AuditLog`는 다른 모델과 FK로 직접 잇지 않는다(감사 로그는 원본이 삭제돼도 남아야 하고, 여러 컨텍스트의 엔티티를 가리키므로 `entityType`+`entityId` 문자열 참조로 느슨하게 둔다).

---

## 4. 이벤트 봉투 & 토픽

### 4.1 공통 봉투 (`DomainEvent`)

```ts
interface DomainEvent<T = unknown> {
  eventId: string;        // uuid v4 — 멱등 키
  eventType: EventType;   // const enum
  occurredAt: string;     // ISO 8601
  actorId: string | null; // 행위자 userId
  entityType: EntityType; // const enum: Post | Comment | Lease
  entityId: string;
  payload: T;
}
```

- `EventType`·`EntityType`·토픽명은 모두 `const enum`/`as const` 상수로 중앙 정의(매직스트링 금지, CLAUDE.md).

### 4.2 토픽 매핑

| 토픽 (`KafkaTopic`) | 이벤트 (`EventType`) | payload 예시 |
|---|---|---|
| `board-events` | `PostCreated` | `{ buildingId, category, title }` |
| `board-events` | `CommentCreated` | `{ postId }` |
| `membership-events` | `TenantJoined` | `{ unitId, buildingId }` |
| `membership-events` | `LeaseEnded` | `{ unitId, endedAt }` |

`eventType → topic` 매핑은 발행 측 `KafkaEventPublisher`가 단일 출처로 관리한다.

---

## 5. 발행 측 (Producer)

### 5.1 포트 & 구현

- `EventPublisher` 포트(인터페이스): `publish(event: DomainEvent): Promise<void>`. 공유 위치(`src/events/` 또는 `src/common/`)에 둔다.
- `KafkaEventPublisher`(infrastructure): `ClientKafka`로 `eventType`에 매핑된 토픽에 발행. 메시지 key=`entityId`, value=봉투 JSON.
- DI: `EVENT_PUBLISHER` 심볼 토큰으로 주입(repository 패턴과 동일).

### 5.2 발행 지점 (DB 저장 성공 후)

| 유스케이스 | 이벤트 | 비고 |
|---|---|---|
| `CreatePostUseCase` | PostCreated | 기존 유스케이스에 발행 추가 |
| `CreateCommentUseCase` | CommentCreated | 기존 유스케이스에 발행 추가 |
| `RedeemInviteCodeUseCase` | TenantJoined | 기존 유스케이스에 발행 추가 |
| `EndLeaseUseCase` (신규) | LeaseEnded | §7 신규 기능 |

- `eventId`=uuid v4, `occurredAt`=발행 시점, `actorId`=요청 사용자.
- 발행은 `try/catch`로 감싸 실패 시 **에러 로깅만** 하고 유스케이스는 성공으로 반환(after-commit 한계, §2.4).

---

## 6. 소비 측 (audit-worker)

### 6.1 hybrid app 부트스트랩

`main.ts`에서 HTTP 앱에 Kafka 마이크로서비스를 연결한다:
```ts
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.KAFKA,
  options: {
    client: { brokers: [config KAFKA_BROKERS] },
    consumer: { groupId: 'audit-worker' },
  },
});
await app.startAllMicroservices();
await app.listen(port);
```

### 6.2 AuditModule

- `AuditWorkerController`: `@EventPattern(KafkaTopic.BoardEvents)`·`@EventPattern(KafkaTopic.MembershipEvents)`로 구독. 수신 봉투를 `AuditLogRepository`로 적재.
- `AuditLogRepository`(포트) + `PrismaAuditLogRepository`(구현): `record(event)` — `AuditLog.create`.
- **멱등 소비:** `eventId @unique`라 중복 수신 시 `create`가 P2002를 던진다 → 잡아서 무시(이미 적재됨)하고 로깅. (upsert 대신 create+P2002 무시로 "중복은 비정상이지만 안전하게 흘려보냄"을 명시.)
- consumer group `audit-worker` 단일. persistence(M4)·notification(M5)은 별도 그룹으로 같은 토픽을 독립 팬아웃.

---

## 7. end-lease 도메인 기능 (신규)

- `Lease` 도메인에 `end()` 메서드: `status` `ACTIVE→ENDED`, `endDate=now`. 이미 `ENDED`면 `DomainError`.
- `LeaseRepository`에 **`findById(id)` 추가**(현재 없음). `PrismaLeaseRepository`에도 구현.
- `EndLeaseUseCase`: `findById` → 권한 검사(해당 건물 OWNER) → `end()` → `save` → `LeaseEnded` 발행.
  - 권한: 입주 관리 주체는 건물주이므로 **건물 OWNER만** 종료 가능. (소유권 검사는 기존 membership/ownership 체커 패턴 재사용 — 계획 단계에서 정확한 의존성 확정.)
- **엔드포인트:** `PATCH /leases/:id/end` — 계약 종료. 인가: 해당 건물 OWNER. Swagger 데코레이터 필수(`@ApiOperation`, `@ApiResponse`, `@ApiBearerAuth`, 4xx는 `ErrorResponseDto`).

---

## 8. 모듈·설정

- 패키지 추가: `@nestjs/microservices`, `kafkajs`.
- `KafkaModule`: `ClientsModule.register`로 `ClientKafka`(producer) 등록 + 토픽/이벤트 상수 export. 전역(`@Global`) 또는 필요한 모듈에 import.
- `.env`/`ConfigKey.KafkaBrokers`는 기존 값 재사용(추가 작업 없음).
- 토픽은 단일 노드 Kafka **auto-create**(복제계수 1)에 의존. 명시적 토픽 생성 스크립트는 두지 않는다(YAGNI).

---

## 9. 에러 처리 & 테스트

### 에러 처리
- 발행 실패: 로깅 후 유스케이스 성공 반환(§2.4).
- 소비 중복(P2002): 로깅 후 무시(멱등).
- 소비 중 그 외 예외: 로깅 후 throw해 Kafka가 재시도하게 둔다(at-least-once 활용).

### 테스트
- 유스케이스 단위테스트(4종): `EventPublisher` mock 주입 → `publish` 호출 여부·봉투 필드(eventType/entityType/entityId/payload) 검증.
- `KafkaEventPublisher`: `eventType→topic` 매핑·메시지 key(=entityId) 단위테스트(`ClientKafka` mock).
- audit-worker: 정상 적재 + **중복 eventId 무시(멱등)** 단위테스트(`AuditLogRepository` mock으로 P2002 시나리오).
- `Lease.end()` 도메인 단위테스트: 정상 종료 + 이미 ENDED면 `DomainError`.

---

## 10. 성공 기준

- [ ] `AuditLog` 모델 + 마이그레이션 적용.
- [ ] `@nestjs/microservices`+`kafkajs` 설치, `KafkaModule`·`EventPublisher`/`KafkaEventPublisher` 구성.
- [ ] 4개 유스케이스가 DB 저장 성공 후 해당 이벤트를 올바른 토픽에 발행.
- [ ] hybrid app으로 audit-worker가 두 토픽을 구독해 `AuditLog`에 적재.
- [ ] 같은 `eventId` 중복 수신 시 재적재되지 않음(멱등).
- [ ] `PATCH /leases/:id/end`로 계약 종료(OWNER 전용) → `LeaseEnded` 발행 → AuditLog 적재 end-to-end 동작.
- [ ] 단위테스트 통과(발행·매핑·멱등·도메인), 기존 테스트 무회귀.

---

## 11. 범위 밖 (명시)

- **Transactional Outbox** → M6. 이벤트 유실(dual-write) 방지는 M3 범위 밖이며 M6에서 해소한다.
- **persistence-worker / notification-worker** → M4 / M5. M3은 audit 단일 소비자만.
- **chat-events / MessageSent** → 채팅(M4) 도입 시.
- 토픽 보존 정책·파티션 수 튜닝·스키마 레지스트리 → 향후 필요 시.
