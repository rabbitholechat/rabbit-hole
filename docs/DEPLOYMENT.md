# 실행과 배포

로컬 첫 실행, 개발 명령, 코드 구조와 모델 설정은 [개발 가이드](DEVELOPMENT.md)를 참고하세요.

## PostgreSQL 연결 준비 (로컬 / Vercel 공통)

1. `make install`로 psycopg를 포함한 잠금 의존성을 설치합니다.
2. `src/backend/.env`의 `DATABASE_URL`에 기존 PostgreSQL 연결 문자열을 입력합니다. 예시 형식은 `postgresql://USER:PASSWORD@HOST:5432/DB?sslmode=require`입니다. 실제 비밀번호는 URL 인코딩된 공급자 문자열을 사용합니다.
3. `make db-init`을 실행합니다. `rabbit_hole_sessions` 테이블과 조회 인덱스만 생성합니다. 반복 실행은 기존 기록을 유지합니다. 초기화 계정에는 테이블/인덱스 생성 권한이 필요합니다.
4. `make dev`로 로컬에서 연결합니다. 키가 없어도 DB 기록 조회는 모델 호출 없이 동작합니다. DB 연결 실패는 기록 영역에 오류를 표시합니다.

`.env`와 실제 연결 정보는 Git에 포함하지 않습니다. 로컬 파일을 Vercel에 업로드하지 않고 프로젝트 **Settings → Environment Variables**에 동일한 `DATABASE_URL`을 등록합니다. 서버 환경변수가 `.env`보다 우선합니다. 프런트는 `/api/sessions`만 호출하며 `VITE_*`에 DB 값을 넣지 않습니다.

