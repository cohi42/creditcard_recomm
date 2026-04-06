from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

try:
    from bs4 import BeautifulSoup
except ImportError as exc:
    raise SystemExit(
        "Missing dependency: beautifulsoup4. "
        "Install with `pip install -r n-gram_analysis/requirements.txt`."
    ) from exc


DEFAULT_RAW_DIR = Path(__file__).resolve().parents[1] / "card_crawling" / "data" / "raw"
DEFAULT_OUTPUT_MD = Path(__file__).resolve().parent / "ngram_frequency_report.md"
DEFAULT_EXCLUDE_CATEGORY = "유의사항"

BULLET_PREFIX_RE = re.compile(r"^\s*[-·•]\s*")
DIGIT_COMMA_RE = re.compile(r"(?<=\d),(?=\d)")
RANGE_RE = re.compile(r"\d+(?:\.\d+)?\s*~\s*\d+(?:\.\d+)?")
DECIMAL_RE = re.compile(r"\d+\.\d+")
DIGIT_RE = re.compile(r"\d+")
PAREN_COLON_RE = re.compile(r"[():]")
MULTI_SPACE_RE = re.compile(r"\s+")


@dataclass
class PipelineStats:
    total_files: int = 0
    invalid_json_files: int = 0
    benefit_items_total: int = 0
    benefit_items_empty_info: int = 0
    benefit_items_excluded_category: int = 0
    benefit_items_used: int = 0
    p_lines_total: int = 0
    p_lines_filtered_short: int = 0
    p_lines_filtered_froala: int = 0
    segments_total: int = 0
    token_lists_with_bigram: int = 0
    token_lists_with_trigram: int = 0


def sort_json_paths(paths):
    def key_fn(path):
        stem = path.stem
        if stem.isdigit():
            return (0, int(stem))
        return (1, stem)

    return sorted(paths, key=key_fn)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run bigram/trigram frequency analysis on card benefit info text."
    )
    parser.add_argument(
        "--raw-dir",
        type=Path,
        default=DEFAULT_RAW_DIR,
        help="Directory that contains raw card JSON files.",
    )
    parser.add_argument(
        "--output-md",
        type=Path,
        default=DEFAULT_OUTPUT_MD,
        help="Output markdown report path.",
    )
    parser.add_argument(
        "--overall-top",
        type=int,
        default=50,
        help="Top-k count for overall bigram/trigram tables.",
    )
    parser.add_argument(
        "--category-top",
        type=int,
        default=15,
        help="Top-k count for each category bigram/trigram table.",
    )
    parser.add_argument(
        "--exclude-category",
        default=DEFAULT_EXCLUDE_CATEGORY,
        help="Category name to exclude from analysis.",
    )
    return parser.parse_args()


def iter_filtered_benefits(raw_dir, exclude_category, stats):
    json_paths = sort_json_paths(raw_dir.glob("*.json"))
    stats.total_files = len(json_paths)

    for json_path in json_paths:
        try:
            with json_path.open("r", encoding="utf-8") as file:
                data = json.load(file)
        except (OSError, json.JSONDecodeError):
            stats.invalid_json_files += 1
            continue

        key_benefit = data.get("key_benefit")
        if not isinstance(key_benefit, list):
            continue

        for benefit in key_benefit:
            if not isinstance(benefit, dict):
                continue

            stats.benefit_items_total += 1

            cate = benefit.get("cate")
            cate_name = ""
            if isinstance(cate, dict):
                cate_name = str(cate.get("name", "")).strip()
            if not cate_name:
                cate_name = "(미분류)"

            info = benefit.get("info")
            if not isinstance(info, str) or not info.strip():
                stats.benefit_items_empty_info += 1
                continue

            if cate_name == exclude_category:
                stats.benefit_items_excluded_category += 1
                continue

            stats.benefit_items_used += 1
            yield cate_name, info


def extract_p_lines(info_html, stats):
    soup = BeautifulSoup(info_html, "html.parser")
    lines = []

    for p_tag in soup.find_all("p"):
        text = p_tag.get_text(" ", strip=True).replace("\xa0", " ").strip()
        if not text:
            continue

        text = BULLET_PREFIX_RE.sub("", text).strip()

        if len(text) <= 3:
            stats.p_lines_filtered_short += 1
            continue

        if "Froala" in text:
            stats.p_lines_filtered_froala += 1
            continue

        lines.append(text)

    stats.p_lines_total += len(lines)
    return lines


