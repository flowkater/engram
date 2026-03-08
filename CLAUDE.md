# CLAUDE.md — Engram Phase 1: 데이터 정합성

## 프로젝트
- 경로: ~/Projects/engram
- 브랜치: master
- 현재: 113 tests, 20 files, tsc 0 errors
- 스택: TypeScript, Vitest, SQLite (better-sqlite3 + sqlite-vec + FTS5), tsup

## TDD 규칙
- Red → Green → Refactor
- 테스트 먼저, 구현 후, 리팩토링
- 각 Task 완료 시 `npm test` 전체 통과 확인 후 커밋
- 커밋 컨벤션: `feat:`, `fix:`, `test:`, `refactor:`, `docs:`

## 실행 순서 (순차, 의존성 있음)

Task 1-4 → Task 1-2 → Task 1-3 → Task 1-1

---

## Task 1-4: ingest `recursive` 파라미터 제거

### 수정
1. `src/tools/ingest.ts`: `IngestParams`에서 `recursive` 필드 삭제, 사용 코드 제거
2. `src/server.ts`: MCP tool 스키마에서 `recursive` property 삭제
   - **주의**: MCP SDK 스키마가 `.strict()` vs `.passthrough()` 확인. strict이면 하위 호환성 깨짐 가능
3. 기존 ingest 테스트에서 recursive 참조 있으면 수정

### 검증
```bash
npx tsc --noEmit  # 0 errors
npm test          # 전체 통과
```

### 커밋
```
fix: remove unused recursive parameter from ingest tool
```

---

## Task 1-2: scope 하드코딩 제거

### 수정
1. `src/utils/scope.ts`:
   - `DEFAULT_SCOPE_MAP = {}` (빈 객체)
   - `DEFAULT_OBSIDIAN_SCOPE_MAP = {}` (빈 객체)

2. `config.example.json` 생성 (프로젝트 루트):
```json
{
  "scopeMap": {
    "todait-backend": "/workspace/todait/todait/todait-backend",
    "todait-ios": "/workspace/todait/todait/todait-ios",
    "data-pipeline": "/Projects/data-pipeline",
    "scrumble-backend": "/Projects/scrumble-backend",
    "blog": "/Projects/flowkater.io",
    "openclaw": "/.openclaw",
    "mentoring": "/Obsidian/flowkater/flowkater/Mentoring"
  },
  "obsidianScopeMap": {
    "Project/todait-backend-v2/": "todait-backend",
    "Project/todait-ios/": "todait-ios",
    "Project/data-pipeline/": "data-pipeline",
    "Project/Todait/": "todait",
    "Mentoring/": "mentoring",
    "Blog/": "blog",
    "Study/": "study",
    "Daily/": "daily"
  }
}
```

3. README에 scope 설정 + 마이그레이션 경고 추가:
   - "config.json 없이 재인덱싱하면 기존 scope와 불일치 발생 가능"
   - "config.example.json 참고하여 ~/.engram/config.json 생성 권장"

### 테스트 (7개) — `src/utils/scope.test.ts` 생성

**테스트 setup**: 각 테스트에서 `process.env.HOME`을 tmpdir로 오버라이드 + `resetScopeConfigCache()` 호출. `vi.mock('fs')` 사용하지 않고 실제 파일 생성.

```
1. config.json 없음 → detectScope("anything") === "global"
2. config.json 없음 → detectObsidianScope("Project/foo.md") === "global"
3. config.json 존재 + scopeMap → 올바른 scope 반환
4. config.json 존재 + obsidianScopeMap → 올바른 scope 반환
5. config.json 파싱 에러 (잘못된 JSON) → graceful fallback to "global"
6. config.json에 scopeMap만 있고 obsidianScopeMap 없음 → obsidian은 "global"
7. resetScopeConfigCache() 후 config 변경 → 새 설정 반영
```

### 기존 테스트 영향
- 기존 scope 관련 테스트가 하드코딩 기본값에 의존하면 수정 필요
- `resetScopeConfigCache()` 호출 후 테스트하면 됨

### 커밋
```
feat: remove hardcoded scope maps — config.json only, default to "global"
```

---

## Task 1-3: minScore 0~1 정규화

### 수정
1. `src/tools/search.ts` — `memorySearch()` 함수:
   - RRF merge 후, minScore 필터 전에 정규화 삽입:
```typescript
// Normalize scores to 0~1 (max score = 1.0)
if (merged.length > 0) {
  const maxScore = merged[0].score;
  if (maxScore > 0) {
    for (const item of merged) {
      item.score = item.score / maxScore;
    }
  }
}
```

2. `src/server.ts` — MCP 스키마 description 수정:
   - `minScore` description: "Minimum relevance score (0~1 normalized, where 1.0 = best match). Default: 0"

