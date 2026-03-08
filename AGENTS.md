# AGENTS.md — Engram MCP Server

Review by: 2026-06-08

---

## Rule: 테스트 선행 커밋
- **Why**: 108개 테스트 기반 안정성 유지. 깨진 테스트로 커밋 시 다른 에이전트 작업 차단
- **Enforcement**: `npm test` 전체 통과 확인 후에만 `git commit`. 실패 시 커밋 금지
- **Scope**: 모든 소스 변경 (`src/**`, `test/**`)

## Rule: 다중 테이블 쓰기는 트랜잭션 필수
- **Why**: memories + memory_vec + memory_fts + memory_tags 4개 테이블 정합성. 중간 실패 시 유령 레코드 발생
- **Enforcement**: `db.transaction(() => { ... })()` 래핑. embed()는 트랜잭션 밖에서 먼저 수행
- **Scope**: `src/tools/add.ts`, `src/tools/summary.ts`, `src/tools/restore.ts`, `src/core/indexer.ts`

## Rule: ESM 임포트 경로에 .js 확장자 필수
- **Why**: tsup 빌드 + Node.js ESM 해석에서 확장자 없으면 런타임 에러
- **Enforcement**: `import ... from "./core/database.js"` 형태. `.ts` 확장자 사용 금지
- **Scope**: `src/**/*.ts`

## Rule: 임베딩 차원 768 고정
- **Why**: nomic-embed-text 모델 기준. sqlite-vec 테이블과 일치 필수. embed_model 컬럼으로 변경 감지
- **Enforcement**: DIMENSIONS 상수 변경 금지. 모델 교체 시 마이그레이션 절차 필수
- **Scope**: `src/core/embedder.ts`, `src/core/database.ts`

## Rule: DB 스키마 변경은 openDatabase()에서만
- **Why**: 단일 마이그레이션 포인트. CREATE IF NOT EXISTS + ALTER TABLE 패턴으로 무중단 스키마 진화
- **Enforcement**: 새 테이블/인덱스/컬럼 추가 시 `database.ts`의 `openDatabase()` 내에서만
- **Scope**: `src/core/database.ts`

## Rule: prune/delete는 기본 dry-run + 관련 테이블 동기 삭제
- **Why**: 실수로 메모리 대량 삭제 방지 + FTS/vec/tags 유령 레코드 방지
- **Enforcement**: `execute` 없으면 건수만 반환. 실제 삭제 시 `deleteRelatedRecords()` 헬퍼로 FTS/vec/tags/links 동기 삭제
- **Scope**: `src/tools/prune.ts`, `src/core/indexer.ts`, `src/utils/delete-related.ts`

## Rule: 동시성 제한 준수
- **Why**: Ollama 로컬 모델 과부하/OOM 방지. indexer pLimit(3) + watcher Semaphore(3) 독립 운영
- **Enforcement**: 임베딩 동시 호출 수 변경 금지. 공유 리미터가 아닌 독립 리미터 유지
- **Scope**: `src/core/indexer.ts`, `src/core/watcher.ts`

## Rule: scope 매핑은 config.json 외부화
- **Why**: 하드코딩 경로는 환경 종속. config.json으로 외부화하여 재사용성 확보
- **Enforcement**: `src/utils/scope.ts`에 경로 하드코딩 금지. `~/.engram/config.json`에서 로드
- **Scope**: `src/utils/scope.ts`
