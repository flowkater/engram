# CLAUDE.md — Engram Phase 1 코드리뷰 반영

## 프로젝트
- 경로: ~/Projects/engram
- 브랜치: master
- 현재: 143 tests, 22 files, tsc 0 errors

## 반영할 코드리뷰 피드백 (9개, 우선순위순)

### 🟠 Medium (Phase 2 전 필수)

#### Fix 1: model mismatch 체크 복원 (server.ts:59-64)
- **문제**: DB에 2종 이상 embed_model일 때만 경고 → 기존 레코드 전부 구 모델 + 현재 새 모델 조합 감지 안 됨
- **수정**: 현재 설정된 모델(Ollama 연결 테스트 또는 env 기반)과 DB의 최신 embed_model을 비교. 불일치 시 경고.
- **테스트**: server 헬스체크에서 모델 불일치 감지 테스트 (있으면 수정, 없으면 추가)

#### Fix 2: scope.ts catch {} 무음 실패 → console.warn 추가
- **문제**: config.json 파싱 오류가 전부 삼켜짐
- **수정**:
```typescript
} catch (err) {
  console.warn(`[scope] Failed to parse config.json: ${(err as Error).message}`);
}
```

#### Fix 3: source_path 상대→절대 one-time 마이그레이션
- **문제**: Phase 0에서 source_path를 절대경로로 전환했으나 기존 DB 행은 상대경로 유지 → softDeleteByPath 매칭 안 됨 → ghost rows
- **수정**: database.ts의 openDatabase()에 마이그레이션 추가:
  1. `SELECT DISTINCT source_path FROM memories WHERE deleted = 0 AND source_path NOT LIKE '/%'` (상대경로 감지)
  2. 상대경로 행이 있으면 → soft delete (deleted=1) 처리
  3. 또는 known vault base path가 있으면 절대경로로 UPDATE
  4. 마이그레이션 실행 여부를 로그로 출력
- **테스트**: 상대경로 레코드가 있는 DB → openDatabase 후 soft delete 또는 절대경로 변환 확인

#### Fix 4: config.example.json 익명화
- **문제**: 실제 프로젝트 경로 노출 (/workspace/todait 등)
- **수정**: 경로를 제네릭하게 변경:
```json
{
  "scopeMap": {
    "my-backend": "/path/to/my-backend",
    "my-ios": "/path/to/my-ios-app"
  },
  "obsidianScopeMap": {
    "Project/my-backend/": "my-backend",
    "Study/": "study",
    "Daily/": "daily"
  }
}
```

### 🟡 Low (품질 개선)

#### Fix 5: setTimeout(50) → fs.utimesSync 교체 (watcher.test.ts)
- **문제**: mtime 변경을 `setTimeout(50)` 대기에 의존 → CI 고부하/HFS+에서 flake 가능
- **수정**: `fs.utimesSync(filePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))` 로 mtime 명시 설정
- 모든 watcher/diffScan 테스트에서 `setTimeout` 대신 `utimesSync` 사용

#### Fix 6: watcher 삭제 처리 db.transaction() 감싸기
- **문제**: diffScan에서 soft delete + checkpoint 삭제가 트랜잭션 없이 실행
- **수정**: `db.transaction(() => { softDeleteByPath(...); deleteCheckpoint(...); })()`

#### Fix 7: E2E mock embedder 중복 → 공유 createMockEmbedder() 통일
- **문제**: full-pipeline.test.ts 등에서 인라인 PRNG mock 사용, 공유 헬퍼와 불일치
- **수정**: `src/__test__/mock-embedder.ts`의 `createMockEmbedder()` 사용으로 통일

#### Fix 8: watcher afterEach tmpDir cleanup
- **문제**: 테스트 후 tmpDir 삭제 안 됨 → CI /tmp 누적
- **수정**: afterEach에 `fs.rmSync(tmpDir, { recursive: true, force: true })` 추가

#### Fix 9: minScore 절대→상대 변환 문서화
- **문제**: 저품질 결과만 있어도 최고 점수가 1.0이 되어 전부 통과
- **수정**: README에 한계 문서화 (이미 계획서에 명시, 코드 변경 불필요. README 확인만)

## 실행 순서

1. Fix 4 (config.example 익명화) — 가장 단순
2. Fix 2 (scope catch warn) — 1줄
3. Fix 9 (README 확인) — 문서만
4. Fix 8 (tmpDir cleanup) — 테스트 수정
5. Fix 7 (mock embedder 통일) — 테스트 수정
6. Fix 5 (utimesSync) — 테스트 수정
7. Fix 6 (transaction) — watcher.ts 수정
8. Fix 3 (source_path 마이그레이션) — database.ts + 테스트
9. Fix 1 (model mismatch 복원) — server.ts + 테스트

## 완료 기준

```bash
npm test          # 전체 통과 (143+)
npx tsc --noEmit  # 0 errors
npm run build     # 성공
```

각 Fix를 개별 커밋.

## 완료 후

```bash
openclaw system event --text "Done: Engram Phase 1 review fixes — all 9 items addressed" --mode now
```