def normalize_numbers(text):
    text = DIGIT_COMMA_RE.sub("", text)
    text = RANGE_RE.sub("N~N", text)
    text = DECIMAL_RE.sub("N", text)
    text = DIGIT_RE.sub("N", text)
    return text


def tokenize_line(line):
    normalized = normalize_numbers(line)
    segments = [segment.strip() for segment in normalized.split(",")]

    token_lists = []
    for segment in segments:
        if not segment:
            continue
        segment = PAREN_COLON_RE.sub(" ", segment)
        segment = MULTI_SPACE_RE.sub(" ", segment).strip()
        if not segment:
            continue
        token_lists.append(segment.split(" "))

    return token_lists


def iter_ngrams(tokens, n):
    for index in range(0, len(tokens) - n + 1):
        yield tuple(tokens[index : index + n])


def analyze(raw_dir, exclude_category, stats):
    overall = {2: Counter(), 3: Counter()}
    category_counters = defaultdict(lambda: {2: Counter(), 3: Counter()})
    category_segment_counts = Counter()

    for cate_name, info_html in iter_filtered_benefits(raw_dir, exclude_category, stats):
        lines = extract_p_lines(info_html, stats)
        for line in lines:
            token_lists = tokenize_line(line)
            stats.segments_total += len(token_lists)

            for tokens in token_lists:
                category_segment_counts[cate_name] += 1

                if len(tokens) >= 2:
                    stats.token_lists_with_bigram += 1
                    bigrams = iter_ngrams(tokens, 2)
                    overall[2].update(bigrams)
                    category_counters[cate_name][2].update(iter_ngrams(tokens, 2))

                if len(tokens) >= 3:
                    stats.token_lists_with_trigram += 1
                    trigrams = iter_ngrams(tokens, 3)
                    overall[3].update(trigrams)
                    category_counters[cate_name][3].update(iter_ngrams(tokens, 3))

    return overall, category_counters, category_segment_counts


def ngram_to_text(ngram):
    return " ".join(ngram)


def print_counter(counter, top_k):
    if not counter:
        print("  (no data)")
        return

    for rank, (ngram, freq) in enumerate(counter.most_common(top_k), start=1):
        print(f"  {rank:>2}. {ngram_to_text(ngram)}\t{freq}")


def print_console_report(
    stats,
    overall,
    category_counters,
    category_segment_counts,
    overall_top,
    category_top,
):
    print("=== N-gram Frequency Analysis ===")
    print(f"- JSON files scanned: {stats.total_files}")
    print(f"- Invalid JSON files: {stats.invalid_json_files}")
    print(f"- key_benefit items total: {stats.benefit_items_total}")
    print(f"- Filtered out (empty info): {stats.benefit_items_empty_info}")
    print(f"- Filtered out (excluded category): {stats.benefit_items_excluded_category}")
    print(f"- key_benefit items used: {stats.benefit_items_used}")
    print(f"- <p> lines used: {stats.p_lines_total}")
    print(f"- Lines dropped (<=3 chars): {stats.p_lines_filtered_short}")
    print(f"- Lines dropped (contains Froala): {stats.p_lines_filtered_froala}")
    print(f"- Segments used: {stats.segments_total}")
    print(f"- Token lists with bigram: {stats.token_lists_with_bigram}")
    print(f"- Token lists with trigram: {stats.token_lists_with_trigram}")

    print(f"\n=== Overall Bigram Top {overall_top} ===")
    print_counter(overall[2], overall_top)

    print(f"\n=== Overall Trigram Top {overall_top} ===")
    print_counter(overall[3], overall_top)

    category_order = sorted(
        category_segment_counts.items(),
        key=lambda item: (-item[1], item[0]),
    )

    for cate_name, segment_count in category_order:
        print(
            f"\n=== Category: {cate_name} "
            f"(segments={segment_count}) Bigram Top {category_top} ==="
        )
        print_counter(category_counters[cate_name][2], category_top)

        print(
            f"\n=== Category: {cate_name} "
            f"(segments={segment_count}) Trigram Top {category_top} ==="
        )
        print_counter(category_counters[cate_name][3], category_top)


