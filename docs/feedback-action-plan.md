# Unified Memory MCP Server — 종합 피드백 반영 계획

> 작성: FORGE | 날짜: 2026-03-08
> 리뷰 소스: Subagent-1, Subagent-2, MUSE, JARVIS — 총 4건
> 대상: v0.1.0 (81/81 tests, 2,539 LOC)

---

## 리뷰 합산 통계

| 구분 | SA1 | SA2 | MUSE | JARVIS | 합계 |
|------|-----|-----|------|--------|------|
| Critical | 4 | 4 | 3 | 3 | 14 |
| Major | 6 | 6 | 5 | 5 | 22 |
| Minor | 7 | 8 | 0 | 6 | 21 |

**중복 제거 후 고유 이슈**: Critical 6건, Major 9건, Minor 10건

---

## Phase 0 — Critical (즉시, ~2.5h)

### [P0-1] 트랜잭션 래핑 ⏱️ 30min
- **출처**: SA1-C2, SA2-C1, JARVIS-C1 (4/4 전원 지적)
- **대상**: `add.ts`, `summary.ts`, `indexer.ts`
- **작업**: `db.transaction(() => { ... })()`으로 memories + memory_vec + memory_fts + memory_links INSERT 원자적 처리
- **주의**: `indexFile`은 embed()를 트랜잭션 밖에서 먼저 수행 → 결과를 트랜잭션 안에서 INSERT
- **DoD**: 기존 81 테스트 + 트랜잭션 중간 실패 시뮬레이션 테스트 1건 추가

### [P0-2] SIGINT/SIGTERM 핸들러 통합 ⏱️ 20min
- **출처**: SA1-C4, SA2-C3, MUSE-W5, JARVIS-C2 (4/4 전원 지적)
- **대상**: `server.ts`
- **작업**: 단일 `shutdown()` 함수 + `once` 플래그로 중복 호출 방지
- **순서**: sessionTracker.flush() → watcher.close() → scheduler.stop() → db.close() → process.exit(0)
- **DoD**: 수동 SIGINT 테스트로 로그에 모든 cleanup 단계 확인

### [P0-3] search scope/source 필터를 SQL 단계로 이동 ⏱️ 1h
- **출처**: SA1-M1, SA2-M1, JARVIS-C3 (3/4 지적)
- **대상**: `search.ts`
- **작업**: vec 검색 시 `JOIN memories`로 scope/source/deleted 필터 적용, FTS도 동일
- **추가**: `agent` 파라미터 필터 실제 적용 (SA1-M2)
- **DoD**: scope 필터 검색 테스트 2건 추가 (다른 scope 결과 배제 확인)

### [P0-4] softDelete 시 FTS/vec 동기 정리 ⏱️ 30min
- **출처**: SA1-M3, SA2-M2, MUSE-W3 (3/4 지적)
- **대상**: `indexer.ts` (softDeleteByPath), `prune.ts`
- **작업**: softDelete에서 `memory_fts`, `memory_vec`, `memory_links`도 함께 DELETE
- **DoD**: softDelete 후 FTS/vec 검색에 해당 레코드 미노출 테스트

### [P0-5] Ollama fetch 타임아웃 + 재시도 ⏱️ 30min
- **출처**: SA2-C2, JARVIS-M2 (2/4 지적)
- **대상**: `embedder.ts`
- **작업**: `AbortSignal.timeout(30_000)` + 1회 재시도 (1초 대기)
- **DoD**: 타임아웃 시뮬레이션 테스트 (mock fetch)

### [P0-6] 임베딩 동시성 제한 ⏱️ 20min
- **출처**: SA2-C4, MUSE-C3 (2/4 지적)
- **대상**: `indexer.ts`
- **작업**: `BATCH_SIZE` 20 → 5, 또는 `p-limit(3)` 적용
- **DoD**: 20파일 배치 인덱싱 시 동시 HTTP 요청 3개 이하 확인

---

## Phase 1 — Major (1주 내, ~3h)

### [P1-1] 프론트매터 YAML 파서 교체 ⏱️ 30min
- **출처**: SA1-M4, SA2-m3, JARVIS-M4 (3/4 지적)
- **대상**: `chunker.ts`
- **작업**: `gray-matter` 패키지 도입, 수동 정규식 파싱 제거
- **DoD**: multi-line tags + 중첩 YAML + 따옴표 콜론 파싱 테스트

### [P1-2] wikilink 매칭 정밀화 ⏱️ 1h
- **출처**: MUSE-W2, JARVIS-M1 (2/4 지적)
- **대상**: `indexer.ts`
- **작업**: `LIKE '%name%'` → 파일명 정확 매칭 (`source_path = ? OR source_path LIKE '%/name.md'`)
- **추가**: 링크 생성을 배치 패스로 분리 (N+1 쿼리 해소)
- **DoD**: `[[Todait]]`가 정확히 `Todait.md`만 매칭

### [P1-3] scope 매핑 외부화 ⏱️ 30min
- **출처**: SA1-m3, SA2-m1, MUSE-W1 (3/4 지적)
- **대상**: `scope.ts`
- **작업**: `~/.unified-memory/config.json`에서 scope map 로드, 하드코딩 제거
- **DoD**: config 파일 변경만으로 scope 추가 가능 확인

