# Card Gorilla Raw Data Dictionary

- API 엔드포인트: `https://api.card-gorilla.com:8080/v1/cards/{id}`
- 수집 일자: `2026-03-12` (Asia/Seoul)
- 탐색 ID 범위: `1~3000`
- 저장 경로: `data/raw/{id}.json`

## 주요 필드 설명

| 필드 | 설명 |
|---|---|
| `idx` | 카드 고유 ID (카드고릴라 내부 번호) |
| `name` | 카드 상품명 |
| `cate` | 카드 카테고리 (`"CRD"` 등) |
| `corp.name` | 카드사명 |
| `corp.logo_img.url` | 카드사 로고 이미지 URL |
| `brand` | 카드 브랜드 배열 (`Mastercard`, `VISA` 등) |
| `annual_fee_basic` | 연회비 (국내전용/해외겸용 텍스트) |
| `pre_month_money` | 전월실적 조건 (숫자, 단위: 원) |
| `c_type` | 카드 유형 (`"P"`=신용 추정, 체크카드는 다른 값일 수 있음) |
| `only_online` | 온라인 전용 여부 |
| `card_img.url` | 카드 이미지 URL |
| `top_benefit` | 주요 혜택 요약 태그 배열 |
| `key_benefit` | 혜택 상세 배열 (각 항목의 `info` 필드는 HTML raw 텍스트) |
| `search_benefit` | 혜택 카테고리 분류 배열 |
| `censorship_info` | 금융 관련 유의사항 HTML |
| `is_visible` | 사이트 노출 여부 |
| `is_discon` | 단종 여부 |
| `is_impend` | 출시 임박 여부 |

## c_type 샘플 관찰값

- `2026-03-12`에 ID `1~80` 샘플 조회 기준, `c_type` 값으로 `P`, `D`, `M`이 확인됨.
- 같은 샘플 구간의 `cate` 값은 모두 `CRD`였음.
- 체크카드(`cate`가 다른 값) 구간의 `c_type` 매핑은 본 수집 완료 후 추가 확인 필요.
