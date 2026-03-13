봤습니다. 코어(database/embedder/indexer/watcher/session-tracker), 툴(add/search/context/graph/summary/ingest/prune/health/restore/stats), 유틸(scope/tags/delete-related/rrf), 테스트, 그리고 로드맵/리뷰 문서까지 기준으로 보면, Engram은 지금 이미 “raw memory retrieval engine” 단계는 꽤 잘 정리돼 있고, strict-local 기본값, file-level checkpoint 기반 diff scan, 외부 config.json 기반 scope, 01 정규화 minScore, ingest의 단순화 같은 Phase 01 전제도 대체로 들어와 있습니다. 그래서 다음 단계가 정말 Phase 2인 건 맞습니다.  ￼

다만 작은 경고 신호도 있습니다. README는 10개 툴과 147 tests를 말하고, AGENTS.md는 113개 테스트, CLAUDE.md는 144개 테스트를 말합니다. 즉 기능은 진척됐지만 운영 문서의 신뢰 계층은 아직 조금 흔들리고 있습니다. Phase 2에 들어가면 데이터 모델이 커지므로, 이런 드리프트는 초반에 한 번 같이 정리하는 편이 좋습니다.  ￼

제 결론부터 말하면, 지금 설계 방향은 맞습니다. 특히 raw memories 위에 canonical layer를 별도로 얹겠다는 방향은 현재 구조와 잘 맞습니다. 지금 검색은 memories + memory_vec + memory_fts를 기준으로 hybrid RRF를 돌리고, context는 scope/global raw memories를 우선순위로 뽑고, graph는 memory_links를 BFS로 탐색합니다. 이 구조에서 raw layer를 갈아엎는 것보다, canonical layer를 “위에 추가”하는 편이 훨씬 안전합니다.  ￼

하지만 그대로 구현하면 안 되는 부분도 분명합니다. 첫째, plan의 “raw memories remain immutable evidence”라는 표현은 현재 코드와는 조금 다릅니다. 지금 raw row는 search/context에서 access_count와 accessed_at가 바뀌고, reindex/prune에서 deleted와 updated_at도 바뀝니다. 즉 지금 memories는 “immutable truth”라기보다 “evidence records with mutable lifecycle”에 가깝습니다. Phase 2 문서와 코드 계약도 그 표현으로 맞추는 게 더 정확합니다.  ￼

둘째, auto-promotion을 access_count에 기대는 건 지금 시점엔 위험합니다. 현재 memory.search와 memory.context는 결과를 반환하는 즉시 access_count를 올립니다. 즉 “정말 쓸모 있어 재사용된 기억”이 아니라 “자주 조회된 chunk”가 점수를 먹는 구조입니다. 이걸 그대로 promotion 신호로 쓰면, context preload나 broad search에 자주 걸리는 노이즈 chunk가 canonical fact로 올라갈 수 있습니다. 그래서 Phase 2 v1은 manual promotion only가 맞고, auto-promotion은 최소한 Phase 2B나 실사용 데이터가 쌓인 뒤로 미루는 게 좋습니다.  ￼

셋째, Phase 2 범위에 prune.ts, scheduler.ts, health.ts, stats.ts를 반드시 넣어야 합니다. 현재 weekly scheduler는 자동 prune을 돌리고, prune은 오래된 raw memory를 soft-delete하면서 vec/fts/links/tags를 같이 지웁니다. canonical memory가 raw evidence를 참조하게 되면, active canonical memory의 근거가 scheduler에 의해 조용히 약해질 수 있습니다. 또 health/stats도 지금은 raw memories/vector/fts/tags/links만 진단·집계합니다. canonical layer를 넣고 이 네 파일을 안 건드리면, 겉보기엔 동작해도 운영 단계에서 틀어질 가능성이 큽니다.  ￼

넷째, graph semantics도 먼저 정리하는 게 좋습니다. server의 memory.graph 설명은 wikilink/tag/scope/session 관계를 탐색한다고 말하지만, 제가 확인한 쓰기 경로에서는 memory_links가 indexer에서 wikilink와 tag로만 생성되고, session 쪽은 sessions table만 갱신합니다. 즉 이름은 넓은데 실제 edge 생성은 좁습니다. 그래서 Phase 2의 관계 모델은 기존 memory_links를 확장하려고 하기보다, canonical 전용 edge를 따로 만들고 의미를 명확히 하는 편이 낫습니다.  ￼

1️⃣ 이 설계가 정말 좋은지에 대한 제 평가는 이렇습니다.
좋은 설계입니다. 다만 “separate canonical layer + fact/decision only + explicit evidence + explicit supersedes/contradicts + asOf search”까지만 잡아야 좋습니다. 반대로 memory.add에 decision metadata를 섞는 것, auto-promotion, supported_by 같은 추가 edge, broad taxonomy, graph time-travel까지 한 번에 넣으면 지금 코드베이스 대비 Phase 2가 너무 커집니다. 특히 memory.add와 memory.summary는 현재 raw memory row를 생성하는 도구라서, 여기에 canonical decision semantics를 섞으면 raw/canonical 경계가 흐려집니다. decision은 memory.promote에서만 만들고, memory.add는 끝까지 raw-only로 두는 게 구조적으로 더 깨끗합니다.  ￼

2️⃣ Engram을 Supermemory보다 강하게 만드는 방향은 “더 많은 generic memory 기능”이 아닙니다. Supermemory는 공식적으로 자동 fact extraction, contradictions/temporal handling, user profiles, hybrid search, Google Drive/Gmail/Notion/OneDrive/GitHub connectors, multimodal extractors, hosted/open MCP, 그리고 LongMemEval·LoCoMo·ConvoMem 1위 포지셔닝까지 전면에 내세우고 있습니다. 이 축에서 breadth 싸움을 하면 Engram은 바로 managed infra 제품과 정면충돌합니다.  ￼

