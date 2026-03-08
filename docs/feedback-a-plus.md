# A+ 달성을 위한 피드백 — Unified Memory MCP Server

> 현재 등급: **A-** (프로덕션 투입 가능)
> 목표: **A+** (레퍼런스 구현 수준)
> Date: 2026-03-08

---

## A-와 A+의 차이

A-는 "잘 동작하고 안전한 코드". A+는 "다른 사람이 보고 배울 수 있는 코드".
아래 7건을 반영하면 오픈소스로 공개해도 손색없는 수준.

---

## 1. 태그 정규화 테이블 (현재 가장 큰 기술 부채)

**현재:** tags가 JSON string (`'["foo","bar"]'`)으로 memories 컬럼에 저장. 태그 기반 링크 생성 시 `LIKE '%tag%'` 풀스캔.

**A+ 기준:**
```sql
CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX idx_tags_tag ON memory_tags(tag);
```

```typescript
// 태그 링크 생성: O(1) 인덱스 룩업
const tagMatches = db.prepare(
  `SELECT DISTINCT memory_id FROM memory_tags
   WHERE tag = ? AND memory_id != ? LIMIT 10`
).all(tag, currentId);
```

**효과:**
- 초기 인덱싱 LIKE 쿼리 ~30,000개 → 인덱스 룩업으로 전환
- 태그 기반 검색/필터링 API 추가 가능
- 태그 통계 (`SELECT tag, COUNT(*) GROUP BY tag`) 즉시 가능

**예상 시간:** 1.5시간

---

## 2. 검색 결과 부족 시 자동 확장 (Adaptive Fetch)

**현재:** `fetchLimit = limit * 5` 고정. scope가 좁으면 유효 결과 부족.

**A+ 기준:**
```typescript
async function memorySearch(db, params) {
  let fetchMultiplier = 5;
  let results: MemoryResult[] = [];

  while (results.length < limit && fetchMultiplier <= 20) {
    const fetchLimit = limit * fetchMultiplier;
    const vecRaw = db.prepare(/*...*/).all(embedding, fetchLimit);
    // ... 필터링 + RRF ...
    results = merged;
    
    if (results.length >= limit) break;
    fetchMultiplier *= 2;  // 5 → 10 → 20
  }

  return results.slice(0, limit);
}
```

**효과:** scope가 전체의 5% 미만인 경우에도 항상 limit개 결과 보장.

**예상 시간:** 30분

---

## 3. graph.ts 양방향 중복 제거

**현재:** outgoing + incoming 링크를 조회하지만, A→B와 B→A가 동시에 존재하면 중복.

**A+ 기준:**
```typescript
// 양방향 링크를 UNION으로 가져오되 dedup
const allLinks = db.prepare(`
  SELECT to_id, link_type, weight FROM memory_links WHERE from_id = ?
  UNION
  SELECT from_id, link_type, weight FROM memory_links WHERE to_id = ?
`).all(nodeId, nodeId);
```

**예상 시간:** 15분

---

## 4. 복원 시나리오 대응 (soft delete ↔ hard delete 정합성)

**현재:** memories는 soft delete, FTS/vec/links는 hard delete.
`deleted = 0`으로 복원하면 검색 불가 상태.

**A+ 기준:**
```typescript
// memory.restore 도구 추가 (또는 prune에 restore 옵션)
export async function memoryRestore(db: Database.Database, id: string): Promise<void> {
  const memory = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  if (!memory) throw new Error("Memory not found");
  
  const embedding = await embed(memory.content);
  
  db.transaction(() => {
    db.prepare("UPDATE memories SET deleted = 0, updated_at = ? WHERE id = ?").run(now, id);
    db.prepare("INSERT INTO memory_vec (id, embedding) VALUES (?, ?)").run(id, Buffer.from(embedding.buffer));
    db.prepare("INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)")
      .run(id, memory.content, memory.summary, memory.tags, memory.scope);
  })();
}
```

또는 최소한 docs에 "복원 시 재인덱싱 필요" 명시.

**예상 시간:** 45분 (도구 추가) 또는 10분 (문서화만)

---

## 5. watcher 시작 시 diff scan

**현재:** `ignoreInitial: true`라 서버 다운타임 동안 변경된 파일 누락.

