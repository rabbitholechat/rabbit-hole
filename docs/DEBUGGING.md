# 검색과 근거 디버깅

VS Code Python 디버거로 실행하면 자동 활성화됩니다. 디버거 없이 실행하려면 `src/backend/.env`에 `DEBUG_DIAGNOSTICS=true`를 설정하고 서버를 재시작하세요. 일반 실행의 기본값은 false입니다. Rabbit Hole 진단만 활성화하며 OpenAI SDK 전체 DEBUG 로깅은 활성화하지 않습니다.

터미널의 레벨 접두사 뒤에는 JSON 한 건이 나옵니다. 출처 목록은 DEBUG, 등록 제외는 WARNING, 근거/구조 검증 실패는 ERROR이며 TTY 터미널에서는 레벨에 색상이 표시됩니다. `request_id`로 요청을 구분합니다.

- `search_sources`: 각 검색 응답의 후보 수와 search_call 번호.
- `search_source`: 첫 검색을 포함한 각 응답에서 파싱한 출처 후보 전부. URL, 제목, 확보한 요약 포함. 전체 API 응답이나 내부 추론은 아님.
- `source_registered`: URL 안전성 검사와 수량 제한을 통과한 출처의 전체 Source 객체. 서버에서 생성한 id, summary, excerpt, 상태 포함.
- `source_rejected`: URL 검사/조회 시간 초과/수량 제한으로 등록하지 못한 이유와 후보 인덱스.
- `evidence_rejected`: source_id, basis, quote, 실패 이유, claim_index 또는 edge_index, evidence_index. 인덱스는 0부터 시작.
- `validation_rejected`: 근거 배열 누락 또는 그래프 구조 오류.

기본 모드에서는 출처 본문/인용을 출력하지 않습니다. DEBUG 모드에도 API 키, 서명 토큰, 전체 공급자 응답과 내부 추론은 출력하지 않습니다.

## 근거를 거부하는 조건

| reason | 조건 |
| --- | --- |
| unknown_source_id | 인용한 ID가 서버 레지스트리에 없음 |
| empty_quote | 인용 문구가 비어 있거나 공백뿐임 |
| ai_summary_as_excerpt | AI 검색 요약을 원문 발췌로 인용 |
| original_not_read | 원문을 읽지 않았는데 excerpt로 인용 |
| empty_source_text | 비교 대상 summary/excerpt가 비어 있음 |
| quote_not_found | 공백을 정규화해도 인용 문구가 비교 대상의 부분 문자열이 아님 |
| missing_evidence | 주장 또는 관계의 근거 배열이 비어 있음 |
| self_edge | 관계의 양 끝이 동일한 페이지 |
| unknown_endpoint | 관계의 양 끝 중 등록되지 않은 ID가 있음 |
| missing_endpoint_evidence | 양쪽 페이지 모두의 근거를 포함하지 않음 |
| duplicate_edge | 동일 페이지 쌍을 중복 연결 |
| unknown_page_type_source | 분류 대상이 등록되지 않은 페이지 |
| unknown_cluster_source | 그룹에 등록되지 않은 페이지 포함 |
| duplicate_cluster_source | 동일 페이지가 그룹에 중복 배정 |

모든 근거와 관계를 검사하여 발견한 오류를 모두 기록한 뒤, 하나라도 실패하면 기존처럼 해당 결과를 거부합니다. 사실 여부를 판정하는 검사가 아니라 출처/인용 일치 검사입니다. 번역, 대소문자 변경, 마크다운 변경도 불일치할 수 있습니다.

## 요청 한 건의 흐름

1. query + 새 request_id를 POST /api/search로 전송. 첫 검색에는 continuation 생략.
2. started → status(understanding): 도구 없는 모델이 질문과 기존 대화를 해석.
3. 조건 확인이 필요하면 clarification → checkpoint → done(awaiting_input). 사용자 답변과 continuation으로 다음 요청.
4. 바로 검색할 수 있으면 답변 에이전트가 search_web 호출 → status(searching). 함수 내부에서 OpenAI Responses web_search 호출. 검색은 예산 안에서 여러 번 가능.
5. OpenAI의 인용 문단/출처 URL 파싱 → URL 검사 → URL 기반 ID 등록. 이때 위 DEBUG 출처 로그 출력.
6. sources → checkpoint: 프런트는 페이지 카드 생성. checkpoint에는 서명된 중간 상태 포함.
7. 답변 에이전트 출력 → 로컬 출처/인용 검사. 통과한 비어 있지 않은 답변만 별도 모델로 의미 검증 → answer. 실패하면 part_error(answer).
8. 출처가 있으면 status(relating) → 관계 모델 → 로컬 관계/양쪽 근거 검사 → sources(분류 반영) → relationships. 실패하면 part_error(relationships).
9. 최종 checkpoint → done(completed/partial/failed). 출처가 있고 실패가 있으면 partial. 취소는 별도 경로.

사용자가 제공한 응답에서는 sources 10개 중 요약이 있는 출처가 2개였습니다. 나머지는 URL만 확보된 페이지입니다. 이 응답의 실제 실패 reason은 새 DEBUG 로그로 확인해야 하며, empty_source_text나 quote_not_found라고 추정해서 확정하면 안 됩니다.

예를 들어 다음은 **형식 설명용** 로그입니다. 실제 실패 재현 결과가 아닙니다.

```text
DEBUG: {"request_id":"…","event":"evidence_rejected","reason":"quote_not_found","evidence":{"source_id":"src_1ce4aae8dee34dcc90e0e32d","quote":"한국어로 다시 쓴 문구","basis":"summary"},"stage":"answer","claim_index":0,"evidence_index":0}
```

같은 source_id의 source_registered 로그에 있는 summary와 비교하면 무엇이 다른지 확인할 수 있습니다.

인용의 기준은 저장된 Markdown summary/excerpt입니다. 모델 지침에 Markdown·구두점·원어 보존을 명시하며 한국어 응답 지시는 quote에 적용하지 않습니다. 비교 시 마크다운을 제거하지 않습니다. 이는 웹페이지 원문을 새로 확보한다는 뜻이 아닙니다.
