# Unified Memory MCP Server — MUSE 리뷰

> 리뷰어: MUSE (기획/아키텍처)
> 날짜: 2026-03-08
> 대상: v0.1.0 (81/81 테스트 통과)

---

## ✅ 잘 된 것

### 1. 아키텍처 분리 깔끔
- `core/` (DB, embedder, chunker, watcher, session) + `tools/` (8개) + `utils/` — 단방향 의존성 잘 지킴
- 각 tool이 DB 인스턴스를 직접 받아서 테스트 용이
- 모듈 간 순환 참조 없음

### 2. 하이브리드 검색 (Vec + FTS5 + RRF)
- RRF k=60 표준값, 구현 정확
- FTS5 쿼리 실패 시 벡터만으로 fallback — 방어적 설계
- `escapeFtsQuery`로 특수문자 처리

### 3. Chunker 정교함
- H2 분할 + 코드블록 보존 (never split mid-block)
- 소섹션(<500 tokens) 병합 + 대섹션 재분할
- 오버랩 토큰 지원 — 청크 경계 정보 손실 방지
- 프론트매터 YAML 파싱, 위키링크 추출

### 4. 세션 트래커 자동화
- stdin close + idle timeout(5분) 이중 감지
- 자동 세션 요약 → memory에 저장
- codex-mem(수동 호출만)보다 진보된 설계

### 5. 해시 기반 스킵
- `sha256(content)` 비교로 이미 인덱싱된 파일 재처리 안 함
- Obsidian vault 3,100+ 파일 환경에서 필수적인 최적화

---

## 🔴 크리티컬 이슈 (3개)

### C1. SQL 동적 문자열 조합 — `context.ts`, `search.ts`

**파일**: `src/tools/context.ts` L49
```typescript
const orderBy = recent
  ? "importance DESC, created_at DESC"
  : "importance DESC";
db.prepare(`...ORDER BY ${orderBy}...`)
```

**위험**: 현재 코드에서 `orderBy`는 하드코딩된 2개 문자열 중 하나라 안전하지만, **동적 SQL 문자열 조합 패턴 자체가 위험**. 향후 파라미터에서 정렬 기준을 받게 되면 즉시 SQL 인젝션 발생.

**수정 제안**:
```typescript
// 2개의 prepared statement를 미리 만들어두기
const stmtRecent = db.prepare(`...ORDER BY importance DESC, created_at DESC LIMIT ?`);
const stmtImportance = db.prepare(`...ORDER BY importance DESC LIMIT ?`);
const rows = (recent ? stmtRecent : stmtImportance).all(scope, limit);
```

---

### C2. 임베딩 차원 하드코딩 — `embedder.ts`, `database.ts`

**파일**: `src/core/embedder.ts` L7, `src/core/database.ts` L86
```typescript
// embedder.ts
const EMBEDDING_DIM = 768;

// database.ts
CREATE VIRTUAL TABLE memory_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[768]    // ← 하드코딩
);
```

**위험**: 
- OpenAI fallback에서 `dimensions: 768`로 요청하고 있지만, 모델을 바꾸면 차원이 달라짐
- sqlite-vec 테이블이 `float[768]`로 고정이라 **모델 변경 시 DB 재생성 필요**
- 차원 불일치 시 silent corruption 가능

**수정 제안**:
```typescript
// config에서 EMBEDDING_DIM 관리
// 서버 시작 시 기존 DB의 vec 테이블 차원과 설정값 일치 검증
// 불일치 시 경고 또는 마이그레이션 안내
```

---

### C3. 배치 인덱싱 동시성 — `indexer.ts`

**파일**: `src/core/indexer.ts` L103
```typescript
const batchResults = await Promise.all(
  batch.map((file) => indexFile(db, fullPath, file, opts))
);
```

**위험**:
- `BATCH_SIZE = 20`개 파일이 동시에 `embed()` 호출
- 각 `embed()`가 Ollama API를 호출 → **20개 동시 HTTP 요청**
- Ollama는 기본적으로 순차 처리하지만, 큐잉 메모리 + 응답 대기 시간으로 **OOM 또는 timeout** 가능
- 특히 M1 MAX에서도 nomic-embed-text 20개 동시는 위험

**수정 제안**:
```typescript
import pLimit from 'p-limit';
const limit = pLimit(3); // 동시 3개로 제한

const batchResults = await Promise.all(
  batch.map((file) => limit(() => indexFile(db, fullPath, file, opts)))
);
```
또는 더 안전하게:
```typescript
for (const file of batch) {
  results.push(await indexFile(db, fullPath, file, opts));
}
```

