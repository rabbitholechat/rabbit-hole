# Rabbit Hole

질문에서 아이디어로, 대화에서 다음 단계로.

일반 에이전트의 Markdown 응답을 React Flow 캔버스 노드에 실시간으로 표시합니다. 요청 하나당 응답 노드 하나를 만들며, 후속 대화는 완료된 이전 대화를 이어받습니다. 현재 에이전트에는 도구가 없습니다.

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
| backend/rabbit_hole/agent.py | 도구 없는 Agent 정의, SDK 스트림 어댑터, 취소·클라이언트 종료 |
| backend/rabbit_hole/app.py | /api/agent SSE, 작업 수명·예산·서명 문맥·오류 |
| backend/rabbit_hole/security.py | 완료 대화의 HMAC continuation |
| backend/rabbit_hole/diagnostics.py | INFO/DEBUG/WARNING/ERROR 구조화 진단 |
| frontend/src/store.ts | 요청 격리, 델타 누적, 취소, IndexedDB 저장 |
| frontend/src/components/ResponseCard.tsx | 공개 Markdown 응답 노드 |

표의 경로는 `src/` 기준입니다. 추상 팩토리나 다중 에이전트 없이 단일 서비스 어댑터와 주입 가능한 service_factory로 구성하며, 실제 API 없이 테스트할 수 있습니다. 나중에 검토한 도구를 에이전트 정의에 추가할 수 있습니다.

첫 응답부터 캔버스에 표시하며 받은 텍스트는 취소·실패 시에도 유지합니다. 부분 응답을 완료된 문맥에 섞지 않고 명시적 재시도 시 이전 완료 문맥으로 다시 요청합니다. 스트리밍 중 500ms 간격으로 로컬 저장하며, 기록 복원은 API를 호출하지 않습니다. 위치·viewport는 보존하고 후속 응답은 오른쪽에 추가합니다.

기존 페이지 카드·관계 기록과 디자인 예시는 로컬 열람만 지원합니다. 그 기록에서 메시지를 보내면 새 대화가 시작됩니다. 샘플을 실제 응답으로 대체하거나 가상 근거를 서버로 보내지 않습니다. 새 응답에는 검색·근거 검증·관계 생성·노드 자동 분해 단계가 없습니다.

## 디버깅과 계약

VS Code 실행 및 디버그에서 `Rabbit Hole: Full Stack` 또는 `Rabbit Hole: Backend`를 선택합니다. `.vscode/launch.json`이 서버 .env와 가상환경을 사용합니다. 디버깅 중에도 시간 제한은 유지됩니다.

- [SSE v2 계약](docs/API.md)
- [로그와 중단점](docs/DEBUGGING.md)
- [실행·배포](docs/DEPLOYMENT.md)
- [검증 기록](docs/VALIDATION.md)
- [공식 OpenAI Agents SDK 실행 문서](https://developers.openai.com/api/docs/guides/agents/running-agents)

실제 유료 API 통합과 원격 배포는 별도 실행 대상입니다. 도구가 없는 현재 에이전트는 실시간 웹 사실 확인이나 외부 작업 실행을 하지 않습니다.

첫 답변이 완료되면 별도 요청으로 대화 제목을 생성합니다. 백엔드 `.env`의
`OPENAI_BACKGROUND_MODEL` (기본 `gpt-4o-mini`)로 작업 모델을,
`BACKGROUND_TIMEOUT_SECONDS` (기본 15초)로 제한 시간을 설정합니다.
본문 모델 `OPENAI_MODEL`과 독립적이며 제목 생성 실패 시 기존 질문 제목을 유지합니다.
