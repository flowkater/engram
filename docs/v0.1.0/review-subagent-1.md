# Code Review — Subagent 1

## Summary

약 4,100줄 규모의 MCP 메모리 서버. 아키텍처는 깔끔하게 `core/tools/utils`로 분리되어 있고, SQLite + sqlite-vec + FTS5 조합은 합리적이다. 그러나 **SQL 인젝션 취약점**, **트랜잭션 미사용으로 인한 데이터 정합성 문제**, **임베딩 모델 불일치 가능성**, **SIGINT 핸들러 중복 등록** 등 프로덕션 운영에서 즉시 문제될 수 있는 결함이 다수 존재한다. 전반적으로 "프로토타입이 잘 동작하는 수준"이며, 프로덕션 레벨까지는 아래 이슈들의 수정이 필요하다.

## Critical Issues (즉시 수정 필요)

### [C1] SQL 인젝션 — 동적 플레이스홀더 구성
- **파일**: `src/tools/search.ts`, `src/tools/context.ts`, `src/tools/prune.ts`
- **문제**: `IN (${placeholders})` 패턴에서 플레이스홀더 자체는 `?`로 안전하지만, `search.ts`의 `WHERE ${whereClause}` 같은 패턴은 유지보수 중 실수 유발 가능. 더 심각한 건 `context.ts`의 `ORDER BY ${orderBy}` — 현재는 하드코딩된 문자열이라 안전하지만, 이 패턴이 동적 입력으로 확장되면 즉시 인젝션 벡터가 된다. **Prepared statement만 사용하는 패턴으로 통일 필요.**
- **수정 제안**: `ORDER BY`는 별도 쿼리 2개로 분리하거나, 화이트리스트 검증 함수를 추가.

### [C2] 트랜잭션 없는 다중 테이블 쓰기
- **파일**: `src/tools/add.ts`, `src/tools/summary.ts`, `src/core/indexer.ts`
- **문제**: `memoryAdd`는 `memories`, `memory_vec`, `memory_fts` 3개 테이블에 순차 삽입하지만 트랜잭션으로 감싸지 않는다. 임베딩 후 `memory_vec` 삽입이 성공하고 `memory_fts` 삽입이 실패하면 불일치 상태. `indexer.ts`의 `indexFile`은 루프 내 N개 청크를 삽입하면서 중간 실패 시 부분 삽입 상태가 된다.
- **수정 제안**: `db.transaction(() => { ... })()` 래핑. 특히 `indexFile`은 전체 파일 단위로 트랜잭션 필수.

### [C3] 임베딩 모델 불일치 시 검색 품질 붕괴
- **파일**: `src/core/embedder.ts`
- **문제**: Ollama 실패 시 OpenAI `text-embedding-3-small`로 폴백한다. 두 모델은 완전히 다른 벡터 공간을 사용하므로, Ollama로 저장된 벡터와 OpenAI로 생성된 쿼리 벡터 간 유사도가 무의미해진다. 혼합된 벡터가 DB에 쌓이면 검색 품질이 조용히 붕괴한다.
- **수정 제안**: (1) 사용된 모델명을 `memories` 테이블에 기록, (2) 폴백 시 경고가 아닌 에러로 처리하거나, (3) 모델 전환 시 기존 벡터 재생성 메커니즘 추가.

### [C4] SIGINT/SIGTERM 핸들러 3중 등록
- **파일**: `src/server.ts`
- **문제**: `process.on("SIGINT")` / `process.on("SIGTERM")`이 3곳에서 등록된다: (1) watcher용 L257-264, (2) scheduler용 L275-276, (3) 파일 하단 전역 L280-289. 이 중 어느 핸들러가 먼저 실행되어 `process.exit(0)`을 호출하면 나머지는 실행되지 않는다. `sessionTracker.flush()`와 `watcher.close()`가 동시에 호출되지 않을 수 있다.
- **수정 제안**: 단일 shutdown 함수로 통합. `once` 플래그로 중복 호출 방지.

## Major Issues (개선 권장)