### [P1-4] context.ts 가중 스코어 정렬 ⏱️ 30min
- **출처**: JARVIS-M3
- **대상**: `context.ts`
- **작업**: `importance * 0.4 + recency * 0.6` 가중 스코어로 변경
- **DoD**: 최신 저중요도 > 오래된 고중요도 시나리오 테스트

### [P1-5] 임베딩 모델 기록 + 불일치 감지 ⏱️ 30min
- **출처**: SA1-C3, MUSE-C2 (2/4 지적)
- **대상**: `embedder.ts`, `database.ts`
- **작업**: `memories` 테이블에 `embed_model` 컬럼 추가, 서버 시작 시 현재 모델과 기존 레코드 모델 비교 → 불일치 시 경고
- **DoD**: Ollama → OpenAI 전환 시 경고 로그 출력 테스트

---

## Phase 2 — Minor & 운영 (2주 내, ~2.5h)

### [P2-1] zod 직접 의존성 추가 ⏱️ 5min
- **출처**: SA2-m7
- **작업**: `npm install zod` → package.json에 명시

### [P2-2] FTS5 OR → AND 기본값 ⏱️ 15min
- **출처**: SA1-m2, JARVIS-m1
- **대상**: `search.ts` (escapeFtsQuery)
- **작업**: 단어 연결 기본 AND, 옵션 OR

### [P2-3] 로그 rotation ⏱️ 20min
- **출처**: SA1-m7, SA2-m5, MUSE-W4
- **대상**: `scheduler.ts`
- **작업**: 7일 이상 로그 파일 자동 삭제 크론 추가

### [P2-4] watcher followSymlinks: false ⏱️ 5min
- **출처**: SA2-M3
- **대상**: `watcher.ts`

### [P2-5] watcher 글로벌 인덱싱 큐 ⏱️ 30min
- **출처**: SA2-M4
- **대상**: `watcher.ts`
- **작업**: git checkout 등 대량 변경 시 동시성 제한 (세마포어 / 큐)

### [P2-6] 한국어 토큰 추정 보정 ⏱️ 15min
- **출처**: SA2-m8
- **대상**: `chunker.ts`
- **작업**: 한국어 감지 시 ~2 chars/token으로 보정

### [P2-7] prune LIMIT 파라미터화 ⏱️ 10min
- **출처**: JARVIS-m2
- **대상**: `prune.ts`

### [P2-8] DB 백업 메커니즘 ⏱️ 20min
- **출처**: JARVIS-m6
- **대상**: `scheduler.ts`
- **작업**: 주기적 `.backup()` 호출

### [P2-9] 세션 요약 품질 개선 ⏱️ 30min
- **출처**: MUSE-P3
- **대상**: `session-tracker.ts`
- **작업**: 검색 쿼리 키워드 추출, agent 이름 자동 감지 ("unknown" 제거)

### [P2-10] session-tracker flush() 안전 종료 ⏱️ 10min
- **출처**: JARVIS-M5
- **대상**: `session-tracker.ts`
- **작업**: stdin end 이벤트에서 `await this.flush()` 처리

---

## Phase 3 — 기획/확장 (장기)

| # | 항목 | 출처 |
|---|------|------|
| P3-1 | scope 감지 강화 (git remote, package.json) | MUSE-P2 |
| P3-2 | Obsidian 온톨로지 레이어 활용 (MOC → graph) | MUSE-P4 |
| P3-3 | 초기 인덱싱 UX (ETA/진행률) | MUSE-P5 |
| P3-4 | ax-engine 워크플로우 상태 도구 | MUSE-P1 |
| P3-5 | 배치 임베딩 API 활용 | SA1-M5 |
| P3-6 | watcher 재시작 시 변경 파일 diff scan | JARVIS-m5 |

---

## 실행 전략

```
Phase 0 (Critical)  →  Claude Code 서브에이전트 1개로 일괄 처리 (~2.5h)
Phase 1 (Major)     →  Claude Code 서브에이전트 1개 (~3h)
Phase 2 (Minor)     →  Phase 0/1 완료 후 순차 (~2.5h)
Phase 3 (장기)      →  별도 이슈 등록, 필요 시 구현
```

**총 예상**: Phase 0+1 = ~5.5h → 프로덕션 레디
**테스트 목표**: 81 → 95+ (신규 테스트 14건 이상)

---

## 리뷰어별 핵심 컨센서스 (4/4 동의)

| 이슈 | 동의 수 | 우선순위 |
|------|---------|---------|
| 트랜잭션 미사용 | **4/4** | P0-1 |
| SIGINT 핸들러 중복 | **4/4** | P0-2 |
| search 필터 위치 | **3/4** | P0-3 |
| FTS/vec 동기화 | **3/4** | P0-4 |
| YAML 파서 취약 | **3/4** | P1-1 |
| scope 하드코딩 | **3/4** | P1-3 |
| 임베딩 동시성 | **2/4** | P0-6 |
| Ollama 타임아웃 | **2/4** | P0-5 |

---

*4방향 리뷰 종합. Critical 6건은 프로덕션 연결 전 반드시 수정.*
