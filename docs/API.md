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
| status | stage=responding/reading_sources | 에이전트 응답 진행 |
| response_delta | id, delta | Markdown 원문 텍스트를 그대로 추가 |
| response_completed | id, text | 완성된 전체 응답으로 확정, 델타에 다시 추가하지 않음 |
| response_sources | id, sources | 선택 이벤트. 해당 응답의 실제 도구 조회 메타데이터 전체 스냅샷 |
| part_error | part=response, code, message | 공개 가능한 실패 정보 |
| done | status, failed_parts | completed/partial/failed, 실패 시 [response] |

정상 순서: started → checkpoint(이전 이력) → response_started → status → response_delta 반복 → response_completed → checkpoint(이번 턴 포함) → done.
조회 자료가 있으면 출처별 조회/요약 시작과 완료 시 `response_sources` 전체 스냅샷을 반복 전송하고, 마지막 checkpoint 직전에도 최종 상태를 보냅니다. 응답 실패 시에도 확보한 조회 자료가 있으면 전송합니다. 취소/연결 종료 뒤에는 전송하지 않습니다. 자료가 없으면 이벤트를 생략합니다. 델타와 동일한 요청/응답 ID·seq 검증을 적용하며, 기존 클라이언트는 모르는 이벤트를 무시할 수 있습니다.
실패 시 response_completed 없음. 받은 텍스트가 있으면 partial, 없으면 failed. checkpoint는 이전 완료 대화만 유지합니다. 취소 시 연결 종료, 클라이언트가 노드 상태를 cancelled로 확정합니다.

에이전트 응답 1개 = 응답 태그·아이콘을 가진 캔버스 노드 1개. 높이는 Markdown 내용에 맞춰 증가합니다. 이어지는 응답은 오른쪽에 배치하고 클라이언트에서 대화 순서 화살표로 연결합니다. 이는 내용 근거 관계가 아닙니다. 완료 후 아래의 독립 구조화 요청으로 정보 노드를 추가합니다. 근거 검증·의미 관계 생성 호출은 없습니다. SDK의 공개 output_text/refusal delta와 제한된 조회 메타데이터만 전달하고 내부 추론·도구 인자·원시 도구 이벤트는 전달하지 않습니다. 출처 카드에는 아래 한도 내에서 실제 읽은 페이지 본문을 전달합니다.

## 에이전트 도구

- `calculator(expression)`: 최대 256자, AST 노드 64개. 십진수 +, -, *, /, 괄호, 절댓값 100 이하 정수 지수의 ** 연산. 유효숫자 40자리, 값의 절댓값 1e100 이하. 코드 실행·함수·속성 접근 금지. 비율은 /100으로 표현.
- `web_search(query)`: 최대 2000자. `OPENAI_SEARCH_MODEL`로 OpenAI Responses 내장 `web_search`를 한 번 호출하며 검색 요약과 실제 응답 메타데이터의 URL만 반환. 요약은 모델 생성 요약이며 본문 인용문이 아님. 출처 메타데이터가 없으면 요약도 사용하지 않음.
- `read_page(url)`: 공개 HTTP(S) HTML/일반 텍스트 읽기. 기본 포트만 허용. DNS 전체 주소 검사 및 연결 IP 고정, Host/TLS 호스트 보존, 리디렉션 최대 3회 재검사, 쿠키·인증·환경 프록시 미사용. gzip 압축 응답을 지원하며 PDF·JS 렌더링·로그인은 미지원. 실패는 안전한 코드로 반환하며 샘플 대체 없음.
- 도구는 일반 에이전트가 필요할 때 선택. 완료 답변에 실제 조회 출처가 있으면 표시 대상 출처의 본문만 자동 병렬 조회. 별도 키워드 분기나 매 요청 강제 검색 없음. 도구 출력은 신뢰할 수 없는 데이터로 취급하며 그 안의 명령은 수행하지 않음.
- 최신성 정책: 요청마다 실제 UTC 날짜, Asia/Seoul 날짜와 UTC+09:00 요청 시각을 본문/검색 모델 지침에 전달. 오늘/최신 같은 상대 날짜는 기본 서울 시간으로 해석하고 사용자가 날짜·시간대를 지정하면 우선 적용. 변할 수 있는 사실·최신 정보·명시적 검색 요청에는 검색 후 답하도록 지시. 과거 대화/학습 기억을 현재 사실의 근거로 삼지 않으며 검색 실패·빈 결과·오래되거나 불충분한 결과는 확인 불가로 설명. 발표/출시/판매·소문 및 문서 발행일/사건 날짜 구분. 사용자가 검색을 금지하면 이를 준수. 이는 일반 에이전트 지침이며 모델의 검색 선택/최신성 판단을 코드로 보증하는 분류기가 아님.
- 기본 예산: SDK 최대 6턴, 요청당 도구 최대 8회(실패 포함), 검색 최대 2회, 도구 20초, 페이지 전송 1MB, 압축 해제 4MB/본문 16,000자. 용량 초과 시 한도 안에서 확보한 본문만 반환하며 본문이 없으면 실패. 잘린 본문에는 `truncated=true`. 검색 호출별 출력 최대 1,500토큰. 기존 전체 요청 시간·동시 실행·출력 제한 및 취소 유지. MAX_OUTPUT_TOKENS는 본문 모델 호출별 제한이며 도구 후속 턴/검색 호출은 추가 비용이 발생할 수 있음. 자동 재시도 없음.

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
- 스트리밍 중 500ms 간격으로 PostgreSQL 저장, 완료·중지·실패 즉시 저장. 새로고침 시 마지막 저장 시점까지 복원. running 기록은 partial로 표시하며 기록 조회 외에 모델/도구 API를 호출하지 않음.
- 노드 위치·viewport 보존. 최초 노드만 자동 화면 맞춤. 후속 노드는 오른쪽에 추가하며 화면 맞춤 버튼으로 전체 보기.
- Markdown HTML/외부 이미지 비활성화. 링크는 클라이언트의 기존 안전한 HTTP(S) URL 검사 적용. 생성 링크는 검증 출처가 아님.

