# Rabbit Hole

질문에서 아이디어로, 대화에서 다음 단계로.

[브랜드 아이콘 다운로드 — 검정·흰색 PNG/SVG](docs/BRAND.md)

일반 에이전트의 Markdown 응답을 React Flow 캔버스 노드에 실시간으로 표시합니다. 요청 하나당 응답 노드 하나를 만들며, 후속 대화는 완료된 이전 대화를 이어받습니다. 에이전트는 필요한 경우 계산기·웹 검색·페이지 본문 읽기 도구를 사용합니다.

## 실행

Node.js 20.19 이상(권장 22), Corepack, uv, Python 3.13 이상이 필요합니다.

```sh
make install
# .env가 없을 때만 복사. 기존 설정을 덮어쓰지 마세요.
cp src/backend/.env.example src/backend/.env
# OPENAI_API_KEY 설정
make dev
```

- 화면: http://127.0.0.1:5178
- API: http://127.0.0.1:8018/docs
- 상태: http://127.0.0.1:8018/api/health
- `make frontend`, `make backend`: 개별 실행
- `make check`: 타입·린트·단위 테스트·프로덕션 빌드
- `make e2e`: 유료 호출 없는 데스크톱·모바일 브라우저 검증

설정은 서버 `.env` 또는 배포 환경변수만 사용합니다. 프런트는 동일 origin `/api/agent`로 요청합니다. 기존 검색 관련 환경변수는 더 이상 사용하지 않습니다. 기본 모델은 OPENAI_MODEL, 출력 토큰은 MAX_OUTPUT_TOKENS, 실행 제한은 JOB_TIMEOUT_SECONDS/MAX_MODEL_TURNS로 조정합니다. SDK tracing과 모델 응답 저장은 비활성화하며 SDK 자동 재시도도 없습니다.

## 구조

| 파일 | 책임 |
| --- | --- |
| backend/rabbit_hole/agent.py | 도구를 가진 Agent 정의, SDK 스트림 어댑터, 취소·클라이언트 종료 |
| backend/rabbit_hole/tools.py | 제한된 계산, 웹 검색, 공개 페이지 읽기, 페이지별 조회 기록 |
| backend/rabbit_hole/app.py | /api/agent SSE, 작업 수명·예산·서명 문맥·오류 |
| backend/rabbit_hole/security.py | 완료 대화의 HMAC continuation |
| backend/rabbit_hole/diagnostics.py | INFO/DEBUG/WARNING/ERROR 구조화 진단 |
| frontend/src/store.ts | 요청 격리, 델타 누적, 취소, IndexedDB 저장 |
| frontend/src/components/ResponseCard.tsx | 공개 Markdown 응답 노드 |

표의 경로는 `src/` 기준입니다. 단일 서비스 어댑터와 주입 가능한 service_factory로 구성하며, 실제 API 없이 테스트할 수 있습니다.

첫 응답부터 캔버스에 표시하며 받은 텍스트는 취소·실패 시에도 유지합니다. 부분 응답을 완료된 문맥에 섞지 않고 명시적 재시도 시 이전 완료 문맥으로 다시 요청합니다. 스트리밍 중 500ms 간격으로 로컬 저장하며, 기록 복원은 API를 호출하지 않습니다. 위치·viewport는 보존하고 후속 응답은 오른쪽에 추가합니다.

기존 페이지 카드·관계 기록과 디자인 예시는 로컬 열람만 지원합니다. 그 기록에서 메시지를 보내면 새 대화가 시작됩니다. 샘플을 실제 응답으로 대체하거나 가상 근거를 서버로 보내지 않습니다. 디자인 예시 생성 UI는 제거했습니다. 새 완료 응답은 독립 구조화 단계에서 원문 발췌를 정보 노드로 추가합니다. 비교는 정보의 하위 유형이며 근거 검증·의미 관계 생성은 수행하지 않습니다.

