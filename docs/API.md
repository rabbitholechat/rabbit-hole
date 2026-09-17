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
| response_sources | id, sources | 선택 이벤트. 해당 응답의 실제 도구 조회 메타데이터 전체 스냅샷 |
| part_error | part=response, code, message | 공개 가능한 실패 정보 |
| done | status, failed_parts | completed/partial/failed, 실패 시 [response] |

정상 순서: started → checkpoint(이전 이력) → response_started → status → response_delta 반복 → response_completed → checkpoint(이번 턴 포함) → done.
조회 자료가 있으면 마지막 checkpoint 직전에 `response_sources`를 보냅니다. 응답 실패 시에도 확보한 조회 자료가 있으면 전송합니다. 취소/연결 종료 뒤에는 전송하지 않습니다. 자료가 없으면 이벤트를 생략합니다. 델타와 동일한 요청/응답 ID·seq 검증을 적용하며, 기존 클라이언트는 모르는 이벤트를 무시할 수 있습니다.
실패 시 response_completed 없음. 받은 텍스트가 있으면 partial, 없으면 failed. checkpoint는 이전 완료 대화만 유지합니다. 취소 시 연결 종료, 클라이언트가 노드 상태를 cancelled로 확정합니다.

에이전트 응답 1개 = 응답 태그·아이콘을 가진 캔버스 노드 1개. 높이는 Markdown 내용에 맞춰 증가합니다. 이어지는 응답은 오른쪽에 배치하고 클라이언트에서 대화 순서 화살표로 연결합니다. 이는 내용 근거 관계가 아닙니다. 완료 후 아래의 독립 구조화 요청으로 정보 노드를 추가합니다. 근거 검증·의미 관계 생성 호출은 없습니다. SDK의 공개 output_text/refusal delta와 제한된 조회 메타데이터만 전달하고 내부 추론·도구 인자·전체 본문·원시 도구 이벤트는 전달하지 않습니다.

## 에이전트 도구

- `calculator(expression)`: 최대 256자, AST 노드 64개. 십진수 +, -, *, /, 괄호, 절댓값 100 이하 정수 지수의 ** 연산. 유효숫자 40자리, 값의 절댓값 1e100 이하. 코드 실행·함수·속성 접근 금지. 비율은 /100으로 표현.
- `web_search(query)`: 최대 2000자. `OPENAI_SEARCH_MODEL`로 OpenAI Responses 내장 `web_search`를 한 번 호출하며 검색 요약과 실제 응답 메타데이터의 URL만 반환. 요약은 모델 생성 요약이며 본문 인용문이 아님. 출처 메타데이터가 없으면 요약도 사용하지 않음.
- `read_page(url)`: 공개 HTTP(S) HTML/일반 텍스트 읽기. 기본 포트만 허용. DNS 전체 주소 검사 및 연결 IP 고정, Host/TLS 호스트 보존, 리디렉션 최대 3회 재검사, 쿠키·인증·환경 프록시 미사용. PDF·JS 렌더링·로그인·압축 응답은 미지원. 실패는 안전한 코드로 반환하며 샘플 대체 없음.
- 도구는 일반 에이전트가 필요할 때 선택. 별도 키워드 분기나 매 요청 강제 검색 없음. 도구 출력은 신뢰할 수 없는 데이터로 취급하며 그 안의 명령은 수행하지 않음.
- 최신성 정책: 요청마다 실제 UTC 날짜를 본문/검색 모델 지침에 전달. 변할 수 있는 사실·최신 정보·명시적 검색 요청에는 검색 후 답하도록 지시. 과거 대화/학습 기억을 현재 사실의 근거로 삼지 않으며 검색 실패·빈 결과·오래되거나 불충분한 결과는 확인 불가로 설명. 발표/출시/판매·소문 및 문서 발행일/사건 날짜 구분. 사용자가 검색을 금지하면 이를 준수. 이는 일반 에이전트 지침이며 모델의 검색 선택/최신성 판단을 코드로 보증하는 분류기가 아님.
- 기본 예산: SDK 최대 6턴, 요청당 도구 최대 8회(실패 포함), 검색 최대 2회, 도구 20초, 페이지 1MB/본문 16,000자. 잘린 본문에는 `truncated=true`. 검색 호출별 출력 최대 1,500토큰. 기존 전체 요청 시간·동시 실행·출력 제한 및 취소 유지. MAX_OUTPUT_TOKENS는 본문 모델 호출별 제한이며 도구 후속 턴/검색 호출은 추가 비용이 발생할 수 있음. 자동 재시도 없음.

