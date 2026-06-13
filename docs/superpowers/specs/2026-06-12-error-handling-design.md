# M2.5 — 전역 에러 처리 + 커스텀 예외 설계 스펙

> 작성일: 2026-06-12 · 상태: 설계 확정(구현 계획 미착수)
> 성격: cross-cutting 품질 마일스톤. **M3 앞에 최우선**으로 삽입(라벨 `M2.5`). 새 기능이 아니라 기존 에러 처리의 일원화·리팩터.
> 선행: M2 머지. 구현은 M2(Board) 코드까지 포함된 main 위에서 진행한다.

---

## 0. 목적

에러 응답을 **FE가 일관된 구조로 받고 안정적으로 분기**할 수 있게 만든다. 현재는 `throw new NotFoundException('post not found')`처럼 **HTTP status와 영어 메시지가 코드 곳곳에 하드코딩**돼 있어, ① 메시지 문구가 바뀌면 FE 분기가 깨지고 ② 같은 404라도 "글 없음"과 "건물 없음"을 FE가 구분하기 어렵고 ③ 메시지를 한곳에서 관리할 수 없다.

해결: **안정적인 앱 비즈니스 코드(`code`) + HTTP status + 한국어 메시지**를 담은 통일된 에러 봉투를 전역 ExceptionFilter로 내려준다. 메시지는 컨텍스트별 카탈로그에 모아 중앙 관리한다.

---

## 1. 현황 & 문제

- **애플리케이션 레이어(24곳):** `NotFoundException`/`ForbiddenException`/`ConflictException`/`UnauthorizedException`에 영어 메시지 하드코딩 → 401/403/404/409.
- **도메인 레이어(14곳):** 순수 `throw new Error('title is required')`. NestJS HttpException이 아니라 **전역 핸들러가 없으면 500으로 샌다**(현재 ValidationPipe가 DTO 입력을 경계에서 막아 실사용에선 거의 안 터지지만, 구조적 갭).
- 전역 ExceptionFilter 없음. 에러 응답 형태는 NestJS 기본값에 의존.

---

## 2. 설계 결정 (트레이드오프)

1. **앱 비즈니스 코드 + HTTP status.** 응답에 `code`(안정 식별자)와 `statusCode`(HTTP)를 함께 싣는다.
   - *근거:* 메시지/다국어 변경에 FE가 휘둘리지 않고 `code`로 분기. 같은 status도 종류 구분 가능.
   - *대안 기각:* "status+message만"은 메시지 문자열 의존이라 취약. "자체 숫자 코드 체계(40401 등)"는 의미-매핑 관리 부담이 커 YAGNI.

2. **컨텍스트별 정의 + 중앙 메커니즘.** 공통(`AppException` 기반·전역 필터·응답 구조)은 `src/common/errors/`에 중앙화하고, **에러 코드 정의는 각 컨텍스트 폴더에 코로케이션**한다.
   - *근거:* "전역 관리"의 본질은 *일관된 메커니즘*이지 *하나의 거대 파일*이 아니다. 컨텍스트 경계 유지 + 단일 카탈로그의 비대화·머지충돌 회피.

3. **framework-free `DomainError`.** 도메인 엔티티는 NestJS를 import할 수 없으므로(의존성 역전), 순수 TS 클래스 `DomainError`(code 보유)를 던지고 전역 필터가 4xx(422)로 매핑한다.
   - *근거:* 도메인 순수성 유지 + 불변식 위반도 통일된 에러 구조로 FE에 전달. 대안("도메인은 500 취급")은 단순하지만 일관성이 깨진다.

4. **에러 응답만 통일(성공 응답 불변).** 2xx 성공 응답은 원시 데이터 그대로 두고, 4xx/5xx만 봉투로 감싼다.
   - *근거:* 기존 엔드포인트 응답·e2e·문서화한 API를 깨지 않으면서 일관성 확보. 전체 응답 래핑은 변경 폭이 과해 기각.

5. **메시지는 한국어.** 사용자 노출 문구를 한국어로 중앙화. `code`가 안정 식별자라 추후 i18n(code→언어별 메시지) 확장도 자연스럽다.

---

## 3. 에러 응답 계약 (FE가 받는 구조 — 4xx/5xx에만)

```json
{
  "statusCode": 404,
  "code": "BOARD_POST_NOT_FOUND",
  "message": "게시글을 찾을 수 없습니다.",
  "path": "/posts/abc123",
  "timestamp": "2026-06-12T08:00:00.000Z"
}
```

| 필드 | 의미 |
|---|---|
| `statusCode` | HTTP 상태 코드(숫자). |
| `code` | 안정적 앱 비즈니스 코드. **FE 분기 기준.** 메시지가 바뀌어도 불변. |
| `message` | 한국어 사용자 메시지. |
| `path` | 요청 경로(디버깅). |
| `timestamp` | ISO 8601 발생 시각(디버깅). |

---

## 4. 구성요소

### 4.1 중앙 메커니즘 — `src/common/errors/`

- **`AppException extends HttpException`** — 비즈니스 에러용 커스텀 예외. `{ code, status, message }` 형태의 에러 스펙을 받아 보유. HTTP status는 super로 전달(라우팅 호환), `code`·`message`를 노출.
- **`DomainError extends Error`** — 순수 TS(NestJS 미import). `code`(기본 `VALIDATION_FAILED`) + 메시지 보유. **도메인 레이어가 import**한다(이 파일은 프레임워크 의존 0이어야 함).
- **`ErrorResponse`** — 3절 봉투의 타입 정의.
- **`AllExceptionsFilter`**(`@Catch()`) — 전역 등록(main.ts `app.useGlobalFilters`). 매핑 규칙은 5절.
- **공통 에러 코드** — `COMMON_VALIDATION_FAILED`(400, ValidationPipe 등), `COMMON_INTERNAL_ERROR`(500), 필요 시 `COMMON_UNAUTHORIZED`(401) 등.

