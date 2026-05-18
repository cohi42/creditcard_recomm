import base64
import html
import json
from pathlib import Path

import streamlit as st

st.set_page_config(
    page_title="카페 카테고리 LLM 기반 회고형 카드 추천 시스템",
    page_icon="☕",
    layout="wide",
    initial_sidebar_state="collapsed",
)

st.markdown("""
<style>
/* ── 전역 ── */
.block-container { max-width: 1400px; padding-top: 1.5rem; }

/* ── 라디오 버튼 패널 타이틀 ── */
.radio-panel-title {
    font-size: 0.75rem;
    font-weight: 700;
    color: #a0aec0;
    letter-spacing: .08em;
    text-transform: uppercase;
    margin-bottom: 12px;
}

/* 옵션 블록 스타일 — :has(input) 으로 위젯 제목 label은 제외 */
div[data-testid="stRadio"] > div {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
div[data-testid="stRadio"] label:has(input[type="radio"]) {
    display: flex !important;
    align-items: center !important;
    padding: 16px 18px !important;
    border: 1.5px solid #e2e8f0 !important;
    border-radius: 12px !important;
    background: #ffffff !important;
    cursor: pointer;
    transition: border-color .15s, background .15s;
    font-size: 0.91rem !important;
    font-weight: 500 !important;
    color: #2d3748 !important;
    line-height: 1.4 !important;
}
div[data-testid="stRadio"] label:has(input[type="radio"]):hover {
    border-color: #667eea !important;
    background: #f5f7ff !important;
}
div[data-testid="stRadio"] label:has(input[type="radio"]:checked) {
    border-color: #4f6ef7 !important;
    background: #eef2ff !important;
    font-weight: 700 !important;
    color: #1a202c !important;
}

/* ── 중앙 페르소나 프로필 카드 ── */
.profile-card {
    position: relative;
    border-radius: 20px;
    overflow: hidden;
    background: #eef2ff;
    border: 1px solid #c7d7f4;
    min-height: 520px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
}
.profile-card-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
    opacity: 0.35;
}
.profile-card-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(
        180deg,
        rgba(238,242,255,0.05) 0%,
        rgba(238,242,255,0.55) 55%,
        rgba(238,242,255,0.97) 100%
    );
}
.profile-card-body {
    position: relative;
    z-index: 1;
    padding: 28px 24px 24px;
}
.profile-name {
    font-size: 1.45rem;
    font-weight: 800;
    color: #1a202c;
    line-height: 1.25;
    margin-bottom: 10px;
}
.profile-desc {
    font-size: 1.05rem;
    color: #4a5568;
    line-height: 1.72;
    margin-bottom: 18px;
}
.profile-metrics {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.metric-chip {
    background: rgba(255,255,255,0.82);
    border: 1px solid #d0dff0;
    border-radius: 10px;
    padding: 8px 14px;
    font-size: 0.80rem;
    color: #4a5568;
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.metric-chip strong { color: #1a56db; font-size: 0.92rem; }

/* ── 추천 카드 헤더 ── */
.rank-card {
    border-radius: 12px;
    padding: 10px 14px;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 10px;
}
.card-thumb-wrap {
    flex-shrink: 0;
    width: 88px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
}
.card-thumb {
    width: 100%;
    height: 100%;
    object-fit: contain;
    border-radius: 5px;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.15));
}
.rank-gold   { border: 2.5px solid #D4AF37; background: linear-gradient(120deg,#FFFFF5,#FFF8DC); }
.rank-silver { border: 2.5px solid #B0B0B0; background: linear-gradient(120deg,#F9F9F9,#EEEEEE); }
.rank-bronze { border: 2.5px solid #CD7F32; background: linear-gradient(120deg,#FDF8F2,#F5E6D3); }
.rank-normal { border: 1px solid #e2e8f0; background: #ffffff; }
.rank-badge  { font-size: 1.4rem; min-width: 1.8rem; }
.rank-num    { font-size: 0.9rem; font-weight: 700; color: #4a5568; min-width: 2.2rem; }
.card-title  { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.card-company { font-size: 0.75rem; font-weight: 500; color: #718096; }
.card-name    { font-size: 0.95rem; font-weight: 700; color: #1a202c; }
.card-discount { font-size: 0.97rem; font-weight: 700; color: #1a56db; white-space: nowrap; }
.card-rate   { font-size: 0.78rem; color: #718096; margin-left: 4px; }

/* ── 거래 내역 ── */
.txn-row {
    display: grid;
    grid-template-columns: 100px 1fr 80px 68px 76px;
    gap: 6px;
    align-items: center;
    padding: 7px 0;
    border-bottom: 1px solid #f0f4f8;
    font-size: 0.83rem;
}
.txn-row:last-child { border-bottom: none; }
.txn-merchant { font-weight: 500; color: #2d3748; }
.txn-amount   { text-align: right; color: #4a5568; }
.txn-discount { text-align: right; font-weight: 600; color: #276749; }
.badge-yes { background:#e6ffed; color:#22543d; padding:2px 7px; border-radius:20px; font-size:0.75rem; font-weight:700; }
.badge-no  { background:#fff5f5; color:#9b2c2c; padding:2px 7px; border-radius:20px; font-size:0.75rem; }
.txn-header { font-size:0.74rem; color:#a0aec0; font-weight:600; text-transform:uppercase; letter-spacing:.05em; }

/* ── LLM 근거 ── */
.llm-box {
    border-left: 3px solid #b0bec5;
    background: #f7fafc;
    padding: 7px 12px;
    margin: 3px 0 9px;
    border-radius: 0 6px 6px 0;
    font-style: italic;
    color: #4a5568;
    font-size: 0.81rem;
    line-height: 1.55;
}

hr { border: none; border-top: 1px solid #e2e8f0; margin: 16px 0; }

/* ── 카드 정형 정보 박스 ── */
.card-info-box {
    background: #f8faff;
    border: 1px solid #dde6f5;
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 16px;
    font-size: 0.84rem;
    color: #2d3748;
}
.card-info-top {
    display: flex;
    gap: 16px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
}
.card-badge {
    background: #e8edff;
    color: #3451b2;
    border-radius: 6px;
    padding: 2px 10px;
    font-size: 0.76rem;
    font-weight: 700;
}
.card-fee { color: #4a5568; font-size: 0.82rem; }
.card-benefit-row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-bottom: 8px;
    flex-wrap: wrap;
}
.card-benefit-label { color: #718096; font-size: 0.78rem; min-width: 64px; }
.card-benefit-value { color: #1a202c; font-weight: 600; }
.brand-tag {
    display: inline-block;
    background: #edf2ff;
    color: #3b5bdb;
    border-radius: 20px;
    padding: 1px 9px;
    font-size: 0.76rem;
    margin: 1px 2px;
}
.tier-table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    font-size: 0.81rem;
}
.tier-table th {
    background: #eef2ff;
    color: #4a5568;
    font-weight: 600;
    padding: 5px 10px;
    text-align: center;
    border-radius: 4px;
}
.tier-table td {
    padding: 5px 10px;
    text-align: center;
    border-bottom: 1px solid #f0f4f8;
    color: #2d3748;
}
.tier-table tr:last-child td { border-bottom: none; }
.exclusion-note {
    margin-top: 8px;
    padding: 6px 10px;
    background: #fff8f0;
    border-left: 3px solid #f6ad55;
    border-radius: 0 6px 6px 0;
    font-size: 0.77rem;
    color: #744210;
}

/* ── 원시 결제 내역 ── */
.raw-txn-title {
    font-size: 0.74rem;
    font-weight: 700;
    color: #a0aec0;
    letter-spacing: .07em;
    text-transform: uppercase;
    margin: 20px 0 10px;
}
.raw-txn-scroll {
    height: 560px;
    overflow-y: auto;
    border: 1px solid #e8edf5;
    border-radius: 12px;
    background: #fafbff;
    padding: 0 2px;
}
.raw-txn-row {
    display: grid;
    grid-template-columns: 52px 28px 1fr auto;
    gap: 6px;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid #f0f4f8;
    font-size: 0.82rem;
}
.raw-txn-row:last-child { border-bottom: none; }
.raw-date  { color: #718096; white-space: nowrap; }
.raw-day   { color: #a0aec0; font-size: 0.75rem; text-align:center; }
.raw-store { color: #2d3748; font-weight: 500;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.raw-amt   { color: #1a56db; font-weight: 600; white-space: nowrap; text-align:right; }
</style>
""", unsafe_allow_html=True)

