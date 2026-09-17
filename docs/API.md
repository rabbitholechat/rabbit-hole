# API / SSE 계약 v1

JSON 본문 기본 2,100,000바이트 상한. continuation은 최대 2,000,000자.

로그인 없음. 같은 origin `/api` 사용. WebSocket 불필요: 단방향 SSE + fetch AbortController.

- `GET /api/health`: 키 값 없이 구성 여부.
- `POST /api/search`: JSON query(1..2000), request_id(UUID), continuation(서버 서명 snapshot, 선택), focus_source_id(선택), retry_part(intent|answer|relationships, 선택). 응답은 `text/event-stream`.
- `DELETE /api/jobs/{id}`: Bearer 작업 접근 토큰. 동일 프로세스에서 최선 노력 취소, 다른 인스턴스는 404. 주 취소 경로는 스트림 연결 종료.

SSE envelope: `{version:1, request_id, job_id, seq, type, data}`. `id: seq`, `event: type`, `data: JSON` + 빈 줄. 주요 이벤트 순서: `started`, `status`, `sources`(여러 번), `answer`/`relationships`, `checkpoint`, `done`. 출처 확보 직후에도 `checkpoint`를 보냅니다. 실패 부문은 `part_error`, 연결 유지 SSE comment `: ping`. `clarification`은 SDK 의도 확인 후 조건 입력 요청과 checkpoint를 보내고 종료합니다. 의도 확인은 모델 호출을 사용합니다.

- started: access_token (메모리 전용), status
- status: stage(understanding|searching|reading|relating)
- clarification: message, questions(1..3개), suggestions(0..4개). 주제별 kind/전용 필드 없음. 클라이언트는 질문을 표시하고 사용자 답변을 query + continuation으로 전송. 예시 선택은 입력만 채우며 자동 호출 없음.
- sources: sources 배열 (페이지 단위 upsert)
- answer: claims 배열(text, evidence[source_id, quote, basis]), limitation
- relationships: relations 배열(source, target, kind, label, explanation, evidence, strength), clusters 배열(id, label, source_ids), page_types 배열(source_id, tag)
- part_error: part(intent|search|answer|relationships), code(아래 목록), message (민감 정보 제거). 기존 클라이언트/기록 호환을 위해 프런트에서 code 생략 허용.
- checkpoint: continuation 서명 문자열. 서버가 확보한 출처/답변/관계/원 질문 보존. 브라우저 데이터를 신뢰해서 레지스트리에 넣지 않음.
- done: status(completed|partial|cancelled|failed|awaiting_input), failed_parts

클라이언트는 활성 request_id만 적용. 새 화면/중지/기록 전환 시 세대 변경과 abort. 단절 시 받은 카드 보존, 자동 재호출 없음.

개별 출처: id(URL SHA256), original_url, url, title, domain, summary, excerpt, published_at(nullable), retrieved_at, read_status(summary|read|failed), tag, content_origin(search_snippet|web_search_summary). 가격 전용 추정 필드 없음.

모델 출력은 미등록 ID, 없는 노드, 근거 발췌 불일치 시 거부. 답변 핵심 주장에 별도 의미 검증 실행. SDK 내부 이벤트와 reasoning은 전송하지 않음.

Vercel: POST 한 응답의 수명 동안 작업 실행. 후속/부문 재시도는 서명 checkpoint로 다른 인스턴스에서도 복구. 완료 이력 DB는 IndexedDB이며 작업 메모리는 만료/재시작 시 소실. 글로벌 rate limit은 배포 WAF에서 추가 구성.

## OpenAI 검색 출처 계약

- 검색 공급자는 OpenAI Responses `web_search`만 사용. 구성 여부는 OPENAI_API_KEY만 검사.
- `content_origin`은 기존 기록에서 생략 가능하며 기본값은 `search_snippet`. 새 검색은 `web_search_summary`.
- `summary`는 OpenAI의 URL 인용 annotation이 붙은 단일 출처 문단. 생성 요약이며 원문 인용이 아님. 복수 URL 문단이나 인용 없는 consulted URL은 요약을 비워 둠.
- 새 검색의 `excerpt`는 빈 문자열, `read_status`는 `summary`. 원문을 확보했다고 주장하지 않음. 기존 기록의 원문은 보존.
- URL은 공급자의 `web_search_call.action.sources` 또는 `url_citation`에서만 등록. 생성 텍스트의 링크는 출처로 채택하지 않음.
- 요청당 내장 도구 호출 최대 1회. `MAX_SEARCH_CALLS`는 재시도를 포함하는 요청 예산. 숨은 SDK 재시도 비활성화.
- 인용 링크는 해당 페이지 카드/근거에서 열 수 있어야 함. AI 요약의 부분 문자열 대조와 의미 검증은 원문 사실 검증을 보장하지 않음.

추가 질문과 awaiting_input 상태는 IndexedDB에 저장하며 복원 시 API를 호출하지 않습니다. 기존 기록의 주제별 레거시 필드는 요청에 전송하지 않습니다.

## 실패 진단

`part_error.code`: timeout, connection_error, provider_auth_error, provider_rate_limit,
provider_request_error, provider_error, invalid_evidence, invalid_output, turn_limit,
search_budget_exhausted, invalid_tool_input, search_incomplete, search_tool_failed,
no_sources, internal_error.

검색 도구 예외는 SDK가 모델용 대체 문장으로 삼키지 않고 서버로 전파됩니다.
검색 예외는 `part=search`로 보고하며 다른 단계의 실패가 이미 있으면 파생된 `no_sources` 오류를 추가하지 않습니다.
출처가 있으면 카드는 보존하고 partial, 없으면 failed로 종료합니다.
서버 로그에는 request_id, part, code, 예외 클래스명, 코드 파일명·줄 번호·함수명만 기록합니다. 예외 원문·응답 본문·키·질문·내부 추론은 기록하지 않습니다.

`evidence.quote`는 저장된 Markdown summary/excerpt의 부분 문자열을 그대로 복사합니다. 강조 문법 제거·번역·제목/URL 대체를 허용하지 않습니다. 관계 유형은 same_topic, comparison, application, same_entity, same_conditions, contrasting_view, related_concept이며 양쪽 페이지 내용에 근거한 무방향 연결입니다.
