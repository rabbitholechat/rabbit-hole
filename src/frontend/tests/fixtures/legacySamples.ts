import type { Graph, Session, Source } from '../../src/types'
import { layoutPages } from '../../src/lib/layout'
export type SampleKind = 'vector' | 'fold' | 'flight'
const content: Record<
  SampleKind,
  { query: string; titles: string[]; summaries: string[]; domains: string[] }
> = {
  vector: {
    query: '벡터 검색이란?',
    domains: ['개념 문서', '기술 블로그', '공식 문서', '구현 가이드', '비교 문서', '활용 사례'],
    titles: [
      '의미로 찾는 검색, 벡터 검색',
      '텍스트는 어떻게 벡터가 될까?',
      '벡터 유사도와 거리 측정',
      '나만의 의미 검색 구현하기',
      '키워드 검색과 하이브리드 검색',
      '추천 시스템에 벡터 검색 적용하기',
    ],
    summaries: [
      '단어가 달라도 의미가 가까운 정보를 찾습니다. 임베딩으로 문서를 표현하고 유사도를 비교합니다.',
      '임베딩은 텍스트의 의미를 숫자로 표현합니다. 가까운 의미는 벡터 공간에서도 가깝게 놓입니다.',
      '코사인 유사도와 거리 기반 검색의 차이를 살펴봅니다. 데이터와 목적에 맞는 지표가 필요합니다.',
      '문서 임베딩부터 유사한 결과 조회까지, 의미 검색 구현 과정을 살펴봅니다.',
      '정확한 단어 일치와 의미 기반 검색을 함께 활용하는 하이브리드 검색을 비교합니다.',
      '의미가 비슷한 콘텐츠를 연결해 추천에 활용합니다. 검색 기술이 실제 제품으로 이어집니다.',
    ],
  },
  fold: {
    query: '아이폰 폴드 가격과 출시일',
    domains: ['공식 발표 확인', '보도', '업계 전망', '가격 조건', '국내 일정', '제품 비교'],
    titles: [
      '공식 제품명과 발표 여부 확인',
      '보도와 공식 발표 구분하기',
      '예상 출시일은 확정 일정이 아닙니다',
      '가격의 통화·용량·세금 확인',
      '한국 출시 일정은 별도 확인',
      '폴더블 기기 비교의 기준',
    ],
    summaries: [
      '디자인 예시입니다. 실제 제품의 공식 발표 여부를 확인한 결과가 아닙니다.',
      '보도에서 인용한 출처와 공식 발표를 구분하는 카드 예시입니다.',
      '발표일, 사전 예약, 판매 시작일을 구분합니다. 날짜는 임의로 넣지 않습니다.',
      '공식 가격이 확보되지 않았습니다. 가상 금액을 표시하지 않습니다.',
      '국가별 출시 조건을 따로 확인하는 카드 예시입니다.',
      '같은 용량과 조건을 바탕으로 제품을 비교하는 디자인 예시입니다.',
    ],
  },
  flight: {
    query: '오사카 최저가 항공권',
    domains: ['항공사', '가격 비교', '예약 안내', '수하물 규정', '공항 안내', '여행 조건'],
    titles: [
      '오사카 항공편 · 실시간 조회 필요',
      '동일 일정 운임 비교하기',
      '예약 가능 여부 확인하기',
      '위탁 수하물 포함 여부',
      '출발 공항과 도착 공항',
      '왕복·인원·세금 조건 맞추기',
    ],
    summaries: [
      '실시간 운임 공급자는 연결되지 않았습니다. 실제 가격이나 예약 가능 여부를 나타내지 않습니다.',
      '날짜, 인원, 직항 여부가 같은 조건에서 운임을 비교합니다.',
      '가격을 확인했더라도 실제 예약 가능한 좌석은 달라질 수 있습니다.',
      '수하물 조건이 다른 항공권의 표시 가격을 그대로 비교하지 않습니다.',
      '출발지와 날짜는 사용자가 정합니다. 시안의 임의 일정은 사용하지 않습니다.',
      '세금과 추가 요금을 포함한 총액을 동일 조건에서 확인해야 합니다.',
    ],
  },
}
export function makeSample(kind: SampleKind): Session {
  const c = content[kind]
  const sources: Source[] = c.titles.map((title, i) => ({
    id: `sample_${kind}_${i}`,
    title,
    summary: c.summaries[i],
    domain: c.domains[i],
    url: '',
    original_url: '',
    excerpt: '',
    published_at: null,
    retrieved_at: '',
    read_status: 'summary',
    tag: c.domains[i],
  }))
  const graph: Graph = {
    clusters: [0, 1, 2].map((i) => ({
      id: `c${i}`,
      label: ['이해하기', '비교하기', '활용하기'][i],
      source_ids: sources.slice(i * 2, i * 2 + 2).map((s) => s.id),
    })),
    relations: [
      [0, 1],
      [0, 2],
      [2, 3],
      [2, 4],
      [4, 5],
    ].map(([a, b], i) => ({
      source: sources[a].id,
      target: sources[b].id,
      label: ['같은 주제', '개념 확장', '설명과 응용', '방식 비교', '활용 사례'][i],
      kind: 'same_topic',
      strength: 'core',
      explanation: '디자인 예시용 연결입니다. 실제 웹페이지를 분석한 관계가 아닙니다.',
      evidence: [a, b].map((index) => ({
        source_id: sources[index].id,
        quote: sources[index].summary,
        basis: 'summary',
      })),
    })),
  }
  return {
    id: crypto.randomUUID(),
    query: c.query,
    mode: 'sample',
    updatedAt: Date.now(),
    sources,
    graph,
    nodes: layoutPages(sources, [], graph),
    answer: {
      claims: [
        {
          text:
            kind === 'vector'
              ? '벡터 검색은 단어의 일치보다 **의미의 가까움**으로 정보를 찾는 방식입니다. 페이지를 비교하며 개념부터 활용까지 탐색해 보세요.'
              : '실제 검색이 아닌 화면 디자인 예시입니다. 가격과 출시일, 항공 운임은 실제 검색에서 확인해야 합니다.',
          evidence: [{ source_id: sources[0].id, quote: sources[0].summary, basis: 'summary' }],
        },
      ],
      limitation: '디자인 예시 · 모든 카드와 관계는 가상 데이터입니다.',
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    fitted: false,
    pinned: [],
    status: 'completed',
    failedParts: [],
  }
}