## 호환성

`/api/search`와 v1 검색 파이프라인은 제거했습니다. 디자인 예시 생성 UI는 제거했습니다. 기존 IndexedDB 페이지·관계 및 가상 데이터 기록은 PostgreSQL 이전 후 읽기 전용 열람 가능. 기존 기록에서 메시지를 보내면 새 v2 대화가 시작되고 기존 continuation/가상 자료를 전송하지 않습니다.

## 실패 코드

timeout, connection_error, provider_auth_error, provider_rate_limit, provider_request_error,
provider_error, invalid_output, turn_limit, incomplete_response, output_limit, internal_error.

원문 오류·키·추론은 SSE에 포함하지 않습니다. 요청 검증 422, 만료/위조/구버전 continuation 409, 본문 제한 413, 요청 제한 429, 미설정 503.

### POST `/api/title`

첫 완료 응답의 마지막 `checkpoint.continuation`과 새 UUID `request_id`를 전달하면
`{"title":"대화 제목"}`을 반환합니다. 서명된 문맥이 user/assistant 한 쌍이어야 합니다.
프런트는 `done(completed)` 후 독립 요청으로 한 번 호출하며 다음 대화를 막지 않습니다.
실패하면 질문을 제목으로 유지합니다. `title`, `titleRequested`는 PostgreSQL에 저장되며
기록 복원은 제목 생성 요청을 보내지 않습니다. 생성 중 다른 기록을 열어도 원래 기록만 갱신합니다.
서명 오류/잘못된 문맥 409, 요청 제한 429, 모델 미설정 503, 생성 실패 502입니다.
본문과 동일한 요청/동시 실행 제한 및 별도 `BACKGROUND_TIMEOUT_SECONDS`를 적용합니다.

### 응답에서 대화 분기

프런트는 완료 응답 직후 `checkpoint`의 서명된 `continuation`을 해당 응답 노드에도 저장합니다.
특정 응답에서 이어서 질문할 때 `/api/agent`에 그 노드의 `continuation`을 전달합니다.
예를 들어 A→B 다음에 A에서 C를 요청하면 모델 문맥은 A→C이며 B는 포함하지 않습니다.
노드의 `parentId`가 캔버스 간선을 결정합니다. `collapsed`와 함께 PostgreSQL에 저장합니다.
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
| information | id, subtype, responseId, textHash, title/excerpt 범위 | 원문 제목·발췌, 이전 노드로 이동 |
| source | id, ToolSource, observations(responseId, access, accessedAt, spans) | 페이지 제목·도메인·검색/본문 조회·페이지 열기 버튼. 응답별 조회 기록은 데이터로만 보존 |

