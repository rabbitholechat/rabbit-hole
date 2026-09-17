# Rabbit Hole 브랜드 아이콘

기존 토끼 심볼을 그대로 내보낸 정사각형 아이콘입니다. 텍스트·배경·그림자 없이 검정과 흰색 두 버전을 제공합니다. PNG는 1024 × 1024 RGBA이며 여백과 투명 배경을 포함합니다. SVG는 크기 제한 없이 사용할 수 있습니다.

| 버전 | PNG | SVG | 용도 |
| --- | --- | --- | --- |
| 검정 `#000000` | [다운로드](../src/frontend/public/brand/rabbit-hole-icon-black.png) | [벡터](../src/frontend/public/brand/rabbit-hole-icon-black.svg) | 밝은 배경 |
| 흰색 `#FFFFFF` | [다운로드](../src/frontend/public/brand/rabbit-hole-icon-white.png) | [벡터](../src/frontend/public/brand/rabbit-hole-icon-white.svg) | 어두운 배경 |

웹 경로는 `/brand/rabbit-hole-icon-black.png`, `/brand/rabbit-hole-icon-white.png`입니다. SVG도 같은 이름으로 제공합니다. 흰색 아이콘은 투명 배경이므로 밝은 이미지 뷰어에서는 보이지 않을 수 있습니다.

기존 앱 심볼과 파비콘은 유지합니다. 원본은 `src/frontend/public/favicon.svg`이며, 새로운 AI 이미지 생성이나 브랜드 형태 변경 없이 색상만 고정해 Chromium으로 PNG를 렌더링했습니다.

재생성:

```sh
node src/frontend/scripts/export-brand-icons.mjs
```

프로젝트 개발 의존성과 Playwright Chromium이 설치되어 있어야 합니다. 재생성은 기존 내보내기 파일을 갱신합니다.
