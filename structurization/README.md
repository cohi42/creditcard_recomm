# structurization

이 폴더는 카드 혜택 원문을 추천 엔진이 계산할 수 있는 정형 혜택 DB로 바꾸는 파이프라인입니다.

## Input / Output

| 구분 | 내용 |
| --- | --- |
| Input | `card_crawling/data/raw/*.json`의 `key_benefit.info` HTML 원문, 카드별 `유의사항`/`기타` 공통 조건 |
| Output | `db/cards.db`, `db/cafe_v3.db` 계열 SQLite DB와 6개 테이블의 정형 혜택 데이터 |

## 왜 raw text를 그대로 추천 LLM에 넘기지 않았는가

raw text만으로도 LLM은 명시적인 할인율이나 횟수 조건을 꽤 잘 읽습니다. 그러나 추천 문제에서는 "조건을 읽는 것"과 "카드 간 비교 가능한 정책으로 집행하는 것"이 다릅니다. 예를 들어 같은 문장 안에 브랜드, 할인율, 월 횟수, 건당 한도, 백화점 입점 매장 제외가 섞이면, 추천 단계에서 어떤 조건이 어느 브랜드에 걸리는지 매번 다시 추론해야 합니다.

그래서 이 파이프라인은 혜택 원문을 `discount_rate`, `discount_type`, `monthly_discount_limit`, `brands`, `performance_tiers`, `exclusions`처럼 비교 가능한 필드로 먼저 분리합니다. 정형화를 통해 LLM이 판단해야 할 문맥과 코드가 계산해야 할 산술을 나누고자합니다.

## 왜 혜택 정보와 조건 정보를 분리했는가

카페 혜택에는 단일 행으로 담기 어려운 구조가 반복됩니다.

- 전월 실적 구간에 따라 월 할인 한도가 달라지는 다단계 실적 구조
- 스타벅스는 50%, 일반 커피전문점은 30%처럼 가맹점별 할인율이 갈리는 이원화 구조
- 백화점 입점 매장, 모바일 주문, 상품권 구매처럼 혜택 적용을 막는 제외 요건

이 구조를 하나의 `benefits` 행에 배열이나 긴 텍스트로 밀어 넣으면 1NF Atomicity가 깨집니다. 한 셀에 여러 실적 구간이나 여러 브랜드별 조건이 들어가면 추천 단계에서 다시 파싱해야 하고, ground truth와의 오차 원인도 추적하기 어렵습니다. 그래서 `benefits`를 중심으로 `brands`, `benefit_brands`, `performance_tiers`, `exclusions`를 분리했습니다.

## 왜 n-gram 뒤에 LLM이 필요한가

필드 후보는 `n-gram_analysis/`에서 귀납적으로 찾았습니다. 하지만 n-gram과 규칙 분할은 의미 단위 분할까지 해결하지 못했습니다. 같은 쉼표라도 `아웃백, 카페마마스 20% 할인`에서는 가맹점 나열이고, `월 2회, 1회 10만원`에서는 조건 구분입니다. 표면 구분자는 같지만 역할이 달라서 문맥 이해가 필요합니다.

따라서 Gemini 2.5 Flash는 의미 단위 추출을 맡고, 이 폴더의 코드는 JSON 파싱, 단위 정규화, 중복 제거, checkpoint/resume, SQLite 적재를 맡습니다.

## Files

| 파일 | 역할 |
| --- | --- |
| `load_raw_to_sqlite.js` | raw JSON을 기본 SQLite 스키마로 적재합니다. |
| `structure_cafe_benefits_with_gemini.js` | 카페 혜택 본문을 Gemini로 정형화합니다. |
| `enrich_cafe_benefits_with_notices.js` | 본문 밖 `유의사항`에 흩어진 공통 조건을 정형 필드로 보강합니다. |
| `enrich_cafe_benefits_with_etc.js` | `기타` 카테고리 공통 조건을 같은 방식으로 보강하는 래퍼입니다. |
| `export_notice_enrichment_delta.js` | 유의사항 보강으로 새로 채워진 값만 JSON으로 내보냅니다. |

## Run

```bash
node structurization/load_raw_to_sqlite.js
node structurization/structure_cafe_benefits_with_gemini.js --db db/cards.db
node structurization/enrich_cafe_benefits_with_notices.js --source-db db/cards.db --output-db db/cafe_v3.db --overwrite-output
```

LLM 호출에는 `GEMINI_API_KEY`가 필요합니다.

