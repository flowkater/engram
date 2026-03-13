# Code Review — Unified Memory MCP Server v0.1.0

> Reviewer: JARVIS (requested by FORGE)
> Date: 2026-03-08
> Scope: 전체 소스 2,539줄 (34 files), 테스트 14 files (81/81 pass)
> Commit: 2 commits

---

## 총평: B+ (양호, 프로덕션 전 수정 필요)

81/81 테스트 통과, 아키텍처 모듈 분리 잘 되어있고 MCP SDK 활용이 깔끔함.
**동시성/데이터 정합성 이슈**가 몇 개 있어서 실사용 전에 수정 필요.

---

## 🔴 Critical (3건)

### C1. 트랜잭션 미사용 — 데이터 정합성 위험

**파일:** `src/tools/add.ts`, `src/tools/summary.ts`, `src/core/indexer.ts`

memories + memory_vec + memory_fts 3개 테이블에 각각 개별 INSERT.
중간에 실패하면 **memories에는 있고 vec에는 없는** 유령 레코드 발생.

```typescript
// ❌ 현재 (위험)
insertMemory.run(...);
insertVec.run(...);    // ← 여기서 실패하면?
insertFts.run(...);

// ✅ 수정: better-sqlite3 transaction 사용
const insertChunk = db.transaction((params) => {
  insertMemory.run(...);
  insertVec.run(...);
  insertFts.run(...);
});
```

**영향:** add, summary, ingest 모든 쓰기 경로
**예상 수정 시간:** 30분

---

### C2. SIGINT 핸들러 중복 등록

**파일:** `src/server.ts`

SIGINT/SIGTERM 핸들러를 **3번** 등록 (watcher용, scheduler용, fallback용).
`process.on`은 additive라 3개 다 실행되지만, 순서 보장 없음.
watcher.close()는 async인데 await 없이 다른 핸들러에서 process.exit(0) 호출 가능.

```typescript
// ✅ 수정: 하나의 graceful shutdown 함수로 통합
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  
  await sessionTracker.flush();
  await watcher?.close();
  scheduler?.stop();
  dbInstance.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

**예상 수정 시간:** 20분

---

### C3. search scope 필터가 RRF 이후 적용

**파일:** `src/tools/search.ts`

vec + FTS 검색에서 scope 필터 없이 전체 검색 → RRF 병합 → JS에서 필터.
**관련 없는 scope 결과가 상위 랭크를 점령**하고 실제 필요한 결과가 limit에 잘릴 수 있음.

```typescript
// ❌ 현재: 전체 검색 후 JS 필터
const vecResults = db.prepare(`
  SELECT id, distance FROM memory_vec
  WHERE embedding MATCH ? ORDER BY distance LIMIT ?
`).all(...);
// ... RRF 병합 후 ...
.filter((r) => {
  if (params.scope && r.scope !== params.scope) return false;  // ← 너무 늦음
})

// ✅ 수정: vec 결과를 memories 테이블과 JOIN해서 scope 프리필터
const vecResults = db.prepare(`
  SELECT mv.id, mv.distance
  FROM memory_vec mv
  JOIN memories m ON mv.id = m.id
  WHERE mv.embedding MATCH ?
    AND m.deleted = 0
    AND (? IS NULL OR m.scope = ?)
  ORDER BY mv.distance
  LIMIT ?
`).all(embeddingBuffer, scope, scope, fetchLimit);
```

**예상 수정 시간:** 1시간

---

## 🟡 Major (5건)

### M1. indexer.ts — 태그/위키링크 LIKE 쿼리 N+1

**파일:** `src/core/indexer.ts` (L108-L135)

각 청크마다 위키링크 추출 → `LIKE '%linkName%'`으로 매칭.
4,964개 파일 × 평균 3 청크 × 위키링크 2-3개 = **~45,000 LIKE 쿼리**.

```typescript
// ❌ 현재: 청크별 LIKE 쿼리
for (const linkName of wikiLinks) {
  const targets = db.prepare(
    "SELECT DISTINCT id FROM memories WHERE source_path LIKE ? AND deleted = 0 LIMIT 5"
  ).all(`%${linkName}%`);
  // ...
}

// ✅ 수정: 링크 생성을 인덱싱과 분리, 배치 패스로 처리
// 또는 source_path → memory_id 매핑 캐시를 메모리에 유지
```

**영향:** 초기 인덱싱 성능
**예상 수정 시간:** 1시간

---

### M2. embedder.ts — 재시도/타임아웃 없음

**파일:** `src/core/embedder.ts`

Ollama 응답 안 하면 무한 대기. 네트워크 에러 시 한 번 실패 → 바로 fallback/throw.

```typescript
// ✅ 수정: AbortSignal.timeout + 재시도
async function embedOllama(text: string, baseUrl: string, model: string): Promise<Float32Array> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(30_000),
      });
      // ...
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
```

**예상 수정 시간:** 30분

---

### M3. context.ts — importance 우선 정렬로 최신 메모리 밀림

**파일:** `src/tools/context.ts` (L50)

`ORDER BY importance DESC, created_at DESC` → importance 0.8 + 2024년 메모리가 importance 0.5 + 오늘 메모리보다 항상 먼저 나옴.

```typescript
// ✅ 수정: 가중 스코어
const orderBy = recent
  ? `(importance * 0.4 + (1.0 - MIN(1.0, (julianday('now') - julianday(created_at)) / 30.0)) * 0.6) DESC`
  : "importance DESC";
