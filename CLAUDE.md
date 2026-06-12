# estate-server

NestJS 기반 백엔드 서버.

---

## NestJS Test Code Rules

> 출처: iCloud `claude/docs/nestjs-test-rules.md`

### 구조

- 테스트 파일은 대상 파일과 동일한 디렉토리에 위치 (`*.spec.ts`)
- `describe → describe(context) → it` 3계층 구조 사용
- `it` 설명은 행위 중심으로 서술 (`'should return user when id is valid'`)
- 단위 / 통합 / e2e 테스트를 디렉토리 또는 파일명으로 명확히 구분

### 테스트 격리

- 각 테스트는 순서에 의존하지 않고 독립적으로 실행 가능해야 함
- `beforeEach`에서 모듈 및 mock 초기화
- `afterEach`에서 `jest.clearAllMocks()` 호출
- describe 스코프 밖 변수의 mutation 금지

### Mocking

외부 의존성(DB, HTTP, 메시지큐 등)은 항상 mock 처리한다.

```ts
// ✅
const mockUserRepository = {
  findOne: jest.fn(),
  save: jest.fn(),
} satisfies Partial<jest.Mocked<UserRepository>>;

// ❌
const mockUserRepository: any = { findOne: jest.fn() };
```

- `as any` 캐스팅 금지 — `Partial<jest.Mocked<T>>` 사용
- Repository mock은 `getRepositoryToken(Entity)` 활용
- `jest.spyOn`은 실제 구현 일부를 유지하면서 감시할 때만 사용

### Assertion

| 상황 | 사용 |
|------|------|
| 원시값 비교 | `toBe` |
| 객체 구조 비교 | `toEqual` |
| 타입까지 엄격 비교 | `toStrictEqual` |

- 비동기 에러 테스트에서는 `expect.assertions(n)`으로 assertion 개수 보장

### 테스트 설계

- **AAA 패턴** 엄수 — Arrange / Act / Assert 각 블록 사이 빈 줄로 구분
- 하나의 `it` 블록에는 하나의 관심사만
- happy path뿐 아니라 edge case / error case 필수 커버
- magic number / string은 상수로 추출

```ts
// ✅
const USER_ID = 1;
const mockUser = createMockUser({ id: USER_ID });

// ❌
const mockUser = { id: 1, name: 'test' };
```

### 픽스처

반복되는 테스트 데이터는 factory 함수로 추출한다.

```ts
function createMockUser(overrides?: Partial<User>): User {
  return { id: 1, email: 'test@example.com', ...overrides };
}
```

### NestJS 특화

- 서비스 단위테스트는 `Test.createTestingModule()`로 DI 컨텍스트 구성
- 컨트롤러 레이어 없이 서비스만 격리해서 테스트
- Guard / Interceptor / Pipe 등 Cross-cutting concern은 별도 spec으로 분리
- 특정 provider만 교체할 때는 `overrideProvider` 활용
- 통합 테스트에서 실제 DB 연결 시 테스트 전용 DB 사용
- 해당 프로젝트는 공부용 이기 때문에 설명이 필요한 부분은 주석을 달 것.

### git
- 커밋 메시지
  - 커밋 메시지는 기능에 대한 설명을 꼭 한글로
  - 커밋 메시지 형식은 {기능}: [티켓번호] {커밋 설명}  