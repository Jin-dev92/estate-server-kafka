# M2.6 — Swagger(OpenAPI) 연동 설계 스펙

> 작성일: 2026-06-13 · 상태: 설계 확정(구현 계획 미착수)
> 성격: cross-cutting 문서화 마일스톤. **M3 앞에 삽입**(라벨 `M2.6`). 새 비즈니스 기능이 아니라 API 자동 문서화 인프라 + 기존 엔드포인트 레트로핑 + 향후 필수 규칙.
> 선행: M2.5(전역 에러 처리) 머지. 브랜치: 새 워크플로대로 `dev`에서 `feat/m2.6-swagger` 분기.

---

## 0. 목적

수기로 관리하던 API 표(README)를 넘어, **코드에서 자동 생성되는 OpenAPI 문서/UI**를 제공한다. FE·미래의 나·리뷰어가 `/docs`에서 요청·응답·인증·에러 계약을 즉시 확인하고, 요청 바디를 바로 시험(Try it out)할 수 있게 한다. 동시에 **앞으로 추가되는 모든 API는 Swagger 문서화를 필수**로 하는 규칙을 정립한다.

핵심 요구: enum이 포함된 DTO에 대해 **enum이 가질 수 있는 값 목록을 UI에 명시**한다(예: `category`는 `NOTICE | FREE`).

---

## 1. 현황 & 문제

- `@nestjs/swagger` 미설치. `main.ts`는 기본 부팅(ValidationPipe만).
- 컨트롤러 3개(`auth`/`property`/`board`)·요청 DTO 8개가 데코레이터 없이 존재 → 외부에서 API 계약을 코드로만 파악.
- M2.5에서 에러 봉투(`{ statusCode, code, message, path, timestamp }`)를 통일했으나 문서에 스키마로 드러나지 않음.
- enum 필드(`CreatePostDto.category: PostCategory`)의 허용값이 문서로 노출되지 않음.

---

## 2. 설계 결정 (트레이드오프)

1. **`@nestjs/swagger` 표준 채택.** NestJS 1급 통합으로 데코레이터 기반 자동 생성. 대안(수기 OpenAPI yaml)은 코드와 동기화가 깨져 기각.

2. **인프라 + 기존 3컨트롤러 전체 레트로핑.** 셋업만 하고 미루지 않고, auth/property/board의 모든 기존 엔드포인트에 데코레이터를 적용한다.
   - *근거:* `/docs`가 처음부터 완전하고, 이후 추가 API의 **참조 예시**가 된다. study 프로젝트라 레트로핑 비용 감수.

3. **응답 DTO 클래스는 도입하지 않음(KISS/YAGNI).** 컨트롤러가 plain 객체를 반환하므로 성공 응답은 `@ApiResponse`의 설명+예시로 문서화하고, 엔드포인트별 응답 DTO 10여 개는 만들지 않는다. 필요해지면 그때 추가.

4. **enum은 명명된 스키마로 노출.** enum 필드는 `@ApiProperty({ enum: XxxEnum, enumName: 'XxxEnum' })`로 표기한다.
   - `enum`만 주면 각 스키마에 값이 인라인되지만, `enumName`을 함께 주면 **재사용 가능한 명명 스키마**(`#/components/schemas/PostCategory`)로 분리돼 문서가 깔끔하고 중복이 사라진다.
   - *근거:* 이번 요구의 핵심(허용값 표기) 충족 + 여러 곳에서 같은 enum 재사용 시 단일 출처.

5. **에러 봉투를 Swagger 스키마로 연계.** M2.5의 `ErrorResponse`를 문서화용 `ErrorResponseDto`(`@ApiProperty` 보유)로 1개 만들고, 4xx 응답을 이 스키마로 참조한다. 런타임 타입은 기존 `ErrorResponse` 인터페이스를 유지(문서 전용 클래스만 추가).

6. **규칙 강제는 경량(문서 + 리뷰).** CLAUDE.md에 "신규 API Swagger 필수" 규칙을 명문화하고 `/review`가 누락을 잡는다. 자동 lint/CI 검사는 study 범위에 과해 기각(YAGNI).

7. **하드코딩 금지 준수.** Swagger 문서 제목·버전·경로(`docs`) 등 문자열은 상수로 추출(`const`/`ConfigKey`) — CLAUDE.md 코드 컨벤션.

---

## 3. 구성요소

### 3.1 부팅 (`main.ts`)
- `DocumentBuilder`로 제목·설명·버전 구성 + `.addBearerAuth()`(JWT Bearer).
- `SwaggerModule.createDocument(app, config)` → `SwaggerModule.setup(<docs 경로>, app, document)`.
- 노출: **`/docs`**(Swagger UI), **`/docs-json`**(OpenAPI JSON).
- 문서 메타 문자열은 상수로(`src/config` 또는 `src/common`의 `const`).

