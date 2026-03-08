# 2차 리뷰 — Subagent 1

> 날짜: 2026-03-08 | 대상: v0.1.0 수정 후 (85/85 tests)
> 커밋: `6c9748e` ~ `80b510d` ~ `cd579ee`

---

## 1차 피드백 반영 검증

### Phase 0 — Critical

#### P0-1 트랜잭션 래핑: **PASS**
- 확인한 코드: `add.ts:37-51`, `summary.ts:42-70`, `indexer.ts:102-145` (indexFile), `indexer.ts:42-56` (softDeleteByPath)
- 판정 근거: embed()를 트랜잭션 밖에서 수행 → memories + vec + FTS를 `db.transaction(() => { ... })()` 패턴으로 원자적 처리. 올바르게 구현됨.

#### P0-2 SIGINT/SIGTERM 핸들러 통합: **PASS**
- 확인한 코드: `server.ts:193-205`
- 판정 근거: `shutdownOnce` 플래그 + 단일 `shutdown()` 함수. 순서: sessionTracker.flush → watcher.close → scheduler.stop → db.close → exit(0). 각 단계 try-catch 포장. 올바르게 구현됨.

#### P0-3 search scope/source 필터를 SQL 단계로 이동: **PARTIAL**
- 확인한 코드: `tools/search.ts:48-76` (vec), `tools/search.ts:79-100` (FTS)
- 판정 근거: sqlite-vec의 KNN 쿼리가 JOIN을 지원하지 않아 post-hoc 필터로 구현한 것은 이해할 수 있음. 그러나 **post-hoc 필터 방식의 문제점이 문서화되지 않음** — `fetchLimit = limit * 3`이 scope 필터링 후 결과가 부족할 수 있는 케이스를 커버 못 할 수 있음. `agent` 필터는 실제 적용됨 (whereClause에 포함). FTS도 동일 post-hoc 방식.
- **잔존 이슈**: fetchLimit 배수(3x)가 하드코딩. 고 scope 편향 데이터에서 결과 부족 가능성.

#### P0-4 softDelete 시 FTS/vec 동기 정리: **PASS**
- 확인한 코드: `indexer.ts:37-56` (softDeleteByPath), `tools/prune.ts:72-79`
- 판정 근거: softDeleteByPath에서 memories soft-delete + FTS/vec/links DELETE를 트랜잭션 내 수행. prune.ts도 동일 패턴. 양쪽 모두 올바르게 구현됨.

#### P0-5 Ollama fetch 타임아웃 + 재시도: **PASS**
- 확인한 코드: `embedder.ts:66-95` (embedOllama)
- 판정 근거: `AbortSignal.timeout(30_000)` + MAX_RETRIES=1 (총 2회 시도) + 1초 대기. 정확히 스펙대로 구현.

#### P0-6 임베딩 동시성 제한: **PASS**
- 확인한 코드: `indexer.ts:12` (BATCH_SIZE=5), `indexer.ts:167` (pLimit(3)), `watcher.ts:29-35` (Semaphore(3))
- 판정 근거: BATCH_SIZE 5 + pLimit(3)으로 indexDirectory에서 동시성 제한. watcher에서도 Semaphore(3) 적용. 두 경로 모두 커버.

### Phase 1 — Major

#### P1-1 프론트매터 YAML 파서 교체: **PASS**
- 확인한 코드: `chunker.ts:1` (`import matter from "gray-matter"`), `chunker.ts:55-81` (parseFrontmatter)
- 판정 근거: gray-matter 도입 완료. tags 배열/문자열 처리, scope/title 추출, 기타 필드 보존. 수동 정규식 파싱 제거됨.

#### P1-2 wikilink 매칭 정밀화: **PASS**
- 확인한 코드: `indexer.ts:123-133`
- 판정 근거: `source_path = ? OR source_path LIKE '%/name.md'`로 정확 매칭. `LIKE '%name%'` 문제 해결됨. 그러나 **링크 생성이 여전히 chunk 루프 안에서 개별 쿼리** (N+1은 개선되었으나 완전 배치화는 아님). Minor 수준이므로 PASS 처리.

#### P1-3 scope 매핑 외부화: **PASS**
- 확인한 코드: `utils/scope.ts` 전체
- 판정 근거: `~/.unified-memory/config.json`에서 scopeMap/obsidianScopeMap 로드, fallback은 DEFAULT_SCOPE_MAP. `resetScopeConfigCache()` 테스트 헬퍼도 제공.

