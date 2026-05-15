const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_DIR = path.resolve(PROJECT_ROOT, 'db');
const OUTPUT_DIR = path.resolve(__dirname, 'persona_analysis_outputs');
const DEFAULT_DB_FILE = 'cafe_v3.db';
const DB_PATH = fs.existsSync(path.resolve(DB_DIR, DEFAULT_DB_FILE))
  ? path.resolve(DB_DIR, DEFAULT_DB_FILE)
  : fs.existsSync(DB_DIR)
    ? fs
        .readdirSync(DB_DIR)
        .filter((name) => /^cafe_v\d+.*\.db$/.test(name))
        .sort()
        .map((name) => path.resolve(DB_DIR, name))
        .at(-1)
    : null;

const GENERIC_CAFE = '__generic_cafe__';
const TENANT_STORE_CONTEXT = 'tenant_store';
const TENANT_STORE_EXCLUSION_KEYWORDS = [
  '입점',
  '백화점',
  '마트',
  '대형할인점',
  '할인점',
  '쇼핑몰',
  '아울렛',
  '면세점',
  '공항',
  '호텔',
  '리조트',
  '역사',
  '휴게소',
  '미군부대',
  '임대매장',
  '대형시설',
];
const TEMPLATE_BRAND_WEIGHTS = {
  starbucks_light: [['스타벅스', 1]],
  starbucks_heavy: [['스타벅스', 1]],
  premium_hopper: [['스타벅스', 2], ['투썸플레이스', 2], ['커피빈', 2], ['폴바셋', 1]],
  ultra_budget_coffee: [['메가커피', 3], ['컴포즈커피', 3], ['빽다방', 2], ['더벤티', 1]],
  premium_cafe_social: [['폴바셋', 2], ['스타벅스', 2], ['엔제리너스', 1], ['투썸플레이스', 1], [GENERIC_CAFE, 2]],
  ediya_local: [['이디야', 3], ['메가커피', 1], ['컴포즈커피', 1]],
};
const TEMPLATE_TRANSACTION_CONTEXT = {
  department_store_social: [TENANT_STORE_CONTEXT],
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, ''));
  return rows
    .filter((values) => values.some((value) => value !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath, rows) {
  const headers = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsv(row[header])).join(','));
  }
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function normalizeBrand(raw) {
  const text = String(raw ?? '').trim();
  const compact = text.replace(/[\s./·()_-]+/g, '').toLowerCase();

  if (compact.includes('스타벅스')) return '스타벅스';
  if (compact.includes('커피빈') || compact.includes('coffeebean')) return '커피빈';
  if (compact.includes('투썸')) return '투썸플레이스';
  if (compact.includes('카페베네')) return '카페베네';
  if (compact.includes('엔제리너스') || compact.includes('엔젤리너스')) return '엔제리너스';
  if (compact.includes('탐앤탐스')) return '탐앤탐스';
  if (compact.includes('폴바셋')) return '폴바셋';
  if (compact.includes('이디야')) return '이디야';
  if (compact.includes('파스쿠찌')) return '파스쿠찌';
  if (compact.includes('할리스')) return '할리스';
  if (compact.includes('아티제')) return '아티제';
  if (compact.includes('블루보틀')) return '블루보틀';
  if (compact.includes('빽다방')) return '빽다방';
  if (compact.includes('메가커피')) return '메가커피';
  if (compact.includes('컴포즈커피')) return '컴포즈커피';
  if (compact.includes('더벤티')) return '더벤티';
  if (compact.includes('달콤')) return '달콤커피';
  if (compact.includes('드롭탑')) return '드롭탑';
  if (compact.includes('공차')) return '공차';
  if (compact.includes('커피전문점') || compact.includes('카페업종') || compact === '카페') {
    return GENERIC_CAFE;
  }

  return text;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseFrequencyLimit(text) {
  const compact = String(text ?? '').replace(/\s+/g, '');
  const dailyMatch = compact.match(/(?:1일|일)(\d+)회/);
  const monthlyMatch = compact.match(/월(\d+)회/);
  const annualMatch = compact.match(/(?:연간|연)(\d+)회/);
  return {
    daily: dailyMatch ? Number(dailyMatch[1]) : null,
    monthly: monthlyMatch ? Number(monthlyMatch[1]) : null,
    annual: annualMatch ? Number(annualMatch[1]) : null,
  };
}

function frequencySignature(text) {
  const parsed = parseFrequencyLimit(text);
  const compact = String(text ?? '').replace(/\s+/g, '');
  const unlimited = compact.includes('제한없') || compact.includes('횟수제한없');
  return `${parsed.daily ?? ''}|${parsed.monthly ?? ''}|${parsed.annual ?? ''}|${unlimited ? 'unlimited' : ''}`;
}

function performanceThresholds(benefit) {
  if (benefit.tiers.length > 0) {
    return [...new Set(benefit.tiers.map((tier) => tier.min_spend).filter((value) => value !== null && value >= 100000))].sort((a, b) => a - b);
  }
  if (benefit.min_spend !== null && benefit.min_spend >= 100000) {
    return [benefit.min_spend];
  }
  return [];
}

function transactionMinAmount(benefit) {
  if (benefit.min_spend !== null && benefit.min_spend < 100000) return benefit.min_spend;
  return null;
}

function discountKind(benefit) {
  if (benefit.discount_rate !== null && benefit.discount_amount !== null) return 'rate+fixed';
  if (benefit.discount_rate !== null) return 'rate';
  if (benefit.discount_amount !== null) return 'fixed';
  return 'unknown';
}

function monthlyLimitForSpend(benefit, previousMonthSpend) {
  if (benefit.tiers.length > 0) {
    const sorted = [...benefit.tiers].sort((a, b) => (a.min_spend ?? 0) - (b.min_spend ?? 0));
    for (const tier of sorted) {
      const min = tier.min_spend ?? 0;
      const max = tier.max_spend;
      if (previousMonthSpend >= min && (max === null || previousMonthSpend < max)) {
        return tier.monthly_limit;
      }
    }
    return 0;
  }

  const thresholds = performanceThresholds(benefit);
  if (thresholds.length > 0 && previousMonthSpend < Math.min(...thresholds)) return 0;
  return benefit.monthly_discount_limit;
}

function isPerformanceEligible(benefit, previousMonthSpend) {
  if (benefit.tiers.length > 0) return monthlyLimitForSpend(benefit, previousMonthSpend) !== 0;
  const thresholds = performanceThresholds(benefit);
  return thresholds.length === 0 || previousMonthSpend >= Math.min(...thresholds);
}

function scoringDuplicateKey(benefit) {
  const tierGateShape = benefit.tiers.map((tier) => `${tier.min_spend ?? ''}-${tier.max_spend ?? ''}`).join('/');
  return [
    [...benefit.brands].sort().join('|'),
    discountKind(benefit),
    benefit.discount_type ?? '',
    frequencySignature(benefit.frequency_limit),
    benefit.per_transaction_limit ?? '',
    benefit.min_spend ?? '',
    tierGateShape,
  ].join('::');
}

function chooseAlternativeBenefit(alternatives, previousMonthSpend, alternativeCapMode) {
  if (alternatives.length === 1) return alternatives[0];

  const capValue = (benefit) => {
    const cap = monthlyLimitForSpend(benefit, previousMonthSpend);
    return cap === null ? 10 ** 15 : cap;
  };
  const rateValue = (benefit) => benefit.discount_rate ?? 0;
  const amountValue = (benefit) => benefit.discount_amount ?? 0;

  const sorted = [...alternatives].sort((left, right) => {
    const capDiff = capValue(left) - capValue(right);
    if (capDiff !== 0) return alternativeCapMode === 'max' ? -capDiff : capDiff;
    const rateDiff = rateValue(left) - rateValue(right);
    if (rateDiff !== 0) return -rateDiff;
    return -(amountValue(left) - amountValue(right));
  });

  return sorted[0];
}

function dedupeScoringBenefits(benefits, previousMonthSpend, alternativeCapMode) {
  const groups = new Map();
  for (const benefit of benefits) {
    const key = scoringDuplicateKey(benefit);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(benefit);
  }
  return [...groups.values()].map((group) => chooseAlternativeBenefit(group, previousMonthSpend, alternativeCapMode));
}

function matchesBrand(benefit, brand) {
  if (benefit.brands.length === 0 || benefit.brands.includes(GENERIC_CAFE)) return true;
  if (brand === GENERIC_CAFE) return false;
  return benefit.brands.includes(brand);
}

function hasTenantStoreExclusion(benefit) {
  return (benefit.exclusions ?? []).some((exclusion) => {
    const compact = String(exclusion ?? '').replace(/\s+/g, '');
    return TENANT_STORE_EXCLUSION_KEYWORDS.some((keyword) => compact.includes(keyword));
  });
}

function matchesTransactionContext(benefit, tx) {
  if ((tx.contextFlags ?? new Set()).has(TENANT_STORE_CONTEXT) && hasTenantStoreExclusion(benefit)) {
    return false;
  }
  return true;
}

function rawDiscountForTx(benefit, tx, previousMonthSpend) {
  if (!matchesBrand(benefit, tx.brand)) return 0;
  if (!matchesTransactionContext(benefit, tx)) return 0;
  if (!isPerformanceEligible(benefit, previousMonthSpend)) return 0;

  const minAmount = transactionMinAmount(benefit);
  if (minAmount !== null && tx.amount < minAmount) return 0;

  const candidates = [];
  if (benefit.discount_rate !== null) candidates.push((tx.amount * benefit.discount_rate) / 100);
  if (benefit.discount_amount !== null) candidates.push(benefit.discount_amount);
  if (candidates.length === 0) return 0;

  let discount = Math.max(...candidates);
  if (benefit.per_transaction_limit !== null) discount = Math.min(discount, benefit.per_transaction_limit);
  discount = Math.min(discount, tx.amount);
  return Math.max(0, Math.floor(discount));
}

function expandedTransactions(persona) {
  const weighted = [];
  const templateKey = persona.candidate_id.replace(/_\d+$/, '');
  const brandWeights = TEMPLATE_BRAND_WEIGHTS[templateKey] ?? [];
  const contextFlags = new Set(TEMPLATE_TRANSACTION_CONTEXT[templateKey] ?? []);
  for (const rawContext of String(persona.transaction_context ?? '').split(',')) {
    const context = rawContext.trim();
    if (context) contextFlags.add(context);
  }

  const explicitBrands = String(persona.transaction_brands ?? '')
    .split(';')
    .map((brand) => normalizeBrand(brand))
    .filter(Boolean);
  const explicitAmounts = String(persona.transaction_amounts ?? '')
    .split(';')
    .map((amount) => Number(amount))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  if (explicitBrands.length > 0 && explicitBrands.length === explicitAmounts.length) {
    return explicitBrands.map((brand, index) => ({
      brand,
      amount: explicitAmounts[index],
      contextFlags,
    }));
  }

  for (const [brandText, weight] of brandWeights) {
    const brand = normalizeBrand(brandText);
    for (let index = 0; index < weight; index += 1) {
      if (brand) weighted.push(brand);
    }
  }

  if (weighted.length === 0) weighted.push(GENERIC_CAFE);

  const multipliers = [0.85, 1.0, 1.15, 0.95, 1.25];
  const transactions = [];
  const count = Number(persona.monthly_cafe_transactions);
  const avgTicket = Number(persona.avg_ticket);
  for (let index = 0; index < count; index += 1) {
    const brand = weighted[index % weighted.length];
    const amount = Math.max(100, Math.round((avgTicket * multipliers[index % multipliers.length]) / 100) * 100);
    transactions.push({ brand, amount, contextFlags });
  }
  return transactions;
}

function scoreCard(benefits, previousMonthSpend, transactions, alternativeCapMode = 'min') {
  const scoringBenefits = dedupeScoringBenefits(benefits, previousMonthSpend, alternativeCapMode);
  const states = new Map();
  for (const benefit of scoringBenefits) {
    states.set(benefit.benefit_id, {
      remainingAmount: monthlyLimitForSpend(benefit, previousMonthSpend),
      remainingCount: parseFrequencyLimit(benefit.frequency_limit).monthly,
    });
  }

  let total = 0;
  for (const tx of transactions) {
    let bestBenefit = null;
    let bestDiscount = 0;

    for (const benefit of scoringBenefits) {
      const state = states.get(benefit.benefit_id);
      if (state.remainingCount !== null && state.remainingCount <= 0) continue;
      if (state.remainingAmount !== null && state.remainingAmount <= 0) continue;

      let discount = rawDiscountForTx(benefit, tx, previousMonthSpend);
      if (state.remainingAmount !== null) discount = Math.min(discount, state.remainingAmount);
      if (discount > bestDiscount) {
        bestBenefit = benefit;
        bestDiscount = discount;
      }
    }

    if (!bestBenefit || bestDiscount <= 0) continue;

    const state = states.get(bestBenefit.benefit_id);
    if (state.remainingCount !== null) state.remainingCount = Math.max(0, state.remainingCount - 1);
    if (state.remainingAmount !== null) state.remainingAmount = Math.max(0, state.remainingAmount - bestDiscount);
    total += bestDiscount;
  }

  return total;
}

function loadBenefits() {
  const db = new DatabaseSync(DB_PATH);
  const benefitRows = db.prepare(`
    SELECT b.benefit_id, b.card_id, c.card_name, c.card_company,
           b.discount_rate, b.discount_amount, b.discount_type, b.frequency_limit,
           b.per_transaction_limit, b.monthly_discount_limit, b.min_spend
    FROM benefits AS b
    JOIN cards AS c ON c.card_id = b.card_id
    WHERE b.category = char(52852,54168)
    ORDER BY b.card_id, b.benefit_id
  `).all();

  const ids = benefitRows.map((row) => row.benefit_id);
  const placeholders = ids.map(() => '?').join(',');
  const brandsByBenefit = new Map();
  const tiersByBenefit = new Map();
  const exclusionsByBenefit = new Map();

  for (const row of db.prepare(`
    SELECT bb.benefit_id, br.brand_name
    FROM benefit_brands AS bb
    JOIN brands AS br ON br.brand_id = bb.brand_id
    WHERE bb.benefit_id IN (${placeholders})
  `).all(...ids)) {
    if (!brandsByBenefit.has(row.benefit_id)) brandsByBenefit.set(row.benefit_id, new Set());
    brandsByBenefit.get(row.benefit_id).add(normalizeBrand(row.brand_name));
  }

  for (const row of db.prepare(`
    SELECT benefit_id, min_spend, max_spend, monthly_limit
    FROM performance_tiers
    WHERE benefit_id IN (${placeholders})
    ORDER BY benefit_id, min_spend
  `).all(...ids)) {
    if (!tiersByBenefit.has(row.benefit_id)) tiersByBenefit.set(row.benefit_id, []);
    tiersByBenefit.get(row.benefit_id).push({
      min_spend: toNumberOrNull(row.min_spend),
      max_spend: toNumberOrNull(row.max_spend),
      monthly_limit: toNumberOrNull(row.monthly_limit),
    });
  }

  for (const row of db.prepare(`
    SELECT benefit_id, exclusion_type
    FROM exclusions
    WHERE benefit_id IN (${placeholders})
    ORDER BY benefit_id, exclusion_id
  `).all(...ids)) {
    if (!exclusionsByBenefit.has(row.benefit_id)) exclusionsByBenefit.set(row.benefit_id, []);
    if (row.exclusion_type) exclusionsByBenefit.get(row.benefit_id).push(String(row.exclusion_type));
  }

  db.close();

  return benefitRows.map((row) => ({
    benefit_id: row.benefit_id,
    card_id: row.card_id,
    card_name: row.card_name,
    card_company: row.card_company,
    discount_rate: toNumberOrNull(row.discount_rate),
    discount_amount: toNumberOrNull(row.discount_amount),
    discount_type: row.discount_type,
    frequency_limit: row.frequency_limit,
    per_transaction_limit: toNumberOrNull(row.per_transaction_limit),
    monthly_discount_limit: toNumberOrNull(row.monthly_discount_limit),
    min_spend: toNumberOrNull(row.min_spend),
    brands: [...(brandsByBenefit.get(row.benefit_id) ?? new Set())].filter(Boolean),
    tiers: tiersByBenefit.get(row.benefit_id) ?? [],
    exclusions: exclusionsByBenefit.get(row.benefit_id) ?? [],
  }));
}

function main() {
  if (!DB_PATH) throw new Error('db/cafe_v*.db not found');

  const selected = parseCsv(fs.readFileSync(path.resolve(OUTPUT_DIR, 'persona_candidates_selected.csv'), 'utf8'));
  const benefits = loadBenefits();
  const cards = new Map();

  for (const benefit of benefits) {
    if (!cards.has(benefit.card_id)) cards.set(benefit.card_id, []);
    cards.get(benefit.card_id).push(benefit);
  }

  const rows = [];
  for (const persona of selected) {
    const previousMonthSpend = Number(persona.previous_month_spending);
    const transactions = expandedTransactions(persona);
    const totalSpend = transactions.reduce((sum, tx) => sum + tx.amount, 0);
    const ranked = [];

    for (const [cardId, cardBenefits] of cards.entries()) {
      const score = scoreCard(cardBenefits, previousMonthSpend, transactions);
      if (score <= 0) continue;
      const first = cardBenefits[0];
      ranked.push({
        card_id: cardId,
        card_name: first.card_name,
        card_company: first.card_company,
        estimated_discount: score,
      });
    }

    ranked.sort((left, right) => right.estimated_discount - left.estimated_discount || left.card_id - right.card_id);
    const top5 = ranked.slice(0, 5);
    const top2Score = top5[1]?.estimated_discount ?? 0;

    for (const [index, card] of top5.entries()) {
      rows.push({
        candidate_id: persona.candidate_id,
        persona_label: persona.persona_label,
        transaction_context: persona.transaction_context ?? '',
        rank: index + 1,
        card_id: card.card_id,
        card_name: card.card_name,
        card_company: card.card_company,
        estimated_discount: card.estimated_discount,
        effective_rate: totalSpend ? Math.round((card.estimated_discount / totalSpend) * 10000) / 100 : 0,
        margin_vs_next: index < top5.length - 1 ? card.estimated_discount - top5[index + 1].estimated_discount : '',
        margin_vs_top2: index === 0 ? card.estimated_discount - top2Score : '',
      });
    }
  }

  const outputPath = path.resolve(OUTPUT_DIR, 'selected_persona_top5_cards.csv');
  writeCsv(outputPath, rows);
  console.log(JSON.stringify(rows, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