```

**예상 수정 시간:** 30분

---

### M4. chunker.ts — 프론트매터 파서 너무 단순

**파일:** `src/core/chunker.ts` (L55-L90)

multi-line tags (`tags:\n  - foo\n  - bar`), nested YAML, 따옴표 이스케이프 등 미지원.
Obsidian은 이런 패턴 많이 사용.

```yaml
# 이런 패턴을 못 읽음:
tags:
  - "#프로젝트/Todait"
  - "#타입/설계문서"
```

**수정 방안:** `yaml` 패키지 사용하거나 최소한 multi-line list 파싱 강화.

**예상 수정 시간:** 30분

---

### M5. session-tracker.ts — flush()가 async인데 process.exit과 경합

**파일:** `src/core/session-tracker.ts` (L86-L88)

```typescript
// ❌ 현재: await 없이 호출
process.stdin.on("end", () => { this.flush(); });  // flush는 async!

// ✅ 수정
process.stdin.on("end", async () => {
  await this.flush();
  // C2 통합 shutdown에서 process.exit 처리
});
```

**예상 수정 시간:** 20분

---

## 🟢 Minor (6건)

### m1. search.ts — FTS5 OR 연산 기본값

`escapeFtsQuery`에서 `"단어" OR "단어"` 패턴은 정밀도가 떨어짐. AND가 기본이 되어야 적절.
→ `"단어" AND "단어"` 또는 `"단어" "단어"` (implicit AND)

### m2. prune.ts — LIMIT 100 하드코딩

대량 정리 시 여러 번 호출 필요. 파라미터화하거나 페이지네이션 지원.

### m3. scheduler.ts — glob 미지원

`memoryMdPaths`에 `*` 하나만 수동 처리. 복잡한 패턴 미지원.
→ `glob` 패키지 이미 devDependencies에 있으므로 활용.

### m4. graph.ts — 양방향 조회 시 중복

incoming + outgoing 결과에서 같은 링크를 중복 카운트 가능.
→ `allLinks` 단계에서 `to_id` 기준 dedup.

### m5. watcher.ts — 재시작 시 변경 누락

`ignoreInitial: true`라 서버 재시작 사이 변경된 파일 누락.
→ 시작 시 마지막 인덱싱 타임스탬프 이후 변경 파일 quick diff scan.

### m6. DB 백업 없음

WAL 모드 SQLite 단일 파일. `memory.db` 손상 시 전체 인덱스 소실.
→ 주기적 `.backup()` 또는 WAL checkpoint 후 cp.

---

## ✅ 잘한 것

| 항목 | 설명 |
|------|------|
| 모듈 분리 | tools/ core/ utils/ 3계층, 의존성 방향 단방향 |
| SQL 인젝션 | prepared statements 일관 사용 ✅ |
| 해시 기반 skip | 이미 인덱싱된 파일 재처리 방지 (sha256 + source_hash) |
| 소프트 삭제 | `deleted` 플래그로 복구 가능 |
| RRF 구현 | 교과서적인 Reciprocal Rank Fusion (k=60) |
| 테스트 | 81/81 pass, 핵심 로직 커버리지 양호 |
| zod 스키마 | MCP 도구 파라미터 타입 검증 |
| UUID v7 | 시간순 정렬 가능한 ID 생성 |
| 세션 자동 추적 | stdin close + idle timeout 양방향 감지 |
| WAL 모드 | 동시 읽기 성능 확보 |

---

## 수정 우선순위 로드맵

| 순서 | 이슈 | 심각도 | 예상 시간 |
|------|------|--------|----------|
| 1 | 트랜잭션 래핑 (C1) | 🔴 Critical | 30분 |
| 2 | SIGINT 통합 (C2) | 🔴 Critical | 20분 |
| 3 | search scope 프리필터 (C3) | 🔴 Critical | 1시간 |
| 4 | embedder timeout+retry (M2) | 🟡 Major | 30분 |
| 5 | context 가중 스코어 (M3) | 🟡 Major | 30분 |
| 6 | session flush 안전 종료 (M5) | 🟡 Major | 20분 |
| 7 | YAML 파서 강화 (M4) | 🟡 Major | 30분 |
| 8 | 인덱서 링크 배치화 (M1) | 🟡 Major | 1시간 |

**Critical 3건 + Major 상위 3건 = 약 3시간이면 프로덕션 레벨.**

---

*Review by JARVIS — 2026-03-08*