`response_sources.data` 예시:

```json
{"id":"response_요청UUID","sources":[{"id":"src_0123456789abcdef01234567","url":"https://example.com/page","title":"응답 메타데이터 또는 페이지의 제목","access":"search_result","accessed_at":"2026-09-17T00:00:00+00:00","verification":"unverified"}]}
```

위 URL은 계약 설명용 예시이며 실제 조회 기록이 아닙니다. `ToolSource`는 백엔드 모델과 프런트 타입에서 같은 필드를 사용합니다. `access`는 `search_result`(검색으로 확보) 또는 `page_read`(앱의 read_page 성공), `verification`은 항상 `unverified`. OpenAI 검색 내부의 페이지 접근을 앱의 본문 읽기 성공으로 승격하지 않습니다. `accessed_at`은 해당 도구 실행 시각이며 문서 발행일이 아닙니다.

ID는 정규화된 페이지 URL의 SHA-256 앞 24자리입니다. fragment만 제외하고 경로·쿼리를 유지하며 도메인 병합하지 않습니다. read_page는 리디렉션의 최종 URL을 사용합니다. 동일 URL의 검색→읽기는 같은 ID로 갱신하고 읽기→검색은 상태를 낮추지 않습니다. 조회 목록은 인용 관계가 아닙니다. 응답에 생성된 임의 링크는 이 목록에 등록하지 않습니다.

프런트는 응답의 `toolSources`를 보존하고 페이지별 출처 노드로 표시합니다. 실제 응답 Markdown에 해당 링크가 있으면 `cites`(출처 표기), 없으면 `consulted`(조회) 화살표를 연결합니다. 조회 성공은 사실 검증이나 답변 지지를 의미하지 않습니다. 과거 검색용 Source 타입과 분리하며 기록 복원은 조회를 재실행하지 않습니다. 도구 본문·조회 목록은 서명 continuation에 추가하지 않고 완료 질문/공개 답변만 유지합니다.

