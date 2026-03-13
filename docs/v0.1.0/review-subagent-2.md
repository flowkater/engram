# Code Review — Subagent 2 (운영/실전 관점)

## Summary

전체적으로 잘 구조화된 MCP 서버이나, **대규모 vault 운영 시 치명적인 성능/안정성 문제**가 다수 존재한다. 특히 indexer의 N+1 쿼리 패턴, 트랜잭션 미사용, Ollama 타임아웃 무방비, SIGINT 핸들러 중복 등록이 실전 배포에서 즉시 문제를 일으킬 수 있다. 세션 트래커의 stdin 기반 종료 감지는 stdio transport 특성상 합리적이나, flush가 async임에도 프로세스가 먼저 종료될 수 있는 레이스 컨디션이 있다.

## Critical Issues (즉시 수정 필요)

### [C1] indexFile에서 트랜잭션 미사용 — 부분 삽입으로 DB 오염

- 파일: `src/core/indexer.ts` (indexFile 함수)
- 문제: 하나의 파일을 인덱싱할 때 memories, memory_vec, memory_fts, memory_links에 여러 INSERT를 실행하는데 트랜잭션으로 감싸지 않는다. 임베딩 API 호출(`await embed()`)이 중간 청크에서 실패하면, 앞선 청크는 이미 DB에 들어가고 뒷 청크는 누락되어 **파편화된 상태**가 된다. softDeleteByPath로 기존 청크를 먼저 삭제하므로, 실패 시 **기존 데이터도 새 데이터도 없는 상태**가 된다.
- 수정 제안: 전체 indexFile을 `db.transaction()`으로 감싸되, 임베딩은 트랜잭션 밖에서 미리 모두 생성한 후 한꺼번에 INSERT. 또는 최소한 softDelete와 INSERT를 하나의 트랜잭션에 묶기.

### [C2] Ollama fetch에 타임아웃/재시도 없음

- 파일: `src/core/embedder.ts`
- 문제: `fetch()` 호출에 `AbortController` 타임아웃이 없다. Ollama가 모델 로딩 중이면 **수분간 블로킹**될 수 있고, 10만 파일 인덱싱 시 한 번의 hang이 전체 파이프라인을 멈춘다. 재시도 로직도 없어서 일시적 네트워크 오류에도 즉시 실패.
- 수정 제안:
  ```typescript
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const res = await fetch(url, { signal: controller.signal, ... });
  clearTimeout(timeout);
  ```
  최소 1회 재시도 (exponential backoff) 추가.

### [C3] SIGINT/SIGTERM 핸들러 3중 등록 — 경쟁 조건

- 파일: `src/server.ts`
- 문제: SIGINT/SIGTERM 핸들러가 3곳에서 등록된다: (1) watcher 정리용, (2) scheduler 정리용, (3) 파일 하단 fallback용. 어떤 핸들러가 먼저 실행될지 보장이 없고, 첫 번째 핸들러의 `process.exit(0)`이 나머지 정리 로직을 건너뛸 수 있다. sessionTracker.flush()는 async인데 SIGINT 핸들러에서 await 후 즉시 exit하므로, watcher.close()는 실행되지 않을 수 있다.
- 수정 제안: 단일 shutdown 함수로 통합.
  ```typescript
  async function shutdown() {
    await sessionTracker.flush();
    await watcher?.close();
    scheduler?.stop();
    dbInstance.close();
    process.exit(0);
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  ```

### [C4] indexDirectory의 Promise.all이 Ollama를 동시 폭격

- 파일: `src/core/indexer.ts` (indexDirectory 함수)
- 문제: `BATCH_SIZE = 20`으로 설정하고 `Promise.all(batch.map(...))`로 동시 실행. 각 파일이 여러 청크를 가지므로 실제로는 수십~수백 개의 Ollama 임베딩 요청이 동시에 발생한다. 로컬 Ollama는 보통 직렬 처리하므로 **큐 폭발, OOM, 타임아웃**이 발생할 수 있다.
- 수정 제안: `BATCH_SIZE`를 3~5로 줄이거나, 임베딩 요청을 세마포어/큐로 직렬화. `p-limit` 등 사용 권장.

## Major Issues (개선 권장)

### [M1] search에서 scope/source 필터를 SQL 밖에서 적용 — 결과 누락