### [M1] scope/source 필터가 RRF 이후 적용됨
- **파일**: `src/tools/search.ts`
- **문제**: 벡터/FTS 검색 → RRF 병합 → **그 후** scope/source 필터링. `fetchLimit = limit * 3`으로 여유를 두긴 했지만, 특정 scope의 결과가 상위에 없으면 필터 후 결과가 `limit`보다 적어진다. scope 필터를 벡터/FTS 쿼리 단계에서 적용해야 한다.
- **수정 제안**: `memory_vec` JOIN `memories` 쿼리에서 scope 조건 추가, FTS에도 scope 필터 추가.

### [M2] agent 필터 미적용
- **파일**: `src/tools/search.ts` L100
- **문제**: `params.agent`를 받지만 실제 필터링 코드에서 사용하지 않는다. `agent` 파라미터가 무시된다.
- **수정 제안**: `.filter()` 체인에 `if (params.agent && r.agent !== params.agent) return false;` 추가. (agent 컬럼을 SELECT에도 추가 필요)

### [M3] FTS5 인덱스와 memories 테이블 동기화 미보장
- **파일**: `src/core/indexer.ts`, `src/tools/prune.ts`
- **문제**: `softDeleteByPath`는 `memories` 테이블만 `deleted=1`로 업데이트하고, `memory_fts`와 `memory_vec`는 그대로 둔다. FTS 검색 시 삭제된 메모리가 계속 나타난다. `prune`도 동일. `memory_fts`에서 해당 행을 DELETE하지 않으면 좀비 데이터가 계속 검색된다.
- **수정 제안**: soft delete 시 `memory_fts`/`memory_vec`에서도 삭제. 또는 검색 시 `JOIN memories ON deleted=0` 추가.

### [M4] 프론트매터 YAML 파서 취약
- **파일**: `src/core/chunker.ts` L70-98
- **문제**: 수동 정규식 YAML 파싱이 다중 라인 태그, 중첩 구조, 특수문자를 제대로 처리하지 못한다. 예: `tags:` 아래에 `  - "tag with: colon"` → 파싱 실패. 또한 `tagItemMatch`가 `tags:` 행 이전의 리스트 아이템도 태그로 오인할 수 있다 (L83의 `!meta.tags` 조건과 L86의 `yamlBlock.includes("tags:")` 조건이 충돌).
- **수정 제안**: `yaml` 패키지 사용 또는 최소한 상태 기반 파싱으로 교체.

### [M5] 배치 임베딩 미사용으로 인한 성능 병목
- **파일**: `src/core/indexer.ts`
- **문제**: `indexFile` 내에서 청크마다 개별 HTTP 요청으로 임베딩을 생성한다. 100개 청크 파일 = 100개 HTTP 요청. Ollama와 OpenAI 모두 배치 API를 지원하므로 활용해야 한다.
- **수정 제안**: `embed` 함수에 `embedBatch(texts: string[])` 추가. indexFile에서 청크 텍스트를 모아 한 번에 임베딩.

### [M6] watcher의 debounce 타이머 누수 가능성
- **파일**: `src/core/watcher.ts`
- **문제**: `debouncedIndex`의 `setTimeout` 콜백 내에서 `indexFile`이 `await`되지만, 이 비동기 작업이 진행 중일 때 `close()`가 호출되면 타이머는 clear되지만 이미 실행 중인 `indexFile`은 취소되지 않는다. DB가 이미 닫힌 후에 쓰기를 시도할 수 있다.
- **수정 제안**: 진행 중인 인덱싱 Promise 추적 + close 시 대기.

## Minor Issues (선택적 개선)

### [m1] `mergeSections` 최소 토큰 하드코딩 불일치
- **파일**: `src/core/chunker.ts` L233
- **문제**: 주석에 "< 500 tokens"이라 했지만 실제 인자는 `125`. `mergeSections` 내부에서 `estimateTokens`를 호출하므로 `125`가 맞다면 주석이 틀리고, 주석이 맞다면 값이 틀리다. (실제로는 `estimateTokens`가 토큰 수를 반환하므로 `125`가 아닌 `500`이 맞을 것)
- **수정 제안**: `mergeSections(sections, 500)` 또는 주석 수정.