공식 API 참고: [OpenAI 웹 검색 도구와 출처 메타데이터](https://developers.openai.com/api/docs/guides/tools-web-search).

## 제한과 보존

- 출력 토큰, 요청 시간, 전체 실행 시간, SDK 턴 수, 응답 길이(64,000자), 동시 작업·요청 빈도 제한 적용.
- 서명 이력은 최근 MAX_CONTEXT_TURNS개 메시지, 최대 96,000자. 오래된 user/assistant 쌍부터 제거. 실패한 턴은 포함하지 않음.
- continuation은 HMAC 서명, 암호화 아님. 로그 출력 금지. 7일 만료. 프로덕션에는 모든 인스턴스가 동일한 SESSION_SIGNING_KEY 사용.
- 프런트는 현재 request_id, 증가하는 seq, 활성 응답 id만 반영. 중지/화면 전환 뒤 늦은 델타 무시.
- 스트리밍 중 500ms 간격으로 IndexedDB 저장, 완료·중지·실패 즉시 저장. 새로고침 시 마지막 저장 시점까지 복원. running 기록은 partial로 표시하며 API를 호출하지 않음.
- 노드 위치·viewport 보존. 최초 노드만 자동 화면 맞춤. 후속 노드는 오른쪽에 추가하며 화면 맞춤 버튼으로 전체 보기.
- Markdown HTML/외부 이미지 비활성화. 링크는 클라이언트의 기존 안전한 HTTP(S) URL 검사 적용. 생성 링크는 검증 출처가 아님.

## 호환성

`/api/search`와 v1 검색 파이프라인은 제거했습니다. 디자인 예시 생성 UI는 제거했습니다. 기존 IndexedDB 페이지·관계 및 가상 데이터 기록은 로컬 열람 가능. 기존 기록에서 메시지를 보내면 새 v2 대화가 시작되고 기존 continuation/가상 자료를 전송하지 않습니다.

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

### POST `/api/structure` — 완료 응답의 정보 추출

요청: `request_id`(새 UUID), `continuation`(해당 응답 직후의 서버 서명 문맥), `text_hash`(공개 답변 UTF-8 SHA-256). 추가 필드는 거부합니다. 서버는 서명을 확인하고 마지막 assistant 답변의 해시와 비교합니다. 사용자가 바꾼 임의 텍스트는 구조화하지 않습니다.

```json
{
  "version": 1,
  "text_hash": "c66e5e88fa09f898b3617cd3c44ea73b8e85dd223c71201ab898cb3a0a4a6012",
  "items": [{
    "key": "2091f76c4d5308a1d7bf1218",
    "subtype": "concept",
    "title": {"start": 0, "end": 5, "quote": "벡터 검색"},
    "excerpt": {"start": 0, "end": 17, "quote": "벡터 검색은 의미를 비교합니다."}
  }]
}
```

위는 원문 `벡터 검색은 의미를 비교합니다.\n\n추가 설명입니다.`의 필드 설명용 결과입니다(실제 120자 미만 응답은 추출 생략). `key`는 `text_hash:start:end:subtype`의 SHA-256 앞 24자리입니다. 범위는 Unicode 코드 포인트 기준 `[start, end)`이며 JavaScript에서는 `Array.from(text)`로 슬라이스합니다. 모델에는 번호를 붙인 원문 줄 목록을 전달하며 `start_line`, `end_line`(양끝 포함), `title_line`, `subtype`만 반환하도록 합니다. 모델이 본문을 복사하거나 새 사실·설명·출처를 작성하지 않습니다. 서버는 유효한 줄 범위를 확인하고 원문에서 발췌와 제목을 직접 가져와 오프셋과 키를 계산합니다. 제목은 선택한 제목 줄의 앞쪽 Markdown 기호를 제외한 최대 100자입니다. 반복 문구도 줄 번호로 위치를 구분합니다. 프런트가 해시·범위·문자열을 재검증합니다. 정확한 복사 여부는 검증하지만 발췌의 의미적 완결성을 보증하지는 않습니다.

- `subtype`: concept / entity / claim / example / comparison. 비교는 정보 노드의 하위 유형입니다.
- 정보는 0..6개. 120자 미만은 모델 호출 없이 빈 배열, 전체 답변 복제·중복 발췌 제외. 긴 답변도 분리할 가치가 없으면 빈 배열입니다.
- 모델: `OPENAI_STRUCTURE_MODEL` 기본 gpt-4.1-mini. Responses 구조화 출력 1회, 최대 4,000 출력 토큰, 도구 없음, 저장·자동 재시도 없음. 본문과 독립된 추가 모델 비용이 발생합니다.
- `STRUCTURE_TIMEOUT_SECONDS` 기본 25초(1..60), 프런트 요청 제한 30초. 기존 요청 빈도·동시 실행 예산 공유. 연결 종료 시 작업 취소·클라이언트 종료.
- 서명/해시 불일치 409, 검증 422, 요청 제한 429, 미설정 503, 추출/시간 초과 502. 오류에 원문을 노출하지 않습니다.

### 캔버스 저장과 관계

`Session.contentGraph = {version: 1, entities, relations, jobs}`에 의미 데이터를 저장하고, `Session.nodes`에는 React Flow 좌표·크기와 파생 노드의 `{entityId}` 참조를 저장합니다. 기존 응답 노드 형식과 원문은 유지합니다.

| 노드 | 의미 데이터 | 기본/상세 표시 |
| --- | --- | --- |
| response | 기존 prompt, text, status, continuation, toolSources | 질문·전체 답변, 구조화 상태·중지·재시도 |
| information | id, subtype, responseId, textHash, title/excerpt 범위 | 원문 제목·발췌, 원문 보기로 응답 위치 추적 |
| source | id, ToolSource, observations(responseId, access, accessedAt, spans) | 페이지 제목·도메인·검색/본문 조회·미검증·링크. 응답별 조회 기록은 데이터로만 보존 |

| 관계 | 방향 | 화면 라벨 | 생성 기준 |
| --- | --- | --- | --- |
| 기존 대화 순서 | 부모 response → 후속 response | 기존 대화 순서 표시 | 사용자의 응답 분기 선택/실행 기록 |
| has_extract | response → information | 정보 추출 | 모델이 선택한 원문 발췌를 서버/클라이언트 검증 |
| consulted | response → source | 조회 | 해당 응답의 실제 도구 조회 기록, 본문에 해당 링크 없음 |
| cites | response 또는 information → source | 출처 표기 | 실제 Markdown 링크가 해당 도구 출처 URL과 일치. 코드 블록·이미지 제외, 참조식 링크 정의 지원 |

출처 ID는 페이지별로 재사용하고 응답별 관찰 기록을 보존합니다. 출처가 없는 응답에는 출처 노드가 없습니다. 도구 메타데이터에 없는 생성 링크는 원래 답변에 남지만 출처 노드를 만들지 않습니다. `cites`도 자료 내용의 지지·인과·사실 검증을 의미하지 않습니다. 정보 간 의미 관계, uses_context, 비교 대상 연결 및 정보에서 대화 분기는 후순위입니다.

`done(completed)` 후 signed checkpoint로 구조화를 시작하고 결과 전체 검증 후 원자적으로 추가합니다. 실패·중지는 기존 답변·출처·배치를 유지하며 사용자가 재시도할 수 있습니다. `jobs[responseId]`에 상태와 시도 ID를 저장해 중복 요청과 오래된 결과를 차단합니다. 완료된 작업은 재실행하지 않고 원문 해시·범위 기반 노드 ID와 관계 ID로 재적용을 중복 제거합니다. 새 노드만 기존 카드와 겹치지 않는 위치에 추가하고 사용자가 옮긴 좌표·viewport는 보존합니다.

화면 전환/삭제는 해당 구조화를 취소합니다. IndexedDB 복원은 모델을 호출하지 않으며 중단된 작업은 cancelled로 복원합니다. 예전 v2 조회 메타데이터는 로컬에서 출처 노드로 표시할 수 있지만 과거 답변의 정보 추출은 자동 실행하지 않습니다. 구조화 실패가 원래 답변 표시와 후속 질문을 막지 않습니다.

구조화 실패 로그는 원문 없이 `structure_invalid_selection`(범위/제목 줄 오류), `structure_invalid_schema`(출력 형식 오류), `structure_output_limit`(출력 토큰 제한), `structure_incomplete`(미완료), `structure_refused`(거절), `structure_missing_output`(파싱 결과 없음)을 구분합니다. HTTP 실패는 기존 502 계약을 유지합니다. 구조화 출력 방식은 [공식 OpenAI 구조화 출력 문서](https://developers.openai.com/api/docs/guides/structured-outputs)를 참고합니다.

출처 카드 기본 크기는 460×280px입니다. 기존 작은 출처도 복원 시 이 크기로 확대하되 좌표·viewport는 그대로 유지합니다. 응답 카드는 투명 배경과 녹색 테두리, 정보 카드는 황토색, 출처 카드는 파란색으로 구분합니다.