DATA_FILE    = Path(__file__).parent / "recommendation_outputs" / "curated_recommendations.json"
TXN_FILE     = Path(__file__).parent / "persona_transactions.json"
IMG_DIR      = Path(__file__).parent / "persona_image"
CARD_RAW_DIR = Path(__file__).parent.parent / "card_crawling" / "data" / "raw"
DB_FILE      = Path(__file__).parent.parent / "db" / "cafe_v3.db"

RANK_CSS   = {1: "rank-gold", 2: "rank-silver", 3: "rank-bronze"}
RANK_EMOJI = {1: "🥇", 2: "🥈", 3: "🥉"}


def short_name(full: str) -> str:
    """'페르소나 1: 스타벅스 다빈도형' → '스타벅스 다빈도형'"""
    return full.split(": ", 1)[1] if ": " in full else full


@st.cache_data
def load_data():
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


@st.cache_data
def load_transactions():
    with open(TXN_FILE, encoding="utf-8") as f:
        return json.load(f)


@st.cache_data
def load_card_db_info(card_id: int) -> dict:
    """DB에서 카드 정형 정보(혜택·실적구간·브랜드·제외) 반환"""
    import sqlite3
    if not DB_FILE.exists():
        return {}
    conn = sqlite3.connect(str(DB_FILE))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 기본 정보
    cur.execute("SELECT annual_fee, is_credit FROM cards WHERE card_id=?", (card_id,))
    card_row = cur.fetchone()
    if not card_row:
        conn.close()
        return {}

    # 카페 혜택 (discount_rate가 있는 benefit 우선, 없으면 brand가 있는 것)
    cur.execute("""
        SELECT b.benefit_id, b.category, b.discount_rate, b.discount_amount,
               b.discount_type, b.monthly_discount_limit, b.frequency_limit,
               b.per_transaction_limit, b.min_spend
        FROM benefits b
        WHERE b.card_id=? AND b.discount_rate IS NOT NULL
        LIMIT 1
    """, (card_id,))
    benefit = cur.fetchone()

    if not benefit:
        cur.execute("""
            SELECT b.benefit_id, b.category, b.discount_rate, b.discount_amount,
                   b.discount_type, b.monthly_discount_limit, b.frequency_limit,
                   b.per_transaction_limit, b.min_spend
            FROM benefits b
            JOIN benefit_brands bb ON b.benefit_id = bb.benefit_id
            WHERE b.card_id=?
            LIMIT 1
        """, (card_id,))
        benefit = cur.fetchone()

    result = {
        "annual_fee": card_row["annual_fee"] or "",
        "is_credit":  bool(card_row["is_credit"]),
        "benefit":    dict(benefit) if benefit else None,
        "tiers":      [],
        "brands":     [],
        "exclusions": [],
    }

    if benefit:
        bid = benefit["benefit_id"]
        cur.execute(
            "SELECT min_spend, max_spend, monthly_limit FROM performance_tiers WHERE benefit_id=? ORDER BY min_spend",
            (bid,)
        )
        result["tiers"] = [dict(r) for r in cur.fetchall()]

        cur.execute(
            "SELECT br.brand_name FROM benefit_brands bb JOIN brands br ON bb.brand_id=br.brand_id WHERE bb.benefit_id=?",
            (bid,)
        )
        result["brands"] = [r["brand_name"] for r in cur.fetchall()]

        cur.execute(
            "SELECT exclusion_type FROM exclusions WHERE benefit_id=?",
            (bid,)
        )
        result["exclusions"] = [r["exclusion_type"] for r in cur.fetchall()]

    conn.close()
    return result


