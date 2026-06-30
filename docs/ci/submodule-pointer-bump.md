# web 서브모듈 포인터 자동 갱신 설정

> estate-web `.github/workflows/bump-submodule-pointer.yml` — estate-web `main`이 머지되면
> 이 레포(estate-server)의 `web` 서브모듈 포인터를 그 SHA로 올리는 PR을 자동 생성한다.
> 지금까지 수동으로 만들던 `[infra]chore: web 서브모듈 포인터 갱신` PR을 자동화한 것.

---

## 무엇을 하나

- **트리거**: estate-web `push: main`(=PR 머지).
- **동작**: estate-web 워크플로가 PAT로 estate-server를 checkout → `web` gitlink를 머지 SHA로 갱신
  → 단일 롤링 브랜치 `chore/auto-bump-web-submodule`에 force push → `gh pr create`/`edit`(idempotent).
- **머지**: 자동 PR도 estate-server CI(checks·migrations)를 거쳐 **사람이 머지**한다(완전 무인 아님 — 안전장치).

## 왜 PAT가 필요한가

GitHub Actions 기본 `GITHUB_TOKEN`은 **워크플로가 도는 레포(estate-web)에만** 권한이 있다.
estate-web 워크플로가 **estate-server**를 checkout·push·PR 생성하려면 크로스 레포 권한이 필요하므로
Fine-grained PAT를 estate-web Secret으로 둔다.

---

## 레포 1회 선행 설정 (사용자 작업)

워크플로 파일이 있어도 **Secret이 없으면 동작하지 않는다**(워크플로가 PAT 가드에서 실패). 아래를 먼저 한다.

### 1) Fine-grained PAT 발급

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token

- **Resource owner**: `Jin-dev92`
- **Repository access**: Only select repositories → **estate-server-kafka**만
- **Permissions** (Repository permissions):
  - **Contents**: Read and write
  - **Pull requests**: Read and write
- **Expiration**: 정책에 맞게(만료 시 워크플로가 실패로 알림 → 재발급)

### 2) estate-web Secret 등록

estate-web → Settings → Secrets and variables → Actions → New repository secret

- **Name**: `SUBMODULE_BUMP_TOKEN`
- **Secret**: 위에서 발급한 PAT 값

---

## 동작 확인

estate-web에 사소한 PR을 `main`에 머지한다 → 수 분 내 estate-server에
`[infra]chore: web 서브모듈 포인터 갱신 (→ <sha7>)` PR이 자동 생성되면 정상.

## 트러블슈팅

| 증상 | 원인 / 조치 |
|---|---|
| 워크플로가 "SUBMODULE_BUMP_TOKEN 미설정"으로 실패 | Secret 미등록 → 위 2) 수행 |
| checkout/push 403 | PAT 권한 부족(Contents/PR write) 또는 estate-server 미선택 → PAT 재발급 |
| PR이 안 생김 + 로그 "포인터 동일" | 이미 같은 SHA(정상, 변경 없음) |
| 갑자기 실패 | PAT 만료 → 재발급 후 Secret 갱신 |

## 한계

- 자동 PR도 **사람이 머지**한다(CI·리뷰 유지).
- 단일 롤링 브랜치라 PR 본문은 최신 머지 SHA만 반영(중간 이력은 PR 타임라인).
- 이 자동화를 "추가하는" estate-web 머지 자체는 혜택을 못 받음(이후 머지부터 작동).
