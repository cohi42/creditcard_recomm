# final_viewer

이 폴더는 정형 혜택 DB와 소비 거래 이력을 결합해 카드별 예상 절감액을 계산하고, 그 결과를 Streamlit viewer로 보여주는 추천 파이프라인입니다.

## Input / Output

| 구분 | 내용 |
| --- | --- |
| Input | `db/cafe_v3.db`, `persona_transactions.json`의 6개 소비 패턴 |
| Output | `recommendation_outputs/final_recommendations.json`, `curated_recommendations.json`, Streamlit demo 화면 |

## LLM과 코드의 역할 분리

추천 단계에는 성격이 다른 두 연산이 섞여 있습니다.

- 문맥 판단: `스타벅스 신세계강남점`이 백화점 입점 매장인지, 거래명이 특정 브랜드/채널 조건에 해당하는지 판단
- 누적 산술: 월 횟수, 월 할인 한도, 건당 한도, 전월 실적 구간을 누적 계산

LLM은 첫 번째에 강하지만 두 번째를 안정적으로 누적하기에는 적합하지 않습니다. 그래서 `generate_recommendation_outputs.js`는 LLM에게 혜택 적용 여부와 문맥 판단을 맡기고, 할인액 cap, 횟수 소진, 실적 미달 같은 계산은 코드가 결정론적으로 처리합니다. 이 분리 덕분에 오답이 문맥 판단 문제인지 산술 집행 문제인지 추적할 수 있습니다.

## 왜 거래 1건 단위로 호출했는가

거래 24건을 한 번에 넘기면 API 비용과 호출 수는 줄어들지만, 어느 거래에서 어떤 조건 판단이 틀렸는지 해상도가 떨어집니다. 본 연구는 검증 가능성을 우선했기 때문에 거래 1건 단위 호출을 택했습니다. 한 거래, 한 카드, 한 페르소나 단위로 로그가 남아야 ground truth와 비교했을 때 오답 원인을 분리할 수 있습니다.

## 데모 페르소나

6개 페르소나는 카드 풀에서 추천 결과가 실제로 갈라지는 축을 자극하도록 설계했습니다. 스타벅스 다빈도형, 이디야 생활권형, 프리미엄 카페 모임형, 저가커피 초저가 다빈도형처럼 브랜드 집중도, 객단가, 전월 실적, 월 이용 횟수가 다르게 설정되어 같은 카드 풀에서도 1위 카드가 달라집니다.

전시 viewer는 전체 결과인 `final_recommendations.json`과, 표현 범위 밖 조건으로 과대평가가 식별된 카드를 제외한 `curated_recommendations.json`을 함께 사용합니다.

## Files

| 파일 | 역할 |
| --- | --- |
| `persona_transactions.json` | 6개 페르소나와 총 83건의 카페 거래 시나리오입니다. |
| `generate_recommendation_outputs.js` | 카드 x 페르소나 x 거래 조합의 추천 판단과 절감액 누적을 수행합니다. |
| `persona_analysis.py` | 추천 결과가 잘 분기되는 페르소나 후보를 찾기 위한 사전 분석 도구입니다. |
| `app.py` | Streamlit 기반 demo viewer입니다. |
| `persona_image/` | viewer에서 사용하는 페르소나 이미지입니다. |
| `requirements.txt` | viewer 실행에 필요한 Python 의존성입니다. |

## Run

```bash
node final_viewer/generate_recommendation_outputs.js --db db/cafe_v3.db
cd final_viewer
pip install -r requirements.txt
streamlit run app.py
```

LLM 호출에는 `GEMINI_API_KEY`가 필요합니다. `recommendation_outputs/`와 `persona_analysis_outputs/`는 생성 산출물이므로 Git에 올리지 않습니다.

