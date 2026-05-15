#!/usr/bin/env python3
"""
Analyze cafe card benefits and derive persona candidates.

The script is intentionally deterministic and local-only:
- reads db/cafe_v3.db from the project root by default
- analyzes all structured cafe benefits
- writes frequency tables, a recommendation matrix, and a Markdown report

The recommendation score is a lightweight rule-based approximation. It is
meant to find persona axes that separate candidate cards before running a
slower LLM-based evaluation pipeline.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


CAFE_CATEGORY = "카페"
GENERIC_CAFE = "__generic_cafe__"

BRAND_ALIASES = {
    "스타벅스": "스타벅스",
    "스타벅스커피": "스타벅스",
    "커피빈": "커피빈",
    "coffeebean": "커피빈",
    "thecoffeebean": "커피빈",
    "투썸플레이스": "투썸플레이스",
    "투썸": "투썸플레이스",
    "카페베네": "카페베네",
    "엔제리너스": "엔제리너스",
    "엔젤리너스": "엔제리너스",
    "탐앤탐스": "탐앤탐스",
    "폴바셋": "폴바셋",
    "이디야": "이디야",
    "이디야커피": "이디야",
    "파스쿠찌": "파스쿠찌",
    "할리스": "할리스",
    "할리스커피": "할리스",
    "아티제": "아티제",
    "블루보틀": "블루보틀",
    "빽다방": "빽다방",
    "메가커피": "메가커피",
    "컴포즈커피": "컴포즈커피",
    "더벤티": "더벤티",
    "달콤커피": "달콤커피",
    "달콤": "달콤커피",
    "달.콤": "달콤커피",
    "드롭탑": "드롭탑",
    "공차": "공차",
    "커피전문점": GENERIC_CAFE,
    "커피전문점업종": GENERIC_CAFE,
    "카페업종": GENERIC_CAFE,
    "카페": GENERIC_CAFE,
}

MAJOR_BRANDS = {
    "스타벅스",
    "커피빈",
    "투썸플레이스",
    "카페베네",
    "엔제리너스",
    "탐앤탐스",
    "폴바셋",
    "이디야",
    "파스쿠찌",
    "할리스",
}
PREMIUM_BRANDS = {"스타벅스", "커피빈", "투썸플레이스", "폴바셋", "아티제", "블루보틀"}
BUDGET_BRANDS = {"이디야", "빽다방", "메가커피", "컴포즈커피", "더벤티"}


@dataclass(frozen=True)
class Tier:
    min_spend: int | None
    max_spend: int | None
    monthly_limit: int | None


@dataclass
class Benefit:
    benefit_id: int
    card_id: int
    card_name: str
    card_company: str
    annual_fee: str | None
    is_credit: int | None
    category: str | None
    discount_rate: float | None
    discount_amount: int | None
    discount_type: str | None
    frequency_limit: str | None
    per_transaction_limit: int | None
    monthly_discount_limit: int | None
    min_spend: int | None
    brands: list[str]
    raw_brands: list[str]
    tiers: list[Tier]
    exclusions: list[str]


@dataclass(frozen=True)
class Tx:
    brand: str
    amount: int
    context_flags: frozenset[str] = frozenset()


@dataclass(frozen=True)
class PersonaTemplate:
    key: str
    label: str
    description: str
    brand_weights: tuple[tuple[str, int], ...]
    monthly_transactions: int
    avg_ticket: int
    previous_month_spending: int | None = None
    total_monthly_cafe_spend: int | None = None
    transaction_context: tuple[str, ...] = ()


def default_db_path() -> Path:
    project_root = Path(__file__).resolve().parents[1]
    db_dir = project_root / "db"
    exact = db_dir / "cafe_v3.db"
    if exact.exists():
        return exact

    candidates = sorted(db_dir.glob("cafe_v*.db"), key=lambda path: path.stat().st_mtime, reverse=True)
    if candidates:
        return candidates[0]

    return exact


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze cafe benefit frequency and derive persona candidates."
    )
    parser.add_argument("--db", type=Path, default=default_db_path(), help="SQLite DB path")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "persona_analysis_outputs",
        help="Output directory",
    )
    parser.add_argument("--category", default=CAFE_CATEGORY, help="Benefit category to analyze")
    parser.add_argument("--max-personas", type=int, default=12, help="Selected persona count")
    parser.add_argument(
        "--min-top-score",
        type=int,
        default=3000,
        help="Drop candidate personas whose top estimated discount is below this amount",
    )
    parser.add_argument(
        "--min-margin",
        type=int,
        default=0,
        help="Optional Top1-Top2 discount margin floor. Defaults to 0 because absolute discount is the primary visibility signal.",
    )
    parser.add_argument(
        "--min-margin-rate",
        type=float,
        default=0.0,
        help="Optional Top1-Top2 margin rate floor. Defaults to 0 because the margin is only a secondary signal.",
    )
    parser.add_argument(
        "--min-effective-rate",
        type=float,
        default=3.0,
        help="Drop candidate personas whose Top1 discount is below this percent of cafe spend",
    )
    parser.add_argument(
        "--alternative-cap-mode",
        choices=("min", "max"),
        default="min",
        help=(
            "How to handle duplicate-looking benefit rows that differ only by monthly cap. "
            "'min' is conservative and avoids seasonal caps being added together."
        ),
    )
    return parser.parse_args()


def as_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        if isinstance(value, float) and math.isnan(value):
            return None
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(value):
        return None
    return value


def normalize_brand(raw: str | None) -> str:
    if raw is None:
        return ""
    text = str(raw).strip()
    compact = re.sub(r"[\s./·()_\-]+", "", text)
    if compact in BRAND_ALIASES:
        return BRAND_ALIASES[compact]
    return text


def money(value: int | float | None) -> str:
    if value is None:
        return ""
    return f"{int(round(value)):,}"


def percent(value: int | float | None) -> str:
    if value is None:
        return ""
    if float(value).is_integer():
        return f"{int(value)}%"
    return f"{value:.1f}%"


def safe_ratio(numerator: int | float, denominator: int | float) -> float | None:
    if denominator == 0:
        return None
    return numerator / denominator


def load_benefits(db_path: Path, category: str) -> list[Benefit]:
    if not db_path.exists():
        raise FileNotFoundError(f"DB not found: {db_path}")

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        benefit_rows = con.execute(
            """
            SELECT
              b.benefit_id,
              b.card_id,
              c.card_name,
              c.card_company,
              c.annual_fee,
              c.is_credit,
              b.category,
              b.discount_rate,
              b.discount_amount,
              b.discount_type,
              b.frequency_limit,
              b.per_transaction_limit,
              b.monthly_discount_limit,
              b.min_spend
            FROM benefits AS b
            JOIN cards AS c ON c.card_id = b.card_id
            WHERE b.category = ?
            ORDER BY b.card_id, b.benefit_id
            """,
            (category,),
        ).fetchall()

        benefit_ids = [row["benefit_id"] for row in benefit_rows]
        brands_by_benefit: dict[int, list[str]] = defaultdict(list)
        raw_brands_by_benefit: dict[int, list[str]] = defaultdict(list)
        tiers_by_benefit: dict[int, list[Tier]] = defaultdict(list)
        exclusions_by_benefit: dict[int, list[str]] = defaultdict(list)

        if benefit_ids:
            placeholders = ",".join("?" for _ in benefit_ids)
            for row in con.execute(
                f"""
                SELECT bb.benefit_id, br.brand_name
                FROM benefit_brands AS bb
                JOIN brands AS br ON br.brand_id = bb.brand_id
                WHERE bb.benefit_id IN ({placeholders})
                ORDER BY bb.benefit_id, br.brand_name
                """,
                benefit_ids,
            ):
                raw = str(row["brand_name"])
                normalized = normalize_brand(raw)
                raw_brands_by_benefit[row["benefit_id"]].append(raw)
                if normalized:
                    brands_by_benefit[row["benefit_id"]].append(normalized)

            for row in con.execute(
                f"""
                SELECT benefit_id, min_spend, max_spend, monthly_limit
                FROM performance_tiers
                WHERE benefit_id IN ({placeholders})
                ORDER BY benefit_id, min_spend
                """,
                benefit_ids,
            ):
                tiers_by_benefit[row["benefit_id"]].append(
                    Tier(
                        min_spend=as_int(row["min_spend"]),
                        max_spend=as_int(row["max_spend"]),
                        monthly_limit=as_int(row["monthly_limit"]),
                    )
                )

            for row in con.execute(
                f"""
                SELECT benefit_id, exclusion_type
                FROM exclusions
                WHERE benefit_id IN ({placeholders})
                ORDER BY benefit_id, exclusion_id
                """,
                benefit_ids,
            ):
                if row["exclusion_type"]:
                    exclusions_by_benefit[row["benefit_id"]].append(str(row["exclusion_type"]))

        benefits: list[Benefit] = []
        for row in benefit_rows:
            benefit_id = row["benefit_id"]
            brands = sorted(set(brands_by_benefit.get(benefit_id, [])))
            raw_brands = sorted(set(raw_brands_by_benefit.get(benefit_id, [])))
            benefits.append(
                Benefit(
                    benefit_id=benefit_id,
                    card_id=row["card_id"],
                    card_name=row["card_name"] or "",
                    card_company=row["card_company"] or "",
                    annual_fee=row["annual_fee"],
                    is_credit=as_int(row["is_credit"]),
                    category=row["category"],
                    discount_rate=as_float(row["discount_rate"]),
                    discount_amount=as_int(row["discount_amount"]),
                    discount_type=row["discount_type"],
                    frequency_limit=row["frequency_limit"],
                    per_transaction_limit=as_int(row["per_transaction_limit"]),
                    monthly_discount_limit=as_int(row["monthly_discount_limit"]),
                    min_spend=as_int(row["min_spend"]),
                    brands=brands,
                    raw_brands=raw_brands,
                    tiers=tiers_by_benefit.get(benefit_id, []),
                    exclusions=exclusions_by_benefit.get(benefit_id, []),
                )
            )
        return benefits
    finally:
        con.close()


def group_by_card(benefits: Iterable[Benefit]) -> dict[int, list[Benefit]]:
    grouped: dict[int, list[Benefit]] = defaultdict(list)
    for benefit in benefits:
        grouped[benefit.card_id].append(benefit)
    return dict(grouped)


def performance_thresholds(benefit: Benefit) -> list[int]:
    thresholds: list[int] = []
    if benefit.tiers:
        thresholds.extend(t.min_spend for t in benefit.tiers if t.min_spend is not None and t.min_spend >= 100000)
    elif benefit.min_spend is not None and benefit.min_spend >= 100000:
        thresholds.append(benefit.min_spend)
    return sorted(set(thresholds))


def transaction_min_amount(benefit: Benefit) -> int | None:
    if benefit.min_spend is not None and benefit.min_spend < 100000:
        return benefit.min_spend
    return None


def discount_kind(benefit: Benefit) -> str:
    has_rate = benefit.discount_rate is not None
    has_amount = benefit.discount_amount is not None
    if has_rate and has_amount:
        return "rate+fixed"
    if has_rate:
        return "rate"
    if has_amount:
        return "fixed"
    return "unknown"


def discount_strength_bucket(benefit: Benefit) -> str:
    if benefit.discount_rate is not None:
        rate = benefit.discount_rate
        if rate < 5:
            return "rate: under 5%"
        if rate == 5:
            return "rate: 5%"
        if rate < 10:
            return "rate: 6-9%"
        if rate == 10:
            return "rate: 10%"
        if rate < 20:
            return "rate: 11-19%"
        if rate == 20:
            return "rate: 20%"
        if rate < 30:
            return "rate: 21-29%"
        if rate < 50:
            return "rate: 30-49%"
        return "rate: 50%+"

    amount = benefit.discount_amount
    if amount is None:
        return "unknown"
    if amount <= 1000:
        return "fixed: <=1,000"
    if amount <= 3000:
        return "fixed: 1,001-3,000"
    if amount <= 5000:
        return "fixed: 3,001-5,000"
    return "fixed: 5,001+"


def parse_frequency_limit(text: str | None) -> dict[str, int | None]:
    if not text:
        return {"daily": None, "monthly": None, "annual": None}
    compact = re.sub(r"\s+", "", str(text))
    daily = None
    monthly = None
    annual = None

    daily_match = re.search(r"(?:1일|일)(\d+)회", compact)
    if daily_match:
        daily = as_int(daily_match.group(1))

    monthly_match = re.search(r"월(\d+)회", compact)
    if monthly_match:
        monthly = as_int(monthly_match.group(1))

    annual_match = re.search(r"(?:연간|연)(\d+)회", compact)
    if annual_match:
        annual = as_int(annual_match.group(1))

    return {"daily": daily, "monthly": monthly, "annual": annual}


def frequency_signature(text: str | None) -> tuple[int | None, int | None, int | None, str]:
    parsed = parse_frequency_limit(text)
    compact = re.sub(r"\s+", "", str(text or ""))
    unlimited = "제한없" in compact or "횟수제한없" in compact
    return (
        parsed["daily"],
        parsed["monthly"],
        parsed["annual"],
        "unlimited" if unlimited else "",
    )


def benefit_monthly_limit_values(benefit: Benefit) -> list[int]:
    values: list[int] = []
    if benefit.monthly_discount_limit is not None:
        values.append(benefit.monthly_discount_limit)
    values.extend(t.monthly_limit for t in benefit.tiers if t.monthly_limit is not None)
    return sorted(set(values))


def monthly_limit_bucket(benefit: Benefit) -> str:
    values = benefit_monthly_limit_values(benefit)
    if not values:
        return "no limit / unknown"
    high = max(values)
    if high <= 1000:
        return "<=1,000"
    if high <= 3000:
        return "1,001-3,000"
    if high <= 5000:
        return "3,001-5,000"
    if high <= 10000:
        return "5,001-10,000"
    if high <= 20000:
        return "10,001-20,000"
    return "20,001+"


def performance_bucket(benefit: Benefit) -> str:
    thresholds = performance_thresholds(benefit)
    if not thresholds:
        return "no performance gate"
    first = min(thresholds)
    if first < 200000:
        return "under 200,000"
    if first == 200000:
        return "200,000"
    if first == 300000:
        return "300,000"
    if first <= 500000:
        return "400,000-500,000"
    if first < 1000000:
        return "600,000-900,000"
    return "1,000,000+"


def brand_coverage_bucket(benefit: Benefit) -> str:
    brands = set(benefit.brands)
    non_generic = brands - {GENERIC_CAFE}
    if not brands or GENERIC_CAFE in brands:
        return "generic cafe / unknown brand"
    if non_generic == {"스타벅스"}:
        return "starbucks only"
    if "스타벅스" in non_generic and len(non_generic) >= 3:
        return "starbucks + major multi-brand"
    if len(non_generic & BUDGET_BRANDS) >= 2:
        return "budget chain cluster"
    if len(non_generic & PREMIUM_BRANDS) >= 2:
        return "premium/major chain cluster"
    if len(non_generic & MAJOR_BRANDS) >= 4:
        return "wide major-chain coverage"
    if len(non_generic) >= 4:
        return "wide long-tail coverage"
    return "narrow named-brand coverage"


def is_credit_label(value: int | None) -> str:
    if value == 1:
        return "credit"
    if value == 0:
        return "check/debit"
    return "unknown"


def count_distinct_cards(benefits: Iterable[Benefit], key_fn) -> list[dict[str, Any]]:
    benefit_count = Counter()
    cards_by_key: dict[str, set[int]] = defaultdict(set)
    for benefit in benefits:
        keys = key_fn(benefit)
        if keys is None or isinstance(keys, (str, int, float, bool)):
            keys = [keys]
        for key in keys:
            label = str(key) if key not in (None, "") else "(blank)"
            benefit_count[label] += 1
            cards_by_key[label].add(benefit.card_id)

    rows = []
    for key, count in benefit_count.most_common():
        rows.append({"value": key, "benefits": count, "cards": len(cards_by_key[key])})
    return rows


def exact_money_rows(benefits: Iterable[Benefit], key_fn) -> list[dict[str, Any]]:
    rows = count_distinct_cards(benefits, key_fn)
    def sort_key(row: dict[str, Any]) -> tuple[int, int]:
        value = row["value"]
        if value == "(blank)":
            return (0, -row["benefits"])
        try:
            return (1, int(value))
        except ValueError:
            return (2, 0)
    return sorted(rows, key=sort_key)


def build_frequency_tables(benefits: list[Benefit]) -> dict[str, list[dict[str, Any]]]:
    tables: dict[str, list[dict[str, Any]]] = {}
    tables["brand_frequency"] = count_distinct_cards(
        benefits,
        lambda b: b.brands if b.brands else ["(no brand extracted)"],
    )
    tables["brand_coverage_bucket"] = count_distinct_cards(benefits, brand_coverage_bucket)
    tables["performance_bucket"] = count_distinct_cards(benefits, performance_bucket)
    tables["performance_threshold"] = exact_money_rows(benefits, performance_thresholds)
    tables["transaction_min_amount"] = exact_money_rows(benefits, transaction_min_amount)
    tables["discount_kind"] = count_distinct_cards(benefits, discount_kind)
    tables["discount_strength_bucket"] = count_distinct_cards(benefits, discount_strength_bucket)
    tables["discount_rate"] = count_distinct_cards(
        benefits,
        lambda b: percent(b.discount_rate) if b.discount_rate is not None else "(blank)",
    )
    tables["discount_amount"] = exact_money_rows(benefits, lambda b: b.discount_amount)
    tables["monthly_limit_bucket"] = count_distinct_cards(benefits, monthly_limit_bucket)
    tables["monthly_limit_value"] = exact_money_rows(
        benefits,
        lambda b: benefit_monthly_limit_values(b) or None,
    )
    tables["frequency_limit_raw"] = count_distinct_cards(benefits, lambda b: b.frequency_limit)
    tables["monthly_frequency_cap"] = count_distinct_cards(
        benefits,
        lambda b: parse_frequency_limit(b.frequency_limit)["monthly"],
    )
    tables["daily_frequency_cap"] = count_distinct_cards(
        benefits,
        lambda b: parse_frequency_limit(b.frequency_limit)["daily"],
    )
    tables["card_company"] = count_distinct_cards(benefits, lambda b: b.card_company)
    tables["card_type"] = count_distinct_cards(benefits, lambda b: is_credit_label(b.is_credit))
    tables["exclusion_count"] = count_distinct_cards(benefits, lambda b: len(b.exclusions))
    return tables


def is_performance_eligible(benefit: Benefit, previous_month_spend: int) -> bool:
    if benefit.tiers:
        return monthly_limit_for_spend(benefit, previous_month_spend) != 0
    thresholds = performance_thresholds(benefit)
    if not thresholds:
        return True
    return previous_month_spend >= min(thresholds)


def monthly_limit_for_spend(benefit: Benefit, previous_month_spend: int) -> int | None:
    if benefit.tiers:
        sorted_tiers = sorted(benefit.tiers, key=lambda t: t.min_spend or 0)
        for tier in sorted_tiers:
            minimum = tier.min_spend or 0
            maximum = tier.max_spend
            lower_ok = previous_month_spend >= minimum
            upper_ok = True if maximum is None else previous_month_spend < maximum
            if lower_ok and upper_ok:
                return tier.monthly_limit
        return 0

    thresholds = performance_thresholds(benefit)
    if thresholds and previous_month_spend < min(thresholds):
        return 0
    return benefit.monthly_discount_limit


def matches_brand(benefit: Benefit, brand: str) -> bool:
    brands = set(benefit.brands)
    if not brands or GENERIC_CAFE in brands:
        return True
    if brand == GENERIC_CAFE:
        return False
    return brand in brands


TENANT_STORE_CONTEXT = "tenant_store"
TENANT_STORE_EXCLUSION_KEYWORDS = (
    "입점",
    "백화점",
    "마트",
    "대형할인점",
    "할인점",
    "쇼핑몰",
    "아울렛",
    "면세점",
    "공항",
    "호텔",
    "리조트",
    "역사",
    "휴게소",
    "미군부대",
    "임대매장",
    "대형시설",
)


def has_tenant_store_exclusion(benefit: Benefit) -> bool:
    compact_exclusions = [re.sub(r"\s+", "", exclusion) for exclusion in benefit.exclusions]
    return any(
        keyword in exclusion
        for exclusion in compact_exclusions
        for keyword in TENANT_STORE_EXCLUSION_KEYWORDS
    )


def matches_transaction_context(benefit: Benefit, tx: Tx) -> bool:
    if TENANT_STORE_CONTEXT in tx.context_flags and has_tenant_store_exclusion(benefit):
        return False
    return True


def raw_discount_for_tx(benefit: Benefit, tx: Tx, previous_month_spend: int) -> int:
    if not matches_brand(benefit, tx.brand):
        return 0
    if not matches_transaction_context(benefit, tx):
        return 0
    if not is_performance_eligible(benefit, previous_month_spend):
        return 0

    min_amount = transaction_min_amount(benefit)
    if min_amount is not None and tx.amount < min_amount:
        return 0

    candidates: list[float] = []
    if benefit.discount_rate is not None:
        candidates.append(tx.amount * benefit.discount_rate / 100)
    if benefit.discount_amount is not None:
        candidates.append(float(benefit.discount_amount))
    if not candidates:
        return 0

    discount = max(candidates)
    if benefit.per_transaction_limit is not None:
        discount = min(discount, benefit.per_transaction_limit)
    discount = min(discount, tx.amount)
    return max(0, int(math.floor(discount)))


def scoring_duplicate_key(benefit: Benefit) -> tuple[Any, ...]:
    tier_gate_shape = tuple((tier.min_spend, tier.max_spend) for tier in benefit.tiers)
    return (
        tuple(sorted(benefit.brands)),
        discount_kind(benefit),
        benefit.discount_type,
        frequency_signature(benefit.frequency_limit),
        benefit.per_transaction_limit,
        benefit.min_spend,
        tier_gate_shape,
    )


def choose_alternative_benefit(
    alternatives: list[Benefit],
    previous_month_spend: int,
    alternative_cap_mode: str,
) -> Benefit:
    if len(alternatives) == 1:
        return alternatives[0]

    def cap_value(benefit: Benefit) -> int:
        cap = monthly_limit_for_spend(benefit, previous_month_spend)
        if cap is None:
            return 10**15
        return cap

    def rate_value(benefit: Benefit) -> float:
        return benefit.discount_rate or 0

    def amount_value(benefit: Benefit) -> int:
        return benefit.discount_amount or 0

    if alternative_cap_mode == "max":
        return max(alternatives, key=lambda benefit: (cap_value(benefit), rate_value(benefit), amount_value(benefit)))

    return min(alternatives, key=lambda benefit: (cap_value(benefit), -rate_value(benefit), -amount_value(benefit)))


def dedupe_scoring_benefits(
    benefits: list[Benefit],
    previous_month_spend: int,
    alternative_cap_mode: str,
) -> list[Benefit]:
    groups: dict[tuple[Any, ...], list[Benefit]] = defaultdict(list)
    for benefit in benefits:
        groups[scoring_duplicate_key(benefit)].append(benefit)

    return [
        choose_alternative_benefit(group, previous_month_spend, alternative_cap_mode)
        for group in groups.values()
    ]


def distribute_amounts(total: int, count: int, avg_ticket: int) -> list[int]:
    if count <= 0:
        return []

    base = max(100, int(round((total / count) / 100)) * 100 if total else avg_ticket)
    amounts = [base for _ in range(count)]
    delta = total - sum(amounts)
    index = 0
    guard = 0
    while delta != 0 and guard < count * 100:
        step = 100 if abs(delta) >= 100 else abs(delta)
        if delta > 0:
            amounts[index] += step
            delta -= step
        elif amounts[index] - step >= 100:
            amounts[index] -= step
            delta += step
        index = (index + 1) % count
        guard += 1
    return amounts


def expanded_transactions(template: PersonaTemplate) -> list[Tx]:
    context_flags = frozenset(template.transaction_context)

    if template.total_monthly_cafe_spend is not None:
        brands: list[str] = []
        for brand, count in template.brand_weights:
            brands.extend([normalize_brand(brand)] * max(0, int(count)))
        if len(brands) < template.monthly_transactions:
            brands.extend([GENERIC_CAFE] * (template.monthly_transactions - len(brands)))
        brands = brands[: template.monthly_transactions]
        amounts = distribute_amounts(template.total_monthly_cafe_spend, len(brands), template.avg_ticket)
        return [
            Tx(brand=brand, amount=amount, context_flags=context_flags)
            for brand, amount in zip(brands, amounts)
        ]

    weighted: list[str] = []
    for brand, weight in template.brand_weights:
        weighted.extend([normalize_brand(brand)] * max(1, int(weight)))
    if not weighted:
        weighted = [GENERIC_CAFE]

    amount_multipliers = [0.85, 1.0, 1.15, 0.95, 1.25]
    transactions: list[Tx] = []
    for index in range(template.monthly_transactions):
        brand = weighted[index % len(weighted)]
        amount = int(round(template.avg_ticket * amount_multipliers[index % len(amount_multipliers)] / 100)) * 100
        transactions.append(Tx(brand=brand, amount=max(100, amount), context_flags=context_flags))
    return transactions


def transaction_brand_counts(transactions: list[Tx]) -> str:
    counter = Counter(tx.brand for tx in transactions)
    labels = []
    for brand, count in counter.items():
        labels.append(f"{'카페 업종 일반' if brand == GENERIC_CAFE else brand} {count}회")
    return ", ".join(labels)


def score_card(
    benefits: list[Benefit],
    previous_month_spend: int,
    transactions: list[Tx],
    alternative_cap_mode: str,
) -> int:
    benefits = dedupe_scoring_benefits(
        benefits=benefits,
        previous_month_spend=previous_month_spend,
        alternative_cap_mode=alternative_cap_mode,
    )
    states: dict[int, dict[str, int | None]] = {}
    for benefit in benefits:
        monthly_limit = monthly_limit_for_spend(benefit, previous_month_spend)
        frequency = parse_frequency_limit(benefit.frequency_limit)
        monthly_count = frequency["monthly"]
        states[benefit.benefit_id] = {
            "remaining_amount": monthly_limit,
            "remaining_count": monthly_count,
        }

    total = 0
    for tx in transactions:
        best_benefit: Benefit | None = None
        best_discount = 0

        for benefit in benefits:
            state = states[benefit.benefit_id]
            remaining_count = state["remaining_count"]
            if remaining_count is not None and remaining_count <= 0:
                continue

            remaining_amount = state["remaining_amount"]
            if remaining_amount is not None and remaining_amount <= 0:
                continue

            discount = raw_discount_for_tx(benefit, tx, previous_month_spend)
            if remaining_amount is not None:
                discount = min(discount, remaining_amount)

            if discount > best_discount:
                best_discount = discount
                best_benefit = benefit

        if best_benefit is None or best_discount <= 0:
            continue

        state = states[best_benefit.benefit_id]
        if state["remaining_count"] is not None:
            state["remaining_count"] = max(0, int(state["remaining_count"]) - 1)
        if state["remaining_amount"] is not None:
            state["remaining_amount"] = max(0, int(state["remaining_amount"]) - best_discount)
        total += best_discount

    return total


def persona_templates() -> list[PersonaTemplate]:
    return [
        PersonaTemplate(
            key="starbucks_heavy",
            label="스타벅스 다빈도형",
            description="스타벅스를 출근길·점심 후·주말까지 반복 이용하는 고빈도 직장인",
            brand_weights=(("스타벅스", 18), ("투썸플레이스", 1), (GENERIC_CAFE, 3)),
            monthly_transactions=22,
            avg_ticket=6000,
            previous_month_spending=1000000,
            total_monthly_cafe_spend=137900,
        ),
        PersonaTemplate(
            key="starbucks_light",
            label="스타벅스 가끔형",
            description="스타벅스를 좋아하지만 헤비 유저는 아닌 라이트 학생",
            brand_weights=(("스타벅스", 6),),
            monthly_transactions=6,
            avg_ticket=6000,
            previous_month_spending=300000,
            total_monthly_cafe_spend=34800,
        ),
        PersonaTemplate(
            key="ediya_local",
            label="이디야 생활권형",
            description="이디야와 생활권 저가 브랜드를 섞어 반복 이용",
            brand_weights=(("이디야", 9), ("메가커피", 2), ("컴포즈커피", 1), (GENERIC_CAFE, 3)),
            monthly_transactions=15,
            avg_ticket=4000,
            previous_month_spending=300000,
            total_monthly_cafe_spend=62800,
        ),
        PersonaTemplate(
            key="premium_cafe_social",
            label="프리미엄 카페 모임형",
            description="평일 직장 미팅과 주말 친구 모임에서 일행 음료·디저트까지 결제하는 호스트형 직장인",
            brand_weights=(
                ("폴바셋", 2),
                ("스타벅스", 2),
                ("엔제리너스", 1),
                ("투썸플레이스", 1),
                (GENERIC_CAFE, 2),
            ),
            monthly_transactions=8,
            avg_ticket=18000,
            previous_month_spending=800000,
            total_monthly_cafe_spend=144500,
        ),
        PersonaTemplate(
            key="premium_hopper",
            label="주요 프리미엄 체인 순회형",
            description="스타벅스·투썸·커피빈·폴바셋을 상황에 따라 고르게 이용",
            brand_weights=(
                ("스타벅스", 4),
                ("투썸플레이스", 3),
                ("커피빈", 2),
                ("폴바셋", 2),
                (GENERIC_CAFE, 2),
            ),
            monthly_transactions=13,
            avg_ticket=9000,
            previous_month_spending=300000,
            total_monthly_cafe_spend=119600,
        ),
        PersonaTemplate(
            key="ultra_budget_coffee",
            label="저가커피 초저가 다빈도형",
            description="메가MGC커피·컴포즈커피·빽다방·더벤티를 3천원 안팎으로 반복 이용",
            brand_weights=(
                ("메가커피", 8),
                ("컴포즈커피", 5),
                ("빽다방", 4),
                ("더벤티", 2),
            ),
            monthly_transactions=19,
            avg_ticket=3000,
            previous_month_spending=300000,
            total_monthly_cafe_spend=52500,
        ),
    ]


def spend_levels_from_data(benefits: list[Benefit]) -> list[int]:
    thresholds: set[int] = {0, 150000, 250000, 350000, 450000, 550000, 750000, 1100000, 1600000, 2200000}
    for benefit in benefits:
        for threshold in performance_thresholds(benefit):
            if 0 <= threshold <= 3000000:
                thresholds.add(threshold)
                thresholds.add(threshold + 50000)
    return sorted(thresholds)


def card_identity(benefits: list[Benefit]) -> dict[str, Any]:
    first = benefits[0]
    return {
        "card_id": first.card_id,
        "card_name": first.card_name,
        "card_company": first.card_company,
    }


def derive_persona_candidates(
    benefits: list[Benefit],
    max_personas: int,
    min_top_score: int,
    min_margin: int,
    min_margin_rate: float,
    min_effective_rate: float,
    alternative_cap_mode: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    cards = group_by_card(benefits)
    templates = persona_templates()
    spend_levels = spend_levels_from_data(benefits)

    all_candidates: list[dict[str, Any]] = []
    matrix_rows: list[dict[str, Any]] = []

    fixed_persona_mode = all(template.previous_month_spending is not None for template in templates)

    for template_order, template in enumerate(templates, start=1):
        template_spend_levels = (
            [template.previous_month_spending]
            if template.previous_month_spending is not None
            else spend_levels
        )
        for spend in template_spend_levels:
            if spend is None:
                continue
            transactions = expanded_transactions(template)
            total_cafe_spend = sum(tx.amount for tx in transactions)
            ranked: list[dict[str, Any]] = []

            for card_id, card_benefits in cards.items():
                score = score_card(
                    benefits=card_benefits,
                    previous_month_spend=spend,
                    transactions=transactions,
                    alternative_cap_mode=alternative_cap_mode,
                )
                if score <= 0:
                    continue
                identity = card_identity(card_benefits)
                ranked.append({**identity, "estimated_discount": score})

            ranked.sort(key=lambda row: (-row["estimated_discount"], row["card_id"]))
            top = ranked[:5]
            if not top:
                continue

            top1 = top[0]
            top2_score = top[1]["estimated_discount"] if len(top) > 1 else 0
            margin = top1["estimated_discount"] - top2_score
            top1_effective_rate = (
                round(top1["estimated_discount"] / total_cafe_spend * 100, 2)
                if total_cafe_spend
                else 0
            )
            top2_effective_rate = round(top2_score / total_cafe_spend * 100, 2) if total_cafe_spend else 0
            margin_rate = round(margin / total_cafe_spend * 100, 2) if total_cafe_spend else 0
            margin_ratio = safe_ratio(margin, top2_score)
            lift_ratio = safe_ratio(top1["estimated_discount"], top2_score)
            persuasiveness_score = round(
                (top1["estimated_discount"] * 1.0)
                + (top1_effective_rate * 100)
                + (margin * 0.1),
                2,
            )
            is_compelling = (
                top1["estimated_discount"] >= min_top_score
                and margin >= min_margin
                and margin_rate >= min_margin_rate
                and top1_effective_rate >= min_effective_rate
            )
            candidate_id = f"{template.key}_{spend}"

            candidate = {
                "candidate_id": candidate_id,
                "template_order": template_order,
                "persona_label": f"{template.label} / 전월 {money(spend)}원",
                "base_pattern": template.label,
                "description": template.description,
                "previous_month_spending": spend,
                "monthly_cafe_transactions": template.monthly_transactions,
                "avg_ticket": template.avg_ticket,
                "estimated_monthly_cafe_spend": total_cafe_spend,
                "brand_mix": transaction_brand_counts(transactions),
                "transaction_brands": ";".join(tx.brand for tx in transactions),
                "transaction_amounts": ";".join(str(tx.amount) for tx in transactions),
                "transaction_context": ", ".join(template.transaction_context),
                "top1_card_id": top1["card_id"],
                "top1_card_name": top1["card_name"],
                "top1_card_company": top1["card_company"],
                "top1_estimated_discount": top1["estimated_discount"],
                "top1_effective_rate": top1_effective_rate,
                "top2_card_name": top[1]["card_name"] if len(top) > 1 else "",
                "top2_estimated_discount": top2_score,
                "top2_effective_rate": top2_effective_rate,
                "top3_card_name": top[2]["card_name"] if len(top) > 2 else "",
                "top3_estimated_discount": top[2]["estimated_discount"] if len(top) > 2 else 0,
                "top5_card_ids": ", ".join(str(row["card_id"]) for row in top),
                "top5_card_names": " | ".join(row["card_name"] for row in top),
                "top1_margin": margin,
                "top1_margin_rate": margin_rate,
                "top1_margin_ratio": round(margin_ratio, 3) if margin_ratio is not None else "",
                "top1_lift_ratio": round(lift_ratio, 3) if lift_ratio is not None else "",
                "persuasiveness_score": persuasiveness_score,
                "is_compelling": "yes" if is_compelling else "no",
            }
            all_candidates.append(candidate)

            for rank, row in enumerate(top, start=1):
                matrix_rows.append(
                    {
                        "candidate_id": candidate_id,
                        "persona_label": candidate["persona_label"],
                        "rank": rank,
                        "card_id": row["card_id"],
                        "card_name": row["card_name"],
                        "card_company": row["card_company"],
                        "estimated_discount": row["estimated_discount"],
                        "effective_rate": round(row["estimated_discount"] / total_cafe_spend * 100, 2)
                        if total_cafe_spend
                        else 0,
                        "estimated_monthly_cafe_spend": total_cafe_spend,
                    }
                )

    all_candidates.sort(
        key=lambda row: (
            -row["persuasiveness_score"],
            -row["top1_estimated_discount"],
            -row["top1_effective_rate"],
            -row["top1_margin"],
            row["previous_month_spending"],
            row["base_pattern"],
        )
    )
    compelling_candidates = [
        candidate for candidate in all_candidates if candidate["is_compelling"] == "yes"
    ]

    if fixed_persona_mode:
        selected = [
            {**candidate, "selected_order": index}
            for index, candidate in enumerate(
                sorted(compelling_candidates, key=lambda row: row["template_order"]),
                start=1,
            )
        ]
        return all_candidates, compelling_candidates, selected, matrix_rows

    def top5_ids(candidate: dict[str, Any]) -> set[int]:
        ids: set[int] = set()
        for value in str(candidate.get("top5_card_ids", "")).split(","):
            value = value.strip()
            if value.isdigit():
                ids.add(int(value))
        return ids

    def has_too_much_top5_overlap(
        candidate: dict[str, Any],
        selected_rows: list[dict[str, Any]],
        max_overlap: int,
    ) -> bool:
        candidate_ids = top5_ids(candidate)
        return any(len(candidate_ids & top5_ids(row)) > max_overlap for row in selected_rows)

    selected: list[dict[str, Any]] = []
    seen_top_cards: set[int] = set()
    seen_base_patterns: set[str] = set()
    for max_overlap in (1, 2, 3, 4):
        for candidate in compelling_candidates:
            if len(selected) >= max_personas:
                break
            top_card = candidate["top1_card_id"]
            base_pattern = candidate["base_pattern"]
            if base_pattern in seen_base_patterns:
                continue
            if top_card in seen_top_cards:
                continue
            if has_too_much_top5_overlap(candidate, selected, max_overlap):
                continue
            selected.append(
                {
                    **candidate,
                    "selected_order": len(selected) + 1,
                    "selection_top5_max_overlap": max_overlap,
                }
            )
            seen_top_cards.add(top_card)
            seen_base_patterns.add(base_pattern)

    return all_candidates, compelling_candidates, selected, matrix_rows


def active_coverage_by_spend(benefits: list[Benefit], spend_levels: list[int]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    all_cards = {benefit.card_id for benefit in benefits}
    for spend in spend_levels:
        active_benefits = [benefit for benefit in benefits if is_performance_eligible(benefit, spend)]
        active_cards = {benefit.card_id for benefit in active_benefits}
        rows.append(
            {
                "previous_month_spending": spend,
                "eligible_benefits": len(active_benefits),
                "eligible_cards": len(active_cards),
                "eligible_card_share": round(len(active_cards) / len(all_cards) * 100, 2) if all_cards else 0,
            }
        )
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in fieldnames:
                fieldnames.append(key)

    with path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def markdown_table(rows: list[dict[str, Any]], columns: list[str], limit: int | None = None) -> str:
    selected = rows[:limit] if limit is not None else rows
    if not selected:
        return "_No rows._"

    lines = []
    lines.append("| " + " | ".join(columns) + " |")
    lines.append("| " + " | ".join("---" for _ in columns) + " |")
    for row in selected:
        values = [str(row.get(column, "")) for column in columns]
        values = [value.replace("\n", " ").replace("|", "/") for value in values]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def build_report(
    db_path: Path,
    benefits: list[Benefit],
    frequency_tables: dict[str, list[dict[str, Any]]],
    coverage_rows: list[dict[str, Any]],
    compelling_personas: list[dict[str, Any]],
    selected_personas: list[dict[str, Any]],
    all_candidates: list[dict[str, Any]],
    min_top_score: int,
    min_margin: int,
    min_margin_rate: float,
    min_effective_rate: float,
) -> str:
    card_count = len({benefit.card_id for benefit in benefits})
    top_card_counter = Counter(candidate["top1_card_name"] for candidate in all_candidates)
    top_card_rows = [
        {"card_name": name, "candidate_count": count}
        for name, count in top_card_counter.most_common(20)
    ]

    lines = [
        "# Cafe Persona Analysis",
        "",
        f"- DB: `{db_path}`",
        f"- Cafe benefit rows: **{len(benefits):,}**",
        f"- Cafe cards: **{card_count:,}**",
        f"- Candidate grid rows: **{len(all_candidates):,}**",
        f"- Compelling candidate rows: **{len(compelling_personas):,}**",
        "",
        "## Why These Axes",
        "",
        "Persona separation should use axes that actually change eligibility or score:",
        "",
        "1. Previous-month spending: determines whether performance gates and tiered monthly limits open.",
        "2. Brand mix: many benefits are brand-specific, especially Starbucks and major-chain bundles.",
        "3. Monthly cafe frequency and ticket size: fixed discounts, monthly caps, and count limits react differently.",
        "4. Benefit structure: rate discount vs fixed discount changes which ticket size wins.",
        "5. Monthly/per-transaction limits: separates light users from heavy users.",
        "6. Visibility: recommendations should show a large enough absolute discount to be noticeable to viewers.",
        "7. Transaction context: tenant-store personas exclude benefits whose terms remove department-store/mall tenant cafe purchases.",
        "",
        "## Compelling Candidate Criteria",
        "",
        f"- Top1 estimated discount >= **{money(min_top_score)}원**",
        f"- Top1 effective rate >= **{min_effective_rate:g}%** of monthly cafe spend",
        f"- Optional Top1 - Top2 margin floor: **{money(min_margin)}원**",
        f"- Optional Top1 - Top2 margin rate floor: **{min_margin_rate:g}%** of monthly cafe spend",
        "",
        "The primary goal is a visibly large discount amount. Top1-Top2 margin is kept as a secondary tie-breaker, not the main reason to create a persona.",
        "Selected personas are then greedily diversified: one row per base persona pattern, unique Top1 cards, and limited Top5 card overlap whenever possible.",
        "",
        "## Key Frequency Tables",
        "",
        "### Brand Frequency",
        markdown_table(frequency_tables["brand_frequency"], ["value", "benefits", "cards"], limit=20),
        "",
        "### Brand Coverage Buckets",
        markdown_table(frequency_tables["brand_coverage_bucket"], ["value", "benefits", "cards"], limit=20),
        "",
        "### Performance Thresholds",
        markdown_table(frequency_tables["performance_threshold"], ["value", "benefits", "cards"], limit=30),
        "",
        "### Eligible Cards By Previous-Month Spend",
        markdown_table(
            coverage_rows,
            ["previous_month_spending", "eligible_benefits", "eligible_cards", "eligible_card_share"],
        ),
        "",
        "### Discount Strength",
        markdown_table(frequency_tables["discount_strength_bucket"], ["value", "benefits", "cards"], limit=20),
        "",
        "### Monthly Limit Buckets",
        markdown_table(frequency_tables["monthly_limit_bucket"], ["value", "benefits", "cards"], limit=20),
        "",
        "### Monthly Frequency Caps",
        markdown_table(frequency_tables["monthly_frequency_cap"], ["value", "benefits", "cards"], limit=20),
        "",
        "## Selected Persona Candidates",
        "",
        markdown_table(
            selected_personas,
            [
                "selected_order",
                "persona_label",
                "brand_mix",
                "transaction_context",
                "monthly_cafe_transactions",
                "avg_ticket",
                "top1_card_name",
                "top1_card_company",
                "top1_estimated_discount",
                "top1_margin",
                "top1_margin_rate",
                "selection_top5_max_overlap",
                "top5_card_names",
                "persuasiveness_score",
            ],
        ),
        "",
        "## Most Compelling Candidate Rows",
        "",
        markdown_table(
            compelling_personas,
            [
                "persona_label",
                "brand_mix",
                "transaction_context",
                "top1_card_name",
                "top1_estimated_discount",
                "top2_card_name",
                "top2_estimated_discount",
                "top1_margin",
                "top1_margin_rate",
                "top1_lift_ratio",
                "persuasiveness_score",
            ],
            limit=20,
        ),
        "",
        "## Top1 Card Concentration Across Candidate Grid",
        "",
        markdown_table(top_card_rows, ["card_name", "candidate_count"], limit=20),
        "",
        "## Output Files",
        "",
        "- `frequency_*.csv`: one frequency table per analysis axis",
        "- `spend_coverage.csv`: eligible benefit/card counts by previous-month spend",
        "- `persona_candidates_all.csv`: every synthetic persona tested",
        "- `persona_candidates_compelling.csv`: candidates that pass the persuasiveness filters",
        "- `persona_candidates_selected.csv`: diverse Top1 persona candidates",
        "- `persona_recommendation_matrix.csv`: Top5 cards per tested persona",
        "- `persona_analysis_summary.json`: compact machine-readable summary",
        "",
        "Note: the scoring step is a deterministic approximation. Use the selected candidates as test personas, then validate the final recommendations with the LLM pipeline.",
        "",
    ]
    return "\n".join(lines)


def run() -> None:
    args = parse_args()
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    benefits = load_benefits(args.db, args.category)
    if not benefits:
        raise RuntimeError(f"No benefits found for category={args.category!r}")

    frequency_tables = build_frequency_tables(benefits)
    spend_levels = spend_levels_from_data(benefits)
    coverage_rows = active_coverage_by_spend(benefits, spend_levels)
    all_candidates, compelling_personas, selected_personas, matrix_rows = derive_persona_candidates(
        benefits=benefits,
        max_personas=args.max_personas,
        min_top_score=args.min_top_score,
        min_margin=args.min_margin,
        min_margin_rate=args.min_margin_rate,
        min_effective_rate=args.min_effective_rate,
        alternative_cap_mode=args.alternative_cap_mode,
    )

    for name, rows in frequency_tables.items():
        write_csv(out_dir / f"frequency_{name}.csv", rows)
    write_csv(out_dir / "spend_coverage.csv", coverage_rows)
    write_csv(out_dir / "persona_candidates_all.csv", all_candidates)
    write_csv(out_dir / "persona_candidates_compelling.csv", compelling_personas)
    write_csv(out_dir / "persona_candidates_selected.csv", selected_personas)
    write_csv(out_dir / "persona_recommendation_matrix.csv", matrix_rows)

    summary = {
        "db_path": str(args.db),
        "category": args.category,
        "alternative_cap_mode": args.alternative_cap_mode,
        "selection_filters": {
            "min_top_score": args.min_top_score,
            "min_margin": args.min_margin,
            "min_margin_rate": args.min_margin_rate,
            "min_effective_rate": args.min_effective_rate,
        },
        "benefit_rows": len(benefits),
        "card_count": len({benefit.card_id for benefit in benefits}),
        "frequency_tables": {
            name: rows[:20]
            for name, rows in frequency_tables.items()
        },
        "spend_coverage": coverage_rows,
        "compelling_personas": compelling_personas,
        "selected_personas": selected_personas,
        "candidate_count": len(all_candidates),
        "compelling_candidate_count": len(compelling_personas),
    }
    write_json(out_dir / "persona_analysis_summary.json", summary)

    report = build_report(
        db_path=args.db,
        benefits=benefits,
        frequency_tables=frequency_tables,
        coverage_rows=coverage_rows,
        compelling_personas=compelling_personas,
        selected_personas=selected_personas,
        all_candidates=all_candidates,
        min_top_score=args.min_top_score,
        min_margin=args.min_margin,
        min_margin_rate=args.min_margin_rate,
        min_effective_rate=args.min_effective_rate,
    )
    (out_dir / "persona_analysis_report.md").write_text(report, encoding="utf-8")

    print(f"Loaded cafe benefits: {len(benefits):,}")
    print(f"Loaded cafe cards: {len({benefit.card_id for benefit in benefits}):,}")
    print(f"Tested persona candidates: {len(all_candidates):,}")
    print(f"Compelling persona candidates: {len(compelling_personas):,}")
    print(f"Selected persona candidates: {len(selected_personas):,}")
    print(f"Output directory: {out_dir}")


if __name__ == "__main__":
    run()