---

## 🟡 중요 이슈 (5개)

### W1. scope.ts 경로 하드코딩

**파일**: `src/utils/scope.ts`
```typescript
const SCOPE_MAP: Record<string, string> = {
  "todait-backend": "/workspace/todait/todait/todait-backend",
  ...
```

**문제**: 토니 로컬 환경 경로가 하드코딩. 다른 환경(서버, 다른 개발자)에서 사용 불가.

**수정 제안**: `~/.unified-memory/config.json`에서 scope 맵을 로드.
```json
{
  "scopes": {
    "todait-backend": { "paths": ["/workspace/todait/todait/todait-backend", "~/projects/todait-backend-v2"] },
    "todait-ios": { "paths": ["~/projects/todait-ios"] }
  }
}
```

---

### W2. wikilink LIKE 매칭 폭발

**파일**: `src/core/indexer.ts` L83
```typescript
db.prepare(
  "SELECT DISTINCT id FROM memories WHERE source_path LIKE ? AND deleted = 0 LIMIT 5"
).all(`%${linkName}%`);
```

**문제**: `[[Todait]]`가 `Todait - v1 런칭 확정 사항.md`, `Todait - Action 정의 v1.md` 등 **수십 개 파일과 매칭**. 
- 3,100+ 파일에서 LIMIT 5여도, 인덱싱마다 수십 번 LIKE 쿼리 → 느려짐
- 잘못된 링크도 생성됨

**수정 제안**:
```typescript
// 정확 매칭 (파일명 기준)
db.prepare(
  "SELECT DISTINCT id FROM memories WHERE (source_path = ? OR source_path = ?) AND deleted = 0 LIMIT 1"
).all(`${linkName}.md`, linkName);
```

---

### W3. softDelete 시 FTS/vec 미정리

**파일**: `src/core/indexer.ts` L27
```typescript
export function softDeleteByPath(db: Database.Database, sourcePath: string): number {
  const result = db.prepare(
    "UPDATE memories SET deleted = 1, updated_at = ? WHERE source_path = ? AND deleted = 0"
  ).run(new Date().toISOString(), sourcePath);
  return result.changes;
}
```

**문제**: 
- `memories` 테이블에만 `deleted = 1` 설정
- `memory_fts`, `memory_vec`에는 레코드가 남아있음
- 검색 시 vec에서 찾고 → memories에서 `deleted = 0` 필터 → 결과가 줄어들지만 **vec 검색 비용은 그대로**
- 시간이 지나면 vec/fts에 ghost 레코드가 축적

**수정 제안**: prune 도구에 FTS/vec cleanup 추가:
```typescript
// prune 시 deleted 레코드의 FTS/vec 정리
db.prepare("DELETE FROM memory_fts WHERE id IN (SELECT id FROM memories WHERE deleted = 1)").run();
db.prepare("DELETE FROM memory_vec WHERE id IN (SELECT id FROM memories WHERE deleted = 1)").run();
db.prepare("DELETE FROM memory_links WHERE from_id IN (SELECT id FROM memories WHERE deleted = 1) OR to_id IN (SELECT id FROM memories WHERE deleted = 1)").run();
```

---

### W4. 로그 파일 무한 성장

**파일**: `src/server.ts` L34
```typescript
fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
```

**문제**: rotation 없음. MCP 서버가 장기 운영되면 디스크 문제.

**수정 제안**: scheduler에서 7일 이상 로그 파일 삭제:
```typescript
// scheduler.ts에 추가
function cleanOldLogs(logDir: string, maxDays: number = 7) {
  const cutoff = Date.now() - maxDays * 86400000;
  for (const file of fs.readdirSync(logDir)) {
    const stat = fs.statSync(path.join(logDir, file));
    if (stat.mtimeMs < cutoff) fs.unlinkSync(path.join(logDir, file));
  }
}
```

---

### W5. SIGINT 핸들러 3중 등록

**파일**: `src/server.ts` — 3군데에서 `process.on("SIGINT", ...)` 등록

```typescript
// 1. watcher 정리 (L180)
process.on("SIGINT", async () => { await watcher.close(); dbInstance.close(); process.exit(0); });
// 2. scheduler 정리 (L193)
process.on("SIGINT", () => scheduler.stop());
// 3. fallback (L202)
process.on("SIGINT", async () => { await sessionTracker.flush(); dbInstance.close(); process.exit(0); });
```