| 관계 | 방향 | 화면 라벨 | 생성 기준 |
| --- | --- | --- | --- |
| 기존 대화 순서 | 부모 response → 후속 response | 기존 대화 순서 표시 | 사용자의 응답 분기 선택/실행 기록 |
| has_extract | response → information | 정보 추출 | 모델이 선택한 원문 발췌를 서버/클라이언트 검증 |
| consulted | response → source | 조회 | 해당 응답의 실제 도구 조회 기록, 본문에 해당 링크 없음 |
| cites | response 또는 information → source | 출처 표기 | 실제 Markdown 링크가 해당 도구 출처 URL과 일치. 코드 블록·이미지 제외, 참조식 링크 정의 지원 |

출처 ID는 페이지별로 재사용하고 응답별 관찰 기록을 보존합니다. 출처가 없는 응답에는 출처 노드가 없습니다. 도구 메타데이터에 없는 생성 링크는 원래 답변에 남지만 출처 노드를 만들지 않습니다. `cites`도 자료 내용의 지지·인과·사실 검증을 의미하지 않습니다. 정보 간 의미 관계와 비교 대상 연결은 후순위입니다. 사용자가 선택한 노드의 맥락 참조는 아래 uses_context로 기록합니다.

`done(completed)` 후 signed checkpoint로 구조화를 시작하고 결과 전체 검증 후 원자적으로 추가합니다. 실패·중지는 기존 답변·출처·배치를 유지하며 사용자가 재시도할 수 있습니다. `jobs[responseId]`에 상태와 시도 ID를 저장해 중복 요청과 오래된 결과를 차단합니다. 완료된 작업은 재실행하지 않고 원문 해시·범위 기반 노드 ID와 관계 ID로 재적용을 중복 제거합니다. 새 노드만 기존 카드와 겹치지 않는 위치에 추가하고 사용자가 옮긴 좌표·viewport는 보존합니다.

화면 전환/삭제는 해당 구조화를 취소합니다. PostgreSQL 복원은 모델을 호출하지 않으며 중단된 작업은 cancelled로 복원합니다. 예전 v2 조회 메타데이터는 로컬에서 출처 노드로 표시할 수 있지만 과거 답변의 정보 추출은 자동 실행하지 않습니다. 구조화 실패가 원래 답변 표시와 후속 질문을 막지 않습니다.

