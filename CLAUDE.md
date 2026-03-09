# CLAUDE.md — Engram Phase 0 재실행 (유실 복구)

## 프로젝트
- 경로: ~/Projects/engram
- 브랜치: master
- 현재: 144 tests passed
- 스택: TypeScript + SQLite + sqlite-vec + Vitest

## TDD 규칙
- Red → Green → Refactor
- 각 작업 완료 시 `npm test` + `npx tsc --noEmit` 통과 후 개별 커밋
- 커밋 후 반드시 `git push origin master`

## 목표: Phase 0 유실 태스크 4개 재실행

---

### Task 0-1: STRICT_LOCAL 기본값 (Critical)

**문제**: embedder.ts에서 OPENAI_API_KEY가 있으면 자동 fallback → "100% local" 포지셔닝 불일치

**수정**:
- `src/embedder.ts`에 `STRICT_LOCAL` 플래그 추가
- 환경변수 `ENGRAM_STRICT_LOCAL` (기본값: `true`)
- `true`일 때 OpenAI fallback 차단, Ollama만 사용
- `false`로 명시적 설정 시에만 OpenAI fallback 허용

```typescript
const strictLocal = (process.env.ENGRAM_STRICT_LOCAL ?? 'true') !== 'false';
if (strictLocal) {
  // OpenAI fallback 차단 — Ollama only
}
```

**테스트**:
1. STRICT_LOCAL=true (기본) → OpenAI API 키 있어도 Ollama만 사용
2. STRICT_LOCAL=false → OpenAI fallback 허용
3. env 미설정 → strict local 기본 동작

**커밋**: `feat: STRICT_LOCAL default — block OpenAI fallback by default`

---

### Task 0-2: embed_model provenance (Major)

**문제**: `memories` 테이블 CREATE 문에 `embed_model` 컬럼 없음. ALTER TABLE로만 추가 → 스키마 drift.

**수정**:
- `src/database.ts`의 CREATE TABLE memories에 `embed_model TEXT` 컬럼 추가
- ALTER TABLE 마이그레이션은 기존 DB 호환용으로 유지 (IF NOT EXISTS)
- embed 시 모델명 기록: `ollama:nomic-embed-text` 또는 `openai:text-embedding-3-small`

**테스트**:
1. 새 DB 생성 시 embed_model 컬럼 존재 확인
2. 메모리 저장 시 embed_model 값 기록 확인
3. 기존 DB (컬럼 없음) → ALTER 마이그레이션 정상

**커밋**: `feat: embed_model in CREATE TABLE — eliminate schema drift`

---

### Task 0-3: source_path 정규화 (Medium)

**문제**: 단일 파일 ingest 시 source_path에 basename만 저장 → 경로 충돌 위험

**수정**:
- `src/indexer.ts`에서 source_path 저장 전 `path.resolve()` 적용
- 이미 absolute path면 그대로, relative면 resolve
- 기존 `source_path relative→absolute migration` 커밋(17ceb5f)이 있으므로, 그 로직과 일관성 유지

**테스트**:
1. relative path 입력 → absolute path 저장
2. absolute path 입력 → 그대로 저장
3. basename만 입력 → cwd 기준 resolve

**커밋**: `fix: source_path normalization — always store absolute paths`

---

### Task 0-4: README/주석 drift (Minor)

**수정**:
- README.md에서 실제 코드와 불일치하는 부분 수정
- MCP 도구 목록 10개 정확히 반영
- 설치/사용법 현재 코드 기준으로 업데이트
- tsc 에러 있으면 수정

**커밋**: `docs: sync README with current codebase — fix drift`

---

## 완료 기준

```bash
npm test              # 전체 통과
npx tsc --noEmit      # 0 errors
```

## 완료 후

```bash
git push origin master
```