**문제**: 실행 순서 보장 안 됨. 첫 번째 핸들러가 `process.exit(0)` 호출하면 나머지 실행 안 됨.

**수정 제안**: 하나의 shutdown 함수로 통합:
```typescript
async function shutdown() {
  await sessionTracker.flush();
  scheduler?.stop();
  await watcher?.close();
  dbInstance.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

---

## 💡 기획/제품 피드백 (MUSE 관점)

### P1. AX Studio Phase 0 프로토타입

이 프로젝트는 **AX Studio의 메모리 레이어 Phase 0**과 정확히 일치함.
- ax-engine이 워크플로우 Step 전환 시 `memory.add` 호출 (자동 컨텍스트 저장)
- 다음 Step 에이전트가 `memory.context` 호출 (이전 작업 컨텍스트 확보)
- → 에이전트 간 컨텍스트 전달 문제 해결

**추가 도구 제안**: `memory.workflow_state` — ax-engine 워크플로우 상태 조회용

### P2. scope 감지 강화

현재 `detectScope`는 cwd 경로 매칭뿐. 실용적이려면:
- `git remote` URL에서 repo name 추출
- `package.json`의 `name` 필드
- `AGENTS.md` / `CLAUDE.md` 파일의 프로젝트명
- 이런 것도 감지해야 "아무 폴더에서나" 쓸 수 있음

### P3. 세션 요약 품질 개선

현재 auto-summary:
```
"[Auto] unknown session in scope 'global'. 3 searches, 1 saves, 4 total actions."
```
이건 나중에 검색해도 유용하지 않음.

**개선 방향**:
- 검색 쿼리 + 저장 내용의 핵심 키워드 자동 추출
- 또는 LLM(Ollama qwen3.5-flash)으로 한 줄 요약 생성
- 최소한 agent 이름이 "unknown"이면 안 됨 (Codex/Claude Code 자동 감지)

### P4. Obsidian 온톨로지 활용

토니 vault에 `_ontology/` MOC(Map of Content) 구조가 있음. 현재 scope 감지에서 `"_ontology/": "ontology"`로만 매핑하고, 그래프 레이어에서 활용하지 않음.

**제안**: MOC 파일의 `[[링크]]`를 `link_type="ontology"`로 추가하면:
- `memory.graph`에서 주제별 탐색 가능
- "Todait 관련 모든 메모리" 같은 쿼리가 MOC 경로를 따라 확장

### P5. 초기 인덱싱 UX

3,100+ 파일 vault를 처음 인덱싱하면:
- 3,100 × Ollama 임베딩 호출 → **수 시간 소요 예상**
- 진행률 표시 없이 멈춘 것처럼 보임
- CLI에서 `memory.ingest` 호출 시 ETA/진행률 표시 필요

---

## 📊 종합 평가

| 항목 | 점수 | 비고 |
|------|------|------|
| 아키텍처 | 8/10 | 모듈 분리 좋음, scope 하드코딩만 해결하면 |
| 코드 품질 | 7/10 | SQL 패턴, 동시성, 핸들러 중복 |
| MCP 도구 설계 | 8/10 | 8개 도구 균형 좋음, context가 좀 약함 |
| 검색 품질 | 7/10 | RRF 좋으나 FTS/vec 비동기화, wikilink 폭발 |
| 보안/안정성 | 6/10 | SQL 동적 조합, 로그 무한성장, SIGINT 중복 |
| 운영 | 6/10 | 로그 rotation 없음, DB 마이그레이션 없음 |
| 테스트 | 8/10 | 81개 통과, 동시성/대량파일 엣지케이스 보강 필요 |

---

## 수정 우선순위

### 즉시 (프로덕션 연결 전)
1. [C3] 배치 동시성 제한 (p-limit 또는 순차)
2. [W5] SIGINT 핸들러 통합
3. [W3] softDelete 시 FTS/vec cleanup

### 단기 (1주 내)
4. [C1] SQL 동적 문자열 → prepared statement 분리
5. [W2] wikilink 정확 매칭
6. [W1] scope 설정 외부화
7. [W4] 로그 rotation

### 중기 (2주+)
8. [C2] 임베딩 차원 config 관리 + DB 검증
9. [P2] scope 감지 강화 (git, package.json)
10. [P3] 세션 요약 품질 개선
11. [P4] 온톨로지 레이어

---

**총평: MVP로서 훌륭. 바로 Codex/Claude Code에 연결해서 쓸 수 있는 수준. 크리티컬 3개 + SIGINT 통합만 먼저 고치면 프로덕션 레디.** 🔥
