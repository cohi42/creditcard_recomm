```mermaid
erDiagram
    CARDS {
        bigint card_id PK "JSON card idx"
        varchar card_name
        varchar card_company
        varchar annual_fee
        boolean is_credit
        text raw_json
    }

    BENEFITS {
        bigint benefit_id PK
        bigint card_id FK
        varchar category
        decimal discount_rate
        int discount_amount
        varchar discount_type
        varchar frequency_limit
        int per_transaction_limit
        int monthly_discount_limit
        int min_spend
        text raw_info
    }

    BRANDS {
        bigint brand_id PK
        varchar brand_name UK
    }

    BENEFIT_BRANDS {
        bigint benefit_id FK
        bigint brand_id FK
    }

    PERFORMANCE_TIERS {
        bigint tier_id PK
        bigint benefit_id FK
        int min_spend
        int max_spend
        int monthly_limit
    }

    EXCLUSIONS {
        bigint exclusion_id PK
        bigint benefit_id FK
        varchar exclusion_type
    }

    CARDS ||--o{ BENEFITS : "1:N"
    BENEFITS ||--o{ BENEFIT_BRANDS : "1:N"
    BRANDS ||--o{ BENEFIT_BRANDS : "1:N"
    BENEFITS ||--o{ PERFORMANCE_TIERS : "1:N"
    BENEFITS ||--o{ EXCLUSIONS : "1:N"
```

```mermaid
erDiagram
    V_CARD_NOTICE {
        bigint card_id PK
        text notice_text "all 유의사항 merged"
        int notice_count "유의사항 row count per card"
    }

    V_BENEFITS_FOR_STRUCTURING {
        bigint benefit_id PK
        bigint card_id
        varchar category
        text raw_info "benefit original HTML"
        text common_notes "from V_CARD_NOTICE"
        int common_note_count
        text effective_info "benefit block only"
    }

    V_BENEFITS_FOR_RECOMMENDATION {
        bigint benefit_id PK
        bigint card_id
        varchar category
        text raw_info
        text common_notes
        int common_note_count
        text effective_info "benefit + common notes"
    }

    V_BENEFITS_FOR_MODEL {
        bigint benefit_id PK
        bigint card_id
        varchar category
        text raw_info
        text common_notes
        int common_note_count
        text effective_info
    }

    BENEFITS ||--o{ V_CARD_NOTICE : "category='유의사항' source"
    BENEFITS ||--o{ V_BENEFITS_FOR_STRUCTURING : "category!='유의사항' source"
    V_CARD_NOTICE ||--o{ V_BENEFITS_FOR_STRUCTURING : "LEFT JOIN by card_id"
    V_BENEFITS_FOR_STRUCTURING ||--|| V_BENEFITS_FOR_RECOMMENDATION : "context merge"
    V_BENEFITS_FOR_RECOMMENDATION ||--|| V_BENEFITS_FOR_MODEL : "compatibility alias"
```

```mermaid
flowchart LR
    A["benefits(category='유의사항')"] --> B["v_card_notice<br/>ordered by benefit_id"]
    C["benefits(category!='유의사항')"] --> D["v_benefits_for_structuring"]
    B --> D
    D --> E["정형화 파이프라인<br/>structure_cafe_benefits_with_gemini.js"]
    D --> F["v_benefits_for_recommendation"]
    F --> G["추천/적용판단 파이프라인"]
```

## 고려점 반영 요약
1. 유의사항 2건 이상 카드 대응:
- `v_card_notice`에서 `benefit_id` 순으로 `GROUP_CONCAT ... OVER (PARTITION BY card_id ORDER BY benefit_id)`를 사용해 결합 순서를 고정했습니다.
- 유의사항 개수 확인을 위해 `notice_count`를 함께 노출합니다.
- 다중 유의사항 구분을 위해 결합 구분자 `[[COMMON_NOTE_SPLIT]]`를 사용합니다.

2. 경계 명확화:
- `effective_info`에는 `[혜택 원문 시작]...[혜택 원문 끝]` / `[공통 유의사항 시작]...[공통 유의사항 끝]` 경계 태그를 사용합니다.
- 동시에 `common_notes`를 별도 컬럼으로 노출해, 모델 프롬프트에서 원문과 공통조건을 분리 참조할 수 있게 했습니다.

3. 용도 분리:
- 정형화(benefit 필드 추출): `v_benefits_for_structuring` 사용
- 추천/적용 판단(공통조건 반영): `v_benefits_for_recommendation` 또는 `v_benefits_for_model` 사용