#### P1-4 context.ts 가중 스코어 정렬: **PASS**
- 확인한 코드: `tools/context.ts:40-42`
- 판정 근거: `(importance * 0.4 + (1.0 - MIN(1.0, (julianday('now') - julianday(created_at)) / 30.0)) * 0.6) DESC` — 30일 기준 recency decay + importance 가중. 스펙대로.

#### P1-5 임베딩 모델 기록 + 불일치 감지: **PASS**
- 확인한 코드: `server.ts:53-62`, `add.ts:42` (embed_model 컬럼), `summary.ts:49` (embed_model 컬럼)
- 판정 근거: 서버 시작 시 DB 조회 → 불일치 시 경고 로그. add/summary에서 embed_model 기록. indexFile의 insertMemory에는 embed_model이 없음 → **PARTIAL 수정** (아래 신규 이슈 참조).

**P1-5 수정 판정: PARTIAL** — indexer.ts의 insertMemory에 embed_model 컬럼이 누락됨.

### Phase 2 — Minor

#### P2-1 zod 직접 의존성: **PASS**
- 확인: package.json에 `"zod": "^4.3.6"` 명시.

#### P2-2 FTS5 OR → AND 기본값: **PASS**
- 확인한 코드: `tools/search.ts:130-136` (escapeFtsQuery)
- 판정 근거: `.join(" AND ")`로 변경됨. 각 단어를 따옴표로 감싸 특수문자 방어도 포함.

#### P2-3 로그 rotation: **PASS**
- 확인한 코드: `scheduler.ts:84-105` (logRotateTask, daily 2AM)
- 판정 근거: 7일 이상 된 로그 파일 삭제. mtime 기반.

#### P2-4 watcher followSymlinks: false: **PASS**
- 확인한 코드: `watcher.ts:71` (`followSymlinks: false`)

#### P2-5 watcher 글로벌 인덱싱 큐: **PASS**
- 확인한 코드: `watcher.ts:29-35` (Semaphore class), `watcher.ts:88` (acquire/release)
- 판정 근거: max=3 세마포어로 동시 인덱싱 제한.

#### P2-6 한국어 토큰 추정 보정: **PASS**
- 확인한 코드: `chunker.ts:43-47` (estimateTokens)
- 판정 근거: 한글 유니코드 범위 감지 → 2 chars/token, 나머지 4 chars/token. 정확히 스펙대로.

#### P2-7 prune LIMIT 파라미터화: **PASS**
- 확인한 코드: `tools/prune.ts:14` (`limit?: number`), `tools/prune.ts:54` (`params.limit ?? 100`)

#### P2-8 DB 백업 메커니즘: **PASS**
- 확인한 코드: `scheduler.ts:108-131` (backupTask, daily 4AM)
- 판정 근거: `db.backup()` 호출 + 7일 이상 백업 정리. backups 디렉토리 자동 생성.

#### P2-9 세션 요약 품질 개선: **PASS**
- 확인한 코드: `session-tracker.ts:157-161` (keywords 추출), `session-tracker.ts:140` (agent "unknown" → "unnamed-agent")
- 판정 근거: 키워드 추출 + agent 감지 + scope별 요약. "unknown" 리네이밍.

#### P2-10 session-tracker flush() 안전 종료: **PASS**
- 확인한 코드: `session-tracker.ts:58-63`
- 판정 근거: stdin `end`/`close` 이벤트에서 `void this.flush()` 호출.

---

## 신규 발견 이슈

### [N1] indexer.ts insertMemory에 embed_model 컬럼 누락
- 파일: `src/core/indexer.ts:111-116`
- 심각도: **Major**
- 문제: `add.ts`와 `summary.ts`는 `embed_model` 컬럼을 기록하지만, `indexer.ts`의 `insertMemory` SQL에는 해당 컬럼이 없음. 파일 인덱싱으로 생성된 레코드는 `embed_model = NULL`이 됨. 서버 시작 시 불일치 감지 쿼리(`WHERE embed_model IS NOT NULL`)가 이 레코드를 무시하므로, Obsidian 파일 대부분이 모델 변경 경고 대상에서 빠짐.
- 수정 제안: `insertMemory`에 `embed_model` 파라미터 추가, embedOpts에서 `getCurrentModelName()` 전달.

### [N2] search.ts vec post-filter 후 결과 부족 가능성
- 파일: `src/tools/search.ts:36`
- 심각도: **Minor**
- 문제: `fetchLimit = limit * 3` 고정. scope 필터로 대부분 걸러지는 경우 요청한 limit보다 적은 결과 반환. 적응형 배수나 반복 fetch 없음.
- 수정 제안: 결과 수 < limit일 때 fetchLimit을 늘려 재쿼리하거나, 최소 `limit * 5`로 상향.

