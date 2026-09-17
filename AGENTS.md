# Rabbit Hole 작업 하네스

## 제품 불변 조건
- 전체 화면은 하나의 React Flow 캔버스. 페이지 카드가 중심이며 AI는 작은 보조 패널.
- 페이지 단위 출처 ID 유지. 도메인 병합, 가짜 출처/가격, 실패 시 샘플 대체 금지.
- 관계는 내용 근거가 필요. 검색 순서/내부 추론을 그래프로 노출하지 않음.
- 사용자의 위치와 viewport 유지. 기록 재개는 유료 호출 없이 IndexedDB에서 복원.

- 주제 키워드에 따른 전용 폼·조건 분기 금지. 추가 질문은 모델의 구조화 출력으로 공통 UI에 표시.

## 구조 및 인터페이스
- `src/frontend`: React + Vite + TypeScript. `src/backend`: FastAPI + Agents SDK.
- DB는 브라우저 IndexedDB. 외부 DB/로그인/소켓은 현 범위에 없음.
- API 계약은 `docs/API.md`. 변경 시 양쪽 타입과 계약 테스트 함께 갱신.
- 모든 설정과 비밀은 `src/backend/.env` 또는 배포 서버 환경변수. 프런트는 동일 origin `/api` 사용.
- 검색 도구는 OpenAI Responses API의 `web_search`만 사용. 공급자 출처·인용 URL만 서버에 등록. AI 검색 요약을 원문 발췌로 표시하지 않음.

## 개발과 검증
- `make install`, `make dev`, `make check`, `make e2e`를 표준 진입점으로 사용.
- 외부 API 없이 실행되는 테스트 기본. 실제 유료 통합 호출은 명시적 실행.
- 변경 전 git 상태 확인, 사용자 변경 보존. 로그에 키/내부 추론 기록 금지. 기본 모드에서 출처 본문 기록 금지. 사용자가 요청한 DEBUG_DIAGNOSTICS 또는 디버거 실행 시에만 출처 목록·요약/발췌·인용 문구·검증 실패 원인 출력 허용. 전체 공급자 응답/비밀/continuation 출력 금지.
- SDK 추적 기본 비활성화. 요청 예산, 취소, 안전한 링크 검증 우회 금지.

## 브랜치 / 커밋
- `main`: 검증된 통합 브랜치.
- `feat/<kebab-case>`, `fix/<kebab-case>`, `docs/<kebab-case>`, `test/<kebab-case>`.
- 기능 브랜치별 검증 후 main에 fast-forward 통합. 원격 push/배포는 별도 요청 범위.
- 커밋은 아래 형식, 제목과 항목은 명사형(~구성, ~구현, ~검증).

```text
feat: 변경 요약 구성

- 작업 내용 구현

# 영향받은 파일
- 경로

# 검증
- 실행한 검증과 결과
```
