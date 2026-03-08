# CLAUDE.md — Engram MCP Server

## 프로젝트 개요
로컬 AI 에이전트 공유 메모리 MCP 서버. Ollama + SQLite 기반, 100% 로컬.

## 기술 스택
- **Runtime**: Node.js 22+, TypeScript, ESM
- **DB**: SQLite + sqlite-vec (코사인 유사도) + FTS5 (전문 검색) + memory_tags (정규화)
- **Embedding**: Ollama nomic-embed-text (768차원), OpenAI fallback
- **빌드**: tsup (번들러), vitest (테스트)
- **MCP SDK**: `@modelcontextprotocol/sdk` (stdio transport)
- **주요 의존성**: gray-matter (프론트매터), p-limit (동시성), zod (스키마), chokidar (파일감시)

## 빌드 & 테스트
```bash
npm install          # 의존성 설치
npm run build        # tsup → dist/
npm test             # vitest 전체 (108 tests)
npm run test:watch   # 워치 모드
npm run dev          # tsx 개발 서버
```

## 프로젝트 구조
```
src/
├── server.ts              # MCP 서버 진입점 (stdio transport, 10 tools 등록)
├── cli.ts                 # CLI 진입점 (index/stats/prune)
├── core/
│   ├── database.ts        # SQLite + sqlite-vec + FTS5 + memory_tags 스키마
│   ├── embedder.ts        # Ollama/OpenAI 임베딩 (768d, 30s timeout, 1회 재시도)
│   ├── chunker.ts         # gray-matter 프론트매터 + H2 분할 + 한국어 토큰 보정
│   ├── indexer.ts         # 배치 인덱싱 (hash 스킵, pLimit(3) 동시성 제한, 트랜잭션)
│   ├── watcher.ts         # chokidar 감시 (Semaphore(3), diffScan, followSymlinks:false)
│   ├── scheduler.ts       # node-cron (6h reindex, weekly prune, daily 로그rotation/백업)
│   └── session-tracker.ts # stdin close + idle timeout 자동 세션 추적 + 실패 시 덤프
├── tools/
│   ├── add.ts             # memory.add — 메모리 저장 + 임베딩 (트랜잭션)
│   ├── search.ts          # memory.search — 하이브리드 검색 (adaptive fetch, AND 기본)
│   ├── context.ts         # memory.context — 가중 스코어 정렬 (importance*0.4 + recency*0.6)
│   ├── summary.ts         # memory.summary — 세션 요약 저장 (트랜잭션)
│   ├── ingest.ts          # memory.ingest — 파일/디렉토리 인덱싱
│   ├── prune.ts           # memory.prune — 오래된 메모리 정리 (FTS/vec/tags 동기 삭제)
│   ├── stats.ts           # memory.stats — 통계 조회
│   ├── graph.ts           # memory.graph — 태그 정규화 테이블 + UNION dedup
│   ├── health.ts          # memory.health — DB 정합성 검사 (고아 레코드, 모델 불일치)
│   └── restore.ts         # memory.restore — soft-deleted 메모리 복원 + 재임베딩
└── utils/
    ├── hash.ts            # SHA-256 content hash
    ├── rrf.ts             # Reciprocal Rank Fusion 병합
    ├── scope.ts           # config.json 기반 스코프 매핑 (외부화, graceful fallback)
    ├── tags.ts            # 태그 파싱 + memory_tags 테이블 CRUD
    └── delete-related.ts  # FTS/vec/tags/links 공통 삭제 헬퍼 (DRY)
```

## 핵심 규칙
- **테스트 필수**: 모든 변경은 `npm test` 통과 확인 후 커밋 (현재 108 tests)
- **ESM only**: `import/export` 사용, `.js` 확장자 임포트 (`./core/database.js`)
- **트랜잭션 필수**: memories + vec + fts + tags 다중 테이블 쓰기는 반드시 `db.transaction()` 래핑
- **환경변수**: `MEMORY_DB`, `VAULT_PATH`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`
- **DB 마이그레이션**: `database.ts`의 `openDatabase()` 내 CREATE IF NOT EXISTS + ALTER TABLE 패턴
- **임베딩 차원**: 768 고정. embed_model 컬럼으로 모델 변경 감지
- **동시성 제한**: indexer pLimit(3), watcher Semaphore(3) — Ollama 과부하 방지
- **scope 설정**: `~/.engram/config.json`에서 외부화 (변경 시 서버 재시작 필요)

## MCP Tools (10개)
| Tool | 입력 | 설명 |
|------|------|------|
| `memory.add` | content, source?, scope?, tags? | 메모리 저장 + 벡터 임베딩 |
| `memory.search` | query, scope?, limit?, source? | 시맨틱+키워드 하이브리드 검색 (adaptive fetch) |
| `memory.context` | cwd?, scope? | cwd 기반 자동 컨텍스트 로드 (가중 스코어) |
| `memory.summary` | summary, sessionId?, scope? | 세션 요약 저장 |
| `memory.ingest` | path, source?, scope? | 파일/디렉토리 인덱싱 |
| `memory.prune` | days?, scope?, limit?, execute? | 오래된 메모리 정리 (기본 dry-run) |
| `memory.stats` | scope? | DB 통계 |
| `memory.graph` | query, hops?, limit? | 그래프 관계 탐색 (UNION dedup) |
| `memory.health` | — | DB 정합성 검사 (고아 레코드, 모델 불일치, 링크 무결성) |
| `memory.restore` | id | soft-deleted 메모리 복원 + 재임베딩 |

## DB 테이블
| 테이블 | 용도 |
|--------|------|
| `memories` | 메인 메모리 (content, scope, tags, embed_model, deleted 등) |
| `memory_vec` | sqlite-vec 벡터 인덱스 (float[768]) |
| `memory_fts` | FTS5 전문 검색 인덱스 |
| `memory_tags` | 태그 정규화 테이블 (memory_id, tag) |
| `memory_links` | 그래프 레이어 (from_id, to_id, link_type, weight) |

## 테스트 패턴
- 유닛: 각 모듈별 `.test.ts` 공존 (co-located), in-memory SQLite
- E2E: `test/e2e/` — fixture vault (12 파일) + 6 시나리오
- embedder mock: 768차원 랜덤 벡터
- scope config: `resetScopeConfigCache()` 테스트 헬퍼

## 커밋 컨벤션
- `feat:` 새 기능, `fix:` 버그, `test:` 테스트, `docs:` 문서, `chore:` 설정