### [N3] watcher Semaphore와 indexDirectory pLimit 이중 동시성 제한
- 파일: `src/core/watcher.ts:29`, `src/core/indexer.ts:167`
- 심각도: **Minor**
- 문제: watcher는 Semaphore(3), indexDirectory는 pLimit(3)로 각각 독립적 동시성 제한. 동시에 watcher + ingest 호출 시 총 6개 동시 요청 가능. 단일 글로벌 리미터가 아님.
- 수정 제안: 공유 리미터 모듈 생성 또는 문서화 (Ollama가 6 동시를 처리 가능하면 현행 유지 가능).

### [N4] prune.ts dry-run=false 시 FTS/vec 정리가 softDeleteByPath와 중복 패턴
- 파일: `src/tools/prune.ts:66-79`, `src/core/indexer.ts:42-56`
- 심각도: **Minor**
- 문제: 동일한 "soft-delete + FTS/vec/links 정리" 로직이 prune.ts와 indexer.ts:softDeleteByPath에 각각 구현. DRY 위반. 하나를 변경하면 다른 쪽 누락 위험.
- 수정 제안: prune.ts가 내부적으로 softDeleteByPath를 재사용하거나, 공통 헬퍼로 추출.

### [N5] session-tracker flush()의 에러 핸들링 - memorySummary 실패 시 세션 데이터 소실
- 파일: `src/core/session-tracker.ts:100`
- 심각도: **Minor**
- 문제: `this.flushed = true`를 먼저 설정한 뒤 memorySummary 호출. 임베딩 서버 다운 등으로 실패하면, flushed 플래그 때문에 재시도 불가. 세션 데이터 영구 소실.
- 수정 제안: flushed 플래그를 성공 후 설정하거나, 실패 시 로컬 파일에 세션 데이터 덤프.

### [N6] server.ts shutdown()에서 sessionTracker.flush()가 async이나 shutdown 함수가 제대로 await하지 않을 수 있음
- 파일: `src/server.ts:198`
- 심각도: **Minor**
- 문제: `shutdown`은 async이지만 `process.on("SIGINT", () => shutdown("SIGINT"))`에서 반환값이 무시됨. Node.js는 시그널 핸들러의 프로미스를 기다리지 않음. `process.exit(0)`이 flush 완료 전에 호출될 수 있음.
- 수정 제안: `process.exit(0)` 전에 명시적으로 await 체인이 완료되었는지 확인하거나, flush 타임아웃 + 강제 종료 패턴 적용. 단, 현재 코드에서 await는 사용 중이므로 async 함수 내에서는 순서가 보장됨. 실제 문제는 시그널 핸들러가 프로미스를 기다리지 않아 process.exit이 먼저 도달할 수 있다는 점.

---

## 종합 판정

### 점수판

| 구분 | 항목 수 | PASS | PARTIAL | FAIL |
|------|---------|------|---------|------|
| P0 Critical | 6 | 5 | 1 (P0-3) | 0 |
| P1 Major | 5 | 4 | 1 (P1-5) | 0 |
| P2 Minor | 10 | 10 | 0 | 0 |
| **합계** | **21** | **19** | **2** | **0** |

### 신규 이슈

| # | 심각도 | 항목 |
|---|--------|------|
| N1 | Major | indexer.ts embed_model 누락 |
| N2 | Minor | search fetchLimit 하드코딩 |
| N3 | Minor | 이중 동시성 리미터 |
| N4 | Minor | prune/softDelete DRY 위반 |
| N5 | Minor | flush 실패 시 데이터 소실 |
| N6 | Minor | 시그널 핸들러 async 미대기 |

### 프로덕션 레디 여부: **조건부 PASS**

**근거:**
1. Critical 6건 중 5건 완전 해결, 1건(P0-3) 기술적 제약으로 인한 합리적 대안 구현
2. Major 5건 중 4건 완전 해결, 1건(P1-5) `indexer.ts`에서 embed_model 누락 — **배포 전 수정 권장**
3. Minor 10건 전원 PASS
4. 신규 Major 1건(N1)은 P1-5와 동일 이슈의 확장
5. 신규 Minor 5건은 운영 안정성 개선이며 즉시 차단 사유는 아님

**배포 전 필수 조치:**
- N1 (indexer.ts embed_model) 수정 → 10분 작업

**운영 안정화 권장 (1주 내):**
- N5 (flush 실패 시 로컬 덤프)
- N4 (DRY 리팩토링)
- N6 (shutdown 타이밍)

85/85 테스트 통과. 아키텍처 전반적으로 견고하며, 1차 피드백의 핵심 지적이 충실하게 반영됨.
