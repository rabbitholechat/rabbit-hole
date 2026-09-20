# 개발 가이드

[서비스 소개](../README.md) · [실행·배포](DEPLOYMENT.md) · [API 계약](API.md)

README에서 개발·운영 정보를 분리한 문서입니다. API와 데이터 구조의 세부 계약은 [API.md](API.md), 환경별 배포 절차는 [DEPLOYMENT.md](DEPLOYMENT.md)를 따릅니다.

## 로컬 실행

Node.js 20.19 이상(권장 22), Corepack, uv, Python 3.13 이상이 필요합니다.

```sh
make install
# .env가 없을 때만 복사합니다. 기존 설정을 덮어쓰지 마세요.
cp src/backend/.env.example src/backend/.env
# OPENAI_API_KEY와 DATABASE_URL 설정
# 로컬 Docker DB 사용 시 POSTGRES_PASSWORD 설정 후 make db-up
make db-init
make dev
```

`DATABASE_URL`에는 기존 PostgreSQL 연결 문자열을 사용합니다. 새 DB마다 `make db-init`을 한 번 실행하며, 반복 실행해도 기존 데이터를 삭제하지 않습니다. 로컬 Docker와 Vercel 연결 방법은 [실행·배포](DEPLOYMENT.md)에 있습니다.

| 주소·명령 | 용도 |
| --- | --- |
| http://127.0.0.1:5178 | 프런트엔드 |
| http://127.0.0.1:8018/docs | API 문서 |
| http://127.0.0.1:8018/api/health | 상태 확인 |
| `make frontend`, `make backend` | 프런트·백엔드 개별 실행 |
| `make check` | 타입 검사, 린트, 단위 테스트, 프로덕션 빌드 |
| `make e2e` | 유료 호출 없는 데스크톱·모바일 브라우저 검증 |

실제 유료 API 통합과 원격 배포는 별도 실행 대상입니다. 기본 테스트는 외부 API 없이 실행하며, PostgreSQL 통합 검증은 별도 테스트 DB로 명시적으로 실행합니다.

## 코드 구조

프런트엔드는 React + Vite + TypeScript + React Flow, 백엔드는 FastAPI + Agents SDK로 구성합니다. 아래 경로는 저장소 루트 기준입니다.

| 파일 | 책임 |
| --- | --- |
| `src/backend/rabbit_hole/agent.py` | 도구를 가진 Agent 정의, SDK 스트림 어댑터, 취소·클라이언트 종료 |
| `src/backend/rabbit_hole/tools.py` | 제한된 계산, 웹 검색, 공개 페이지 읽기, 페이지별 조회 기록 |
| `src/backend/rabbit_hole/app.py` | `/api/agent` SSE, 작업 수명·예산·서명 문맥·오류 |
| `src/backend/rabbit_hole/security.py` | 완료 대화의 HMAC continuation |
| `src/backend/rabbit_hole/structure.py` | 완료 응답의 독립 구조화와 원문 참조 검증 |
| `src/backend/rabbit_hole/history.py` | 공용 PostgreSQL 기록과 공유 스냅샷 |
| `src/backend/rabbit_hole/diagnostics.py` | INFO/DEBUG/WARNING/ERROR 구조화 진단 |
| `src/frontend/src/store.ts` | 세션별 요청 격리, 델타 누적, 취소, 구조화, 저장 요청 |
| `src/frontend/src/lib/db.ts` | 서버 기록 접근과 기존 IndexedDB 이전 |
| `src/frontend/src/components/ResponseCard.tsx` | 공개 Markdown 응답 노드 |

단일 서비스 어댑터와 주입 가능한 `service_factory`로 구성하며 실제 API 없이 테스트할 수 있습니다. 내부 추론은 그래프로 노출하지 않습니다.

## 설정과 요청 예산

모든 설정과 비밀은 `src/backend/.env` 또는 배포 서버 환경변수에서 관리합니다. 프런트는 동일 origin의 `/api`를 사용하며 비밀값이나 모델 설정을 `VITE_*`로 옮기지 않습니다. 과거 검색 업체용 환경변수는 사용하지 않습니다.

아래는 [Settings](../src/backend/rabbit_hole/config.py)의 기본값입니다. `.env`와 배포 환경변수가 기본값을 덮어씁니다. 현재 [.env.example](../src/backend/.env.example)의 `OPENAI_MODEL`은 `gpt-4.1-mini`이므로, 이를 복사한 환경에서는 코드 기본값과 다르게 실행될 수 있습니다.

