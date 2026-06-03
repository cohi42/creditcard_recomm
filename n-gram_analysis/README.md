# n-gram_analysis

이 폴더는 정형화 스키마를 임의로 정하지 않기 위해, 카드 혜택 텍스트에서 반복 조건을 귀납적으로 찾는 분석 파이프라인입니다. 카드 혜택은 카드사마다 표현이 달라서 처음부터 고정 필드를 선언하면 연구자가 예상한 조건만 보게 됩니다. 그래서 본 프로젝트는 정규식이나 직관적 분류보다 먼저 n-gram 빈도 분석으로 반복되는 조건 표현을 확인했습니다.

## Input / Output

| 구분 | 내용 |
| --- | --- |
| Input | `card_crawling/data/raw/*.json`의 `key_benefit.info` HTML 텍스트 |
| Output | `ngram_frequency_report.md`, 전체/카테고리별 bigram·trigram 빈도표 |

## 연구상 역할

n-gram 분석은 최종 추천 엔진이 아닙니다. 이 폴더의 목적은 정형화 스키마 설계의 근거를 만드는 것입니다. 전체 혜택 텍스트에서 `N만원 이상`, `월 N회`, `할인 제외`, `N% 청구할인` 같은 반복 표현을 뽑고, 카테고리별로 조건 구조가 얼마나 다른지 비교했습니다.

이 분석을 통해 카페 카테고리가 파일럿으로 선택되었습니다. 카페는 혜택 유형이 할인 중심으로 수렴하고, 브랜드/횟수/실적/제외 조건처럼 다른 카테고리에도 재활용 가능한 축을 포함했습니다. 반대로 쇼핑, 주유, 테마파크 등은 무이자 할부나 도메인 특화 조건이 강해 같은 스키마로 곧장 묶기 어렵다고 판단했습니다.

분석의 한계도 명확했습니다. n-gram은 "월 N회", "할인 제외"처럼 반복 표현을 드러내지만, 같은 쉼표가 가맹점 나열인지 조건 구분인지는 알 수 없습니다. 그래서 이 폴더는 스키마 후보를 찾는 단계이고, 의미 단위 추출은 `structurization/`의 LLM 정형화로 넘겼습니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `analyze_ngrams.py` | raw JSON의 혜택 HTML에서 텍스트를 추출해 bigram/trigram 빈도를 계산합니다. |
| `ngram_frequency_report.md` | 분석 결과 보고서입니다. 2,790개 JSON, 14,006개 혜택 항목, 298,507개 segment를 기반으로 작성되었습니다. |
| `requirements.txt` | `beautifulsoup4` 의존성을 명시합니다. |

## 재현

```bash
pip install -r n-gram_analysis/requirements.txt
python n-gram_analysis/analyze_ngrams.py
```

이 단계의 산출물은 이후 `structurization/`의 6개 테이블 및 9개 정형 필드가 임의로 만들어진 것이 아님을 보이는 근거입니다.