웹 검색은 기존 OPENAI_API_KEY와 OPENAI_SEARCH_MODEL(기본 gpt-4.1-mini)을 사용하며 별도 검색 업체 키가 필요하지 않습니다. 도구 이후 답변을 위한 MAX_MODEL_TURNS 기본값은 6입니다. 기존 .env에 1로 고정했다면 6 이상으로 조정하세요. 요청당 MAX_TOOL_CALLS=8, MAX_WEB_SEARCHES=2, TOOL_TIMEOUT_SECONDS=20을 기본 제한으로 적용합니다. 검색은 추가 OpenAI 호출과 내장 검색 비용이 발생할 수 있으며 자동 재시도하지 않습니다.

본문과 검색 모델에는 요청 시점의 UTC 날짜·서울 날짜·서울 시간대의 요청 시각을 전달합니다. 상대 날짜는 기본 서울 기준이며 사용자가 지정한 시간대를 우선합니다. 최신 정보나 변할 수 있는 사실은 검색 후 답하고, 검색 실패/불충분한 결과를 과거 지식으로 대체하지 않도록 지시합니다. 검색 여부는 일반 에이전트가 판단하며 제품명·키워드별 분기는 없습니다. 조회 목록은 검색 실행의 기록이지 답변의 최신성 보증이 아닙니다.

계산기는 십진수 사칙연산·괄호·제한된 정수 거듭제곱을 지원합니다. 페이지 읽기는 공개 HTML/텍스트를 최대 1MB 내려받아 본문 16,000자까지 반환하며, PDF·JS 렌더링·로그인·압축 응답은 지원하지 않습니다. 실제 조회한 자료는 별도 출처 노드에 검색/본문 조회 상태로 표시하며, 조회 성공을 사실 검증으로 표시하지 않습니다. 자세한 안전 제한과 데이터 구조는 [API 계약](docs/API.md)을 따릅니다.

## 디버깅과 계약

VS Code 실행 및 디버그에서 `Rabbit Hole: Full Stack` 또는 `Rabbit Hole: Backend`를 선택합니다. `.vscode/launch.json`이 서버 .env와 가상환경을 사용합니다. 디버깅 중에도 시간 제한은 유지됩니다.

- [SSE v2 계약](docs/API.md)
- [로그와 중단점](docs/DEBUGGING.md)
- [실행·배포](docs/DEPLOYMENT.md)
- [검증 기록](docs/VALIDATION.md)
- [공식 OpenAI Agents SDK 실행 문서](https://developers.openai.com/api/docs/guides/agents/running-agents)

실제 유료 API 통합과 원격 배포는 별도 실행 대상입니다. 도구는 산술 계산과 공개 웹 자료 조회만 수행하며 외부 사이트의 상태를 변경하지 않습니다.

첫 답변이 완료되면 별도 요청으로 대화 제목을 생성합니다. 백엔드 `.env`의
`OPENAI_BACKGROUND_MODEL` (기본 `gpt-4o-mini`)로 작업 모델을,
`BACKGROUND_TIMEOUT_SECONDS` (기본 15초)로 제한 시간을 설정합니다.
본문 모델 `OPENAI_MODEL`과 독립적이며 제목 생성 실패 시 기존 질문 제목을 유지합니다.

응답·정보·출처의 세 노드 타입을 사용합니다. 정보는 원문에서 그대로 추출하며 이전 노드로 버튼으로 원래 응답에 이동합니다. 조회 자료는 응답에 실제 링크가 있는 경우 ‘출처 표기’, 그 외는 ‘조회’로 연결합니다. 구조화 실패는 원래 답변에 영향을 주지 않으며 명시적으로 재시도할 수 있습니다. 새 노드만 추가하고 기존 좌표와 화면 위치를 유지합니다.

정보 추출은 `OPENAI_STRUCTURE_MODEL`(기본 `gpt-4.1-mini`)의 별도 유료 모델 호출이며 `STRUCTURE_TIMEOUT_SECONDS` 기본 25초입니다. 120자 미만 답변과 기록 복원에는 추출 호출을 보내지 않습니다. 제목 생성과 독립적으로 실행합니다.

응답당 출처 카드는 서버 `MAX_RESPONSE_SOURCES`로 제한하며 기본 5개입니다. 클라이언트 설정은 없고 기존 저장 출처는 유지합니다.