### 3.2 컨트롤러 데코레이터 (auth/property/board 레트로핑)
- 컨트롤러: `@ApiTags(<컨텍스트>)`.
- 라우트: `@ApiOperation({ summary })`, 성공 응답 `@ApiResponse({ status, description, ... })`(대표 예시 포함).
- 인증 라우트(`JwtAuthGuard`/`RolesGuard` 사용): `@ApiBearerAuth()`.
- 에러 응답: 해당 라우트가 낼 수 있는 4xx를 `@ApiResponse({ status, type: ErrorResponseDto })`로 표기(예: 게시글 조회 404, 멤버 아님 403).

### 3.3 요청 DTO `@ApiProperty` (8개)
- 일반 필드: `@ApiProperty({ description, example, required })`.
- **enum 필드: `@ApiProperty({ enum: XxxEnum, enumName: 'XxxEnum', required })`.**

### 3.4 enum 인벤토리 (허용값 표기 대상)
| enum | 값 | 등장 위치 |
|---|---|---|
| `PostCategory` | `NOTICE`, `FREE` | 요청 DTO `CreatePostDto.category`(선택) → `@ApiProperty({ enum })` |
| `Role` | `OWNER`, `TENANT`, `ADMIN` | 응답(`auth/me`, signup 결과) → `@ApiResponse` 예시/스키마에 enum 표기 |
| `LeaseStatus` | `ACTIVE`, `ENDED` | 응답(초대코드 redeem 결과 Lease) → `@ApiResponse` 예시/스키마에 enum 표기 |

> 요청 바디에 직접 들어가는 enum은 현재 `PostCategory` 하나. 나머지(`Role`·`LeaseStatus`)는 응답에 등장하므로 응답 문서화 시 enum 값을 함께 노출한다. 향후 enum 요청 필드가 생기면 동일하게 `@ApiProperty({ enum, enumName })` 적용(규칙으로 명문화).

### 3.5 에러 문서화 클래스
- `ErrorResponseDto`(문서 전용): `statusCode`·`code`·`message`·`path`·`timestamp`에 `@ApiProperty`. M2.5 `ErrorResponse` 인터페이스와 필드 동일.

---

## 4. 규칙 (CLAUDE.md — 신규 API Swagger 필수)

CLAUDE.md에 섹션 추가. 새 엔드포인트는 다음을 **필수**로 한다:
- 컨트롤러 `@ApiTags`, 라우트 `@ApiOperation` + 성공 `@ApiResponse`.
- 인증 라우트 `@ApiBearerAuth`.
- 낼 수 있는 4xx에 대한 에러 `@ApiResponse`(`ErrorResponseDto` 참조).
- 요청 DTO 모든 필드 `@ApiProperty`; **enum 필드는 `enum` + `enumName` 필수**.
- `/review`가 누락을 점검(기존 "API 문서화" 규칙과 병행 — README 표 + Swagger 둘 다).

---

## 5. 테스트 / 검증

- e2e 1건: `GET /docs-json` → 200, OpenAPI 문서에 `auth`/`property`/`board` 태그와 주요 경로가 존재하고, `components.schemas`에 `PostCategory`(값 `NOTICE`/`FREE`)·`ErrorResponseDto`가 포함됨을 검증. (UI가 아닌 스펙 JSON 단위로 안정 확인.)
- 기존 단위·e2e 불변(데코레이터는 런타임 동작에 영향 없음).
- `npm run lint`·`npx tsc --noEmit` 통과.

**학습 포인트:** NestJS Swagger 데코레이터, OpenAPI 스키마 컴포넌트, enum 명명 스키마(`enumName`), 문서-코드 단일 출처, Bearer 인증 문서화.

---

## 6. 마일스톤 배치

| 단계 | 내용 | 비고 |
|---|---|---|
| M2.5 | 전역 에러 처리 | 머지됨 |
| **M2.6** | **Swagger 연동 + 기존 엔드포인트 레트로핑 + 신규 API 필수 규칙** | **M3 앞 삽입** |
| M3 | Kafka 도입 + audit-worker | M2.6 이후 |

---

## 7. 명시적으로 범위 밖 (YAGNI)

- **응답 DTO 전면 도입** — 성공 응답은 `@ApiResponse` 설명/예시로 충분, 기각.
- **prod에서 `/docs` 비활성/인증 게이팅** — study 프로젝트라 항상 노출. 운영 전환 시 env 게이팅 검토(언급만).
- **자동 lint/CI 데코레이터 검사** — 경량 규칙+리뷰로 대체.
- **API 버저닝(`/v1`)·다중 문서** — 추후.