def _safe_int_fmt(val, suffix="원") -> str:
    """숫자면 '1,234원' 형식, 문자열이면 그대로 반환"""
    try:
        return f"{int(val):,}{suffix}"
    except (ValueError, TypeError):
        return str(val) if val is not None else "-"


def _to_int_or_none(val):
    try:
        if val is None or val == "":
            return None
        return int(val)
    except (TypeError, ValueError):
        return None


def _money_or_none(val):
    amount = _to_int_or_none(val)
    return f"{amount:,}원" if amount is not None else None


def _benefit_transaction_min_spend(card_info: dict):
    min_spend = _to_int_or_none((card_info.get("benefit") or {}).get("min_spend"))
    if min_spend is not None and 0 < min_spend < 20000:
        return min_spend
    return None


def _benefit_performance_requirement(card_info: dict):
    candidates = [
        _to_int_or_none(t.get("min_spend"))
        for t in card_info.get("tiers", [])
    ]
    benefit_min_spend = _to_int_or_none((card_info.get("benefit") or {}).get("min_spend"))
    candidates.append(benefit_min_spend)

    performance_candidates = [
        amount for amount in candidates
        if amount is not None and amount >= 100000
    ]
    return min(performance_candidates) if performance_candidates else None


def benefit_block_reason(txn: dict, card_info: dict, persona: dict) -> str:
    pp = txn.get("postprocess") or {}
    blocked_by = pp.get("blocked_by")
    if not blocked_by:
        return ""

    block_label = "사전 차단" if str(blocked_by).endswith("_pre_llm") else "후처리 제한"
    policy = pp.get("policy") or {}
    state = pp.get("state_snapshot") or {}
    transaction = txn.get("transaction") or {}

    if blocked_by in {"monthly_cap_reached_pre_llm", "MONTHLY_AMOUNT_LIMIT"}:
        cap = _money_or_none(policy.get("monthlyAmountCap"))
        used = _money_or_none(state.get("total_discount"))
        if cap and used:
            return f"{block_label}: 이 카드의 월 할인 한도 {cap}가 이미 소진되었습니다. 현재 누적 할인액이 {used}라서 이 거래는 혜택 미적용으로 처리했습니다."
        if cap:
            return f"{block_label}: 이 카드의 월 할인 한도 {cap}가 이미 소진되어 이 거래는 혜택 미적용으로 처리했습니다."
        return f"{block_label}: 이 카드의 월 할인 한도가 이미 소진되어 이 거래는 혜택 미적용으로 처리했습니다."

    if blocked_by in {"monthly_count_reached_pre_llm", "MONTHLY_COUNT_LIMIT"}:
        cap = _to_int_or_none(policy.get("monthlyCountCap"))
        used = _to_int_or_none(state.get("monthly_count"))
        if cap is not None and used is not None:
            return f"{block_label}: 이 카드의 월 제공 횟수 {cap}회를 이미 모두 사용했습니다. 현재 적용 횟수가 {used}회라서 이 거래는 혜택 미적용으로 처리했습니다."
        if cap is not None:
            return f"{block_label}: 이 카드의 월 제공 횟수 {cap}회를 이미 모두 사용해 이 거래는 혜택 미적용으로 처리했습니다."
        return f"{block_label}: 이 카드의 월 제공 횟수를 이미 모두 사용해 이 거래는 혜택 미적용으로 처리했습니다."

    if blocked_by == "previous_month_spending_insufficient_pre_llm":
        spend = _money_or_none(persona.get("previous_month_spending"))
        required = _money_or_none(_benefit_performance_requirement(card_info))
        if spend and required:
            return f"사전 차단: 전월 실적 {spend}이 혜택 조건 {required}에 미달하여 이 카드 혜택을 적용할 수 없습니다."
        if spend:
            return f"사전 차단: 전월 실적 {spend}이 이 카드의 혜택 조건에 미달하여 적용할 수 없습니다."
        return "사전 차단: 전월 실적이 이 카드의 혜택 조건에 미달하여 적용할 수 없습니다."

    if blocked_by == "transaction_min_spend_not_met_pre_llm":
        amount = _money_or_none(transaction.get("amount"))
        min_spend = _money_or_none(_benefit_transaction_min_spend(card_info))
        if amount and min_spend:
            return f"사전 차단: 결제금액 {amount}이 건당 최소 결제금액 {min_spend}보다 낮아 혜택 미적용으로 처리했습니다."
        if amount:
            return f"사전 차단: 결제금액 {amount}이 이 카드 혜택의 건당 최소 결제금액 조건에 미달하여 적용할 수 없습니다."
        return "사전 차단: 이 거래는 카드 혜택의 건당 최소 결제금액 조건에 미달하여 적용할 수 없습니다."

    if blocked_by == "DAILY_COUNT_LIMIT":
        cap = _to_int_or_none(policy.get("dailyCountCap"))
        if cap is not None:
            return f"후처리 제한: 해당 날짜의 일 제공 횟수 {cap}회를 이미 사용해 이 거래는 혜택 미적용으로 처리했습니다."
        return "후처리 제한: 해당 날짜의 일 제공 횟수를 이미 사용해 이 거래는 혜택 미적용으로 처리했습니다."

    return f"혜택 제한({blocked_by})으로 최종 할인금액이 0원 처리되었습니다."