구조화 실패 로그는 원문 없이 `structure_invalid_selection`(범위/제목 줄 오류), `structure_invalid_schema`(출력 형식 오류), `structure_output_limit`(출력 토큰 제한), `structure_incomplete`(미완료), `structure_refused`(거절), `structure_missing_output`(파싱 결과 없음)을 구분합니다. HTTP 실패는 기존 502 계약을 유지합니다. 구조화 출력 방식은 [공식 OpenAI 구조화 출력 문서](https://developers.openai.com/api/docs/guides/structured-outputs)를 참고합니다.

출처 카드 너비는 460px, 최소 높이는 260px이며 본문에 따라 높이가 늘어납니다. 긴 본문은 기본 160px 미리보기로 접고 펼칠 수 있습니다. 기존 작은 출처도 복원 시 너비를 확대하되 좌표·viewport는 그대로 유지합니다. 응답 카드는 투명 배경과 녹색 테두리, 정보 카드는 황토색, 출처 카드는 파란색으로 구분합니다.

### 출처 중복 제거와 노드 탐색

캔버스에서는 출처 ID가 달라도 정규화된 페이지 URL이 같으면 첫 카드로 합칩니다. fragment와 알려진 추적 파라미터(`utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `srsltid`, `yclid`, `mc_cid`, `mc_eid`, `_ga`, `_gl`)를 비교에서 제외합니다. 쿼리 키 순서를 정렬해 파라미터 나열 순서만 다른 URL도 합칩니다(동일 키의 반복 값 순서는 유지). 도메인만으로 합치지 않으며 문서 ID·언어 등 나머지 쿼리, 다른 경로·프로토콜·호스트는 유지합니다. 서버의 원래 도구 메타데이터와 페이지 ID는 변경하지 않습니다.

동일 페이지의 관찰 기록·인용 범위를 합치고 본문 조회 상태를 보존하며, 응답/정보의 연결선을 남는 카드로 갱신합니다. 기존 위치·viewport는 그대로 유지합니다. 새 조회 때와 기록 복원 때 모두 적용하고 추가 모델/도구 API 호출은 없습니다. 기존 중복의 합쳐진 화면은 후속 저장 시 PostgreSQL에도 반영됩니다.

모든 카드의 ‘이전 노드로’는 들어오는 연결선의 시작 노드로 이동합니다. 응답은 실제 parentId(구버전은 기존 대화 순서), 정보/출처는 해당 관계를 따릅니다. 여러 개면 선택 목록, 없으면 비활성 버튼입니다. 이동은 노드를 선택하고 현재 배율을 유지하여 화면을 해당 노드로 옮깁니다. 별도 원문 보기와 원문 발췌 패널은 제거했지만 추출 범위 데이터는 보존합니다.

‘미검증’은 카드 표시에서만 제거하며 `verification=unverified` 계약은 유지합니다. 구조화 중에는 스피너와 중지 버튼을 표시하고 완료 문구는 숨깁니다. 새 정보·출처 카드는 짧은 페이드/이동 애니메이션을 적용하며 시스템의 동작 줄이기 설정에서는 끕니다.

### 선택한 노드를 다음 응답에 사용

`POST /api/agent`는 선택적으로 `node_context: {node_id, kind, title, text}`를 받습니다. kind는 information/source, ID 1..200자, 제목 최대 500자, text 1..12000자이며 추가 필드는 거부합니다. 이는 클라이언트에서 사용자가 명시적으로 선택한 참고 데이터이며 서버가 검증한 출처/사실로 취급하지 않습니다. 백엔드는 질문 뒤에 자료임을 명시한 JSON으로 붙여 일반 에이전트 입력과 서명 대화 이력에 포함합니다. 사용자 질문 자체의 2000자 제한은 유지합니다.

응답 노드의 기존 분기는 해당 응답의 서명 문맥을 사용합니다. 정보/출처의 ‘다음 응답에 사용’은 현재 대화 문맥에 선택한 발췌 또는 페이지 제목·URL·확보한 본문을 최대 12,000자로 제한해 추가합니다. 질문 텍스트는 카드에 별도로 유지합니다. 재시도는 같은 선택 자료를 재사용합니다. 새 응답 → 선택한 정보/출처의 `uses_context`(맥락 참고) 간선은 사용자 선택 기록으로만 생성하며 지지·인과·검증 의미가 없습니다. 이전 노드 탐색은 이 맥락 참조 간선을 제외하고 원래 대화/추출/조회 경로를 따릅니다.

응답·정보·출처에 복사, 접기/펼치기, 다음 응답 사용 동작을 제공합니다. 과거 가상 페이지 기록은 읽기 전용이므로 다음 응답 사용을 비활성화합니다. 접기 상태와 높이는 배치 데이터로 저장합니다. 페이지 열기/이전 노드로는 하단에 나란히 배치합니다. 툴팁은 카드 밖 body 포털에 표시해 카드 overflow/캔버스 배율에 잘리지 않으며 화면 경계에서 위치를 보정합니다.

### 서버 출처 개수와 접기 기준

`MAX_RESPONSE_SOURCES`는 응답당 SSE로 전달할 출처 개수 상한입니다. 기본 5, 허용 1..50이며 서버 `.env` 또는 배포 환경변수로 설정합니다. 성공/부분 실패의 조회 기록 모두 같은 상한을 적용합니다. 실제 조회 기록 순서로 최대 5개만 전달하며 도구 실행 예산·검색 결과 자체·공개 답변의 링크를 변경하지 않습니다. 여러 응답이 쌓인 캔버스 전체 개수 제한은 아닙니다. 과거 저장된 출처를 삭제하거나 클라이언트에서 숨기지 않습니다. 사이드바에는 개수 설정을 두지 않습니다.

응답·정보·과거 페이지의 접기는 실제 렌더링 본문 높이를 공통으로 측정합니다. 160px를 초과할 때만 버튼이 활성화되며 접어도 제목·앞부분 160px·하단 동작은 남습니다. 짧은 정보와 본문 없는 출처는 접기를 비활성화합니다. 정보의 펼친 높이는 본문에 맞게 자동 측정하고, 과거 고정 높이/출처 접기 상태는 복원 시 바로잡습니다.

### 하위 노드에서 응답 이어가기

정보/출처를 선택해 요청하면 새 응답의 `parentId`는 선택한 하위 노드 ID입니다. 새 응답을 해당 노드 오른쪽의 빈 공간에 배치하고 선택 노드 → 새 응답의 대화 흐름 화살표를 표시합니다. 이 연결은 사용자 조작에 따른 흐름이며 내용의 지지 관계가 아닙니다. 모델 입력은 기존 서명 대화 문맥과 선택한 `node_context`를 유지합니다.

`uses_context` 기록은 보존하지만 동일 선택을 나타내는 역방향 선을 중복 표시하지 않습니다. ‘이전 노드로’도 선택했던 하위 노드로 이동합니다. 이전 버전 기록은 새 응답에서 출발하는 유일한 uses_context 선택 기록이 있으면 그 노드를 연결 기준으로 복원하며 사용자 배치는 바꾸지 않습니다. 출처 중복 병합 시 응답 parentId·재시도 맥락 참조도 남는 출처로 갱신합니다.

### 최신 상태의 근거 확인

본문 에이전트는 발표/출시 상태 질문에 대해 공식 제품 페이지·뉴스룸·문서를 우선 확인하도록 지시합니다. 결과가 불충분하거나 충돌하면 남은 검색 예산 내에서 현재 날짜·공식 도메인으로 검색을 보완하고 필요한 원문을 읽습니다. 확인하지 못한 것을 ‘미발표/존재하지 않음/루머뿐’으로 단정하지 않으며, 과거 학습 기억과 다르다는 이유만으로 최근 공식 자료를 배제하지 않습니다. 특정 제품명에 따른 분기는 없습니다.

검색 컨텍스트 크기를 low에서 medium으로 변경하고 요약에 출처별 사실·발행/사건 날짜를 명시하도록 지시합니다. 검색 결과의 실제 인용 URL을 전체 발견 URL보다 먼저 등록하여 최대 40개 메타데이터와 5개 카드 상한에서 인용 페이지가 밀려나는 것을 방지합니다. 같은 URL의 제목 없는 발견 기록은 기존 인용 제목을 지우지 않습니다. 검색 횟수·출력 토큰·전체 요청 예산은 그대로이며 지침 준수와 실제 의미 정확성을 코드만으로 보증하지는 않습니다.

### 재질문과 답변 범위의 기본값

일반 정보 요청은 대화에서 가장 자연스러운 의도를 추론해 바로 수행합니다. ‘신 모델/최신 제품’처럼 범위가 넓어도 현재 기준 최신 공식 발표 세대를 기본으로 조사하고 발표와 판매 상태를 구분합니다. 특정 제품명에 대한 코드 분기는 없습니다. 선택적인 지역·비교·형식 선호를 이유로 질문을 돌려주지 않으며, 유용한 답변 자체를 만들 수 없거나 중요한 실행 판단이 달라지는 경우에만 짧은 확인 질문을 합니다.

핵심 답변·주요 사실·출처를 먼저 제시하고 불필요한 선택지 목록이나 ‘원하시면 찾아드릴게요’로 요청을 미루지 않습니다. 검색 실패는 검색 한계로 짧게 설명하며 질문이 모호하다는 설명으로 대체하거나 사실을 지어내지 않습니다. 이는 모델 지침이며 실제 응답의 준수 여부를 코드로 보증하는 분류기는 아닙니다.

### 출처 본문 병렬 조회

완료 응답에 실제 도구 출처가 있으면 `response_completed` 이후 `status(stage=reading_sources)`를 전송하고 표시 대상 출처(`MAX_RESPONSE_SOURCES`, 기본 5개)의 공개 페이지를 병렬 조회합니다. `MAX_SOURCE_CONCURRENCY`는 기본 3, 범위 1..8입니다. 출처 없는 응답에는 조회를 추가하지 않습니다. 확보한 각 페이지 본문은 아래의 제한된 독립 요약 호출로 요약하며 추가 검색/검증 호출은 없습니다. 에이전트가 이미 읽은 본문은 같은 요청에서 재사용합니다.

자동 조회도 기존 `MAX_TOOL_CALLS`(실패 포함), `JOB_TIMEOUT_SECONDS`의 남은 시간, 페이지별 시간/바이트/문자 한도 안에서 실행합니다. 대기 작업과 진행 중 요청 모두 연결 종료/취소에 연동됩니다. 기존 `fetch_page`의 URL·DNS·IP 고정·리디렉션 검사를 그대로 적용합니다. 실패는 답변 완료 상태와 별개로 격리합니다. 개별 페이지 실패가 다른 페이지 처리를 막지 않습니다.

`response_sources`의 각 ToolSource에 선택적 `content` 객체가 추가됩니다. 이전 기록의 누락/null도 허용합니다.

```json
{"status":"read","text":"실제로 읽은 페이지 텍스트","truncated":false,"final_url":"https://example.com/page","error_code":null}
```

- `status`: reading / summarizing / read / failed / skipped / cancelled. text는 최대 32,000자(설정 기본 16,000자), 실패/건너뜀은 빈 문자열.
- `truncated`: 페이지 문자 한도로 잘렸는지 표시.
- `final_url`: 읽기 성공 시 안전 검사한 최종 URL, 실패 시 null.
- `error_code`: null / page_unavailable / page_timeout / budget_exhausted / page_blocked / page_not_found / page_size_limit / unsupported_content_type / unsupported_encoding / empty_page / unsafe_url.
- 자동 읽기는 원래 검색 출처 ID와 URL을 유지하며 리디렉션 도착 주소는 final_url로 구분합니다. 성공 시 access=page_read, verification=unverified 유지. 검색 요약을 본문으로 대체하지 않습니다.
- 출처 본문은 HTML/Markdown으로 실행하지 않는 일반 텍스트로 표시하며, 복사·다음 응답의 명시적 참고 자료 선택에 포함됩니다. 본문이 길면 기본 접힌 상태로 표시합니다.
- 본문과 실패 상태는 PostgreSQL에 저장합니다. 기록 복원에서는 URL 조회나 모델 호출을 재실행하지 않습니다. 자동 조회 본문은 서명 continuation에 포함하지 않습니다.

### 페이지 요약과 개별 진행 상태

출처 카드의 본문 영역 이름은 접근 방법과 관계없이 **페이지 요약**입니다. 내부 `access`(search_result/page_read)와 `verification=unverified`는 유지합니다. `reading`은 스피너와 ‘조회 중’, `summarizing`은 스피너와 ‘요약 중’, 요약이 있으면 ‘요약 완료’를 표시합니다. 실패를 완료된 요약으로 표시하지 않습니다.

`SourceContent`의 추가 필드:
- `summary`: 실제 페이지 본문만으로 작성한 한국어 요약. 기본 빈 문자열, 최대 2,000자.
- `summary_error`: null / summary_unavailable / summary_timeout / summary_budget_exhausted.
- `reading`은 빈 text와 null error_code, `summarizing`은 확보한 text·final_url 및 access=page_read를 가집니다.
- 요약 실패 시 본문 조회는 성공(read)으로 유지하고 원문임을 명시해 표시합니다. 실패한 본문에 검색 요약을 대신 넣지 않습니다. 자동 재시도는 없습니다.

`OPENAI_SOURCE_SUMMARY_MODEL`(기본 gpt-4.1-mini)로 페이지당 도구 없는 요약 요청 1회, 최대 700 출력 토큰입니다. `MAX_SOURCE_SUMMARIES`는 요청당 최대 호출 수(기본 5, 범위 0..50), `SOURCE_SUMMARY_TIMEOUT_SECONDS`는 호출별 제한(기본 15초)입니다. 이 호출은 일반 응답/정보 추출과 별도로 비용이 발생합니다. 조회와 요약 모두 `MAX_SOURCE_CONCURRENCY` 및 전체 작업의 남은 시간 안에서 실행하고 중지 시 취소합니다. 원래 답변·다른 출처와 실패를 격리합니다. 입력은 페이지 제목·확보한 본문·잘림 여부뿐이며 검색 요약이나 원래 답변을 요약 근거로 사용하지 않습니다. 저장·도구·자동 재시도는 비활성화합니다.

페이지 전송은 `MAX_PAGE_BYTES`(기본 1MB), gzip 압축 해제는 `MAX_PAGE_DECODED_BYTES`(기본 4MB, 범위 1KB..8MB)로 각각 제한합니다. 압축 폭탄이 전체 메모리에 풀리지 않도록 스트림을 제한하며 한도 도달 시 연결을 닫고 확보한 텍스트에 truncated=true를 표시합니다. HTML은 article, main, 일반 본문 순으로 선택하고 메뉴·스크립트·숨김 영역·반복 빈 줄을 제외한 뒤 문자 한도를 적용합니다. 안전한 DNS·연결 IP 고정·TLS·리디렉션 검증은 유지합니다.

요약/본문/실패 상태는 함께 PostgreSQL에 저장합니다. 복원 시 조회·요약을 재실행하지 않고 남아 있는 reading/summarizing 상태는 cancelled로 정리합니다. 이전 기록에 요약이 없으면 원문임을 명시하고 기존 데이터를 보존합니다.

### 페이지 요약 스트리밍

페이지 요약 모델 요청은 stream=true로 실행합니다. 공개 output_text 델타만 누적하고 기존 response_sources 스냅샷의 content.summary로 전송합니다. 첫 텍스트는 즉시, 후속 스냅샷은 최대 약 80ms 간격으로 묶어 전송하며 완료·실패 시 최종 상태를 확정합니다. 내부 추론과 원시 모델 이벤트는 전송하지 않습니다.

summarizing 상태에도 summary에 부분 텍스트가 들어올 수 있습니다. 클라이언트는 이를 이어 붙이지 않고 누적 스냅샷으로 교체해 중복을 방지합니다. 출처 카드는 받은 요약을 즉시 표시하면서 토끼 굴 파는 로더와 ‘요약 중’을 유지합니다. 조회 중에도 같은 로더를 사용합니다.

실패·취소 시 생성된 부분은 보존하고 일부 요약/중지 상태로 표시합니다. 공급자 스트림은 완료·실패·취소·시간 초과 시 닫습니다. 기존 2,000자·700 출력 토큰·동시 실행·호출 횟수·전체 시간 제한은 유지하며 기록 복원은 재요약하지 않습니다.

### 이미지 검색 카드

일반 에이전트의 image_search(query) 도구는 Wikimedia Commons 공개 이미지 검색 API를 사용합니다. 별도 키는 필요 없으며 일반 웹 전체 이미지 검색은 아닙니다. 이미지/사진/시각 자료 요청에 에이전트가 선택하고 키워드별 UI 분기는 없습니다. 기존 전체 도구 횟수·검색 횟수·시간 예산을 공유합니다.

실제 API 메타데이터의 파일 설명 페이지를 출처 URL/페이지 ID로 유지하고 ToolSource.image: {thumbnail_url: string} | null을 추가합니다. 썸네일은 HTTPS upload.wikimedia.org 또는 thumb.wikimedia.org, 원본 페이지는 HTTPS commons.wikimedia.org만 허용합니다. 빈 결과·실패는 샘플로 대체하지 않습니다.

카드는 이미지 미리보기, 제목, ‘원본 페이지’ 링크를 표시합니다. 이미지 출처는 자동 본문 조회·요약에서 제외합니다. 기존 노드 동작과 페이지별 중복 제거를 유지합니다. 미리보기 실패 시 실패 문구와 원본 링크를 유지합니다. 썸네일은 외부 CDN에서 지연 로딩하고 referrer를 보내지 않습니다. 기록 복원은 검색/요약을 재실행하지 않지만 이미지 표시에 CDN 요청은 필요할 수 있습니다.

API 참고: [Wikimedia Commons API](https://commons.wikimedia.org/wiki/Commons:API/MediaWiki), [Imageinfo](https://www.mediawiki.org/wiki/API:Imageinfo).

### 출처 요약 이후 관련 이미지

web_search는 별도 이미지 검색을 자동 실행하지 않습니다. 각 출처의 기존 본문 조회에서 og:image/twitter:image를 함께 수집하고, 페이지 요약이 성공적으로 완료된 뒤 HTTPS·공개 DNS 검사를 통과한 이미지가 있으면 ToolSource.page_image: {thumbnail_url: string} | null로 전달합니다. 추가 페이지 조회나 이미지 생성 호출 없이 기존 예산·취소·조회 제한을 유지합니다. 이미지가 없거나 요약/이미지 검사가 실패하면 이미지 노드를 만들지 않습니다.

프런트는 페이지 출처와 요약을 유지하고 `image_<출처 ID>`의 별도 이미지 노드를 출처 오른쪽에 생성합니다. `related_image` 관계는 source → image이며 라벨은 ‘관련 이미지’입니다. 이는 페이지 이미지 메타데이터에 따른 연결이며 내용 검증이나 인용을 의미하지 않습니다. 원본 페이지 링크와 제목을 유지하고, 동일 페이지의 이미지 노드는 중복 생성하지 않습니다. 기록 복원은 저장된 메타데이터만 사용하며 기존 노드 위치를 유지합니다.


## 공용 기록 API

심사용 공용 저장소이며 로그인·쿠키·소유자 구분이 없습니다. 모든 브라우저가 동일한 기록을 조회·수정·삭제합니다. 기록 복원은 아래 DB API만 사용하고 모델/검색/본문 조회/구조화/제목 생성 요청을 보내지 않습니다. 현재 화면은 자동 동기화하지 않으며 다른 화면의 변경은 새로고침으로 반영합니다.

| 메서드 | 경로 | 입력 | 결과 |
| --- | --- | --- | --- |
| GET | `/api/sessions?cursor=...` | cursor 생략 시 첫 페이지 | `{sessions: [{session, revision}], next_cursor?}` |
| PUT | `/api/sessions/{id}` | `{session, revision}` | `{revision}` |
| POST | `/api/sessions/{id}/import` | `session` 원본 | `{imported: boolean}` |
| DELETE | `/api/sessions/{id}?revision=N` | 마지막 조회/저장 revision | 204 |

`session`은 프런트 `Session`의 전체 스냅샷입니다. ID·질문·갱신 시각·공개 응답·출처·노드 위치·viewport·고정/접힘 상태·continuation·정보 그래프·작업 상태를 보존합니다. 서버 `HistorySession`, 프런트 `HistoryWrite/HistoryList/Revision/ImportResult`, `docs/openapi.json`을 함께 갱신합니다. 기존 페이지/예시 기록의 추가 필드도 보존하되 모델 요청 문맥으로 사용하지 않습니다.

- 생성은 revision 0, 수정은 마지막 서버 revision을 보냅니다. PostgreSQL의 조건부 쓰기가 성공하면 revision을 1 증가시킵니다. 충돌·다른 화면의 삭제는 409로 알리고 자동 덮어쓰지 않습니다. 현재 화면의 내용을 복사한 뒤 새로고침하여 다시 시작합니다.
- 삭제는 payload를 제거하고 ID와 버전만 남깁니다. 늦은 저장이나 이전 기록 재전송으로 삭제된 대화를 복원하지 않습니다. 삭제 실패 시 사이드바 기록을 유지합니다.
- 스트리밍 저장은 기존 500ms 주기를 유지하며 완료·취소·실패 시 즉시 저장을 요청합니다. 프런트 쓰기를 직렬화하여 먼저 시작된 저장이 나중 결과를 덮어쓰지 않습니다. 마지막 서버 저장 이후의 미전송 변경은 탭 종료/네트워크 장애 시 유실될 수 있습니다.
- 이전 API는 ID가 없는 경우만 삽입합니다. 존재하거나 삭제된 ID는 `imported: false`로 응답하며 현재 서버 기록을 덮어쓰지 않습니다. IndexedDB 원본에 이전 완료 표시만 남기며 원본은 삭제하지 않습니다. 실패한 항목은 표시하지 않아 다음 새로고침에서 재시도합니다. 이전 실패가 서버의 기존 기록 조회를 막지 않습니다.
- GET은 ID순으로 최대 20개와 응답 크기 약 4MB를 기준으로 페이지를 나눕니다. `next_cursor`가 있으면 다음 페이지를 조회합니다. 프런트가 전체 페이지를 수신한 뒤 `updatedAt` 역순으로 표시합니다. `Cache-Control: no-store`를 적용합니다.
- 기록 쓰기 제한은 `MAX_HISTORY_BYTES` 기본/상한 4,000,000바이트입니다. 기존 모델 요청 제한 `MAX_REQUEST_BYTES`와 별도이며 POST와 PUT 모두 본문 파싱 전에 검사합니다. 초과 시 413, 잘못된 필드/ID는 422, DB 미설정/연결 실패/미초기화는 503입니다.
- DB 장애 시 브라우저 저장이나 샘플로 대체하지 않습니다. 연결 문자열·SQL 매개변수·질문/응답 원문은 로그/오류 응답에 출력하지 않습니다.


### 서버 오류 화면

초기 기록 조회 실패는 공통 `ServerErrorPage`로 표시합니다. 기존 React Flow 격자 배경 위에 Rabbit Hole 브랜드 아이콘, `500 · SERVER ERROR`, “서버에 오류가 발생했어요”, “잠시 후 다시 시도해 주세요”와 다시 시도 버튼을 배치합니다. 이 상태에서는 사이드바·입력창·캔버스 도구를 숨기고 단축키 입력을 막습니다.

다시 시도는 페이지 전체를 새로고침하지 않고 기록 조회만 재실행합니다. 처리 중 버튼을 비활성화하며 중복 초기화 요청을 합칩니다. 실패하면 오류 화면을 유지하고 성공하면 원래 화면으로 복귀합니다. 응답 작성 중 부분 실패나 저장 실패는 기존 응답을 보존하는 안내 흐름을 유지합니다.