def build_markdown_table(counter, top_k):
    lines = [
        "| Rank | N-gram | Frequency |",
        "|---:|---|---:|",
    ]

    rows = counter.most_common(top_k)
    if not rows:
        lines.append("| - | (no data) | 0 |")
        return lines

    for rank, (ngram, freq) in enumerate(rows, start=1):
        lines.append(f"| {rank} | {ngram_to_text(ngram)} | {freq} |")

    return lines


def build_markdown_report(
    raw_dir,
    exclude_category,
    stats,
    overall,
    category_counters,
    category_segment_counts,
    overall_top,
    category_top,
):
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lines = [
        "# N-gram Frequency Analysis",
        "",
        f"- Generated at: `{generated_at}`",
        f"- Input directory: `{raw_dir}`",
        f"- Excluded category: `{exclude_category}`",
        f"- Overall top-k: `{overall_top}`",
        f"- Category top-k: `{category_top}`",
        "",
        "## Pipeline Stats",
        f"- JSON files scanned: **{stats.total_files}**",
        f"- Invalid JSON files: **{stats.invalid_json_files}**",
        f"- `key_benefit` items total: **{stats.benefit_items_total}**",
        f"- Filtered out (`info` empty): **{stats.benefit_items_empty_info}**",
        f"- Filtered out (excluded category): **{stats.benefit_items_excluded_category}**",
        f"- `key_benefit` items used: **{stats.benefit_items_used}**",
        f"- `<p>` lines used: **{stats.p_lines_total}**",
        f"- Lines dropped (<=3 chars): **{stats.p_lines_filtered_short}**",
        f"- Lines dropped (`Froala`): **{stats.p_lines_filtered_froala}**",
        f"- Segments used: **{stats.segments_total}**",
        f"- Token lists with bigram: **{stats.token_lists_with_bigram}**",
        f"- Token lists with trigram: **{stats.token_lists_with_trigram}**",
        "",
        "## Overall Frequency",
        "",
        f"### Bigram Top {overall_top}",
    ]
    lines.extend(build_markdown_table(overall[2], overall_top))
    lines.extend(["", f"### Trigram Top {overall_top}"])
    lines.extend(build_markdown_table(overall[3], overall_top))

    lines.append("")
    lines.append("## Category Frequency")

    category_order = sorted(
        category_segment_counts.items(),
        key=lambda item: (-item[1], item[0]),
    )

    for cate_name, segment_count in category_order:
        lines.append("")
        lines.append(f"### {cate_name} (segments={segment_count})")
        lines.append("")
        lines.append(f"#### Bigram Top {category_top}")
        lines.extend(build_markdown_table(category_counters[cate_name][2], category_top))
        lines.append("")
        lines.append(f"#### Trigram Top {category_top}")
        lines.extend(build_markdown_table(category_counters[cate_name][3], category_top))

    return "\n".join(lines) + "\n"


def validate_positive(value, option_name):
    if value < 1:
        raise SystemExit(f"{option_name} must be >= 1, got {value}.")


def main():
    args = parse_args()
    validate_positive(args.overall_top, "--overall-top")
    validate_positive(args.category_top, "--category-top")

    raw_dir = args.raw_dir.resolve()
    if not raw_dir.is_dir():
        raise SystemExit(f"Input directory does not exist: {raw_dir}")

    stats = PipelineStats()
    overall, category_counters, category_segment_counts = analyze(
        raw_dir=raw_dir,
        exclude_category=args.exclude_category.strip(),
        stats=stats,
    )

    print_console_report(
        stats=stats,
        overall=overall,
        category_counters=category_counters,
        category_segment_counts=category_segment_counts,
        overall_top=args.overall_top,
        category_top=args.category_top,
    )

    report = build_markdown_report(
        raw_dir=raw_dir,
        exclude_category=args.exclude_category.strip(),
        stats=stats,
        overall=overall,
        category_counters=category_counters,
        category_segment_counts=category_segment_counts,
        overall_top=args.overall_top,
        category_top=args.category_top,
    )

    output_md = args.output_md.resolve()
    output_md.parent.mkdir(parents=True, exist_ok=True)
    output_md.write_text(report, encoding="utf-8")

    print(f"\nMarkdown report saved to: {output_md}")


if __name__ == "__main__":
    main()