def render_card_info_box(info: dict):
    if not info:
        return

    # 기본 정보 행
    card_type = "신용카드" if info["is_credit"] else "체크카드"
    fee_text  = info["annual_fee"].split("/")[0].strip() if info["annual_fee"] else "정보 없음"
    top_html  = (
        f'<div class="card-info-top">'
        f'<span class="card-badge">{card_type}</span>'
        f'<span class="card-fee">연회비 {fee_text}</span>'
        f'</div>'
    )

    b = info.get("benefit")
    benefit_html = ""
    if b:
        rate    = b.get("discount_rate")
        dtype   = b.get("discount_type") or ""
        mlimit  = b.get("monthly_discount_limit")
        flimit  = b.get("frequency_limit")

        rate_str = f"{_safe_int_fmt(rate, '%')} {dtype}".strip() if rate else (dtype or "")
        rows_html = f'<div class="card-benefit-row"><span class="card-benefit-label">카페 할인</span><span class="card-benefit-value">{rate_str}</span></div>'

        if mlimit:
            rows_html += f'<div class="card-benefit-row"><span class="card-benefit-label">월 한도</span><span class="card-benefit-value">{_safe_int_fmt(mlimit)}</span></div>'
        if flimit:
            rows_html += f'<div class="card-benefit-row"><span class="card-benefit-label">횟수 제한</span><span class="card-benefit-value">{_safe_int_fmt(flimit, "회")}</span></div>'

        benefit_html = rows_html

    # 브랜드 태그
    brand_html = ""
    if info["brands"]:
        tags = "".join(f'<span class="brand-tag">{b}</span>' for b in info["brands"])
        brand_html = f'<div class="card-benefit-row"><span class="card-benefit-label">적용 브랜드</span><span>{tags}</span></div>'

    # 실적 구간 테이블
    tier_html = ""
    if info["tiers"]:
        rows = ""
        for t in info["tiers"]:
            lo  = _safe_int_fmt(t["min_spend"])  if t["min_spend"]  is not None else "-"
            hi  = (_safe_int_fmt(t["max_spend"]) + " 미만") if t["max_spend"] is not None else "이상"
            lim = _safe_int_fmt(t["monthly_limit"]) if t["monthly_limit"] is not None else "-"
            rows += f'<tr><td>{lo} ~ {hi}</td><td>{lim}</td></tr>'
        tier_html = (
            f'<div class="card-benefit-row"><span class="card-benefit-label">실적 구간</span>'
            f'<span style="flex:1"><table class="tier-table">'
            f'<tr><th>전월 실적</th><th>월 할인 한도</th></tr>{rows}'
            f'</table></span></div>'
        )

    # 제외 항목
    excl_html = ""
    if info["exclusions"]:
        excl_list = " · ".join(info["exclusions"])
        excl_html = f'<div class="exclusion-note">⚠ 제외 항목: {excl_list}</div>'

    html = (
        f'<div class="card-info-box">'
        f'{top_html}{benefit_html}{brand_html}{tier_html}{excl_html}'
        f'</div>'
    )
    st.markdown(html, unsafe_allow_html=True)