**A+ 기준:**
```typescript
// 서버 시작 시 마지막 인덱싱 이후 변경 파일 스캔
async function diffScan(db: Database.Database, vaultPath: string) {
  const lastIndexed = db.prepare(
    "SELECT MAX(updated_at) as t FROM memories WHERE source = 'obsidian'"
  ).get() as { t: string | null };

  if (!lastIndexed?.t) return; // 초기 인덱싱 안 됨

  const cutoffMs = new Date(lastIndexed.t).getTime();
  const files = findMarkdownFiles(vaultPath);
  
  for (const file of files) {
    const stat = fs.statSync(path.join(vaultPath, file));
    if (stat.mtimeMs > cutoffMs) {
      await indexFile(db, path.join(vaultPath, file), file, { source: 'obsidian' });
    }
  }
}
```

**효과:** 서버 재시작 후에도 메모리 일관성 보장.

**예상 시간:** 45분

---

## 6. 에러 복구 + health check 도구

**현재:** 에러 시 로그만 남기고 계속 실행. DB 정합성 문제 감지 수단 없음.

**A+ 기준 — `memory.health` 도구 추가:**
```typescript
server.tool("memory.health", "Check memory store integrity", {}, async () => {
  const checks = {
    // memories에 있는데 vec에 없는 유령 레코드
    orphanedMemories: db.prepare(`
      SELECT COUNT(*) as c FROM memories m
      WHERE m.deleted = 0
      AND m.id NOT IN (SELECT id FROM memory_vec)
    `).get(),
    
    // vec에 있는데 memories에 없는 고아 벡터
    orphanedVectors: db.prepare(`
      SELECT COUNT(*) as c FROM memory_vec v
      WHERE v.id NOT IN (SELECT id FROM memories WHERE deleted = 0)
    `).get(),
    
    // FTS 정합성
    orphanedFts: db.prepare(`
      SELECT COUNT(*) as c FROM memory_fts f
      WHERE f.id NOT IN (SELECT id FROM memories WHERE deleted = 0)
    `).get(),
    
    // embed_model 불일치
    modelMismatch: db.prepare(`
      SELECT embed_model, COUNT(*) as c FROM memories
      WHERE deleted = 0 AND embed_model IS NOT NULL
      GROUP BY embed_model
    `).all(),
  };
  
  return { content: [{ type: "text", text: JSON.stringify(checks, null, 2) }] };
});
```

**효과:** 운영 중 정합성 문제 조기 발견 + 자동 복구 기반 마련.

**예상 시간:** 1시간

---

## 7. 통합 테스트 — 실제 Obsidian vault로 E2E

**현재:** 85개 유닛 테스트는 mock/fixture 기반. 실제 vault 인덱싱 → 검색 → 그래프 탐색 E2E 없음.

**A+ 기준:**
```typescript
// test/e2e/full-pipeline.test.ts
describe('E2E: vault indexing → search → graph', () => {
  const testVault = path.join(__dirname, 'fixtures/sample-vault'); // 10-20개 .md
  
  it('indexes vault and returns correct search results', async () => {
    await indexDirectory(db, testVault, { source: 'obsidian' });
    const stats = memoryStats(db, dbPath);
    expect(stats.total).toBeGreaterThan(0);
    
    const results = await memorySearch(db, { query: 'test topic' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].scope).toBe('expected-scope');
  });
  
  it('graph traversal finds connected notes via wikilinks', async () => {
    const graph = await memoryGraph(db, { query: 'linked note' });
    expect(graph.connected.length).toBeGreaterThan(0);
    expect(graph.connected.some(c => c.linkType === 'wikilink')).toBe(true);
  });
});
```

**효과:** 리팩토링 시 회귀 방지, 검색 품질 벤치마크 기반.

**예상 시간:** 2시간 (fixture vault 제작 포함)

---

## 우선순위 요약

| 순서 | 항목 | 예상 시간 | 임팩트 |
|------|------|----------|--------|
| 1 | 태그 정규화 테이블 | 1.5h | ⭐⭐⭐ 성능 + 확장성 |
| 2 | memory.health 도구 | 1h | ⭐⭐⭐ 운영 안정성 |
| 3 | watcher diff scan | 45m | ⭐⭐ 데이터 일관성 |
| 4 | E2E 통합 테스트 | 2h | ⭐⭐ 품질 보증 |
| 5 | Adaptive fetch | 30m | ⭐⭐ 검색 품질 |
| 6 | graph dedup | 15m | ⭐ 정확성 |
| 7 | restore 도구/문서 | 45m | ⭐ 완성도 |

**총 예상: ~6.5시간 → A+ 달성**

---

*Feedback by JARVIS — 2026-03-08*