| 환경변수 | 기본값 | 용도 |
| --- | --- | --- |
| `OPENAI_MODEL` | `gpt-5.4-mini` | 일반 응답 모델 |
| `MAX_OUTPUT_TOKENS` | `4000` | 일반 응답 출력 한도 |
| `JOB_TIMEOUT_SECONDS` | `90` | 요청 전체 실행 제한(초) |
| `MAX_MODEL_TURNS` | `6` | 도구 이후 답변을 포함한 모델 턴 제한 |
| `MAX_TOOL_CALLS` | `8` | 요청당 도구 호출 한도 |
| `OPENAI_SEARCH_MODEL` | `gpt-4.1-mini` | 웹 검색 모델 |
| `MAX_WEB_SEARCHES` | `2` | 요청당 웹 검색 한도 |
| `TOOL_TIMEOUT_SECONDS` | `20` | 도구 실행 제한(초) |
| `MAX_RESPONSE_SOURCES` | `5` | 응답당 출처 카드 한도 |
| `OPENAI_BACKGROUND_MODEL` | `gpt-4o-mini` | 대화 제목 생성 모델 |
| `BACKGROUND_TIMEOUT_SECONDS` | `15` | 제목 생성 제한(초) |
| `OPENAI_STRUCTURE_MODEL` | `gpt-4.1-mini` | 정보·엔티티 구조화 모델 |
| `STRUCTURE_TIMEOUT_SECONDS` | `25` | 구조화 제한(초) |

기존 `.env`의 `MAX_MODEL_TURNS`가 1이면 도구 실행 후 답변할 여유가 없으므로 6 이상으로 조정하세요. 출처 카드 수의 클라이언트 설정은 없으며 기존 저장 출처는 유지합니다. 전체 설정 항목은 `.env.example`과 `config.py`를 참고합니다.

SDK tracing과 공급자 측 모델 응답 저장은 비활성화하며 SDK 자동 재시도도 없습니다. 이는 서비스의 PostgreSQL 대화 기록 저장과 별개입니다.

## 응답·세션·저장 흐름

사용자 요청 하나당 공개 응답 노드 하나를 만들고 받은 Markdown을 실시간으로 누적합니다. 첫 응답부터 캔버스에 표시하며 받은 텍스트는 취소·실패 시에도 유지합니다. 부분 응답은 완료 문맥에 섞지 않고, 명시적 재시도 시 이전 완료 문맥으로 다시 요청합니다.

후속 대화는 완료된 이전 대화를 이어받습니다. 기존 노드 위치와 viewport를 유지하고 후속 응답은 오른쪽에 추가합니다. 스트리밍 중에는 500ms 간격으로 저장을 예약하며 완료 등 주요 이벤트에서도 저장합니다.

- 세션별 요청을 분리해 다른 대화로 이동해도 응답 생성과 카드 구조화를 유지합니다. 진행 중 세션으로 돌아오면 메모리의 최신 내용과 중지 동작을 복원합니다.
- 사이드바의 생성 중 표시는 응답 생성과 카드 구조화가 진행되는 동안 표시합니다.
- 탭 닫기·새로고침 등으로 연결이 끊어지면 서버 작업은 취소됩니다. 사이트 종료 후에도 실행되는 영속 백그라운드 작업은 구현하지 않았습니다.
- 기록 복원은 DB 조회 API만 사용하며 모델·검색·페이지 읽기·구조화·제목 생성을 다시 호출하지 않습니다. 저장된 미완료 작업은 중단된 상태로 복원합니다.

기록은 심사용 **공용 PostgreSQL**에 저장합니다. 모든 브라우저가 같은 대화를 조회·수정·삭제하며, 다른 브라우저의 변경은 새로고침으로 불러옵니다. 로그인이나 브라우저 식별 쿠키는 없습니다. 노드 위치·viewport·공개 답변·출처·구조화 결과를 함께 복원합니다.

기존 IndexedDB는 첫 접속 때 서버로 이전하고 브라우저의 원본을 보존하는 일회성 이전 소스로만 사용합니다. 기존 페이지 카드·관계 기록과 디자인 예시는 읽기 전용으로 열람하며, 해당 기록에서 메시지를 보내면 새 대화가 시작됩니다. 디자인 예시 생성 UI는 제거했습니다. 실패한 실제 응답을 샘플로 대체하거나 가상 근거를 모델 요청에 보내지 않습니다.

## 도구와 출처

