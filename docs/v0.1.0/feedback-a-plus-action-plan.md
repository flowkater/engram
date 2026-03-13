# A+ 피드백 반영 계획 — Unified Memory MCP Server

> 작성: FORGE | 날짜: 2026-03-08
> 소스: `docs/feedback-a-plus.md` (JARVIS, 7건)
> 현재: A- (85/85 tests) → 목표: A+

---

## 실행 전략

파일 충돌 최소화를 위해 **2 Wave**로 분할.

### Wave A — DB/검색/도구 (서브에이전트 1)
독립 모듈 위주. 기존 코드 수정 최소, 신규 파일 추가 중심.

| # | 항목 | 예상 | 대상 파일 |
|---|------|------|----------|
| 1 | 태그 정규화 테이블 | 1.5h | `database.ts` (스키마), 신규 `utils/tags.ts`, `indexer.ts`, `add.ts`, `summary.ts` |
| 2 | memory.health 도구 | 1h | 신규 `tools/health.ts`, `server.ts` (도구 등록) |
| 3 | Adaptive fetch | 30m | `search.ts` |
| 4 | graph dedup | 15m | `graph.ts` |

### Wave B — 운영/테스트 (서브에이전트 2)
인프라/테스트 레이어. Wave A와 파일 겹침 없음.

| # | 항목 | 예상 | 대상 파일 |
|---|------|------|----------|
| 5 | watcher diff scan | 45m | `watcher.ts`, `server.ts` (시작 시 호출) |
| 6 | restore 도구 | 45m | 신규 `tools/restore.ts`, `server.ts` (도구 등록) |
| 7 | E2E 통합 테스트 | 2h | 신규 `test/e2e/`, fixture vault 제작 |

---

## 상세 스펙

### 1. 태그 정규화 테이블 ⭐⭐⭐

**신규 테이블:**
```sql
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON memory_tags(tag);
```

**변경점:**
- `database.ts`: 스키마에 `memory_tags` 추가
- `add.ts`, `summary.ts`, `indexer.ts`: INSERT 트랜잭션에 `memory_tags` INSERT 포함
- `indexer.ts` (softDeleteByPath): `memory_tags`도 DELETE
- `prune.ts`: `delete-related.ts` 헬퍼에 `memory_tags` 추가
- `graph.ts`: 태그 기반 링크 조회를 `LIKE` → `memory_tags` 인덱스 룩업
- **신규** `utils/tags.ts`: `parseTags(tags: string | string[]): string[]` + `insertTags(db, memoryId, tags)`

**DoD:** 태그 검색 테스트, 기존 LIKE 쿼리 제거 확인

### 2. memory.health 도구 ⭐⭐⭐

**신규 파일:** `tools/health.ts`

**검사 항목:**
- orphanedMemories: memories(deleted=0)에 있는데 vec에 없는 레코드
- orphanedVectors: vec에 있는데 memories(deleted=0)에 없는 레코드
- orphanedFts: FTS에 있는데 memories(deleted=0)에 없는 레코드
- orphanedTags: memory_tags에 있는데 memories(deleted=0)에 없는 레코드
- modelMismatch: embed_model별 카운트
- linkIntegrity: memory_links의 from_id/to_id가 존재하지 않는 레코드

**server.ts:** 9번째 MCP 도구로 등록

**DoD:** health 도구 테스트, 의도적 정합성 깨뜨리기 → 감지 확인

### 3. Adaptive Fetch ⭐⭐

**변경:** `search.ts`
```
fetchMultiplier = 5 → 결과 부족 시 10 → 20 → 최대 3회 시도
```

**DoD:** scope가 전체의 5% 미만인 테스트에서 limit개 결과 반환 확인

### 4. Graph Dedup ⭐

**변경:** `graph.ts`
- outgoing + incoming을 `UNION`으로 가져오기
- 또는 결과 Set에서 `id` 기준 dedup

**DoD:** A→B + B→A 양방향 링크 시 중복 없이 1건만 반환

### 5. Watcher Diff Scan ⭐⭐

**변경:** `watcher.ts`에 `diffScan(db, vaultPath)` 함수 추가
- `MAX(updated_at)` 이후 `mtime` 기준 변경 파일 탐지
- `startWatcher()` 호출 시 watcher 시작 전에 diff scan 선행

**DoD:** 서버 다운타임 동안 변경된 파일이 재시작 후 인덱싱되는 테스트

### 6. Restore 도구 ⭐

**신규 파일:** `tools/restore.ts`
- soft-deleted 메모리를 복원: `deleted=0` + 재임베딩 + FTS/vec/tags 재생성
- 트랜잭션으로 원자적 처리

**server.ts:** 10번째 MCP 도구로 등록 (`memory.restore`)

**DoD:** delete → restore → search에서 정상 반환 테스트

### 7. E2E 통합 테스트 ⭐⭐

**신규 디렉토리:** `test/e2e/`
**Fixture vault:** `test/e2e/fixtures/sample-vault/` (10~15개 .md 파일)
- 프론트매터 + 위키링크 + 태그 포함
- 다양한 scope 시뮬레이션

**테스트 시나리오:**
1. vault 인덱싱 → stats 확인
2. 키워드 검색 → 관련 결과 반환
3. scope 필터 검색 → 정확한 scope만 반환
4. graph 탐색 → wikilink 기반 연결 확인
5. add → search → prune → search(없음) 라이프사이클
6. health 도구 → 정합성 확인

**DoD:** E2E 6건 전체 통과 (임베딩은 mock)

---

## 도구 변경 요약

| 도구 | 변경 |
|------|------|
| memory.search | Adaptive fetch (3회 시도) |
| memory.graph | UNION dedup |
| memory.health | **신규** (9번째) |
| memory.restore | **신규** (10번째) |

---

## 테스트 목표

현재 85 → **목표 105+** (신규 ~20건)
- tags 관련: 4건
- health: 3건
- adaptive fetch: 2건
- graph dedup: 1건
- restore: 3건
- diff scan: 2건
- E2E: 6건

---

## 실행 명령

```
Wave A (서브에이전트 1): 태그 정규화 + health + adaptive fetch + graph dedup
Wave B (서브에이전트 2): watcher diff scan + restore + E2E 테스트
```

**총 예상: ~6.5h → A+ 달성**
**완료 후**: CLAUDE.md, AGENTS.md, README.md 업데이트 (10 MCP tools)
