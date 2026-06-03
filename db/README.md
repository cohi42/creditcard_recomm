# db

이 폴더는 SQLite 데이터베이스 파일이 놓이는 위치입니다. DB 파일은 수집 원천과 LLM 정형화 결과를 포함해 크기가 크므로 `db/*.db`가 `.gitignore`에 들어 있습니다. GitHub에는 DB 자체보다 DB가 어떤 연구 단계를 대표하는지 설명하는 이 문서와 루트의 `ERD.md`를 남깁니다.

## Input / Output

| 구분 | 내용 |
| --- | --- |
| Input | `structurization/`에서 적재·정형화한 SQLite DB 파일 |
| Output | 추천, 평가, viewer가 참조하는 로컬 실험 DB 위치 |

## 데이터베이스의 의미

`cards.db`는 카드고릴라 raw JSON을 6개 논리 테이블로 적재한 기본 DB입니다. 카페 혜택 정형화와 유의사항 보강을 거치며 `cafe_v2.db`, `cafe_v3.db` 같은 실험 DB가 만들어졌습니다. 전시 제출 기준 최종 설명은 `cafe_v3.db` 계열 결과를 기준으로 맞추었습니다.

현재 로컬 DB의 핵심 규모는 다음과 같습니다.

| 항목 | 값 |
| --- | ---: |
| 카드 | 2,790 |
| 혜택 row | 16,619 |
| 카페 혜택 보유 카드 | 463 |
| 카페 혜택 row | 508 |
| 브랜드 사전 | 117 |
| 혜택-브랜드 연결 | 1,634 |
| 실적 구간 | 578 |
| 제외 조건 | 2,667 |

## 왜 SQLite인가

이 연구의 DB는 다중 사용자 운영 DB가 아니라, 크롤링 이후 고정된 실험 데이터를 반복적으로 정형화하고 평가하기 위한 로컬 저장소입니다. SQLite는 DB 파일 하나를 복사해 실험 버전을 분기할 수 있어, 스키마 설계 변경과 유의사항 보강 실험을 분리해 관리하기에 적합했습니다.

## 관련 파일

- `../ERD.md`: 전시 제출물에 맞춘 논리 ERD입니다.
- `../structurization/load_raw_to_sqlite.js`: raw JSON을 기본 SQLite 스키마로 적재합니다.
- `../structurization/structure_cafe_benefits_with_gemini.js`: 카페 혜택을 정형 필드와 종속 테이블로 채웁니다.
