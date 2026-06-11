# PR 리뷰 워크플로

이 레포의 PR 코드 리뷰 운영 방식.

## 현재 (학습용): Claude Code `/review` 로 로컬 리뷰

학습용 프로젝트라 OpenAI API/구독 비용 없이, **Claude Code의 `/review` 스킬**로
PR을 올리기 전에 로컬에서 리뷰한다. 리뷰는 Claude가 직접 수행하므로 OpenAI
계정 상태(ChatGPT 플랜, API 결제)와 무관하게 동작한다.

절차:

1. feature 브랜치에서 작업한다.
2. Claude Code에서 `/review` 를 실행한다.
   - 현재 브랜치의 `merge-base(origin/main, HEAD)` 대비 diff를 분석한다.
   - 리뷰 기준에는 이 레포의 보안 원칙(RLS / rate limit / API 키 노출 / RBAC,
     `CLAUDE.md` 참조)이 포함된다.
3. 리뷰 결과를 확인하고, 필요한 수정을 반영한다.
4. PR을 생성한다. (Claude에게 "리뷰 코멘트 달아서 PR 만들어줘"라고 하면
   리뷰 요약을 PR 코멘트로 함께 게시한다.)

비용 0, 추가 설정 없음.

## 미래 (상업화): GitHub Actions CI 자동 리뷰

서버사이드 자동 리뷰가 필요해지면 `.github/workflows/codex-review.yml` 을
활성화한다. 이 워크플로는 검증을 마친 뒤 **비활성 상태로 보존**돼 있다.
(`pull_request` 가 non-draft 가 될 때 codex CLI 로 리뷰 → PR 요약 코멘트, 비차단.)

활성화 방법은 해당 파일 상단 주석 참조. 요약하면:

1. 레포 Secret 에 결제된 `OPENAI_API_KEY` 등록
2. `on:` 의 `pull_request` 트리거 주석 해제 + `workflow_dispatch` 제거
3. job 가드를 `vars.ENABLE_CODEX_CI == 'true'` 에서 draft 가드로 교체
   (또는 리포지토리 변수 `ENABLE_CODEX_CI=true` 설정)

설계/구현 기록: `docs/superpowers/specs/2026-06-12-codex-pr-review-pipeline-design.md`,
`docs/superpowers/plans/2026-06-12-codex-pr-review-pipeline.md`.
