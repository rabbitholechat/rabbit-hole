# API / SSE 계약 v2

동일 origin `/api`, JSON 본문 상한 2,100,000바이트, continuation 최대 2,000,000자.

- `GET /api/health`: status, configured, api_version=2. 비밀값 없음.
- `POST /api/agent`: query(공백 제외 1..2000자), request_id(UUID), continuation(선택). 추가 필드 거부.
- `DELETE /api/jobs/{job_id}`: started의 access_token을 Bearer 헤더로 전달. 주 취소 경로는 fetch AbortController/연결 종료. 다른 서버 인스턴스의 작업은 404.

```json
{"query":"아이디어를 실행 계획으로 정리해줘","request_id":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}
```

첫 요청에는 continuation 생략. 후속 요청에는 마지막 checkpoint의 continuation과 새로운 query/request_id를 전달합니다. 실패/중지된 답변은 모델 대화 이력에 포함되지 않으므로 같은 query를 다시 보내면 해당 턴을 다시 시도합니다. 자동 유료 재시도 없음.

## 스트림

SSE envelope: `{version:2, request_id, job_id, seq, type, data}`. `id: seq`, `event: type`, `data: JSON`과 빈 줄. seq는 요청별 단조 증가. 5초 동안 전송이 없으면 `: ping`.

| 이벤트 | data | 의미 |
| --- | --- | --- |
| started | access_token, status=running | 작업 제어 토큰, 브라우저 메모리에만 유지 |
| checkpoint | continuation | 서버 서명된 완료 대화 이력 |
| response_started | id | 응답 노드 생성. ID는 response_{request_id} |
| status | stage=responding | 에이전트 응답 진행 |
| response_delta | id, delta | Markdown 원문 텍스트를 그대로 추가 |
| response_completed | id, text | 완성된 전체 응답으로 확정, 델타에 다시 추가하지 않음 |
| part_error | part=response, code, message | 공개 가능한 실패 정보 |
| done | status, failed_parts | completed/partial/failed, 실패 시 [response] |

정상 순서: started → checkpoint(이전 이력) → response_started → status → response_delta 반복 → response_completed → checkpoint(이번 턴 포함) → done.
실패 시 response_completed 없음. 받은 텍스트가 있으면 partial, 없으면 failed. checkpoint는 이전 완료 대화만 유지합니다. 취소 시 연결 종료, 클라이언트가 노드 상태를 cancelled로 확정합니다.

에이전트 응답 1개 = 응답 태그·아이콘을 가진 캔버스 노드 1개. 높이는 Markdown 내용에 맞춰 증가합니다. 이어지는 응답은 오른쪽에 배치하고 클라이언트에서 대화 순서 화살표로 연결합니다. 이는 내용 근거 관계가 아닙니다. 별도 요약·노드 분해·출처 등록·관계 생성 모델 호출 없음. SDK의 공개 output_text/refusal delta만 전달하고 내부 추론/도구 이벤트는 전달하지 않습니다. 현재 등록 도구는 없습니다.

## 제한과 보존

- 출력 토큰, 요청 시간, 전체 실행 시간, SDK 턴 수, 응답 길이(64,000자), 동시 작업·요청 빈도 제한 적용.
- 서명 이력은 최근 MAX_CONTEXT_TURNS개 메시지, 최대 96,000자. 오래된 user/assistant 쌍부터 제거. 실패한 턴은 포함하지 않음.
- continuation은 HMAC 서명, 암호화 아님. 로그 출력 금지. 7일 만료. 프로덕션에는 모든 인스턴스가 동일한 SESSION_SIGNING_KEY 사용.
- 프런트는 현재 request_id, 증가하는 seq, 활성 응답 id만 반영. 중지/화면 전환 뒤 늦은 델타 무시.
- 스트리밍 중 500ms 간격으로 IndexedDB 저장, 완료·중지·실패 즉시 저장. 새로고침 시 마지막 저장 시점까지 복원. running 기록은 partial로 표시하며 API를 호출하지 않음.
- 노드 위치·viewport 보존. 최초 노드만 자동 화면 맞춤. 후속 노드는 오른쪽에 추가하며 화면 맞춤 버튼으로 전체 보기.
- Markdown HTML/외부 이미지 비활성화. 링크는 클라이언트의 기존 안전한 HTTP(S) URL 검사 적용. 생성 링크는 검증 출처가 아님.

## 호환성

`/api/search`와 v1 검색 파이프라인은 제거했습니다. 기존 IndexedDB 페이지·관계 기록과 디자인 예시는 로컬 열람 가능. 기존 기록에서 메시지를 보내면 새 v2 대화가 시작되고 기존 continuation/가상 자료를 전송하지 않습니다.

## 실패 코드

timeout, connection_error, provider_auth_error, provider_rate_limit, provider_request_error,
provider_error, invalid_output, turn_limit, incomplete_response, output_limit, internal_error.

원문 오류·키·추론은 SSE에 포함하지 않습니다. 요청 검증 422, 만료/위조/구버전 continuation 409, 본문 제한 413, 요청 제한 429, 미설정 503.

### POST `/api/title`

첫 완료 응답의 마지막 `checkpoint.continuation`과 새 UUID `request_id`를 전달하면
`{"title":"대화 제목"}`을 반환합니다. 서명된 문맥이 user/assistant 한 쌍이어야 합니다.
프런트는 `done(completed)` 후 독립 요청으로 한 번 호출하며 다음 대화를 막지 않습니다.
실패하면 질문을 제목으로 유지합니다. `title`, `titleRequested`는 IndexedDB에 저장되며
기록 복원은 제목 생성 요청을 보내지 않습니다. 생성 중 다른 기록을 열어도 원래 기록만 갱신합니다.
서명 오류/잘못된 문맥 409, 요청 제한 429, 모델 미설정 503, 생성 실패 502입니다.
본문과 동일한 요청/동시 실행 제한 및 별도 `BACKGROUND_TIMEOUT_SECONDS`를 적용합니다.

### 응답에서 대화 분기

프런트는 완료 응답 직후 `checkpoint`의 서명된 `continuation`을 해당 응답 노드에도 저장합니다.
특정 응답에서 이어서 질문할 때 `/api/agent`에 그 노드의 `continuation`을 전달합니다.
예를 들어 A→B 다음에 A에서 C를 요청하면 모델 문맥은 A→C이며 B는 포함하지 않습니다.
노드의 `parentId`가 캔버스 간선을 결정합니다. `collapsed`와 함께 IndexedDB에 저장합니다.
실패한 분기의 재시도는 같은 부모와 요청 전 문맥을 사용합니다.
기존 기록 중 노드별 문맥이 없는 응답은 분기 버튼을 비활성화하며 문맥을 추측하지 않습니다.
