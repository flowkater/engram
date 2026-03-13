제 판단을 한 줄로 요약하면, **“로컬 retrieval layer로서는 좋다. 하지만 진짜 memory system가 되려면 consolidation·temporal grounding·versioning·feedback loop가 더 필요하다”**입니다. Supermemory 쪽은 공식적으로 long/short-term memory, entity graph, connectors/extractors, learned user context, temporal change handling까지 포지셔닝하고 있어서, 단순 검색/저장만으로는 차별화가 어렵습니다. Engram의 현재 갭은 검색 기술 자체보다도, 무엇을 기억으로 승격할지 / 무엇이 업데이트되었는지 / 오래된 기억을 어떻게 폐기하거나 대체할지에 있어요.

좋았던 점부터 말하면, 첫째로 스택 선택이 현실적입니다. SQLite + FTS5 + sqlite-vec + MCP 조합은 개인용·로컬용에서 과하지 않고, 설치/백업/이식성이 좋습니다. 실제 DB 초기화도 WAL, foreign_keys, vec/fts 테이블 분리 등 기본기가 나쁘지 않습니다. 둘째로 운영성이 생각보다 잘 들어가 있습니다. health, restore, stats, prune, 세션 자동 요약, 주기적 reindex/backup/log rotation 같은 요소가 있어서 “데모”보다 “계속 쓰는 로컬 서비스”를 지향하는 흔적이 보입니다. 셋째로 Markdown/Obsidian 친화성이 좋습니다. frontmatter parsing, H2/문단 기반 chunking, wikilink/tag link 생성, scope/context retrieval은 개인 지식창고와 잘 맞는 선택이에요.

코드 관점에서도 장점이 분명합니다. ingest 시 memories / vec / fts / tags / links를 트랜잭션으로 묶고, restore·indexing·session summary까지 흐름이 비교적 단순해서 디버깅하기 쉽습니다. 그리고 테스트도 제법 있는 편입니다. 다만 이건 중요한데, E2E와 여러 단위 테스트가 embedder를 mock하기 때문에 파이프라인이 안 깨지는지는 보여주지만, 실제 Ollama 기반 retrieval 품질이 좋은지는 아직 입증되지 않았습니다. 즉 “테스트가 많다”와 “메모리 품질이 높다”는 아직 같은 말이 아닙니다.

가장 먼저 고쳐야 할 문제는 로컬/프라이버시 계약이 모호하다는 점입니다. README는 “100% local, privacy-first” 톤이 강한데, 실제 embedder는 Ollama가 실패하고 OPENAI_API_KEY가 있으면 OpenAI text-embedding-3-small로 fallback합니다. 이건 기능적으로는 편리할 수 있지만, 제품 포지셔닝 측면에서는 꽤 큰 차이예요. 개인용 로컬 메모리 툴은 “언제 외부로 나갈 수 있는가”가 신뢰의 핵심인데, 지금 구조는 그 경계가 너무 느슨합니다. 최소한 기본값은 strict local-only여야 하고, remote fallback은 명시적 opt-in이어야 합니다.

그다음은 데이터 정합성 버그입니다. memoryAdd, memorySummary, indexer, restore는 실제 embedding 결과와 별개로 getCurrentModelName() 값을 embed_model에 저장하는데, 이 함수는 실질적으로 ollama/<model>을 반환합니다. 그래서 OpenAI fallback이 실제로 일어나도 DB에는 Ollama로 기록될 수 있습니다. 이건 나중에 “이 메모리를 어떤 모델로 만들었는가”, “재색인이 필요한가”, “retrieval 품질이 왜 흔들리는가”를 추적할 때 치명적이에요. 메모리 시스템에서 provenance는 부가 기능이 아니라 핵심입니다.

세 번째로는 변경 감지 로직이 생각보다 위험합니다. diffScan이 파일별 checkpoint가 아니라 source 단위의 MAX(updated_at) 하나를 watermark로 쓰기 때문에, 제 해석으로는 어떤 파일 A의 변경이 다른 파일 B의 더 늦은 인덱싱에 가려질 수 있습니다. 즉 “최근에 source 전체를 한 번 인덱싱했다”와 “각 파일의 최신 상태를 모두 반영했다”가 같지 않습니다. watcher 테스트도 기본 케이스는 보지만, 이런 edge case를 검증하진 않습니다. 메모리 툴에서 변경 누락은 신뢰를 갉아먹는 문제라 우선순위가 높습니다.

