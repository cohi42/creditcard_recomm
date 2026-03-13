import json
import os
import random
import time

import requests
from requests.exceptions import ConnectionError, Timeout

API_BASE_URL = "https://api.card-gorilla.com:8080/v1/cards/"
START_ID = 1
END_ID = 3000
SAVE_DIR = os.path.join("data", "raw")
REQUEST_TIMEOUT = 10
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    )
}


def load_existing_ids(directory):
    existing_ids = set()
    if not os.path.isdir(directory):
        return existing_ids

    for filename in os.listdir(directory):
        if not filename.lower().endswith(".json"):
            continue

        card_id, _ = os.path.splitext(filename)
        if card_id.isdigit():
            existing_ids.add(int(card_id))

    return existing_ids


def main():
    os.makedirs(SAVE_DIR, exist_ok=True)

    total_targets = END_ID - START_ID + 1
    success_count = 0
    failure_count = 0
    skipped_count = 0
    failed_ids = []

    existing_ids = load_existing_ids(SAVE_DIR)
    if existing_ids:
        print(f"기존 파일 감지: {len(existing_ids)}개 (이어받기 모드)")

    for index, card_id in enumerate(range(START_ID, END_ID + 1), start=1):
        if card_id in existing_ids:
            skipped_count += 1
            print(
                f"[{index}/{total_targets}] ID {card_id} - 건너뜀 (이미 존재) "
                f"| 성공:{success_count} 실패:{failure_count} 건너뜀:{skipped_count}"
            )
            continue

        try:
            response = requests.get(
                API_BASE_URL + str(card_id),
                headers=HEADERS,
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                failure_count += 1
                failed_ids.append(card_id)
                print(
                    f"[{index}/{total_targets}] ID {card_id} - 없음 "
                    f"({response.status_code}) "
                    f"| 성공:{success_count} 실패:{failure_count} 건너뜀:{skipped_count}"
                )
                continue

            data = response.json()
            if not isinstance(data, dict) or "idx" not in data:
                failure_count += 1
                failed_ids.append(card_id)
                print(
                    f"[{index}/{total_targets}] ID {card_id} - 무효 응답 (idx 없음) "
                    f"| 성공:{success_count} 실패:{failure_count} 건너뜀:{skipped_count}"
                )
                continue

            output_path = os.path.join(SAVE_DIR, f"{card_id}.json")
            with open(output_path, "w", encoding="utf-8") as file:
                json.dump(data, file, ensure_ascii=False, indent=2)

            success_count += 1
            card_name = data.get("name", "이름 없음")
            print(
                f"[{index}/{total_targets}] ID {card_id} - 성공 (카드명: {card_name}) "
                f"| 성공:{success_count} 실패:{failure_count} 건너뜀:{skipped_count}"
            )

        except ConnectionError as error:
            failure_count += 1
            failed_ids.append(card_id)
            print(
                f"[{index}/{total_targets}] ID {card_id} - 연결 오류 ({error}) "
                f"| 성공:{success_count} 실패:{failure_count} 건너뜀:{skipped_count}"
            )
        except Timeout as error:
            failure_count += 1
            failed_ids.append(card_id)
            print(
                f"[{index}/{total_targets}] ID {card_id} - 타임아웃 ({error}) "
                f"| 성공:{success_count} 실패:{failure_count} 건너뜀:{skipped_count}"
            )
        except json.JSONDecodeError as error:
            failure_count += 1
            failed_ids.append(card_id)
            print(
                f"[{index}/{total_targets}] ID {card_id} - JSON 디코딩 오류 ({error}) "
                f"| 성공:{success_count} 실패:{failure_count} 건너뜀:{skipped_count}"
            )
        finally:
            time.sleep(random.uniform(1, 2))

    print("\n=== 수집 요약 ===")
    print(f"탐색 범위: ID {START_ID}~{END_ID}")
    print(f"전체 탐색 수: {total_targets}")
    print(f"성공 수: {success_count}")
    print(f"실패 수: {failure_count}")
    print(f"건너뜀 수(이미 존재): {skipped_count}")
    if failed_ids:
        print(f"실패 ID 목록: {failed_ids}")


if __name__ == "__main__":
    main()