- 파일: `src/tools/search.ts`
- 문제: vec/fts 검색 후 RRF merge → fetch → **JS에서 scope/source 필터링**. `limit=10` 요청 시 fetchLimit=30개를 가져와 병합하지만, 대부분이 다른 scope이면 결과가 0~2개만 남을 수 있다. 필터를 SQL 단계에서 적용해야 한다.
- 수정 제안: vec 검색 시 JOIN memories로 scope 필터 적용하거나, 필터 후 결과가 부족하면 추가 fetch.

### [M2] FTS 인덱스와 memories 테이블 동기화 보장 없음

- 파일: `src/core/database.ts`, `src/core/indexer.ts`
- 문제: memories 테이블에서 soft-delete(`deleted=1`)해도 memory_fts와 memory_vec에는 그대로 남는다. 검색 시 deleted 레코드가 vec/fts 결과에 포함된 후 memories JOIN에서 필터되므로, 삭제된 데이터가 많을수록 **유효 결과 수가 줄어든다**. prune도 soft-delete만 한다.
- 수정 제안: soft-delete 시 fts/vec에서도 제거하거나, 주기적 vacuum 작업 추가. 최소한 prune에서 hard-delete 시 fts/vec 정리.

### [M3] watcher가 심볼릭 링크를 따라감

- 파일: `src/core/watcher.ts`
- 문제: chokidar 옵션에 `followSymlinks` 설정이 없다 (기본값 true). Obsidian vault에 심볼릭 링크가 있으면 **무한 루프** 또는 vault 외부 파일 인덱싱이 발생할 수 있다.
- 수정 제안: `followSymlinks: false` 추가.

### [M4] 대량 파일 변경 시 watcher debounce가 메모리 누수

- 파일: `src/core/watcher.ts`
- 문제: `debounceTimers` Map에 파일별 타이머를 저장하는데, git checkout으로 1만 파일이 동시 변경되면 1만 개의 타이머가 동시 생성된다. 각 타이머의 콜백이 Ollama 임베딩을 호출하므로 2초 후 1만 개의 동시 HTTP 요청이 발생.
- 수정 제안: 글로벌 큐 또는 동시성 제한(semaphore) 도입. git 작업 감지 시 일괄 처리 모드로 전환.

### [M5] CLI exit code가 부정확

- 파일: `src/cli.ts`
- 문제: 잘못된 명령어에 `process.exit(1)`, index 경로 누락에 `process.exit(1)`은 올바르지만, main의 catch에서 모든 에러를 exit(1)로 처리한다. 인덱싱 중 일부 파일 실패 시에도 성공(exit 0)으로 종료.
- 수정 제안: 부분 실패 시 exit code 구분 (예: exit 2).

### [M6] search에서 access_count UPDATE의 SQL injection 가능성

- 파일: `src/tools/search.ts`, `src/tools/context.ts`
- 문제: `${placeholders}` 동적 SQL 생성을 사용. better-sqlite3의 prepared statement에 spread로 넘기므로 실제 injection은 아니지만, ids가 외부 입력이 아닌 DB에서 온 UUID이므로 안전하다. 그러나 **패턴 자체가 위험**하고 유지보수 시 실수 유발.
- 수정 제안: 일괄 UPDATE 대신 개별 UPDATE를 트랜잭션으로 묶거나, `db.prepare().run()` 반복.

## Minor Issues (선택적 개선)

### [m1] 하드코딩된 경로들

- 파일: `src/utils/scope.ts`
- 문제: `/workspace/todait/todait/todait-backend` 등 토니 개인 환경 경로가 하드코딩. 다른 환경에서 재사용 불가.
- 수정 제안: 설정 파일(`~/.unified-memory/config.json`)로 외부화.

### [m2] EMBEDDING_DIM 768 하드코딩

- 파일: `src/core/embedder.ts`, `src/core/database.ts`
- 문제: `float[768]`이 DB 스키마에 고정. 모델 변경 시 DB 재생성 필요.
- 수정 제안: 설정 가능하게 하거나 최소한 상수를 공유 참조.

### [m3] parseFrontmatter의 YAML 파싱이 불완전

