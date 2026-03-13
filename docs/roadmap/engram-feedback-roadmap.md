---
tags:
  - 프로젝트/engram
  - 타입/로드맵
created: 2026-03-09
status: 진행중
---

# engram 피드백 반영 로드맵

> 피드백 원문: [[Engram(Unified memory mcp) 피드백]]
> 핵심 전환: **"메모리 검색 서버" → "메모리 시스템"**
> 온톨로지 확장은 별도 로드맵으로 분리 (현재 제외)

---

## 핵심 인사이트

> "검색 서버 → 기억 시스템" 전환의 핵심은 **consolidation(승격/병합/폐기)**이다.
> 지금은 "넣고 찾기"만 있고 "기억하기"가 없다.

피드백 요약:
- 스택 선택(SQLite+FTS5+sqlite-vec+MCP)과 운영성은 좋음
- **신뢰 문제**: OpenAI fallback이 기본값, embed_model 기록 부정확
- **데이터 정합성**: diffScan watermark 누락 가능, source_path 충돌 위험
- **기억 모델 부재**: chunk 저장/검색은 하지만 승격/통합/폐기가 없음
- **차별화**: Supermemory 정면 승부 X → 개발자 작업기억 엔진으로

---

## Phase 0: 신뢰 회복 (1-2일) ⚡

FORGE 즉시 실행 가능.

| # | 작업 | 핵심 이유 |
|---|------|----------|
| 0-1 | **strict local-only 기본값** | OpenAI fallback → 명시적 opt-in. "100% local" 약속 지키기 |
| 0-2 | **embed_model provenance 수정** | getCurrentModelName() → 실제 사용 모델 기록. 재인덱싱 판단의 기초 |
| 0-3 | **source_path 정규화** | basename → full relative path. 파일명 충돌 방지 |
| 0-4 | **README/주석 drift 정리** | 10 tools vs 8, 108 tests vs 81, recursive 미사용 파라미터 등 |

**완료 기준**: 테스트 전부 통과 + README와 코드가 일치

---

## Phase 1: 데이터 정합성 (3-5일)

| # | 작업 | 핵심 이유 |
|---|------|----------|
| 1-1 | **file-level checkpoint** | diffScan의 MAX(updated_at) watermark → 파일별 체크포인트. 변경 누락 원천 차단 |
| 1-2 | **scope 하드코딩 제거** | scope.ts 기본 매핑 → 설정 파일 외부화 (AGENTS.md 명세와 실제가 불일치) |
| 1-3 | **minScore 스케일 정리** | RRF 합산 점수 ≠ 0~1. API 문서 + 사용자 가이드라인 명시 |
| 1-4 | **ingest recursive 파라미터** | 사용 안 되는 파라미터 제거 or 실제 구현 |

**완료 기준**: diffScan edge case 테스트 추가, scope 설정 외부화 완료

---

## Phase 2: 기억 모델 (2주)

"검색 서버 → 기억 시스템" 전환의 핵심.

**Phase 2 v1 원칙:**
- manual canonicalization 우선, auto-promotion은 보류
- `memory.add`는 raw evidence 전용으로 유지
- canonical layer는 raw layer 위에 별도 `canonical_*` 테이블로 추가
- `time-aware`는 먼저 `memory.search.asOf`에만 적용
- 운영 안전성(`prune`/`scheduler`/`health`/`stats`)을 같은 phase 안에서 같이 보강

| # | 작업 | 핵심 이유 |
|---|------|----------|
| 2-1 | **manual promotion pipeline** | raw memory → canonical memory 수동 승격. 현재 `access_count`는 조회 노이즈가 섞여 auto-promotion 신호로 부적합 |
| 2-2 | **supersedes/contradicts 관계** | truth change와 conflict를 분리해 표현. `supersedes`만 validity를 닫고 `contradicts`는 비파괴로 유지 |
| 2-3 | **decision memory** | canonical `decision` 타입 추가. `memory.add`를 확장하지 않고 `memory.promote`로만 생성 |
| 2-4 | **time-aware query** | 먼저 `memory.search.asOf`만 지원. context/graph historical replay는 후속 단계로 분리 |
| 2-5 | **operational safety for canonical layer** | active canonical memory가 참조하는 raw evidence를 prune/scheduler가 지우지 않도록 보장 |

**완료 기준**: canonical memory/evidence/edge 테이블 + manual promotion + supersedes/contradicts + `memory.search.asOf` + canonical-aware prune/health/stats 동작 확인

---

## Phase 3: 개발자 작업기억 커넥터 (2-3주)

피드백이 정확히 짚은 **"cloud가 못 따라오는 영역"**.

**방향성:** breadth 경쟁 대신 developer workflow truth engine에 집중.
Google Drive/Gmail/범용 consumer profile보다 git/build/test/failure/terminal 맥락을 먼저 기억한다.