### 4.2 컨텍스트별 카탈로그 (코로케이션)

- `src/auth/auth.errors.ts` · `src/property/property.errors.ts` · `src/board/board.errors.ts`
- 각 파일은 `code`·`status`·한국어 `message`를 담은 const 객체를 export. 예:
  - `BoardError.POST_NOT_FOUND = { code: 'BOARD_POST_NOT_FOUND', status: 404, message: '게시글을 찾을 수 없습니다.' }`
  - `BoardError.NOT_AUTHOR = { …, status: 403 }`, `BoardError.NOT_BUILDING_MEMBER = { …, status: 403 }`
- 코드는 **기존 HTTP status에 1:1 매핑**(404/403/409/401)하여 status 기반 e2e가 그대로 통과하도록 한다.

### 4.3 코드 ↔ 기존 throw 매핑(예시)

| 기존 throw | 새 코드(status) |
|---|---|
| `ConflictException('email already in use')` | `AUTH_EMAIL_IN_USE` (409) |
| `UnauthorizedException('invalid credentials')` | `AUTH_INVALID_CREDENTIALS` (401) |
| `ForbiddenException('insufficient role')` | `AUTH_INSUFFICIENT_ROLE` (403) |
| `NotFoundException('building not found')` | `PROPERTY_BUILDING_NOT_FOUND` (404) |
| `ForbiddenException('not the building owner')` | `PROPERTY_NOT_BUILDING_OWNER` (403) |
| `NotFoundException('unit not found')` | `PROPERTY_UNIT_NOT_FOUND` (404) |
| `NotFoundException('invalid or expired invite code')` | `PROPERTY_INVALID_INVITE_CODE` (404) |
| `NotFoundException('post not found')` | `BOARD_POST_NOT_FOUND` (404) |
| `ForbiddenException('not the author')` | `BOARD_NOT_AUTHOR` (403) |
| `ForbiddenException('not a building member')` | `BOARD_NOT_BUILDING_MEMBER` (403) |
| 도메인 `Error('… is required')` | `DomainError('VALIDATION_FAILED', '…는 필수입니다.')` (422) |

---

## 5. 매핑 규칙 (AllExceptionsFilter)

`@Catch()`로 모든 예외를 받아 다음 순서로 봉투를 만든다:

1. `AppException` → 그 `status`·`code`·`message`.
2. `DomainError` → **422** + 그 `code`·`message`.
3. NestJS 기본 `HttpException`(예: ValidationPipe 400, 혹은 미이주 잔여) → `getStatus()` + 파생 `code`(예: 400→`COMMON_VALIDATION_FAILED`, 401→`COMMON_UNAUTHORIZED`, 그 외 `HTTP_<status>`) + 응답에서 메시지 추출.
4. 그 외 알 수 없는 `Error` → **500** `COMMON_INTERNAL_ERROR`, 일반 메시지(내부 세부 미누출). 5xx는 서버 로깅.

모든 분기에서 `path`·`timestamp`를 채운다.

---

## 6. 이주 범위 & 테스트

**이주:**
- 애플리케이션 24곳 throw → `throw new AppException(<컨텍스트>Error.XXX)`.
- 도메인 14곳 `Error` → `throw new DomainError('VALIDATION_FAILED', '<한국어 메시지>')`.
- main.ts에 전역 필터 등록.

**테스트 전환(핵심):**
- 기존 단위 테스트의 `rejects.toThrow(ForbiddenException)` / 메시지 문자열 검증 → **안정적인 `code` 검증**으로 전환(예: 던져진 예외의 `code === 'BOARD_NOT_BUILDING_MEMBER'`). 메시지 언어에 독립적이라 한국어 전환과 충돌 없음.
- 신규: `AllExceptionsFilter` 단위(각 에러 타입 → 봉투 매핑 검증), e2e 1~2건(에러 응답 본문이 `{ statusCode, code, message, path, timestamp }` 형태이고 **status는 기존과 동일**함을 확인).
- status 기반 기존 e2e(401/403/404/409)는 코드↔status 1:1 매핑 덕에 그대로 통과해야 한다.

**학습 포인트:** 전역 ExceptionFilter, 커스텀 예외(HttpException 확장), 도메인 순수성을 지킨 에러 전파(DomainError), 안정 코드 기반 계약.

---

## 7. 마일스톤 배치

| 단계 | 내용 | 비고 |
|---|---|---|
| M2 | 게시판 + Redis 캐시 | (PR #7) |
| **M2.5** | **전역 에러 처리 + 커스텀 예외 + 일관 에러 봉투** | **M3 앞 최우선 삽입** |
| M3 | Kafka 도입 + audit-worker | M2.5 이후 |

> M3 이후 컨슈머·이벤트에서 발생하는 에러도 같은 메커니즘 위에서 다루게 되므로, M3 전에 에러 처리를 일원화해 두는 것이 비용이 낮다(최우선 근거).

---

## 8. 명시적으로 범위 밖 (YAGNI)

- **성공 응답 래핑**(2xx 봉투) — 변경 폭 과다, 기각.
- **자체 숫자 코드 체계**(40401 등) — 관리 부담, 기각.
- **i18n(다국어 메시지)** — `code` 기반 구조로 추후 확장 가능하게만 열어 두고, 이번엔 한국어 단일.
- **rate limit·보안 강화** — M6 소관(별개).
- **에러 추적/모니터링 연동(Sentry 등)** — 추후.