3. README — minScore 가이드라인 + 한계 문서화:
   - "동일 점수 결과 → 전부 1.0 (의도된 동작: 차별화 불가)"
   - "결과 1건 → 항상 1.0 (품질 판단 불가)"

### 단위 테스트 (8개) — `src/tools/search.test.ts`에 추가 또는 별도 파일

RRF 정규화 로직을 직접 테스트. mock embedder 사용.

```
1. 정규화 후 최고 점수가 1.0
2. 두 번째 결과 점수가 0 < score < 1.0
3. minScore: 0.5 → 하위 절반 필터링
4. 결과 0건 → 빈 배열 (division by zero 없음)
5. 결과 1건 → score = 1.0
6. 모든 결과가 동일 RRF score → 전부 1.0
7. minScore: 0 → 전체 반환 (기본값 하위 호환)
8. minScore: 1.0 → 최고 점수만 반환
```

### 통합 테스트 (2개) — `src/core/full-pipeline.test.ts` 확장

실제 sqlite-vec + FTS5 사용:
```
9. vec만 결과 있고 FTS 0건 → 정규화 정상
10. FTS만 결과 있고 vec 0건 → 정규화 정상
```

### 커밋
```
feat: normalize minScore to 0~1 scale — max score always 1.0
```

---

## Task 1-1: file-level checkpoint (diffScan 개선) — 가장 큰 작업

### 수정

1. `src/core/database.ts` — 스키마 추가:
```sql
CREATE TABLE IF NOT EXISTS file_checkpoints (
  source_path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_source ON file_checkpoints(source);
```

2. `src/core/watcher.ts` — `diffScan()` 전면 리팩토링:

**핵심 로직:**
```
전체 .md 파일 순회:
  - stat → mtime 확인
  - file_checkpoints에서 source_path로 조회
  - checkpoint 없음 or mtime > file_mtime_ms:
    - stat → mtime_before
    - indexFile(db, absPath, absPath, opts)   // absPath = path.resolve()
    - stat → mtime_after
    - mtime_before === mtime_after → UPSERT checkpoint
    - mtime_before !== mtime_after → skip checkpoint (race condition 방지)

checkpoint에 있지만 vault에 없는 파일:
  - softDeleteByPath(db, source_path)
  - DELETE FROM file_checkpoints WHERE source_path = ?
```

**제약:**
- `source_path`는 반드시 **절대경로** (`path.resolve()`) — memories.source_path와 동일 형식
- checkpoint UPSERT는 diffScan 내부에서 수행 (indexFile은 checkpoint을 모름)
- 기존 `MAX(updated_at)` watermark 로직 제거

3. `isAlreadyIndexed` 호출은 indexFile 내부에서 여전히 hash 기반 skip — 변경 없음

### 테스트 (14개) — `src/core/watcher.test.ts` 수정/추가

**setup**: tmpDir + tmpDb, 각 테스트마다 독립 DB 인스턴스 (기존 패턴 유지)

```
Happy path:
1. checkpoint 테이블 생성 확인 (openDatabase 후 테이블 존재)
2. 최초 diffScan → 전체 파일 인덱싱 + checkpoint 생성
3. 수정 없이 재실행 → 0건 인덱싱 (checkpoint mtime 일치)
4. 파일 A 수정 → diffScan → A만 재인덱싱
5. 파일 삭제 → diffScan → soft delete + checkpoint 제거
6. 새 파일 추가 → diffScan → 새 파일만 인덱싱

핵심 버그 방지:
7. 파일 A,B 존재 → B 인덱싱 후 A 수정 → diffScan → A 감지
8. 파일 A,B 동시 수정 → A만 먼저 인덱싱 → B도 다음 배치에서 감지

Edge case:
9a. diffScan 단위: mtime 변경(touch) → indexFile 호출됨
9b. indexer 단위: 동일 hash → isAlreadyIndexed가 skip
10. checkpoint 있지만 memories 없음 (수동 DB 삭제) → 재인덱싱
11. 빈 디렉토리 → diffScan 에러 없이 {scanned: 0, indexed: 0}
12. .obsidian/.trash 내 파일 변경 → 무시
13. 기존 DB (checkpoint 테이블 없음) → 마이그레이션 후 전체 인덱싱
14. 인덱싱 중 파일 재수정 (mtime_before ≠ mtime_after) → checkpoint 미기록
```

### 커밋
```
feat: file-level checkpoint for diffScan — eliminate watermark gap
```

---

## 완료 기준

모든 Task 완료 후:

```bash
npm test              # 전체 통과 (~144 tests)
npx tsc --noEmit      # 0 errors
npm run build         # 성공
```

## 완료 후

```bash
openclaw system event --text "Done: Engram Phase 1 — data integrity complete. Tests: $(npm test 2>&1 | grep 'Tests' | head -1)" --mode now
```