@st.cache_data
def load_card_img_urls() -> dict:
    """card_id → card_img URL 매핑을 한 번만 로드"""
    result = {}
    if not CARD_RAW_DIR.exists():
        return result
    for fpath in CARD_RAW_DIR.glob("*.json"):
        try:
            cid = int(fpath.stem)
        except ValueError:
            continue
        with open(fpath, encoding="utf-8") as f:
            d = json.load(f)
        img = d.get("card_img")
        if isinstance(img, dict):
            url = img.get("url", "")
            if url:
                result[cid] = url
    return result


@st.cache_data
def img_b64(persona_id: int) -> str:
    path = IMG_DIR / f"P{persona_id}.png"
    if not path.exists():
        return ""
    return base64.b64encode(path.read_bytes()).decode()


def render_profile_card(p: dict):
    b64 = img_b64(p["persona_id"])
    img_tag = (
        f'<img class="profile-card-img" src="data:image/png;base64,{b64}" alt="">'
        if b64 else ""
    )
    st.markdown(
        f"""
        <div class="profile-card">
            {img_tag}
            <div class="profile-card-overlay"></div>
            <div class="profile-card-body">
                <div class="profile-name">{short_name(p['persona_name'])}</div>
                <div class="profile-desc">{p['usage_concept']}</div>
                <div class="profile-metrics">
                    <div class="metric-chip">
                        <span>카페 월 지출</span>
                        <strong>{p['monthly_cafe_spend']:,}원</strong>
                    </div>
                    <div class="metric-chip">
                        <span>거래 건수</span>
                        <strong>{p['transaction_count']}건</strong>
                    </div>
                    <div class="metric-chip">
                        <span>전월 실적</span>
                        <strong>{p['previous_month_spending']:,}원</strong>
                    </div>
                </div>
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_raw_transactions(persona_idx: int):
    txn_data = load_transactions()
    txns = txn_data["personas"][persona_idx]["transactions"]
    total = sum(t["amount_krw"] for t in txns)

    rows = "".join(
        f'<div class="raw-txn-row">'
        f'<span class="raw-date">{t["date"]}({t["day_of_week"]})</span>'
        f'<span class="raw-day">{t["time"]}</span>'
        f'<span class="raw-store">{t["merchant"]}</span>'
        f'<span class="raw-amt">{t["amount_krw"]:,}원</span>'
        f'</div>'
        for t in txns
    )

    st.markdown('<div class="raw-txn-title">이번 달 카페 결제 내역</div>', unsafe_allow_html=True)
    st.markdown(
        f'<div class="raw-txn-scroll">{rows}</div>',
        unsafe_allow_html=True,
    )
    st.markdown(
        f"<div style='text-align:right;font-size:0.8rem;color:#718096;margin-top:6px;'>"
        f"총 {len(txns)}건 &nbsp;·&nbsp; <strong style='color:#1a56db'>{total:,}원</strong>"
        f"</div>",
        unsafe_allow_html=True,
    )


def render_cards(p: dict):
    card_img_urls = load_card_img_urls()
    st.markdown("#### 추천 카드 랭킹")
    for card in p["ranked_cards"]:
        rank       = card["rank"]
        css        = RANK_CSS.get(rank, "rank-normal")
        emoji      = RANK_EMOJI.get(rank, "")
        rank_label = f"{rank}위" if rank > 3 else ""
        img_url    = card_img_urls.get(card["card_id"], "")
        img_tag    = (
            f'<div class="card-thumb-wrap"><img class="card-thumb" src="{img_url}" alt=""></div>'
            if img_url else
            '<div class="card-thumb-wrap"></div>'
        )

        st.markdown(
            f'<div class="rank-card {css}">'
            f'{img_tag}'
            f'<span class="rank-badge">{emoji}</span>'
            f'<span class="rank-num">{rank_label}</span>'
            f'<span class="card-title"><span class="card-company">{card["card_company"]}</span><span class="card-name">{card["card_name"]}</span></span>'
            f'<span class="card-discount">{card["estimated_discount"]:,}원 절감</span>'
            f'<span class="card-rate">({card["estimated_discount_rate"]:.1f}%)</span>'
            f'</div>',
            unsafe_allow_html=True,
        )

        with st.expander("거래 내역 펼치기"):
            card_info = load_card_db_info(card["card_id"])
            render_card_info_box(card_info)
            st.markdown(
                """
                <div class="txn-row">
                    <span class="txn-header">날짜/시간</span>
                    <span class="txn-header">가맹점</span>
                    <span class="txn-header" style="text-align:right">결제금액</span>
                    <span class="txn-header" style="text-align:center">적용</span>
                    <span class="txn-header" style="text-align:right">할인금액</span>
                </div>
                """,
                unsafe_allow_html=True,
            )
            for txn in card["transaction_calculations"]:
                t          = txn["transaction"]
                ld         = txn.get("llm_decision") or {}
                pp         = txn.get("postprocess") or {}
                final_amt  = _to_int_or_none(pp.get("final_amount")) or 0
                applicable = final_amt > 0
                reasoning  = benefit_block_reason(txn, card_info, p) or ld.get("reasoning", "")

                badge        = '<span class="badge-yes">✓ 적용</span>' if applicable else '<span class="badge-no">✗ 미적용</span>'
                discount_str = f"{final_amt:,}원" if applicable and final_amt else "–"
                date_str     = f"{t.get('date','')} {t.get('time','')}".strip()

                st.markdown(
                    f"""
                    <div class="txn-row">
                        <span style="color:#718096">{date_str}</span>
                        <span class="txn-merchant">{t.get('merchant','')}</span>
                        <span class="txn-amount">{t.get('amount',0):,}원</span>
                        <span style="text-align:center">{badge}</span>
                        <span class="txn-discount">{discount_str}</span>
                    </div>
                    """,
                    unsafe_allow_html=True,
                )
                if reasoning:
                    safe_reasoning = html.escape(str(reasoning))
                    st.markdown(
                        f'<div class="llm-box">"{safe_reasoning}"</div>',
                        unsafe_allow_html=True,
                    )

        st.markdown("<div style='height:5px'></div>", unsafe_allow_html=True)


def main():
    data     = load_data()
    personas = data["personas"]
    names    = [short_name(p["persona_name"]) for p in personas]

    st.markdown("## ☕ 카페 카테고리 LLM 기반 회고형 카드 추천 시스템")
    st.markdown(
        "<span style='color:#718096;font-size:.88rem;'>"
        "카페 거래 내역에 각 카드를 반사실적으로 적용했을 때의 절감액 시뮬레이션입니다."
        "</span>",
        unsafe_allow_html=True,
    )
    st.markdown("<hr>", unsafe_allow_html=True)

    # ── 3분할 레이아웃 ──────────────────────────────────────────
    col_select, col_profile, col_cards = st.columns([1.3, 1.4, 2.3], gap="large")

    with col_select:
        st.markdown('<div class="radio-panel-title">페르소나 선택</div>', unsafe_allow_html=True)
        selected_idx = st.radio(
            label="",
            options=range(len(personas)),
            format_func=lambda i: names[i],
            label_visibility="collapsed",
        )

    persona = personas[selected_idx]

    with col_profile:
        render_profile_card(persona)
        render_raw_transactions(selected_idx)

    with col_cards:
        render_cards(persona)


if __name__ == "__main__":
    main()
