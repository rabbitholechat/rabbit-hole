# 실행과 배포

## Vercel 정적 파일 + Python Functions

루트 `vercel.json`은 Vite 정적 빌드와 `api/index.py` ASGI Function을 한 origin에서 제공하도록 구성합니다. Python 의존성은 `src/backend/uv.lock`에서 내보낸 루트 `requirements.txt`, 버전은 루트 `.python-version`을 사용합니다.

1. 이 저장소 루트를 Vercel 프로젝트 루트로 연결합니다.
2. Node.js 22를 선택합니다. Python 3.13과 Function `maxDuration: 120` 지원 여부를 해당 프로젝트에서 확인합니다.
3. Vercel 서버 환경변수에 `.env.example`의 키/모델/예산과 고정 `SESSION_SIGNING_KEY`를 설정합니다. `.env` 파일 자체는 업로드하지 않습니다.
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
- 서명 checkpoint는 7일간 유효합니다. 키 교체·만료 후에도 IndexedDB 기록 열람은 가능하고, 후속 대화는 새 대화로 시작해야 합니다.

### 메모리 저장소와 제한

메모리 JobStore는 제어 토큰·시작 시각·취소 상태만 보관합니다. 기본 30분 TTL, 100개 상한, 다음 요청 때 만료 항목을 정리하고 꽉 차면 오래된 완료 작업부터 제거합니다. 서버 재시작으로 사라집니다. 세션 영속 저장은 사용자의 IndexedDB입니다.

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

이번 환경에는 Vercel 프로젝트 연결과 인증된 CLI가 없어서 외부 배포를 실행하지 않았습니다. Docker CLI는 있으나 Docker 데몬이 실행되지 않아 실제 이미지 빌드·컨테이너 부팅은 확인하지 못했습니다. 설정 파일과 ASGI import·로컬 개발 서버·정적 빌드를 검증했습니다. 실제 Vercel 라우팅과 disconnect 전파는 preview 배포에서 확인해야 합니다.

공식 참고: [Vercel Python runtime 및 streaming](https://vercel.com/docs/functions/runtimes/python), [vercel.json 설정](https://vercel.com/docs/project-configuration/vercel-json), [Agents SDK 실행과 구조화 출력](https://github.com/openai/openai-agents-python/tree/main/docs).
