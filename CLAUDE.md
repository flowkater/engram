# CLAUDE.md — Engram Phase 0 크리틱 반영

## 프로젝트
- 경로: ~/Projects/engram
- 브랜치: master
- 현재: 113 tests, 20 files, tsc 0 errors

## 반영할 크리틱 피드백 (8개)

### 🔴 Critical

#### Fix 1: source_path 절대 vs 상대 통일
- **문제**: `ingest.ts` 단일 파일은 `path.resolve()` (절대), `indexDirectory`는 상대경로
- **수정**: `indexDirectory` → `indexFile` 호출 시 `path.resolve(path.join(dirPath, file))` 사용
- **영향**: indexer.ts의 `indexDirectory` 함수
- **테스트**: indexer.test.ts에서 디렉토리 인덱싱 후 source_path가 절대경로인지 확인

#### Fix 2: embed_model DB 기록 검증 테스트 추가
- **문제**: indexer/ingest 테스트에서 memories.embed_model 칼럼 값을 검증하지 않음
- **수정**: indexer.test.ts와 ingest.test.ts에 `SELECT embed_model FROM memories` assert 추가
- **테스트 코드**:
```typescript
const row = db.prepare("SELECT embed_model FROM memories WHERE deleted = 0 LIMIT 1").get() as any;
expect(row.embed_model).toBe("test-model");
```

### 🟠 Major

#### Fix 3: getCurrentModelName() 서버 헬스체크 교체
- **문제**: server.ts 헬스체크에서 deprecated `getCurrentModelName()` 사용 → OpenAI fallback 시 잘못된 모델 반환
- **수정**: 헬스체크에서 실제 embed 테스트를 실행하거나, DB의 최신 embed_model 조회
- **영향**: server.ts

#### Fix 4: ingest source_path assert 강화
- **문제**: `expect(row.source_path).toContain("note.md")` — 느슨
- **수정**:
```typescript
expect(path.isAbsolute(row.source_path)).toBe(true);
expect(row.source_path).toBe(path.resolve(filePath));
```

#### Fix 5: mock embedder 공유 헬퍼 추출
- **문제**: 10개 테스트 파일에 동일한 fakeEmbed + withModel wrapper 복붙
- **수정**: `src/__test__/mock-embedder.ts` 생성, 모든 테스트 파일에서 import
- **영향**: 모든 `vi.mock("./embedder.js")` 또는 `vi.mock("../core/embedder.js")` 사용 파일

### 🟡 Minor

#### Fix 6: uuid.d.ts + @types/uuid 이중 선언 제거
- **문제**: `src/types/uuid.d.ts` 수동 선언 + `@types/uuid` 패키지 동시 존재
- **수정**: `src/types/uuid.d.ts` 파일 삭제

#### Fix 7: strict local 에러 메시지 개선
- **문제**: OPENAI_API_KEY 있지만 STRICT_LOCAL=true일 때 "no OPENAI_API_KEY" 메시지 → 혼란
- **수정**:
```typescript
if (apiKey && STRICT_LOCAL) {
  throw new Error(`Embedding failed: Ollama unavailable. ENGRAM_STRICT_LOCAL=true blocks OpenAI fallback. Set ENGRAM_STRICT_LOCAL=false to allow.`);
}
throw new Error(`Embedding failed: Ollama unavailable and no OPENAI_API_KEY set`);
```
- **테스트**: OPENAI_API_KEY 설정 + STRICT_LOCAL=true → 에러 메시지에 "ENGRAM_STRICT_LOCAL" 포함 확인

#### Fix 8: recursive 파라미터는 아직 제거하지 말 것
- MCP strict schema 호환성 문제 가능. Phase 1에서 제거 예정. 지금은 유지.

## 실행 순서

1. Fix 6 (uuid.d.ts 삭제) — 가장 단순
2. Fix 5 (mock 헬퍼 추출) — 많은 파일 수정이지만 로직 변경 없음
3. Fix 7 (에러 메시지) — embedder.ts 수정 + 테스트
4. Fix 2 (embed_model DB 검증 테스트)
5. Fix 4 (source_path assert 강화)
6. Fix 1 (source_path 절대경로 통일) — indexer.ts 수정 + 테스트
7. Fix 3 (헬스체크 getCurrentModelName 교체)

## 완료 기준

1. `npm test` — 전체 통과 (113 + 신규 테스트)
2. `npx tsc --noEmit` — 0 에러
3. `npm run build` — 성공
4. 각 Fix를 개별 커밋

## 완료 후

```bash
openclaw system event --text "Done: Engram Phase 0 critique fixes — all 8 items addressed" --mode now
```
