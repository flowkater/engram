# CLAUDE.md — Unified Memory MCP Server

## 프로젝트 개요
로컬 AI 에이전트 공유 메모리 MCP 서버. Ollama + SQLite 기반, 100% 로컬.

## 기술 스택
- **Runtime**: Node.js 22+, TypeScript, ESM
- **DB**: SQLite + sqlite-vec (코사인 유사도) + FTS5 (전문 검색)
- **Embedding**: Ollama nomic-embed-text (768차원)
- **빌드**: tsup (번들러), vitest (테스트)
- **MCP SDK**: `@modelcontextprotocol/sdk` (stdio transport)

## 빌드 & 테스트
```bash
npm install          # 의존성 설치
npm run build        # tsup → dist/
npm test             # vitest 전체 (81 tests)
npm run test:watch   # 워치 모드
npm run dev          # tsx 개발 서버
```

## 프로젝트 구조
```
src/
├── server.ts              # MCP 서버 진입점 (stdio transport, 8 tools 등록)
├── cli.ts                 # CLI 진입점 (index/stats/prune)
├── core/
│   ├── database.ts        # SQLite + sqlite-vec + FTS5 스키마, openDatabase()
│   ├── embedder.ts        # Ollama/OpenAI 임베딩 (768d)
│   ├── chunker.ts         # Markdown H2 분할, 코드블록 보존, wikilink 추출
│   ├── indexer.ts          # 디렉토리 배치 인덱싱 (hash 기반 스킵)
│   ├── watcher.ts         # chokidar 파일 감시 (2s debounce)
│   ├── scheduler.ts       # node-cron (6h reindex, weekly prune)
│   └── session-tracker.ts # stdin close + idle timeout 자동 세션 추적
├── tools/
│   ├── add.ts             # memory.add — 메모리 저장 + 임베딩
│   ├── search.ts          # memory.search — 하이브리드 검색 (vec+FTS+RRF)
│   ├── context.ts         # memory.context — cwd 기반 자동 컨텍스트 로드
│   ├── summary.ts         # memory.summary — 세션 요약 저장
│   ├── ingest.ts          # memory.ingest — 파일/디렉토리 인덱싱
│   ├── prune.ts           # memory.prune — 오래된 메모리 정리
│   ├── stats.ts           # memory.stats — 통계 조회
│   └── graph.ts           # memory.graph — wikilink/tag 그래프 탐색 (BFS 1-3홉)
└── utils/
    ├── hash.ts            # SHA-256 content hash
    ├── rrf.ts             # Reciprocal Rank Fusion 병합
    └── scope.ts           # 프로젝트 스코프 추출
```

## 핵심 규칙
- **테스트 필수**: 모든 변경은 `npm test` 통과 확인 후 커밋
- **ESM only**: `import/export` 사용, `.js` 확장자 임포트 (`./core/database.js`)
- **환경변수**: `MEMORY_DB`, `VAULT_PATH`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`
- **DB 마이그레이션**: `database.ts`의 `openDatabase()` 내 CREATE IF NOT EXISTS로 관리
- **임베딩 차원**: 768 고정 (nomic-embed-text). 변경 시 DB 재생성 필요

## MCP Tools (8개)
| Tool | 입력 | 설명 |
|------|------|------|
| `memory.add` | content, source?, scope?, tags? | 메모리 저장 + 벡터 임베딩 |
| `memory.search` | query, scope?, limit?, source? | 시맨틱+키워드 하이브리드 검색 |
| `memory.context` | cwd?, scope? | cwd 기반 자동 컨텍스트 로드 |
| `memory.summary` | summary, sessionId?, scope? | 세션 요약 저장 |
| `memory.ingest` | path, source?, scope? | 파일/디렉토리 인덱싱 |
| `memory.prune` | days?, scope?, execute? | 오래된 메모리 정리 (기본 dry-run) |
| `memory.stats` | scope? | DB 통계 |
| `memory.graph` | query, hops?, limit? | 그래프 관계 탐색 |

## 테스트 패턴
- 각 모듈별 `.test.ts` 공존 (co-located)
- vitest + in-memory SQLite (`":memory:"`)로 DB 의존 테스트
- embedder mock: 768차원 랜덤 벡터

## 커밋 컨벤션
- `feat:` 새 기능, `fix:` 버그, `test:` 테스트, `docs:` 문서, `chore:` 설정
