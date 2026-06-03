# evaluation

이 폴더는 정형화가 실제 추천 판단을 개선했는지 ground truth로 검증하는 평가 파이프라인입니다.

## Input / Output

| 구분 | 내용 |
| --- | --- |
| Input | `db/cafe_v3.db`, `evaluation_input.json`, `ground_truth.json` |
| Output | 실험 결과 XLSX/JSONL/summary, ground truth 비교 score workbook |

## 평가 축은 스키마에서 역산했다

평가지의 7개 feature 축은 임의로 만든 테스트 항목이 아니라, 정형화 스키마가 실제로 표현해야 하는 조건에서 역산했습니다.

| feature 축 | 연결되는 정형 필드/테이블 |
| --- | --- |
| 브랜드 매칭 | `brands`, `benefit_brands` |
| 횟수 제한 초과 | `frequency_limit` |
| 전월 실적 구간 | `min_spend`, `performance_tiers` |
| 제외 요건 해당 | `exclusions` |
| 할인율 이원화 | 혜택 row 분리 + `brands` |
| 최저 결제 금액 | `min_spend` |
| 할인 총액 한도 | `monthly_discount_limit`, `performance_tiers.monthly_limit` |

이 방식은 "모델이 대충 잘 맞는가"가 아니라, 정형화가 분리한 조건 차원이 실제 추천 판단에서 작동하는지를 확인하기 위한 설계입니다.

## 통제 설계

평가는 3개 페르소나, 24건 거래, 7개 카드로 구성되어 총 504건입니다. 3개 페르소나는 거래 목록을 바꾸지 않고 전월 실적만 다르게 두었습니다. 이렇게 하면 같은 거래라도 실적 구간에 따라 혜택 적용 여부와 월 한도가 어떻게 달라지는지 분리해 볼 수 있습니다.

카드 7장은 feature 조합이 최대한 겹치지 않도록 골랐습니다. 어떤 카드는 제외 조건을, 어떤 카드는 실적 구간을, 어떤 카드는 횟수/한도 조건을 강하게 드러내도록 구성해 한 종류의 쉬운 조건만 반복 평가하지 않게 했습니다.

## 수동 ground truth의 의미

정답 절감액은 각 거래-페르소나-카드 조합마다 수동 산출했습니다. 이 과정은 단순 채점표 작성이 아니라, 정형화 누락을 역으로 찾는 장치이기도 했습니다. 실제로 1차 평가에서 오답이 단일 카드의 제외 조건으로 집중되었고, 원인은 혜택 본문 밖 `유의사항`에 있던 조건이 정형 필드로 흡수되지 않은 것이었습니다. 이후 `structurization/`에서 유의사항 보강을 추가해 같은 평가 framework 위에서 효과를 다시 측정했습니다.

최종 결과는 Accuracy `0.98`, F1 Score `0.97`, MCC `0.95`입니다. 같은 LLM과 산술 코드를 쓰되 raw text만 입력한 baseline과 비교했을 때, 오류는 `23건 -> 12건`, 제외 조건 판별 오류는 `7건 -> 0건`으로 줄었습니다.

## Files

| 파일 | 역할 |
| --- | --- |
| `evaluation_input.json` | 3개 페르소나와 24건 평가 거래를 정의합니다. |
| `ground_truth.json` | 504건의 수동 산출 정답 절감액입니다. |
| `recommendation_testing_pipeline.js` | 정형화 DB를 입력으로 평가 시뮬레이션을 수행합니다. |
| `baseline_b_raw_text_pipeline.js` | raw text 입력 baseline을 같은 조건에서 실행합니다. |
| `score_simulation_outputs.js` | 실험 결과 XLSX를 ground truth와 비교해 score workbook을 만듭니다. |
| `sampled_cafe_cate.md`, `sampled_cafe_cate_test.md` | 평가 카드/혜택 표본을 설명하는 보조 문서입니다. |

## Run

```bash
node evaluation/recommendation_testing_pipeline.js --db db/cafe_v3.db
node evaluation/baseline_b_raw_text_pipeline.js --db db/cafe_v3.db
node evaluation/score_simulation_outputs.js --experiment-xlsx test_outputs/test_simulation/test_experiment_result.xlsx
```

LLM 호출에는 `GEMINI_API_KEY`가 필요합니다. `test_outputs/`는 생성 산출물이므로 Git에 올리지 않습니다.