반대로 Engram 로드맵이 이미 잘 짚고 있듯이, Engram이 이길 자리는 developer working memory입니다. 로드맵도 Supermemory 정면 승부를 피하고, provenance, inspectability, editability, reproducibility, project-scoped privacy, 그리고 이후 Git/build/test/failure connectors 쪽을 차별화 포인트로 잡고 있습니다. 이 방향이 맞습니다. Engram은 “generic memory cloud”가 아니라, 로컬 코드베이스와 작업흐름에 붙어 있는 truth engine이 돼야 합니다.  ￼

그래서 제품 방향은 이렇게 잡는 게 좋습니다.
첫째, canonical result는 항상 “한 줄 주장”만 주지 말고 근거 raw memories와 superseded predecessor를 같이 보여줘야 합니다. 신뢰는 retrieval score가 아니라 provenance explainability에서 나옵니다. 둘째, 현재 raw layer가 이미 source_path, source_hash, file checkpoint를 가지고 있으니, 이걸 이용해 evidence source drift가 생기면 canonical memory를 needs_review로 표식하는 방향이 매우 강합니다. 이건 generic consumer memory보다, 로컬 코드·문서·노트가 바뀌었을 때 진실이 흔들리는 개발자 환경에 더 맞습니다. 셋째, Phase 3는 Google Drive나 Gmail보다 git diff / build / test / failure / terminal workflow가 먼저입니다. 그게 roadmap이 말한 cloud가 따라오기 어려운 해자입니다.  ￼

3️⃣ memory model을 더 단순하게 만드는 리팩토링도 분명히 가능합니다. 제 추천은 Phase 2 v1에서 테이블을 세 개만 도입하는 것입니다. canonical_memories, canonical_evidence, canonical_edges 정도면 충분합니다. 이름도 memory_evidence, memory_relationships보다는 이렇게 canonical_*로 분리하는 편이 현재의 raw memory_links와 충돌이 덜합니다. 그리고 v1에서는 status, summary, tags, supported_by를 빼는 편이 낫습니다. status는 valid_to로 대부분 유도할 수 있고, supported_by는 evidence table이 이미 support를 표현합니다. tags도 유지하려면 raw layer처럼 정규화 테이블까지 같이 들어가야 하는데, 그건 Phase 2를 다시 넓힙니다. 현재 raw layer가 이미 memory_tags를 둔 이유가 그만큼 JSON tags만으로는 한계가 있기 때문입니다.  ￼

저라면 canonical_memories에는 id, kind, title, content(또는 statement), scope, importance, confidence, valid_from, valid_to, decided_at, created_at, updated_at만 둡니다. 그리고 규칙은 단순하게 갑니다. supersedes는 predecessor의 valid_to를 successor의 valid_from ?? decided_at ?? relation.created_at로 닫고, contradicts는 상대를 비활성화하지 않습니다. contradiction은 “해결된 변화”가 아니라 “동시에 존재하는 충돌”이기 때문입니다. 이 정도면 time-aware retrieval도 충분히 됩니다.

툴 표면도 줄이세요. memory.promote는 유지하되, 입력은 memoryIds, kind, title, content, scope, confidence, validFrom, decidedAt, supersedes, contradicts 정도면 충분합니다. summary, tags, importance 같은 건 optional로만 두거나 아예 빼도 됩니다. 반대로 memory.add는 건드리지 않는 게 좋습니다. current code 기준으로 memory.add는 raw insert, memory.promote는 canonicalization이라는 경계가 제일 깔끔합니다.  ￼

API도 줄이는 편이 좋습니다. asOf는 v1에서 memory.search에만 먼저 넣고, memory.context는 current-state only로 두는 걸 권합니다. context는 기본적으로 “지금 작업 맥락 주입”이 목적이라 historical replay 수요가 훨씬 낮습니다. graph도 v1에서 꼭 time-aware까지 갈 필요는 없습니다. 먼저 search/context에서 canonical-first가 안정화되고, prune/scheduler safety가 확보된 뒤 graph를 canonical edges로 확장하는 편이 낫습니다. 지금 graph는 가치가 있지만, search/context만큼 핵심 경로는 아닙니다.  ￼

제가 지금 이 레포에 맞춰 Phase 2를 다시 자른다면 순서는 이렇게 갑니다.
먼저 canonical_* 스키마와 repository를 추가하고, 그다음 memory.promote만 붙입니다. 다음으로 memory.search와 memory.context를 canonical-first + evidence-aware dedupe로 바꿉니다. 그다음 반드시 prune/scheduler/health/stats를 canonical-aware로 보강합니다. 마지막에 supersedes/contradicts + asOf를 붙이고, auto-promotion과 graph 확장은 그다음입니다. 이 순서가 현재 코드의 위험을 가장 적게 건드립니다.  ￼

한 줄로 요약하면 이렇습니다.
	•	설계 방향은 맞다. 다만 Phase 2 v1은 manual canonicalization 중심으로 더 잘라야 한다.
	•	Supermemory와는 breadth로 싸우지 말고, 로컬 provenance·staleness·developer workflow memory로 가야 한다.
	•	가장 큰 설계 수정점은 세 가지다. memory.add는 raw-only 유지, auto-promotion 보류, prune/scheduler/health/stats를 Phase 2 범위에 포함.

이 기준으로 다시 쓰면, 지금 계획은 훨씬 날카롭고 실제 코드베이스와도 잘 맞습니다.