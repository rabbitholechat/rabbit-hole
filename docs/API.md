# API / SSE 계약 v1

로그인 없음. 같은 origin `/api` 사용. WebSocket 불필요: 단방향 SSE + fetch AbortController.

- `GET /api/health`: 키 값 없이 구성 여부.
- `POST /api/search`: JSON query(1..2000), request_id(UUID), continuation(서버 서명 snapshot, 선택), focus_source_id(선택), retry_part(answer|relationships, 선택), flight(선택). 응답은 `text/event-stream`.
- `DELETE /api/jobs/{id}`: Bearer 작업 접근 토큰. 동일 프로세스에서 최선 노력 취소, 다른 인스턴스는 404. 주 취소 경로는 스트림 연결 종료.

SSE envelope: `{version:1, request_id, job_id, seq, type, data}`. `id: seq`, `event: type`, `data: JSON` + 빈 줄. 이벤트 순서: `started`, `status`, `sources`(여러 번), `answer`/`relationships`, `checkpoint`, `done`. 실패 부문은 `part_error`, 연결 유지 `ping`. `clarification`은 유료 호출 전에 조건 입력 요청 후 종료.

- started: access_token (메모리 전용), status
- status: stage(searching|reading|relating)
- sources: sources 배열 (페이지 단위 upsert)
- answer: claims 배열(text, evidence[source_id, quote, basis]), limitation
- relationships: relations 배열(source, target, kind, label, explanation, evidence, strength), clusters 배열(id, label, source_ids)
- part_error: part(search|answer|relationships), message (민감 정보 제거)
- checkpoint: continuation 서명 문자열. 서버가 확보한 출처/답변/관계/원 질문 보존. 브라우저 데이터를 신뢰해서 레지스트리에 넣지 않음.
- done: status(completed|partial|cancelled|failed), failed_parts

클라이언트는 활성 request_id만 적용. 새 화면/중지/기록 전환 시 세대 변경과 abort. 단절 시 받은 카드 보존, 자동 재호출 없음.

개별 출처: id(URL SHA256), original_url, url, title, domain, summary, excerpt, published_at(nullable), retrieved_at, read_status(summary|read|failed), tag. 가격 전용 추정 필드 없음.

모델 출력은 미등록 ID, 없는 노드, 근거 발췌 불일치 시 거부. 답변 핵심 주장에 별도 의미 검증 실행. SDK 내부 이벤트와 reasoning은 전송하지 않음.

Vercel: POST 한 응답의 수명 동안 작업 실행. 후속/부문 재시도는 서명 checkpoint로 다른 인스턴스에서도 복구. 완료 이력 DB는 IndexedDB이며 작업 메모리는 만료/재시작 시 소실. 글로벌 rate limit은 배포 WAF에서 추가 구성.