네 번째는 요구사항-구현 드리프트입니다. README는 10개 MCP 도구를 설명하지만 서버 파일 상단 주석은 여전히 8개라고 적혀 있고, README 안에서도 테스트 수가 108과 81로 엇갈립니다. memory.ingest의 recursive 파라미터는 실제 구현에서 사용되지 않고, graph API는 scope/session 링크 타입을 받지만 현재 코드상 실제로 만들어지는 링크는 wikilink와 tag 중심입니다. AGENTS에서는 scope 매핑 외부화와 path hardcoding 금지를 말하지만 scope.ts에는 하드코딩된 기본 매핑이 남아 있습니다. 이건 “기능 부족”보다 더 중요한데, 프로젝트가 자신을 설명하는 방식과 실제 동작이 어긋나기 시작했다는 신호거든요.

다섯 번째는 검색 API와 품질 계약이 아직 거칠다는 점입니다. 서버 스키마의 minScore 설명은 0~1처럼 읽히지만 실제 랭킹은 RRF 합산이라 스코어 스케일이 훨씬 작습니다. 이건 사용자가 threshold를 직관적으로 잡기 어렵게 만듭니다. 게다가 코드 주석과 달리 파일 내부 chunk embedding은 순차 처리되고, 최종 랭킹도 learned reranker 없이 vector + FTS + RRF 정도라 “잘 찾는다”는 인상은 줄 수 있어도 “에이전트가 안정적으로 필요한 기억만 가져온다” 수준까지는 아직 아닙니다.

여섯 번째는 source identity 관리입니다. 단일 파일 ingest는 source_path에 basename만 저장해서, 서로 다른 디렉터리의 같은 파일명이 충돌할 여지가 있습니다. 지금처럼 dedupe/soft delete가 source_path에 의존하면, 데이터가 조금만 커져도 나중에 이상한 side effect가 생길 수 있습니다. 로컬 메모리 툴은 장기적으로 “조용히 망가지는” 문제가 제일 무서워서, 이런 키 설계는 초기에 잡는 편이 좋아요.

그래서 개인용으로 충분하냐는 질문에는, **토니님 같은 1인 개발자 기준으로는 “조건부로 충분하다”**고 답하겠습니다. Obsidian/Markdown 중심이고, 프로젝트 수가 아주 많지 않고, 로컬에서 Ollama를 돌릴 수 있고, 주 목적이 “예전에 적어둔 결정/노트/세션 요약을 다시 잘 찾는 것”이라면 지금도 가치가 날 가능성이 큽니다. 반대로 기대치가 “에이전트가 내 모든 앱/프로젝트/문맥을 장기적으로 학습하고, 오래된 사실을 갱신하고, 모순을 정리하고, 사람/프로젝트별 프로필을 유지하는 것”이라면 아직 멀었습니다. 지금의 Engram은 좋은 memory substrate이지만, 아직 memory intelligence layer는 얇습니다.

제 생각에 Supermemory와 정면으로 같은 게임을 하면 불리합니다. 그쪽은 이미 managed infra, connectors, learned context, temporal handling을 이야기하고 있어요. Engram이 로컬에서 차별화되려면 **“더 많은 커넥터”**보다 “더 믿을 수 있고, 더 설명 가능하고, 더 수정 가능한 기억” 쪽으로 가야 합니다. 즉, 로컬만이 줄 수 있는 장점인 provenance, inspectability, editability, reproducibility, project-scoped privacy를 전면에 내세우는 게 맞습니다. 특히 개발자용이라면 범용 user profile보다 Git/터미널/빌드/테스트/디버깅 맥락을 기억하는 쪽이 훨씬 강력한 차별화 포인트가 됩니다.

제가 오너라면 로드맵은 이렇게 갑니다.

1단계: 신뢰 회복과 정합성 정리.

strict local-only 모드를 기본으로 두고 remote fallback은 별도 플래그로 분리합니다. 실제 사용된 embedding model을 정확히 저장하고, file-level checkpoint를 도입해 diffScan 누락 가능성을 없앱니다. recursive, source_path, minScore, 문서/주석 drift, 하드코딩된 scope 기본값도 이 단계에서 정리합니다.

2단계: 메모리 모델 업그레이드.

