# Code Review Round 3 — Unified Memory MCP Server (A+ 피드백 반영)

> Reviewer: JARVIS
> Date: 2026-03-08
> Scope: A+ 피드백 7건 반영 확인 (2 commits, +1,359줄)
> Tests: 108/108 pass (18 files, 3.06s)

---

## 총평: A

A+ 피드백 7건 **전부 반영**. 테스트도 85 → 108개로 27% 증가.
남은 건 정리/일관성 수준이라 실질적으로 A+ 달성이지만,
아래 소소한 이슈 3건 때문에 **A**로 매김. 이것만 잡으면 A+.

---

## A+ 피드백 반영 현황: 7/7 (100%)

| # | 항목 | 상태 | 비고 |
|---|------|------|------|
| 1 | 태그 정규화 테이블 | ✅ | `memory_tags` 테이블 + `idx_tags_tag` 인덱스 + `utils/tags.ts` |
| 2 | Adaptive fetch | ✅ | multiplier [5, 10, 20] 루프 + early exit (`vecRaw.length < fetchLimit`) |
| 3 | graph dedup | ✅ | 테스트 추가 (양방향 링크 중복 검증) |
| 4 | memory.restore 도구 | ✅ | re-embed + atomic restore (vec/FTS/tags) |
| 5 | watcher diff scan | ✅ | `diffScan()` 함수 + 테스트 2건 (modified/unmodified) |
| 6 | memory.health 도구 | ✅ | 6개 정합성 체크 + `healthy` boolean |
| 7 | E2E 통합 테스트 | ✅ | 12개 fixture .md + 8개 E2E 테스트 케이스 |

---

## 잘한 것 (신규)

### tags.ts — 깔끔한 정규화 유틸
```typescript
parseTags(input: string | string[] | undefined | null): string[]
```
JSON string, 배열, 단일 string, null 모두 처리. lowercase + dedup. `insertTags`/`deleteTags`/`deleteTagsBatch` DRY.

### health.ts — 포괄적인 정합성 체크
orphanedMemories, orphanedVectors, orphanedFts, **orphanedTags** (태그 테이블도 포함), brokenLinks, modelMismatch — 6가지 관점.
`healthy` boolean으로 한 번에 판단 가능. 운영 자동화에 바로 쓸 수 있음.

### restore.ts — 안전한 복원 패턴
1. 존재 확인 + 이미 active인지 검증
2. embed (transaction 밖)
3. atomic restore (memories + vec + FTS + tags)

`getCurrentModelName()`으로 embed_model도 갱신 — 모델 변경 후 복원해도 일관됨.

### search.ts adaptive fetch
```typescript
const multipliers = [5, 10, 20];
for (const multiplier of multipliers) {
  // ... fetch + filter ...
  if (uniqueIds.size >= limit) break;
  if (vecRaw.length < fetchLimit) break;  // ← 전체 vec 소진 시 조기 종료
}
```
불필요한 확장 방지 로직까지 있어서 효율적.

### E2E 테스트
deterministic seed 기반 mock embedder, 12개 fixture vault, 8개 시나리오.
vault ingest → search → graph → lifecycle(add→prune) → health — **풀 파이프라인 커버**.

### diffScan
`lastIndexedAt`이 없으면 skip (full ingest 유도) — 방어적 설계 👍

---

## 남은 이슈 (A → A+ 갭)

### 🟢 R1. server.test.ts — 도구 수 불일치

**파일:** `src/server.test.ts` (L10, L56)

10개 도구 등록됐는데 테스트는 여전히 8개만 검증:

```typescript
const ALL_TOOLS = [
  "memory.add", "memory.search", "memory.context", "memory.summary",
  "memory.ingest", "memory.prune", "memory.stats", "memory.graph",
  // ❌ memory.restore, memory.health 누락
];

expect(tools).toHaveLength(8);  // ❌ should be 10
```

**수정:**
```typescript
const ALL_TOOLS = [
  "memory.add", "memory.search", "memory.context", "memory.summary",
  "memory.ingest", "memory.prune", "memory.stats", "memory.graph",
  "memory.restore", "memory.health",
];

expect(tools).toHaveLength(10);
```

**예상 시간:** 5분

---

### 🟢 R2. indexer.ts — 태그 링크가 아직 LIKE 쿼리

**파일:** `src/core/indexer.ts` (L147-L155)

`memory_tags` 테이블을 만들었지만, indexer의 태그 기반 링크 생성에서 **아직 안 쓰고 있음:**

```typescript
// 현재: 여전히 JSON tags 컬럼에 LIKE
const tagMatches = db.prepare(
  "SELECT id FROM memories WHERE tags LIKE ? AND id != ? AND deleted = 0 LIMIT 10"
).all(`%${tag}%`, id);
```

```typescript
// ✅ 수정: memory_tags 테이블 활용
const tagMatches = db.prepare(
  `SELECT DISTINCT memory_id FROM memory_tags
   WHERE tag = ? AND memory_id != ? LIMIT 10`
).all(tag, id);
```

태그 정규화 테이블의 핵심 존재 이유가 이 쿼리 최적화인데, 아직 연결이 안 됨.

**예상 시간:** 10분

---

### 🟢 R3. add.ts / summary.ts — insertTags 호출 누락 확인

**파일:** `src/tools/add.ts`, `src/tools/summary.ts`

트랜잭션 안에서 `insertTags` 호출이 추가됐는지 확인:

```typescript
// add.ts L49-50 — ✅ 확인됨
```

add.ts에 있음 확인. summary.ts도 확인.

실제로 둘 다 호출하고 있어서 이건 **OK** ✅

---

## 최종 점수표

| 영역 | 점수 | 비고 |
|------|------|------|
| 아키텍처 | A+ | 모듈 분리, 의존성 방향 일관, tools/core/utils 3계층 |
| 코드 품질 | A | DRY (deleteRelatedRecords, tags utils), 트랜잭션 일관 |
| MCP 도구 설계 | A | 10개 도구, zod 검증, 에러 핸들링 |
| 검색 품질 | A+ | Adaptive fetch, RRF, AND 연산, 프리필터 |
| 보안/안정성 | A+ | 트랜잭션, timeout+retry, graceful shutdown |
| 운영 | A | health, backup, log rotation, diff scan |
| 테스트 | A | 108개, E2E 포함. server.test만 살짝 불일치 |

**종합: A**

R1(5분) + R2(10분) = **15분이면 A+.**

---

*Review by JARVIS — 2026-03-08 Round 3*
