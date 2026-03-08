# AGENTS.md — Unified Memory MCP Server

Review by: 2026-06-08

---

## Rule: 테스트 선행 커밋
- **Why**: 81개 테스트 기반 안정성 유지. 깨진 테스트로 커밋 시 CI/CD 및 다른 에이전트 작업 차단
- **Enforcement**: `npm test` 전체 통과 확인 후에만 `git commit`. 실패 시 커밋 금지
- **Scope**: 모든 소스 변경 (`src/**`)

## Rule: ESM 임포트 경로에 .js 확장자 필수
- **Why**: tsup 빌드 + Node.js ESM 해석에서 확장자 없으면 런타임 에러
- **Enforcement**: `import ... from "./core/database.js"` 형태. `.ts` 확장자 사용 금지
- **Scope**: `src/**/*.ts`

## Rule: 임베딩 차원 768 고정
- **Why**: nomic-embed-text 모델 기준. sqlite-vec 테이블 스키마와 일치해야 함. 불일치 시 DB 전체 재생성 필요
- **Enforcement**: `embedder.ts`의 DIMENSIONS 상수 변경 금지. 모델 교체 시 마이그레이션 절차 필수
- **Scope**: `src/core/embedder.ts`, `src/core/database.ts`

## Rule: DB 스키마 변경은 openDatabase()에서만
- **Why**: 단일 마이그레이션 포인트. CREATE IF NOT EXISTS 패턴으로 무중단 스키마 진화
- **Enforcement**: 새 테이블/인덱스 추가 시 `database.ts`의 `openDatabase()` 함수 내에서만 CREATE문 추가
- **Scope**: `src/core/database.ts`

## Rule: prune은 기본 dry-run
- **Why**: 실수로 메모리 대량 삭제 방지. 운영 데이터 보호
- **Enforcement**: `execute` 파라미터 없으면 삭제 건수만 반환. 실제 삭제는 `execute: true` 명시 필요
- **Scope**: `src/tools/prune.ts`, `src/cli.ts`

## Rule: 환경변수 기본값 유지
- **Why**: 설정 없이 바로 실행 가능해야 함. Tony의 로컬 경로가 기본값
- **Enforcement**: `MEMORY_DB` → `~/.unified-memory/memory.db`, `VAULT_PATH` → `~/Obsidian/flowkater/flowkater` 기본값 변경 금지
- **Scope**: `src/server.ts`, `src/cli.ts`