지금처럼 “문서 chunk를 저장하고 찾는 구조”에서 한 단계 올라가야 합니다. raw event/문서, extracted claim, canonical memory를 분리하세요. 메모리 타입도 최소한 fact / decision / procedure / preference / bug / todo / session-event 정도로 나누고, 각 항목에 source span, timestamp, confidence, validity interval을 붙이는 게 좋습니다. 핵심은 저장보다 승격과 통합입니다. 같은 사실이 반복되면 canonical memory로 병합하고, 바뀐 사실은 supersedes나 contradicts로 연결해야 합니다.

3단계: 진짜 agent usefulness 추가.

query intent router가 필요합니다. “사실을 찾는 질문”, “최근 일을 묻는 질문”, “왜 그런 결정을 했는지 묻는 질문”, “다시 실행 가능한 절차를 묻는 질문”은 서로 다른 retrieval plan을 써야 합니다. 여기에 optional local reranker를 붙이고, context pack builder를 만들어 토큰 예산 안에서 evidence-rich한 결과만 넘기면 실제 에이전트 품질이 올라갑니다.

4단계: 로컬만의 차별화.

이건 거의 승부처인데, Git commit/diff/branch, 터미널 명령과 실패 로그, 빌드/테스트 결과, flaky test 히스토리, 환경설정 함정, 반복되는 디버깅 패턴을 기억하도록 만드세요. 그러면 Engram은 “개인 노트 검색기”가 아니라 개발자 작업기억 + 절차기억 엔진이 됩니다. 이건 cloud memory 제품이 따라오기 어려운 영역입니다.

5단계: 제품화.

memory inspector UI를 넣어서 “왜 이 메모리가 검색되었는지”, “이 기억의 원문은 무엇인지”, “이 기억을 수정/승격/폐기할지”를 사람이 통제할 수 있게 해야 합니다. 그리고 golden questions 기반의 로컬 평가셋을 두고, hit@k보다 agent task success lift, stale memory rate, contradiction rate, token efficiency를 보세요. 지금 테스트 구조는 파이프라인 안정성 중심이라, 실제 usefulness를 재는 계층이 필요합니다.

조금 더 구체적인 아이디어를 적으면, 저는 아래 기능들이 특히 유용하다고 봅니다.

- Memory promotion pipeline: 세션 로그나 문서 chunk는 일단 raw로 저장하고, 반복 등장하거나 실제 retrieval에 자주 쓰인 정보만 canonical memory로 승격.
- Time-travel memory: “지난주 기준으로 이 프로젝트의 인증 방식은 뭐였지?”처럼 시점 기준 질의 지원.
- Decision memory: “무엇을 했는가”보다 “왜 그렇게 했는가”를 따로 저장.
- Procedure memory: 성공한 복구 절차나 배포 절차를 자동 추출해서 재실행 가능한 playbook으로 축적.
- Failure memory: 자주 터지는 에러, 원인, 해결법, 관련 파일/명령을 묶어 재발 방지.
- Memory surgery: 잘못 기억한 항목을 사람이 병합, 폐기, canonical 지정할 수 있는 수동 편집 워크플로.
- Retrieval explanation: 각 결과에 대해 “semantic hit인지, FTS hit인지, 최근성 때문에 올라왔는지, 어떤 edge를 타고 왔는지”를 설명.
- Agent feedback loop: retrieved memory가 실제 task success에 도움이 됐는지 로그로 남기고 이후 ranking에 반영.

딱 5개만 먼저 하라면 저는 이 순서입니다.

1. strict local mode + embedding provenance 버그 수정
2. file-level checkpoint + source_path 정규화
3. typed memory + canonicalization + supersedes/contradicts
4. Git/터미널/테스트 결과 커넥터
5. memory inspector + 로컬 eval harness

제 최종 평가는 이렇습니다. Engram은 방향이 나쁘지 않은 v0.1이고, 개인 개발자용으로는 이미 실용 가능성이 있다. 하지만 지금 상태로는 “메모리 검색 서버”에 더 가깝고, “에이전트 메모리 시스템”으로 가려면 기억의 품질 관리 계층을 반드시 추가해야 한다. 그리고 Supermemory보다 로컬에서 차별화하려면, 더 많은 범용 기능보다 더 믿을 수 있고, 더 개발자 작업에 밀착된 기억으로 가는 쪽이 훨씬 승산이 있습니다.