### [m2] `escapeFtsQuery`에서 OR 연결
- **파일**: `src/tools/search.ts`
- **문제**: 모든 단어를 `OR`로 연결하면 관련 없는 결과가 다수 포함된다. 기본은 `AND`가 자연스럽고, 사용자가 명시적으로 선택하게 해야 한다.
- **수정 제안**: 기본 `AND`, 옵션으로 `OR` 제공.

### [m3] `detectScope`의 경로 매핑 하드코딩
- **파일**: `src/utils/scope.ts`
- **문제**: 토니의 개인 디렉토리 구조가 코드에 하드코딩되어 있다. 환경 변수나 설정 파일로 외부화해야 재사용성이 생긴다.
- **수정 제안**: `~/.unified-memory/config.json`에서 scope map 로드.

### [m4] `memory_vec` distance → similarity 변환 없음
- **파일**: `src/tools/search.ts`
- **문제**: `sqlite-vec`는 L2 distance를 반환하지만, RRF에서는 단순히 rank 순서만 사용하므로 현재는 문제없다. 다만 `minScore`와의 비교에서 RRF score와 vector distance가 다른 스케일이라는 점이 혼란을 줄 수 있다.
- **수정 제안**: 문서에 score 의미 명시 또는 cosine similarity로 변환.

### [m5] 테스트에서 실제 임베딩 서버 의존
- **파일**: 각 `.test.ts` 파일
- **문제**: 테스트 파일들을 확인하지 않았지만, `embed()` 호출이 있는 도구 테스트가 실제 Ollama/OpenAI에 의존한다면 CI에서 실패한다.
- **수정 제안**: `embed` 함수를 DI로 주입하거나 mock 가능하게 리팩토링.

### [m6] CLI `index` 명령에서 `recursive` 옵션 미노출
- **파일**: `src/cli.ts`
- **문제**: `indexDirectory`는 항상 재귀적으로 동작하고, `--recursive` 플래그가 CLI에 없다. `memoryIngest`에는 있는데 CLI에는 없는 불일치.
- **수정 제안**: CLI에 `--no-recursive` 옵션 추가하거나, 둘 다 제거.

### [m7] 로그 파일 rotation 없음
- **파일**: `src/server.ts`
- **문제**: 일자별 로그 파일이 무한히 쌓인다. rotation이나 cleanup 메커니즘 없음.
- **수정 제안**: 스케줄러에 30일 이상 로그 삭제 작업 추가.

## Positive Aspects

1. **모듈 구조가 깔끔하다.** `core/tools/utils` 분리가 자연스럽고, 각 도구가 독립적으로 테스트 가능한 순수 함수 형태.
2. **RRF 하이브리드 검색** — 벡터 + FTS5 조합을 RRF로 병합하는 전략이 학술적으로 검증된 방식이며 구현도 간결하다.
3. **Soft delete + dry-run prune** — 데이터 손실 방지를 기본으로 설계한 점이 좋다.
4. **SessionTracker 자동 요약** — idle timeout + stdin close 이중 감지로 세션 종료를 포착하는 설계가 실용적.
5. **hash 기반 변경 감지** — 파일 재인덱싱 시 SHA-256 비교로 불필요한 작업을 건너뛰는 것이 효율적.
6. **UUID v7 사용** — 시간 순서 정렬이 가능한 UUID 선택이 적절.

## Recommendations

### 우선순위 1 (즉시)
1. **[C2] 트랜잭션 래핑** — `memoryAdd`, `memorySummary`, `indexFile` 모두 `db.transaction()` 적용
2. **[C4] SIGINT 핸들러 통합** — 단일 graceful shutdown 함수
3. **[M3] FTS/Vec 동기화** — soft delete 시 FTS/Vec에서도 삭제

### 우선순위 2 (1주 내)
4. **[C3] 임베딩 모델 기록** — `memories` 테이블에 `embed_model` 컬럼 추가
5. **[M1] 검색 필터 선적용** — scope 필터를 벡터/FTS 쿼리 단계로 이동
6. **[M4] YAML 파서 교체** — `yaml` 패키지 도입

### 우선순위 3 (개선)
7. **[M5] 배치 임베딩** — 성능 최적화
8. **[m3] scope 매핑 외부화** — 설정 파일로 분리
9. **[m5] 임베딩 mock** — 테스트 안정성 확보
