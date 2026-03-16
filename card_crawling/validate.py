import json
import os
from collections import Counter

RAW_DIR = os.path.join("data", "raw")
TARGET_RANGE_TOTAL = 3000


def normalize_label(value):
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "(null)"
    text = str(value).strip()
    return text if text else "(empty)"


def sort_json_filenames(filenames):
    def key_fn(name):
        stem = os.path.splitext(name)[0]
        if stem.isdigit():
            return (0, int(stem))
        return (1, stem)

    return sorted(filenames, key=key_fn)


def load_cards(raw_dir):
    cards = []
    invalid_files = []

    if not os.path.isdir(raw_dir):
        return cards, invalid_files

    filenames = [name for name in os.listdir(raw_dir) if name.lower().endswith(".json")]
    for filename in sort_json_filenames(filenames):
        path = os.path.join(raw_dir, filename)
        try:
            with open(path, "r", encoding="utf-8") as file:
                data = json.load(file)
            if isinstance(data, dict):
                cards.append(data)
            else:
                invalid_files.append(filename)
        except (OSError, json.JSONDecodeError):
            invalid_files.append(filename)

    return cards, invalid_files


def add_bool_counter_lines(lines, title, counter):
    lines.append(title)
    lines.append(f"true: {counter.get(True, 0)}건")
    lines.append(f"false: {counter.get(False, 0)}건")

    others = [(key, count) for key, count in counter.items() if key not in (True, False)]
    for key, count in sorted(others, key=lambda item: (-item[1], normalize_label(item[0]))):
        lines.append(f"{normalize_label(key)}: {count}건")
    lines.append("")


def main():
    cards, invalid_files = load_cards(RAW_DIR)

    c_type_counter = Counter()
    is_visible_counter = Counter()
    is_discon_counter = Counter()
    corp_counter = Counter()
    cate_counter = Counter()
    benefit_counter = Counter()

    c_type_samples = {}
    discon_true_samples = []
    visible_false_samples = []

    for card in cards:
        card_id = card.get("idx")
        card_name = card.get("name", "(이름 없음)")
        card_sample = (card_id, card_name)

        c_type_value = normalize_label(card.get("c_type"))
        c_type_counter[c_type_value] += 1
        c_type_samples.setdefault(c_type_value, [])
        if len(c_type_samples[c_type_value]) < 2:
            c_type_samples[c_type_value].append(card_sample)

        is_visible_value = card.get("is_visible")
        is_visible_counter[is_visible_value] += 1
        if is_visible_value is False and len(visible_false_samples) < 2:
            visible_false_samples.append(card_sample)

        is_discon_value = card.get("is_discon")
        is_discon_counter[is_discon_value] += 1
        if is_discon_value is True and len(discon_true_samples) < 2:
            discon_true_samples.append(card_sample)

        corp = card.get("corp")
        corp_name = normalize_label(corp.get("name")) if isinstance(corp, dict) else "(null)"
        corp_counter[corp_name] += 1

        cate_counter[normalize_label(card.get("cate"))] += 1

        search_benefit = card.get("search_benefit")
        if isinstance(search_benefit, list):
            for benefit in search_benefit:
                if isinstance(benefit, dict):
                    benefit_counter[normalize_label(benefit.get("title"))] += 1

    lines = []
    lines.append("=== 수집 데이터 기본 통계 ===")
    lines.append(f"총 수집 건수: {len(cards)}건")
    lines.append(f"탐색 범위 대비 수집률: {len(cards)}/{TARGET_RANGE_TOTAL}")
    if invalid_files:
        lines.append(f"파싱 실패 파일 수: {len(invalid_files)}건")
    lines.append("")

    lines.append("=== c_type 분포 ===")
    for value, count in sorted(c_type_counter.items(), key=lambda item: (-item[1], item[0])):
        lines.append(f"{value}: {count}건")
    lines.append("")

    add_bool_counter_lines(lines, "=== is_visible 분포 ===", is_visible_counter)
    add_bool_counter_lines(lines, "=== is_discon 분포 ===", is_discon_counter)

    lines.append("=== 카드사 분포 (상위 10) ===")
    corp_sorted = corp_counter.most_common()
    for rank, (corp_name, count) in enumerate(corp_sorted[:10], start=1):
        lines.append(f"{rank}. {corp_name}: {count}건")
    if len(corp_sorted) > 10:
        etc_company_count = len(corp_sorted) - 10
        etc_card_count = sum(count for _, count in corp_sorted[10:])
        lines.append(f"기타 {etc_company_count}개사: {etc_card_count}건")
    lines.append("")

    lines.append("=== cate 분포 ===")
    for value, count in sorted(cate_counter.items(), key=lambda item: (-item[1], item[0])):
        lines.append(f"{value}: {count}건")
    lines.append("")

    lines.append("=== 혜택 카테고리 분포 ===")
    for rank, (title, count) in enumerate(benefit_counter.most_common(), start=1):
        lines.append(f"{rank}. {title}: {count}건")
    lines.append("")

    lines.append("=== 사이트 대조 검증용 샘플 ===")
    for c_type_value in sorted(c_type_counter.keys()):
        samples = c_type_samples.get(c_type_value, [])[:2]
        for sample_id, sample_name in samples:
            lines.append(f"[c_type='{c_type_value}'] ID {sample_id}, 카드명: {sample_name}")

    if discon_true_samples:
        for sample_id, sample_name in discon_true_samples[:2]:
            lines.append(f"[is_discon=true] ID {sample_id}, 카드명: {sample_name}")
    else:
        lines.append("[is_discon=true] 샘플 없음")

    if visible_false_samples:
        for sample_id, sample_name in visible_false_samples[:2]:
            lines.append(f"[is_visible=false] ID {sample_id}, 카드명: {sample_name}")
    else:
        lines.append("[is_visible=false] 샘플 없음")

    print("\n".join(lines))


if __name__ == "__main__":
    main()
