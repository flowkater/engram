# CLAUDE.md — Engram Phase 0: 신뢰 회복

## 프로젝트 개요
Engram: 로컬 AI 에이전트 메모리 MCP 서버. SQLite + sqlite-vec + FTS5 + Ollama.

## 기술 스택
- Node.js 22+ / TypeScript 5
- better-sqlite3 + sqlite-vec + FTS5
- Ollama nomic-embed-text (768-dim)
- MCP SDK (@modelcontextprotocol/sdk)
- Vitest

## 테스트
```bash
npm test          # Vitest 실행 (현재 108 tests, 18 files)
npx tsc --noEmit  # 타입 체크
npm run build     # 빌드
```

## 개발 방법론
- **TDD (Red→Green→Refactor)**
- Feature 단위 커밋 (fix: ..., refactor: ..., docs: ...)
- 각 작업 완료 시 `npm test` 통과 확인 후 git commit

---

## 작업 목록 (순서대로)

### Task 0-1: strict local-only 기본값

현재 문제: `src/core/embedder.ts`에서 Ollama 실패 시 OPENAI_API_KEY가 있으면 자동으로 OpenAI로 fallback. README는 "100% local, privacy-first"라고 명시. 모순.

수정:
1. `embedder.ts`에 `STRICT_LOCAL` 모드 추가 (기본값: `true`)
   - 환경변수 `ENGRAM_STRICT_LOCAL` (기본 "true")
   - strict local 모드에서는 OpenAI fallback 하지 않음. Ollama 실패 시 그대로 throw
   - `ENGRAM_STRICT_LOCAL=false`로 명시적 opt-in해야 OpenAI fallback 활성화
2. `embed()` 함수에서 strict local 체크 추가
3. `README.md` Environment Variables에 `ENGRAM_STRICT_LOCAL` 추가
4. 테스트 추가:
   - strict local 모드에서 Ollama 실패 시 OpenAI fallback 안 하고 throw
   - strict local false 시 기존처럼 fallback 동작

DoD: strict local 기본값 + 테스트 통과 + README 반영

### Task 0-2: embed_model provenance 수정

현재 문제: `getCurrentModelName()`은 항상 `ollama/<model>`을 반환. OpenAI fallback이 실제로 일어나도 DB에는 Ollama로 기록됨. 이건 재인덱싱 판단과 데이터 정합성에 치명적.

수정:
1. `embed()` 함수의 `withModel: true` 오버로드를 **기본 경로로** 활용
   - `add.ts`, `summary.ts`, `restore.ts`, `ingest.ts`에서 embed 호출 시 `withModel: true` 사용
   - 반환된 `EmbedResult.model`을 `embed_model`에 저장
2. `getCurrentModelName()` 의존 제거 — 실제 호출 결과의 model을 사용
3. `getCurrentModelName()`은 deprecated 마크 (health check의 model mismatch 감지용으로만 유지)
4. 테스트: embed가 OpenAI fallback 했을 때 "openai/text-embedding-3-small" 반환 확인

DoD: embed_model이 실제 사용 모델 기록 + 기존 108 테스트 통과

### Task 0-3: source_path 정규화

현재 문제: 단일 파일 ingest에서 `source_path`에 basename만 저장. 서로 다른 디렉토리의 같은 파일명 충돌 가능.

수정:
1. `src/tools/ingest.ts` 확인 — source_path 저장 로직
2. 단일 파일: basename → **상대 경로** (VAULT_PATH 기준) 또는 **절대 경로**
3. 디렉토리 인덱싱(`indexer.ts`): 이미 상대 경로 사용하는지 확인, 아니면 수정
4. 기존 데이터와의 호환성: 마이그레이션은 불필요 (새 ingest부터 적용)
5. 테스트: 같은 basename, 다른 경로의 파일 2개 ingest → 충돌 없이 별도 저장

DoD: source_path가 최소 상대 경로 + 테스트 통과

### Task 0-4: README/주석 drift 정리

현재 문제:
- README Quick Start: "81 tests expected" → 실제 108개
- server.ts 상단 주석: "8 MCP tools" → 실제 10개
- `memory.ingest`의 `recursive` 파라미터가 스키마에 있지만 실제 미사용
- AGENTS.md의 scope 외부화 명세 vs scope.ts 하드코딩

수정:
1. README: "81 tests" → "108 tests" 수정
2. server.ts 상단 주석 확인 및 10 tools로 수정 (있으면)
3. `ingest` tool 스키마에서 `recursive` 파라미터: 구현하거나 제거 (구현이 복잡하면 제거)
4. `AGENTS.md`가 있으면 scope 관련 명세 현실화
5. 기타 코드 내 주석에서 발견되는 숫자 불일치 수정

DoD: README/주석/스키마가 실제 코드와 100% 일치

---

## 완료 시 알림
전체 작업 완료 후 반드시 실행:
```bash
openclaw system event --text "Done: Engram Phase 0 — trust recovery complete" --mode now
```