Vercel 프로젝트의 **Storage → Create Database → Neon**에서 PostgreSQL을 생성하여 프로젝트에 연결할 수 있습니다. 기존 외부 PostgreSQL 연결도 가능합니다. [Postgres on Vercel](https://vercel.com/docs/postgres). 제공자가 다른 이름으로 연결 변수를 생성하면 해당 연결 문자열을 `DATABASE_URL`에도 지정하세요. 서버리스에는 제공자가 지원하는 pooled URL을 사용하고 TLS 옵션을 유지합니다. psycopg는 요청별 연결을 닫으며 자동 prepared statements를 끄므로 transaction pooling과 함께 사용할 수 있습니다. [Vercel Storage](https://vercel.com/docs/storage), [psycopg prepared statements](https://www.psycopg.org/psycopg3/docs/advanced/prepare.html).

배포 전 해당 DB를 가리키는 환경에서 `make db-init`을 한 번 실행합니다. Preview와 Production이 서로 다른 DB면 각각 실행합니다. 빌드나 콜드 스타트에서 DDL을 자동 실행하지 않습니다. 로컬·Preview·Production에 같은 URL을 지정하면 같은 공용 기록을 사용합니다. 새로운 DB를 사용할 때는 별도 초기화가 필요합니다. 로컬 PostgreSQL 기록이 새 DB로 자동 복사되지는 않으므로 기록까지 옮길 때는 별도 데이터 이전이 필요합니다.

`MAX_HISTORY_BYTES=4000000`을 기본으로 사용합니다. 기록 목록은 건수와 응답 바이트 기준으로 페이지를 나누며, Vercel Functions의 4.5MB 요청/응답 제한 아래로 유지하도록 구성합니다. [공식 제한](https://vercel.com/docs/functions/limitations). 단일 대화가 제한을 넘으면 저장 오류가 표시되며 새 대화로 이어가야 합니다.

로그인 없는 심사용 공용 기록입니다. 방문자는 공용 기록을 읽고 변경·삭제할 수 있습니다. 기존 브라우저 IndexedDB 기록도 첫 접속 시 공용 DB로 이전되며 원본은 브라우저에 보존됩니다.

### 로컬 Docker PostgreSQL

`compose.yaml`은 PostgreSQL 17과 영구 볼륨 `rabbit-hole_postgres_data`를 구성합니다. 외부 공개 없이 `127.0.0.1:5432`에만 바인딩합니다. 설정은 모두 `src/backend/.env`에서 읽습니다.

```dotenv
POSTGRES_USER=rabbit_hole
POSTGRES_PASSWORD=직접_생성한_비밀번호
POSTGRES_DB=rabbit_hole
POSTGRES_PORT=5432
DATABASE_URL=postgresql://rabbit_hole:직접_생성한_비밀번호@127.0.0.1:5432/rabbit_hole
```

```sh
make db-up      # 건강 상태 확인까지 대기
make db-init    # 스키마 생성
make dev
make db-status
make db-down    # 컨테이너/네트워크 종료, 데이터 볼륨 유지
```

처음 생성된 볼륨은 최초 비밀번호를 사용합니다. 기존 볼륨의 비밀번호를 변경하려면 `.env` 변경과 별도로 DB 역할의 비밀번호도 갱신해야 합니다. Vercel에서는 이 컨테이너를 실행하지 않고 Marketplace DB의 URL을 `DATABASE_URL`로 지정하면 됩니다. 코드 변경은 필요 없습니다.

## Vercel 정적 파일 + Python Functions

루트 `vercel.json`은 Vite 정적 빌드와 `api/index.py` ASGI Function을 한 origin에서 제공하도록 구성합니다. Python 의존성은 `src/backend/uv.lock`에서 내보낸 루트 `requirements.txt`, 버전은 루트 `.python-version`을 사용합니다.

1. 이 저장소 루트를 Vercel 프로젝트 루트로 연결합니다.
2. Node.js 22를 선택합니다. Python 3.13과 Function `maxDuration: 120` 지원 여부를 해당 프로젝트에서 확인합니다.
3. Vercel 서버 환경변수에 `.env.example`의 키/모델/예산과 고정 `SESSION_SIGNING_KEY`, PostgreSQL `DATABASE_URL`을 설정합니다. `.env` 파일 자체는 업로드하지 않습니다.
4. Install: `corepack pnpm install --frozen-lockfile`, Build: `corepack pnpm build`, Output: `src/frontend/dist`.
5. preview 배포에서 `/api/health`, 에이전트 응답 SSE, 후속 대화, 브라우저 abort를 확인한 뒤 production으로 승격합니다.
6. Vercel Firewall/WAF에 `/api/agent`의 글로벌 rate limit을 설정하고 OpenAI 계정 예산을 설정합니다.

`.env`의 비밀값과 모델명을 `VITE_*`로 옮기지 마세요. `SESSION_SIGNING_KEY`가 32자 미만이면 Vercel에서 애플리케이션 시작을 거부합니다. 서명키는 `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`로 로컬에서 생성할 수 있습니다. 배포 환경에 직접 입력하고 공유하지 마세요.

### 서버리스 수명과 취소

- 응답 생성과 SSE 수신은 **하나의 POST 요청**입니다. 별도 생성 요청 후 다른 인스턴스에서 EventSource를 여는 패턴을 사용하지 않습니다.
- SSE가 살아 있는 동안만 SDK 작업을 실행합니다. 백그라운드 작업 지속을 기대하지 않습니다.
- HTTP 연결 해제 시 ASGI 스트림을 취소하고 SDK 스트림·진행 중인 검색/페이지 읽기를 중단합니다. 도구 예산과 검색 모델 설정도 서버 환경변수로 관리합니다.
- 보조 DELETE 취소는 작업 토큰을 확인하지만 다른 인스턴스에서는 404일 수 있습니다. 기본 취소 수단은 클라이언트 AbortController입니다.
- 배포 프록시가 연결 종료를 늦게 전달하면 서버 중지가 늦어질 수 있습니다. 이미 공급자가 접수한 요청의 비용은 취소로 되돌릴 수 없고, 전체 90초 제한이 마지막 경계입니다.
- 요청 시작과 완료 시 서명 checkpoint를 보냅니다. 후속 대화/응답 재시도는 이 snapshot으로 다른 인스턴스에서도 복원됩니다.
- 서명 checkpoint는 7일간 유효합니다. 키 교체·만료 후에도 PostgreSQL 기록 열람은 가능하고, 후속 대화는 새 대화로 시작해야 합니다.

### 메모리 저장소와 제한

메모리 JobStore는 제어 토큰·시작 시각·취소 상태만 보관합니다. 기본 30분 TTL, 100개 상한, 다음 요청 때 만료 항목을 정리하고 꽉 차면 오래된 완료 작업부터 제거합니다. 서버 재시작으로 사라집니다. 세션 영속 저장은 모든 브라우저가 공유하는 PostgreSQL입니다. 새로고침하면 최신 기록을 조회합니다.

프로세스별 동시 작업과 직접 연결 IP별 제한은 전역 제한이 아닙니다. Vercel 프록시 환경의 공유 IP와 다중 인스턴스에서는 WAF 제한을 반드시 함께 구성해야 합니다. X-Forwarded-For를 무조건 신뢰하여 우회할 수 있게 만들지 않았습니다. 로그인 없는 공개 API의 비용 남용을 완전히 막는 인증 시스템은 범위 밖입니다.

## Docker / 컨테이너

```sh
make docker
docker run --rm --env-file src/backend/.env -p 8018:8018 rabbit-hole-backend
```

Dockerfile은 비밀 없는 uv lock 기반 Python 3.13 이미지, 비특권 사용자, 단일 Uvicorn worker를 사용합니다. 컨테이너는 내부 8018 포트이며 외부 매핑으로 변경합니다. 개발용 자동 reload는 사용하지 않습니다. 프런트엔드가 별도 서버에 있다면 `/api` reverse proxy를 연결하세요.

## 변경 시 재현성

```sh
uv lock --project src/backend
uv export --project src/backend --no-dev --no-hashes --no-emit-project --output-file requirements.txt
corepack pnpm install
make check
make e2e
```

`requirements.txt`는 수동 관리하지 않고 uv lock으로부터 다시 내보냅니다.

## 검증 범위

원격 Vercel 배포는 실행하지 않았습니다. PostgreSQL 저장소는 Docker의 임시 PostgreSQL 17에서 통합 테스트로 검증했습니다. 앱 Docker 이미지의 실제 배포는 별도 검증 대상입니다. 설정 파일과 ASGI import·로컬 개발 서버·정적 빌드를 검증했습니다. 실제 Vercel 라우팅과 disconnect 전파는 preview 배포에서 확인해야 합니다.

공식 참고: [Vercel Python runtime 및 streaming](https://vercel.com/docs/functions/runtimes/python), [vercel.json 설정](https://vercel.com/docs/project-configuration/vercel-json), [Agents SDK 실행과 구조화 출력](https://github.com/openai/openai-agents-python/tree/main/docs).


## PostgreSQL 검증

`make check`의 기본 테스트는 외부 DB와 유료 API 없이 실행합니다. 실제 PostgreSQL 검증은 별도 테스트 DB를 지정하여 명시적으로 실행합니다.

```sh
TEST_DATABASE_URL='postgresql://USER:PASSWORD@HOST/TEST_DB' make test-postgres
```

테스트는 무작위 전용 스키마를 만들고 그 스키마만 정리합니다. 운영 DB 대신 테스트 DB를 사용하세요. 앱 인스턴스 간 복원, JSONB 스냅샷 보존, 원자적 수정 충돌, 삭제 후 재생성 방지, 페이지 크기를 검증합니다.