| # | 작업 | 핵심 이유 |
|---|------|----------|
| 3-1 | **Git commit/diff 커넥터** | 코드 변경의 why/what을 자동 기억. commit message + diff 요약 ingest |
| 3-2 | **빌드/테스트 결과 커넥터** | 빌드 실패 → 원인 → 해결법 자동 번들링 |
| 3-3 | **procedure memory** | 성공한 디버깅/배포 절차 자동 추출 → 재실행 가능한 playbook |
| 3-4 | **failure memory** | 반복 에러 패턴 + flaky test 히스토리 축적 |

**완료 기준**: git log ingest 자동화 + 테스트 결과 파싱 + procedure 추출 프로토타입

---

## Phase 4: 품질 측정 + 제품화 (3-4주)

| # | 작업 | 핵심 이유 |
|---|------|----------|
| 4-1 | **retrieval explanation** | 각 결과에 "왜 이게 나왔나" (semantic/FTS/최근성/link) 메타데이터 |
| 4-2 | **golden questions eval harness** | 로컬 평가셋. hit@k 말고 agent task success lift, stale rate, contradiction rate 측정 |
| 4-3 | **memory inspector TUI** | 기억 편집/승격/폐기/병합 — 사람이 통제 가능 |
| 4-4 | **agent feedback loop** | retrieved memory가 실제 도움됐나 로그 → 향후 랭킹 반영 |

**완료 기준**: eval harness 동작 + inspector로 memory surgery 가능

---

## 타임라인

```
Phase 0 (1-2일)  ■■ 신뢰 회복
Phase 1 (3-5일)  ■■■ 데이터 정합성
Phase 2 (2주)    ■■■■■■ 기억 모델
Phase 3 (2-3주)  ■■■■■■■ 개발자 작업기억
Phase 4 (3-4주)  ■■■■■■■■ 품질+제품화
                 ──────────────────────
                 총 ~8-10주
```

---

## 의도적으로 제외한 것

| 제외 항목 | 이유 |
|----------|------|
| 온톨로지 확장 (PageRank GraphRAG, LLM entity extraction, domain schema) | 별도 로드맵으로 분리. 기억 모델이 먼저 |
| typed memory full taxonomy (fact/procedure/preference/bug/todo 등) | Phase 2 v1은 `fact`/`decision`만. 나머지는 실사용 데이터 보고 |
| query intent router | Phase 4 eval 결과 보고 판단 |
| Supermemory 벤치마킹 | 용도가 다름 — 우리는 개발자 MCP 메모리 |
| memory inspector web UI | TUI 우선. web은 사용량 보고 |
| auto-promotion | 현재 `access_count`는 조회 노이즈가 섞임. 실사용 피드백/평가 지표 확보 후 재검토 |

---

## 차별화 포지셔닝

```
Supermemory          engram
─────────────        ─────────────
managed infra        100% local
범용 user profile    개발자 작업기억
connectors 수        provenance 깊이
learned context      inspectable memory
temporal handling    memory surgery
```

> engram이 이기는 영역:
> **provenance, inspectability, editability, reproducibility, project-scoped privacy**
> 특히 Git/터미널/빌드/테스트/디버깅 맥락 기억은 cloud 제품이 따라올 수 없다.

> 운영 원칙:
> canonical truth는 항상 raw evidence와 함께 설명 가능해야 한다.
> breadth보다 provenance와 staleness control이 우선이다.

---

## ⚠️ FORGE 실행 시 주의사항

1. **Phase 순서 엄수** — 반드시 Phase 0 → 1 → 2 → 3 → 4 순서. 앞 Phase 완료 전 다음 Phase 착수 금지
2. **기존 테스트 108개 보호** — Phase 0~1은 버그 수정/정합성이므로, 기존 테스트가 깨지면 안 됨. 새 테스트 추가는 OK
3. **Phase 2 데이터 모델 변경 전 토니 확인 필수** — typed memory + canonicalization은 DB 스키마 변경이 큼. 마이그레이션 잘못되면 670MB 재인덱싱. **설계 먼저 → 토니 승인 → 구현** 순서
4. **Phase 2 v1은 manual canonicalization만** — auto-promotion, graph time-travel, broad taxonomy는 넣지 말 것
5. **운영 안전성은 같은 phase에서 같이 처리** — canonical layer 도입 시 prune/scheduler/health/stats를 반드시 함께 보강
6. **Phase 2부터는 실사용 피드백 반영** — "잘못된 기억이 올라온 케이스", "못 찾은 기억 케이스" 등 실제 데이터를 수집한 뒤 방향 조정. 이론만으로 과도하게 확장하지 말 것
7. **Phase 3~4는 실사용 데이터 재평가 후 착수** — Phase 2 결과 + 실사용 2~3주 데이터를 보고 Phase 3~4 범위를 재조정할 수 있음

---

## 🔗 메타데이터
- **관련**: [[Engram(Unified memory mcp) 피드백]], [[Unified Memory MCP Server 설계 문서]]
- **프로젝트**: engram (GitHub: flowkater/engram)
- **경로**: `~/workspace/side/engram/`