- 파일: `src/core/chunker.ts`
- 문제: 수동 정규식으로 YAML을 파싱하여 multi-line tags, 중첩 구조, 따옴표 내 콜론 등에서 오동작. `tags:` 아래의 `- item` 파싱 로직에 버그: `tagItemMatch && !meta.tags` 조건이 첫 번째 아이템만 잡고, 이후 아이템은 `yamlBlock.includes("tags:")` 분기로 빠지는데 다른 리스트 항목도 태그로 오인할 수 있다.
- 수정 제안: `yaml` 패키지 사용하거나, `gray-matter` 같은 frontmatter 전용 라이브러리 도입.

### [m4] node-cron 의존성이 불필요할 수 있음

- 파일: `package.json`, `src/core/scheduler.ts`
- 문제: MCP 서버가 항상 장시간 구동되는 것이 아니라 세션 단위로 실행될 수 있다. cron 스케줄러가 서버 시작 시 등록되지만 세션이 짧으면 한 번도 실행되지 않는다. `setInterval`로도 충분.
- 수정 제안: node-cron 제거하고 OS cron + CLI 조합 또는 setInterval 사용.

### [m5] 로그 파일 무제한 증가

- 파일: `src/server.ts`
- 문제: 날짜별 로그 파일 생성하지만 rotation/삭제 정책이 없다. 장기 운영 시 디스크 소모.
- 수정 제안: 7일 이상 된 로그 자동 삭제 또는 최대 크기 제한.

### [m6] `uuid` v7 사용은 좋으나 정렬 의존 미명시

- 파일: 전역
- 문제: UUIDv7은 시간 순서 정렬이 가능한데, 코드에서 이 속성을 활용하는지 불명확. created_at 컬럼도 별도로 존재하므로 UUIDv4로도 충분할 수 있다.

### [m7] `zod` import가 MCP SDK 내부에서 re-export되는 것에 의존

- 파일: `src/server.ts`
- 문제: `import { z } from "zod"`인데 package.json에 zod가 직접 의존성으로 없다. MCP SDK가 zod를 가져오므로 현재 동작하지만, SDK 버전 업 시 깨질 수 있다.
- 수정 제안: `zod`를 dependencies에 명시 추가.

### [m8] `estimateTokens` 함수의 4 chars/token은 매직 넘버

- 파일: `src/core/chunker.ts`
- 문제: 한국어 콘텐츠가 많은 Obsidian vault에서 4 chars/token 추정은 부정확 (한국어는 ~2 chars/token에 가까움). 청크 크기가 의도보다 2배 커질 수 있다.
- 수정 제안: 언어별 보정 또는 `tiktoken` 사용.

## Positive Aspects

1. **RRF 기반 하이브리드 검색**: 벡터 + FTS5를 RRF로 병합하는 설계가 실용적이고 정확도가 높다.
2. **Hash 기반 skip**: 이미 인덱싱된 파일을 SHA-256으로 감지하여 불필요한 재처리 방지.
3. **Soft-delete 패턴**: 데이터 복구 가능성을 남겨둔 점이 좋다.
4. **세션 자동 요약**: 사용 패턴을 자동 기록하는 기능이 실전적으로 유용.
5. **코드 구조**: tools/core/utils 분리가 깔끔하고, 각 모듈의 책임이 명확.
6. **WAL 모드**: 동시 읽기 성능 확보.
7. **Debounce 적용**: 파일 변경 시 불필요한 재인덱싱 방지.
8. **OpenAI fallback**: Ollama 실패 시 대체 경로 존재.

## Recommendations

**즉시 (P0):**
1. [C1] indexFile에 트랜잭션 적용 — DB 정합성의 기본
2. [C2] Ollama fetch에 30초 타임아웃 + 1회 재시도
3. [C3] SIGINT/SIGTERM 핸들러 단일화

**1주 내 (P1):**
4. [C4] 임베딩 동시성 제한 (semaphore, max 3~5 concurrent)
5. [M1] search 필터를 SQL 단계로 이동
6. [M2] soft-delete 시 fts/vec 동기 정리
7. [M3] `followSymlinks: false` 추가

**2주 내 (P2):**
8. [M4] watcher에 글로벌 인덱싱 큐 도입
9. [m3] frontmatter 파싱을 `gray-matter`로 교체
10. [m7] zod를 직접 의존성으로 추가
11. [m8] 한국어 토큰 추정 보정

**장기 (P3):**
12. [m1] scope 매핑을 설정 파일로 외부화
13. [m4] 스케줄러를 OS cron + CLI로 전환
14. [m5] 로그 rotation 정책 추가