일반 에이전트가 요청에 필요한 계산기·웹 검색·페이지 읽기를 예산 안에서 선택합니다. 주제나 제품명 키워드별 전용 폼·조건 분기는 없으며 모든 답변에 일괄 검색하지 않습니다. 도구는 계산과 공개 자료 조회를 수행하며 외부 사이트의 상태를 변경하지 않습니다.

웹 검색은 같은 `OPENAI_API_KEY`와 `OPENAI_SEARCH_MODEL`을 사용하므로 별도 검색 업체 키가 필요하지 않습니다. 검색에는 추가 모델 호출과 내장 검색 비용이 발생할 수 있으며 자동 재시도하지 않습니다.

본문과 검색 모델에는 요청 시점의 UTC 날짜·서울 날짜·서울 시간대 시각을 전달합니다. 상대 날짜는 기본 서울 기준이며 사용자가 지정한 시간대를 우선합니다. 최신 정보나 변할 수 있는 사실은 검색 후 답하고, 검색 실패나 불충분한 결과를 과거 지식으로 대체하지 않도록 지시합니다. 검색 실행 기록은 답변의 최신성 보증이 아닙니다.

계산기는 십진수 사칙연산·괄호·제한된 정수 거듭제곱을 지원합니다. 페이지 읽기의 기본 한도는 다운로드 1MB, 압축 해제 후 4MB, 반환 본문 16,000자입니다. 공개 HTML/텍스트와 gzip 응답을 지원하며, 페이지 읽기 도구의 PDF·JavaScript 렌더링·로그인은 지원하지 않습니다. 사용자가 업로드한 PDF 처리는 별도 [첨부 자료 기능](ATTACHMENTS.md)입니다.

출처 노드는 실제 도구 메타데이터를 사용하며 페이지 단위 식별자를 유지합니다. 검색 결과와 본문 조회, 답변의 출처 표기를 구분합니다. 조회 성공이나 링크의 존재를 사실 검증으로 표시하지 않습니다. 출처에 실제 답변 링크가 연결되면 ‘출처 표기’, 그 외는 ‘조회’로 구분하며 세부 규칙과 안전 제한은 [API 계약](API.md)을 따릅니다.

## 완료 후 제목과 카드 정리

첫 답변이 완료되면 별도 요청으로 대화 제목을 생성합니다. 본문 모델과 독립적으로 실행하며 제목 생성 실패 시 기존 질문 제목을 유지합니다.

완료 응답은 도구 없는 독립 구조화 호출로 요청 목적에 맞는 정보 카드와 엔티티로 재구성합니다. 비교는 정보의 하위 유형입니다. 정보 항목마다 원문 참조를 유지하고 의미·수치·조건·예외를 보존하며 새 사실·추가 설명·검색 보강은 하지 않습니다. 별도의 근거 검증·의미 관계 생성 호출도 없습니다.

현재 카드는 응답·정보·엔티티·출처·이미지·첨부 자료 등을 표시합니다. 정보는 원문을 재구성할 수 있으며 ‘이전 노드로’ 버튼으로 원래 응답에 이동합니다. 출처 조회, 원문 참조, 대화 순서, 사용자가 만든 연결을 구분합니다. 카드 정리가 실패해도 원래 답변은 유지되며 명시적으로 재시도할 수 있습니다. 새 카드 추가 시 기존 좌표와 화면 위치를 유지합니다.

구조화는 제목 생성과 독립적인 별도 유료 호출입니다. **빈 답변은 생략하지만 120자 미만의 짧은 답변도 구조화 대상**이며, 정리할 내용이 없으면 카드 없이 완료할 수 있습니다. 저장 기록을 복원할 때는 추출 호출을 보내지 않습니다. 이전 README의 ‘120자 미만 호출 생략’과 ‘원문 그대로 발췌만 허용’ 설명은 현재 동작에 맞춰 갱신했습니다.

## 디버깅과 검증 문서

VS Code 실행 및 디버그에서 `Rabbit Hole: Full Stack` 또는 `Rabbit Hole: Backend`를 선택합니다. `.vscode/launch.json`이 서버 `.env`와 가상환경을 사용하며 디버깅 중에도 시간 제한은 유지됩니다.

- [로그와 중단점](DEBUGGING.md)
- [SSE와 API 계약](API.md)
- [실행·배포와 PostgreSQL 검증](DEPLOYMENT.md)
- [검증 기록](VALIDATION.md)
- [제품 스크린샷 원본과 웹용 이미지](assets/product-screenshots/README.md)
- [공식 OpenAI Agents SDK 실행 문서](https://developers.openai.com/api/docs/guides/agents/running-agents)
