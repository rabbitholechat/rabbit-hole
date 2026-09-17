# 에이전트 스트리밍 디버깅

VS Code Python 디버거에서 자동 활성화됩니다. 일반 터미널에서는 `src/backend/.env`의 `DEBUG_DIAGNOSTICS=true`로 켭니다. SDK 전체 DEBUG 로깅은 켜지 않습니다.

로그는 레벨 접두사 + JSON 한 건이며 TTY에서는 레벨별 색상을 표시합니다.

| 레벨 | 이벤트 | 내용 |
| --- | --- | --- |
| INFO | request_started | request_id, job_id |
| DEBUG | agent_start | 모델, 문맥 메시지/문자 수, 도구 수(현재 3), 턴 제한 |
| DEBUG | response_delta | seq, 이번 델타 문자 수, 누적 문자 수 |
| ERROR | request_failed | part, code, 예외 클래스, 파일·줄·함수 위치 |
| WARNING | cleanup_failed | 클라이언트 종료 실패 예외 클래스 |
| INFO | request_finished | 상태, 응답 문자 수, 소요 시간 |

```text
INFO: {"request_id":"…","event":"request_started","job_id":"…"}
DEBUG: {"request_id":"…","event":"agent_start","model":"gpt-4.1-mini","context_turns":1,"context_chars":18,"tools":3,"max_turns":6}
DEBUG: {"request_id":"…","event":"response_delta","seq":5,"delta_chars":8,"total_chars":8}
INFO: {"request_id":"…","event":"request_finished","status":"completed","output_chars":120,"elapsed_ms":1500}
```

위 로그는 형식 예시입니다. 실제 모델 결과가 아닙니다. 키, 작업 토큰, continuation, 질문·응답 원문, 전체 공급자 응답, 내부 추론은 DEBUG에도 기록하지 않습니다.

추천 중단점:

- `agent.py:AgentService.stream`: `event.data`에서 SDK 실제 응답 확인. `response.output_text.delta`와 `response.refusal.delta`만 화면으로 전달.
- `app.py:produce`: 델타 전송, 타임아웃, 오류 코드 확인. 잡힌 예외는 VS Code Raised Exceptions로 확인.
- `store.ts:receive`: response_started → response_delta → response_completed 처리 및 노드 변경 확인.

요청 흐름: /api/agent → 서명 문맥 검증 → 단일 Agent/Runner.run_streamed → SSE 텍스트 → 캔버스 응답 노드 → 완료 이력 서명·PostgreSQL 저장.

검색·근거 검증·관계 모델 호출은 현재 파이프라인에 없습니다. 추가 질문도 일반 응답으로 표시됩니다. 취소 시 fetch 연결과 SDK 백그라운드 실행을 함께 종료합니다.

대화 제목은 별도 `/api/title` 요청으로 실행됩니다. `INFO`의 `title_started`,
`title_completed`, `WARNING`의 `title_failed`로 확인합니다. 디버그 모드에서는
`DEBUG`의 `title_model`에 선택된 모델만 기록하며 제목과 대화 원문은 기록하지 않습니다.
