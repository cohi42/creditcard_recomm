const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CAFE_CATEGORY = '\uCE74\uD398';
const DEFAULT_DB_FILE = 'cafe_v3.db';
const DEFAULT_DB_PATH = path.resolve(__dirname, DEFAULT_DB_FILE);
const DEFAULT_CARD_IDS = [10, 105, 161, 208, 231, 263, 574];
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_YEAR = 2026;
const DEFAULT_REQUEST_DELAY_MS = 250;
const DEFAULT_API_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;

const SYSTEM_PROMPT = [
  '너는 카드 혜택 적용 여부를 판단하는 엔진이다.',
  '카드의 카페 혜택 정보(JSON)와 거래 1건이 주어진다.',
  '이 거래에 해당 혜택이 적용되는지 판단하고, 적용되면 할인 금액을 산출하라.',
  '반드시 아래 JSON만 출력하라. JSON 외 텍스트를 출력하지 마라.',
  '{"applicable": true/false, "discount_amount": 정수(원), "reasoning": "판단 근거"}',
].join('\n');

class ApiHttpError extends Error {
  constructor(status, bodyText) {
    super(`Gemini API HTTP ${status}: ${bodyText}`);
    this.name = 'ApiHttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = {
    dbPath: DEFAULT_DB_PATH,
    inputPath: path.resolve(__dirname, 'evaluation_input.json'),
    outputDir: path.resolve(__dirname, 'test_outputs', 'test_simulation'),
    outputXlsx: null,
    outputLog: null,
    outputSummaryJson: null,
    model: DEFAULT_MODEL,
    year: DEFAULT_YEAR,
    requestDelayMs: DEFAULT_REQUEST_DELAY_MS,
    apiRetries: DEFAULT_API_RETRIES,
    cardIds: [...DEFAULT_CARD_IDS],
    dryRun: false,
    maxCalls: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--db' && argv[index + 1]) {
      parsed.dbPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--input' && argv[index + 1]) {
      parsed.inputPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--output-dir' && argv[index + 1]) {
      parsed.outputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--output-xlsx' && argv[index + 1]) {
      parsed.outputXlsx = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--output-log' && argv[index + 1]) {
      parsed.outputLog = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--output-summary' && argv[index + 1]) {
      parsed.outputSummaryJson = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--model' && argv[index + 1]) {
      parsed.model = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--year' && argv[index + 1]) {
      parsed.year = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === '--request-delay-ms' && argv[index + 1]) {
      parsed.requestDelayMs = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === '--api-retries' && argv[index + 1]) {
      parsed.apiRetries = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === '--card-ids' && argv[index + 1]) {
      parsed.cardIds = String(argv[index + 1])
        .split(',')
        .map((token) => Number.parseInt(token.trim(), 10))
        .filter((value) => Number.isInteger(value));
      index += 1;
      continue;
    }
    if (arg === '--max-calls' && argv[index + 1]) {
      parsed.maxCalls = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    }
  }

  if (!Number.isInteger(parsed.year) || parsed.year < 2000 || parsed.year > 2100) {
    throw new Error(`--year must be an integer in [2000, 2100] (got: ${parsed.year})`);
  }
  if (!Number.isInteger(parsed.requestDelayMs) || parsed.requestDelayMs < 0) {
    throw new Error(`--request-delay-ms must be an integer >= 0 (got: ${parsed.requestDelayMs})`);
  }
  if (!Number.isInteger(parsed.apiRetries) || parsed.apiRetries < 1) {
    throw new Error(`--api-retries must be an integer >= 1 (got: ${parsed.apiRetries})`);
  }
  if (!Array.isArray(parsed.cardIds) || parsed.cardIds.length < 1) {
    throw new Error('--card-ids must contain at least one card id.');
  }
  if (parsed.maxCalls !== null && (!Number.isInteger(parsed.maxCalls) || parsed.maxCalls < 1)) {
    throw new Error(`--max-calls must be an integer >= 1 (got: ${parsed.maxCalls})`);
  }

  if (!parsed.outputXlsx) {
    parsed.outputXlsx = path.resolve(parsed.outputDir, 'test_experiment_result.xlsx');
  }
  if (!parsed.outputLog) {
    parsed.outputLog = path.resolve(parsed.outputDir, 'test_llm_decision_log.jsonl');
  }
  if (!parsed.outputSummaryJson) {
    parsed.outputSummaryJson = path.resolve(parsed.outputDir, 'test_run_summary.json');
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage:
  node recommendation_testing_pipeline.js [options]

Options:
  --db <path>                 SQLite DB path (default: ./${DEFAULT_DB_FILE})
  --input <path>              evaluation_input.json path
  --output-dir <path>         output directory
  --output-xlsx <path>        output XLSX path
  --output-log <path>         output JSONL log path
  --output-summary <path>     output summary JSON path
  --model <name>              Gemini model (default: gemini-2.5-flash)
  --year <yyyy>               year for sorting month/day transactions (default: 2026)
  --request-delay-ms <n>      delay between API calls in ms (default: 250)
  --api-retries <n>           retry count per API call (default: 5)
  --card-ids <csv>            card ids (default: 10,105,161,208,231,263,574)
  --max-calls <n>             stop after N calls (for smoke testing)
  --dry-run                   skip API calls and emit mock non-applicable decisions
  -h, --help                  show this help

Environment variable:
  GEMINI_API_KEY
`);
  process.exit(0);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex <= 0) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseMonthDay(rawDate) {
  const parts = String(rawDate)
    .split('/')
    .map((token) => Number.parseInt(token.trim(), 10));
  if (parts.length !== 2 || !Number.isInteger(parts[0]) || !Number.isInteger(parts[1])) {
    throw new Error(`Invalid date format (expected M/D): ${rawDate}`);
  }
  return { month: parts[0], day: parts[1] };
}

function parseHourMinute(rawTime) {
  const parts = String(rawTime)
    .split(':')
    .map((token) => Number.parseInt(token.trim(), 10));
  if (parts.length !== 2 || !Number.isInteger(parts[0]) || !Number.isInteger(parts[1])) {
    throw new Error(`Invalid time format (expected HH:MM): ${rawTime}`);
  }
  return { hour: parts[0], minute: parts[1] };
}

function toTransactionSortKey(tx, year) {
  const { month, day } = parseMonthDay(tx.date);
  const { hour, minute } = parseHourMinute(tx.time);
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0);
}

function normalizeTransactions(transactions, year) {
  const normalized = transactions.map((tx) => ({
    id: Number(tx.id),
    date: String(tx.date),
    time: String(tx.time),
    merchant: String(tx.merchant),
    amount: Number(tx.amount),
    _sortKey: toTransactionSortKey(tx, year),
  }));

  normalized.sort((a, b) => {
    if (a._sortKey !== b._sortKey) return a._sortKey - b._sortKey;
    return a.id - b.id;
  });

  return normalized;
}

function loadCardData(dbPath, cardIds) {
  const db = new DatabaseSync(dbPath);
  const placeholders = cardIds.map(() => '?').join(',');

  const cardRows = db
    .prepare(
      `SELECT card_id, card_name, card_company
       FROM cards
       WHERE card_id IN (${placeholders})
       ORDER BY card_id`
    )
    .all(...cardIds);

  const benefitsRows = db
    .prepare(
      `SELECT
         benefit_id,
         card_id,
         category,
         discount_rate,
         discount_amount,
         discount_type,
         frequency_limit,
         per_transaction_limit,
         monthly_discount_limit,
         min_spend
       FROM benefits
       WHERE card_id IN (${placeholders})
         AND category = ?
       ORDER BY card_id, benefit_id`
    )
    .all(...cardIds, CAFE_CATEGORY);

  const benefitIds = benefitsRows.map((row) => row.benefit_id);

  const brandsByBenefitId = new Map();
  const exclusionsByBenefitId = new Map();
  const tiersByBenefitId = new Map();

  if (benefitIds.length > 0) {
    const benefitPlaceholders = benefitIds.map(() => '?').join(',');

    const brandRows = db
      .prepare(
        `SELECT bb.benefit_id, br.brand_name
         FROM benefit_brands AS bb
         JOIN brands AS br ON br.brand_id = bb.brand_id
         WHERE bb.benefit_id IN (${benefitPlaceholders})
         ORDER BY bb.benefit_id, br.brand_name`
      )
      .all(...benefitIds);

    for (const row of brandRows) {
      if (!brandsByBenefitId.has(row.benefit_id)) {
        brandsByBenefitId.set(row.benefit_id, []);
      }
      brandsByBenefitId.get(row.benefit_id).push(row.brand_name);
    }

    const exclusionRows = db
      .prepare(
        `SELECT benefit_id, exclusion_type
         FROM exclusions
         WHERE benefit_id IN (${benefitPlaceholders})
         ORDER BY benefit_id, exclusion_id`
      )
      .all(...benefitIds);

    for (const row of exclusionRows) {
      if (!exclusionsByBenefitId.has(row.benefit_id)) {
        exclusionsByBenefitId.set(row.benefit_id, []);
      }
      exclusionsByBenefitId.get(row.benefit_id).push(row.exclusion_type);
    }

    const tierRows = db
      .prepare(
        `SELECT benefit_id, min_spend, max_spend, monthly_limit
         FROM performance_tiers
         WHERE benefit_id IN (${benefitPlaceholders})
         ORDER BY benefit_id, min_spend`
      )
      .all(...benefitIds);

    for (const row of tierRows) {
      if (!tiersByBenefitId.has(row.benefit_id)) {
        tiersByBenefitId.set(row.benefit_id, []);
      }
      tiersByBenefitId.get(row.benefit_id).push({
        min_spend: row.min_spend,
        max_spend: row.max_spend,
        monthly_limit: row.monthly_limit,
      });
    }
  }

  const cardsById = new Map();
  for (const cardRow of cardRows) {
    cardsById.set(cardRow.card_id, {
      card_id: cardRow.card_id,
      card_name: cardRow.card_name,
      card_company: cardRow.card_company,
      benefits: [],
    });
  }

  for (const benefitRow of benefitsRows) {
    const card = cardsById.get(benefitRow.card_id);
    if (!card) continue;

    card.benefits.push({
      benefit_id: benefitRow.benefit_id,
      category: benefitRow.category,
      discount_rate: benefitRow.discount_rate,
      discount_amount: benefitRow.discount_amount,
      discount_type: benefitRow.discount_type,
      frequency_limit: benefitRow.frequency_limit,
      per_transaction_limit: benefitRow.per_transaction_limit,
      monthly_discount_limit: benefitRow.monthly_discount_limit,
      min_spend: benefitRow.min_spend,
      performance_tiers: tiersByBenefitId.get(benefitRow.benefit_id) ?? [],
      brands: brandsByBenefitId.get(benefitRow.benefit_id) ?? [],
      exclusions: exclusionsByBenefitId.get(benefitRow.benefit_id) ?? [],
    });
  }

  db.close();

  const cards = [];
  for (const cardId of cardIds) {
    const card = cardsById.get(cardId);
    if (!card) {
      throw new Error(`Card not found in DB: ${cardId}`);
    }
    if (!Array.isArray(card.benefits) || card.benefits.length < 1) {
      throw new Error(`No cafe benefits found in DB for card_id=${cardId}`);
    }
    cards.push(card);
  }

  return cards;
}

function toIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric);
}

function parseFrequencyLimit(text) {
  if (!text) {
    return { dailyLimit: null, monthlyLimit: null };
  }

  const normalized = String(text).replace(/\s+/g, '');
  let dailyLimit = null;
  let monthlyLimit = null;

  const dailyMatch = normalized.match(/(?:1일|일)(\d+)회/);
  if (dailyMatch) {
    dailyLimit = Number.parseInt(dailyMatch[1], 10);
  }

  const monthlyMatch = normalized.match(/월(\d+)회/);
  if (monthlyMatch) {
    monthlyLimit = Number.parseInt(monthlyMatch[1], 10);
  }

  if (!Number.isInteger(dailyLimit) || dailyLimit <= 0) {
    dailyLimit = null;
  }
  if (!Number.isInteger(monthlyLimit) || monthlyLimit <= 0) {
    monthlyLimit = null;
  }

  return { dailyLimit, monthlyLimit };
}

function resolveTierMonthlyLimit(benefit, previousMonthSpending) {
  const tiers = Array.isArray(benefit.performance_tiers) ? benefit.performance_tiers : [];
  if (tiers.length < 1) {
    return null;
  }

  const sortedTiers = [...tiers].sort((a, b) => {
    const left = toIntegerOrNull(a.min_spend) ?? 0;
    const right = toIntegerOrNull(b.min_spend) ?? 0;
    return left - right;
  });

  for (const tier of sortedTiers) {
    const minSpend = toIntegerOrNull(tier.min_spend) ?? 0;
    const maxSpend = toIntegerOrNull(tier.max_spend);
    const monthlyLimit = toIntegerOrNull(tier.monthly_limit) ?? 0;

    const lowerOk = previousMonthSpending >= minSpend;
    const upperOk = maxSpend === null ? true : previousMonthSpending < maxSpend;
    if (lowerOk && upperOk) {
      return monthlyLimit;
    }
  }

  return 0;
}

function resolveMonthlyAmountCap(benefit, previousMonthSpending) {
  const tierLimit = resolveTierMonthlyLimit(benefit, previousMonthSpending);
  if (tierLimit !== null) {
    return tierLimit;
  }

  const monthlyDiscountLimit = toIntegerOrNull(benefit.monthly_discount_limit);
  const minSpend = toIntegerOrNull(benefit.min_spend);

  // Heuristic: 10만원 이상 min_spend는 전월 실적 조건일 가능성이 높음.
  if (minSpend !== null && minSpend >= 100000 && previousMonthSpending < minSpend) {
    return 0;
  }

  return monthlyDiscountLimit;
}

function combineCaps(values) {
  const filtered = values.filter((value) => Number.isInteger(value) && value >= 0);
  if (filtered.length < 1) {
    return null;
  }
  return Math.min(...filtered);
}

function buildCardPolicy(card, previousMonthSpending) {
  const dailyCaps = [];
  const monthlyCountCaps = [];
  const perTransactionCaps = [];
  const monthlyAmountCaps = [];

  for (const benefit of card.benefits) {
    const parsedFrequency = parseFrequencyLimit(benefit.frequency_limit);
    if (parsedFrequency.dailyLimit !== null) {
      dailyCaps.push(parsedFrequency.dailyLimit);
    }
    if (parsedFrequency.monthlyLimit !== null) {
      monthlyCountCaps.push(parsedFrequency.monthlyLimit);
    }

    const perTransactionLimit = toIntegerOrNull(benefit.per_transaction_limit);
    if (perTransactionLimit !== null && perTransactionLimit >= 0) {
      perTransactionCaps.push(perTransactionLimit);
    }

    const monthlyAmountCap = resolveMonthlyAmountCap(benefit, previousMonthSpending);
    if (monthlyAmountCap !== null) {
      monthlyAmountCaps.push(monthlyAmountCap);
    }
  }

  return {
    dailyCountCap: combineCaps(dailyCaps),
    monthlyCountCap: combineCaps(monthlyCountCaps),
    perTransactionCap: combineCaps(perTransactionCaps),
    monthlyAmountCap: combineCaps(monthlyAmountCaps),
  };
}

function initCardState(policy) {
  return {
    dailyCounts: new Map(),
    monthlyCount: 0,
    monthlyRemainingAmount: policy.monthlyAmountCap,
    totalDiscount: 0,
  };
}

function applyPostProcessing({
  decision,
  transaction,
  policy,
  state,
}) {
  const rawAmount = decision.applicable ? Math.max(0, Math.floor(Number(decision.discount_amount) || 0)) : 0;
  const post = {
    beforePostprocessAmount: rawAmount,
    afterPerTransactionCapAmount: rawAmount,
    finalAmount: 0,
    blockedBy: null,
  };

  if (rawAmount <= 0) {
    return post;
  }

  const dayKey = transaction.date;
  const currentDailyCount = state.dailyCounts.get(dayKey) ?? 0;

  if (policy.dailyCountCap !== null && currentDailyCount >= policy.dailyCountCap) {
    post.blockedBy = 'DAILY_COUNT_LIMIT';
    return post;
  }
  if (policy.monthlyCountCap !== null && state.monthlyCount >= policy.monthlyCountCap) {
    post.blockedBy = 'MONTHLY_COUNT_LIMIT';
    return post;
  }

  let amount = rawAmount;
  if (policy.perTransactionCap !== null) {
    amount = Math.min(amount, policy.perTransactionCap);
  }
  post.afterPerTransactionCapAmount = amount;

  if (policy.monthlyAmountCap !== null) {
    const remaining = state.monthlyRemainingAmount ?? 0;
    if (remaining <= 0) {
      post.blockedBy = 'MONTHLY_AMOUNT_LIMIT';
      return post;
    }
    amount = Math.min(amount, remaining);
    if (amount <= 0) {
      post.blockedBy = 'MONTHLY_AMOUNT_LIMIT';
      return post;
    }
  }

  amount = Math.max(0, Math.floor(amount));
  if (amount <= 0) {
    return post;
  }

  state.dailyCounts.set(dayKey, currentDailyCount + 1);
  state.monthlyCount += 1;
  if (policy.monthlyAmountCap !== null && state.monthlyRemainingAmount !== null) {
    state.monthlyRemainingAmount -= amount;
  }
  state.totalDiscount += amount;

  post.finalAmount = amount;
  return post;
}

function buildCardPromptPayload(card) {
  return {
    card_id: card.card_id,
    card_name: card.card_name,
    card_company: card.card_company,
    benefits: card.benefits.map((benefit) => ({
      benefit_id: benefit.benefit_id,
      category: benefit.category,
      discount_rate: benefit.discount_rate,
      discount_amount: benefit.discount_amount,
      discount_type: benefit.discount_type,
      frequency_limit: benefit.frequency_limit,
      per_transaction_limit: benefit.per_transaction_limit,
      monthly_discount_limit: benefit.monthly_discount_limit,
      min_spend: benefit.min_spend,
      performance_tiers: benefit.performance_tiers,
      brands: benefit.brands,
      exclusions: benefit.exclusions,
    })),
  };
}

function buildUserPrompt({ persona, transaction, cardPayload }) {
  return [
    '아래 정보를 바탕으로 거래 1건에 대해 할인 적용 여부를 판단하라.',
    '### Persona',
    JSON.stringify(persona),
    '### Transaction',
    JSON.stringify({
      id: transaction.id,
      date: transaction.date,
      time: transaction.time,
      merchant: transaction.merchant,
      amount: transaction.amount,
    }),
    '### CardBenefitDataFromDB',
    JSON.stringify(cardPayload),
  ].join('\n\n');
}

function looksLikeUnknownSystemInstructionError(error) {
  if (!(error instanceof ApiHttpError)) return false;
  if (error.status !== 400) return false;
  const lowered = String(error.bodyText).toLowerCase();
  return lowered.includes('system_instruction') || lowered.includes('systeminstruction');
}

async function callGeminiOnce({ apiKey, model, userPrompt, useSystemInstruction }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  };

  if (useSystemInstruction) {
    requestBody.system_instruction = {
      parts: [{ text: SYSTEM_PROMPT }],
    };
  } else {
    requestBody.contents[0].parts.unshift({ text: SYSTEM_PROMPT });
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new ApiHttpError(response.status, bodyText);
  }

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(bodyText);
  } catch {
    throw new Error(`Gemini API returned non-JSON envelope: ${bodyText.slice(0, 500)}`);
  }

  const parts = parsedResponse?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length < 1) {
    throw new Error(`Gemini API response missing candidate text: ${bodyText.slice(0, 500)}`);
  }

  const text = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();

  if (!text) {
    throw new Error(`Gemini API response text is empty: ${bodyText.slice(0, 500)}`);
  }

  return text;
}

async function callGeminiWithBackoff({ apiKey, model, userPrompt, apiRetries }) {
  let useSystemInstruction = true;
  let lastError = null;

  for (let attempt = 1; attempt <= apiRetries; attempt += 1) {
    try {
      return await callGeminiOnce({
        apiKey,
        model,
        userPrompt,
        useSystemInstruction,
      });
    } catch (error) {
      if (useSystemInstruction && looksLikeUnknownSystemInstructionError(error)) {
        useSystemInstruction = false;
        continue;
      }

      lastError = error;
      if (attempt >= apiRetries) {
        break;
      }

      const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

function extractJsonText(rawText) {
  const trimmed = String(rawText).trim();
  if (!trimmed) {
    throw new Error('Model output is empty.');
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const inside = fenced[1].trim();
    JSON.parse(inside);
    return inside;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = trimmed.slice(firstBrace, lastBrace + 1);
    JSON.parse(sliced);
    return sliced;
  }

  throw new Error(`Could not extract JSON from model output: ${trimmed.slice(0, 500)}`);
}

function normalizeModelDecision(rawText) {
  const jsonText = extractJsonText(rawText);
  const parsed = JSON.parse(jsonText);

  const applicableRaw = parsed?.applicable;
  const applicable =
    typeof applicableRaw === 'boolean'
      ? applicableRaw
      : String(applicableRaw).toLowerCase() === 'true';

  const discountNumeric = Number(parsed?.discount_amount);
  const discountAmount = Number.isFinite(discountNumeric)
    ? Math.max(0, Math.floor(discountNumeric))
    : 0;

  const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning.trim() : '';

  return {
    applicable,
    discount_amount: applicable ? discountAmount : 0,
    reasoning,
    _raw_parsed_object: parsed,
  };
}

async function getModelDecision({
  dryRun,
  apiKey,
  model,
  persona,
  transaction,
  cardPayload,
  apiRetries,
}) {
  if (dryRun) {
    return {
      rawText: '{"applicable":false,"discount_amount":0,"reasoning":"dry-run"}',
      normalized: {
        applicable: false,
        discount_amount: 0,
        reasoning: 'dry-run',
        _raw_parsed_object: {
          applicable: false,
          discount_amount: 0,
          reasoning: 'dry-run',
        },
      },
    };
  }

  const userPrompt = buildUserPrompt({ persona, transaction, cardPayload });
  const rawText = await callGeminiWithBackoff({
    apiKey,
    model,
    userPrompt,
    apiRetries,
  });
  const normalized = normalizeModelDecision(rawText);
  return { rawText, normalized };
}

function makeResultMatrix(personas, transactions, cards) {
  const matrix = {};
  for (const persona of personas) {
    const personaKey = String(persona.persona);
    matrix[personaKey] = {};
    for (const tx of transactions) {
      matrix[personaKey][tx.id] = {};
      for (const card of cards) {
        matrix[personaKey][tx.id][card.card_id] = 0;
      }
    }
  }
  return matrix;
}

function columnNameFromIndex(index1Based) {
  let column = '';
  let value = index1Based;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

function cellRef(row1Based, col1Based) {
  return `${columnNameFromIndex(col1Based)}${row1Based}`;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildWorksheetXml(rows) {
  let maxCol = 1;
  for (const row of rows) {
    if (Array.isArray(row) && row.length > maxCol) {
      maxCol = row.length;
    }
  }

  const rowXmlParts = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rowNumber = rowIndex + 1;
    const row = rows[rowIndex] ?? [];
    const cellXmlParts = [];

    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      const colNumber = colIndex + 1;
      const value = row[colIndex];
      if (value === null || value === undefined || value === '') {
        continue;
      }

      const ref = cellRef(rowNumber, colNumber);

      if (typeof value === 'number' && Number.isFinite(value)) {
        cellXmlParts.push(`<c r="${ref}"><v>${value}</v></c>`);
        continue;
      }

      if (
        typeof value === 'object' &&
        value !== null &&
        Object.prototype.hasOwnProperty.call(value, 'formula')
      ) {
        const cachedValue =
          typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : 0;
        const formula = escapeXml(String(value.formula));
        cellXmlParts.push(`<c r="${ref}"><f>${formula}</f><v>${cachedValue}</v></c>`);
        continue;
      }

      const text = escapeXml(String(value));
      const preserve = /^\s|\s$/.test(String(value)) ? ' xml:space="preserve"' : '';
      cellXmlParts.push(`<c r="${ref}" t="inlineStr"><is><t${preserve}>${text}</t></is></c>`);
    }

    if (cellXmlParts.length > 0) {
      rowXmlParts.push(`<row r="${rowNumber}">${cellXmlParts.join('')}</row>`);
    }
  }

  const dimensionRef = `A1:${cellRef(Math.max(rows.length, 1), Math.max(maxCol, 1))}`;

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="${dimensionRef}"/>`,
    '<sheetData>',
    rowXmlParts.join(''),
    '</sheetData>',
    '</worksheet>',
  ].join('');
}

function buildExperimentSheetRows({ personas, transactions, cards, matrix }) {
  const rows = [];

  const header = ['transaction_id', 'date', 'time', 'merchant', 'amount'];
  for (const persona of personas) {
    for (const card of cards) {
      header.push(`${persona.persona}_card_${card.card_id}`);
    }
  }
  rows.push(header);

  for (const tx of transactions) {
    const row = [tx.id, tx.date, tx.time, tx.merchant, tx.amount];
    for (const persona of personas) {
      const personaKey = String(persona.persona);
      for (const card of cards) {
        row.push(matrix[personaKey][tx.id][card.card_id]);
      }
    }
    rows.push(row);
  }

  return rows;
}

function buildComparisonSheetRows({ personas, transactions, cards, matrix }) {
  const rows = [];
  const cellMap = [];

  const header = ['transaction_id', 'date', 'time', 'merchant', 'amount'];
  let currentCol = 6;

  for (const persona of personas) {
    for (const card of cards) {
      const expCol = currentCol;
      const gtCol = currentCol + 1;
      const diffCol = currentCol + 2;
      header.push(`EXP_${persona.persona}_${card.card_id}`);
      header.push(`GT_${persona.persona}_${card.card_id}`);
      header.push(`DIFF_${persona.persona}_${card.card_id}`);
      cellMap.push({
        persona: String(persona.persona),
        card_id: card.card_id,
        card_name: card.card_name,
        expCol,
        gtCol,
        diffCol,
      });
      currentCol += 3;
    }
  }

  rows.push(header);

  for (let txIndex = 0; txIndex < transactions.length; txIndex += 1) {
    const tx = transactions[txIndex];
    const rowNumber = txIndex + 2;
    const row = [tx.id, tx.date, tx.time, tx.merchant, tx.amount];

    for (const meta of cellMap) {
      const expValue = matrix[meta.persona][tx.id][meta.card_id];
      const expRef = cellRef(rowNumber, meta.expCol);
      const gtRef = cellRef(rowNumber, meta.gtCol);
      row.push(expValue);
      row.push('');
      row.push({
        formula: `IF(ISNUMBER(${gtRef}),${gtRef}-${expRef},"")`,
        value: 0,
      });
    }

    rows.push(row);
  }

  const txStartRow = 2;
  const txEndRow = transactions.length + 1;

  const sectionTitleRow = txEndRow + 3;
  rows[sectionTitleRow - 1] = ['CARD_TOTAL_AND_RANK_TEMPLATE'];

  const totalsHeaderRow = sectionTitleRow + 1;
  rows[totalsHeaderRow - 1] = [
    'persona',
    'card_id',
    'card_name',
    'exp_total',
    'gt_total',
    'total_diff',
    'exp_rank',
    'gt_rank',
    'rank_gap(gt-exp)',
  ];

  const totalsStartRow = totalsHeaderRow + 1;
  let totalsCursor = totalsStartRow;

  for (let pIndex = 0; pIndex < personas.length; pIndex += 1) {
    const persona = personas[pIndex];
    const personaRows = [];

    for (const card of cards) {
      const meta = cellMap.find(
        (item) => item.persona === String(persona.persona) && item.card_id === card.card_id
      );
      if (!meta) continue;

      const expRange = `${columnNameFromIndex(meta.expCol)}${txStartRow}:${columnNameFromIndex(meta.expCol)}${txEndRow}`;
      const gtRange = `${columnNameFromIndex(meta.gtCol)}${txStartRow}:${columnNameFromIndex(meta.gtCol)}${txEndRow}`;

      rows[totalsCursor - 1] = [
        String(persona.persona),
        card.card_id,
        card.card_name,
        { formula: `SUM(${expRange})`, value: 0 },
        { formula: `SUM(${gtRange})`, value: 0 },
        {
          formula: `IF(COUNT(${gtRange})=0,"",SUM(${gtRange})-SUM(${expRange}))`,
          value: 0,
        },
        '',
        '',
        '',
      ];

      personaRows.push(totalsCursor);
      totalsCursor += 1;
    }

    if (personaRows.length > 0) {
      const firstRow = personaRows[0];
      const lastRow = personaRows[personaRows.length - 1];
      for (const rowNumber of personaRows) {
        rows[rowNumber - 1][6] = {
          formula: `RANK.EQ(D${rowNumber},$D$${firstRow}:$D$${lastRow},0)`,
          value: 0,
        };
        rows[rowNumber - 1][7] = {
          formula: `IF(COUNT($E$${firstRow}:$E$${lastRow})=0,"",RANK.EQ(E${rowNumber},$E$${firstRow}:$E$${lastRow},0))`,
          value: 0,
        };
        rows[rowNumber - 1][8] = {
          formula: `IF(OR(G${rowNumber}="",H${rowNumber}=""),"",H${rowNumber}-G${rowNumber})`,
          value: 0,
        };
      }
    }
  }

  return rows;
}

function buildLogMetaSheetRows({
  args,
  personas,
  transactions,
  cards,
  totalCallsPlanned,
  totalCallsExecuted,
  successCalls,
  failedCalls,
  outputXlsx,
  outputLog,
}) {
  return [
    ['key', 'value'],
    ['generated_at_utc', new Date().toISOString()],
    ['model', args.model],
    ['dry_run', String(args.dryRun)],
    ['db_path', args.dbPath],
    ['input_path', args.inputPath],
    ['output_xlsx', outputXlsx],
    ['output_log_jsonl', outputLog],
    ['persona_count', personas.length],
    ['transaction_count', transactions.length],
    ['card_count', cards.length],
    ['total_calls_planned', totalCallsPlanned],
    ['total_calls_executed', totalCallsExecuted],
    ['success_calls', successCalls],
    ['failed_calls', failedCalls],
    ['note_1', 'Error_Comparison 시트의 GT_* 열은 수동 입력 칸입니다.'],
    ['note_2', 'DIFF_* 및 total/rank 공식은 GT 입력 후 자동 계산됩니다.'],
  ];
}

function buildStylesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>',
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>',
  ].join('');
}

function buildWorkbookXml(sheetDefs) {
  const sheetsXml = sheetDefs
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )
    .join('');

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets>${sheetsXml}</sheets>`,
    '</workbook>',
  ].join('');
}

function buildWorkbookRelsXml(sheetDefs) {
  const rels = [];
  for (let index = 0; index < sheetDefs.length; index += 1) {
    rels.push(
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    );
  }
  rels.push(
    `<Relationship Id="rId${sheetDefs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  );

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    rels.join(''),
    '</Relationships>',
  ].join('');
}

function buildRootRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    '</Relationships>',
  ].join('');
}

function buildContentTypesXml(sheetDefs) {
  const sheetOverrides = sheetDefs
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('');

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    sheetOverrides,
    '</Types>',
  ].join('');
}

function buildCorePropsXml() {
  const now = new Date().toISOString();
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<dc:creator>week7_recommendation_pipeline</dc:creator>',
    '<cp:lastModifiedBy>week7_recommendation_pipeline</cp:lastModifiedBy>',
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>',
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>',
    '</cp:coreProperties>',
  ].join('');
}

function buildAppPropsXml(sheetDefs) {
  const titles = sheetDefs
    .map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`)
    .join('');

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<Application>Node.js</Application>',
    '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>' +
      sheetDefs.length +
      '</vt:i4></vt:variant></vt:vector></HeadingPairs>',
    `<TitlesOfParts><vt:vector size="${sheetDefs.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>`,
    '</Properties>',
  ].join('');
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((value & 1) !== 0) {
        value = 0xedb88320 ^ (value >>> 1);
      } else {
        value >>>= 1;
      }
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | ((Math.floor(seconds / 2)) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);

  return { dosDate, dosTime };
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const { dosDate, dosTime } = toDosDateTime(now);

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    const nameBuffer = Buffer.from(name, 'utf8');
    const dataBuffer = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');

    const crc = crc32(dataBuffer);
    const size = dataBuffer.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + size;
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralDirectoryOffset = offset;
  const entryCount = entries.length;

  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0);
  endOfCentral.writeUInt16LE(0, 4);
  endOfCentral.writeUInt16LE(0, 6);
  endOfCentral.writeUInt16LE(entryCount, 8);
  endOfCentral.writeUInt16LE(entryCount, 10);
  endOfCentral.writeUInt32LE(centralDirectorySize, 12);
  endOfCentral.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentral.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endOfCentral]);
}

function writeWorkbookXlsx(outputPath, sheetDefs) {
  const entries = [];

  entries.push({ name: '[Content_Types].xml', data: buildContentTypesXml(sheetDefs) });
  entries.push({ name: '_rels/.rels', data: buildRootRelsXml() });
  entries.push({ name: 'docProps/core.xml', data: buildCorePropsXml() });
  entries.push({ name: 'docProps/app.xml', data: buildAppPropsXml(sheetDefs) });
  entries.push({ name: 'xl/workbook.xml', data: buildWorkbookXml(sheetDefs) });
  entries.push({ name: 'xl/_rels/workbook.xml.rels', data: buildWorkbookRelsXml(sheetDefs) });
  entries.push({ name: 'xl/styles.xml', data: buildStylesXml() });

  for (let index = 0; index < sheetDefs.length; index += 1) {
    const sheet = sheetDefs[index];
    entries.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: buildWorksheetXml(sheet.rows),
    });
  }

  const zipBuffer = createStoredZip(entries);
  fs.writeFileSync(outputPath, zipBuffer);
}

async function runSimulation(args) {
  if (!fs.existsSync(args.dbPath)) {
    throw new Error(`DB not found: ${args.dbPath}`);
  }
  if (!fs.existsSync(args.inputPath)) {
    throw new Error(`Input JSON not found: ${args.inputPath}`);
  }

  loadDotEnv(path.resolve(__dirname, '.env'));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!args.dryRun && !apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }

  ensureDir(args.outputDir);

  const evaluationInput = parseJsonFile(args.inputPath);
  const personas = Array.isArray(evaluationInput.personas) ? evaluationInput.personas : [];
  const transactions = normalizeTransactions(
    Array.isArray(evaluationInput.transactions) ? evaluationInput.transactions : [],
    args.year
  );

  if (personas.length < 1) {
    throw new Error('No personas found in evaluation_input.json.');
  }
  if (transactions.length < 1) {
    throw new Error('No transactions found in evaluation_input.json.');
  }

  const cards = loadCardData(args.dbPath, args.cardIds);
  const cardPayloads = new Map();
  for (const card of cards) {
    cardPayloads.set(card.card_id, buildCardPromptPayload(card));
  }

  const matrix = makeResultMatrix(personas, transactions, cards);
  const totals = {};
  for (const persona of personas) {
    const personaKey = String(persona.persona);
    totals[personaKey] = {};
    for (const card of cards) {
      totals[personaKey][card.card_id] = 0;
    }
  }

  const logStream = fs.createWriteStream(args.outputLog, { encoding: 'utf8' });

  const totalCallsPlanned = personas.length * transactions.length * cards.length;
  let totalCallsExecuted = 0;
  let successCalls = 0;
  let failedCalls = 0;

  try {
    for (const persona of personas) {
      const personaKey = String(persona.persona);
      const previousMonthSpending = Number(persona.previous_month_spending) || 0;

      const policies = new Map();
      const states = new Map();

      for (const card of cards) {
        const policy = buildCardPolicy(card, previousMonthSpending);
        policies.set(card.card_id, policy);
        states.set(card.card_id, initCardState(policy));
      }

      for (const transaction of transactions) {
        for (const card of cards) {
          if (args.maxCalls !== null && totalCallsExecuted >= args.maxCalls) {
            break;
          }

          totalCallsExecuted += 1;
          const progress = `[${totalCallsExecuted}/${args.maxCalls !== null ? Math.min(args.maxCalls, totalCallsPlanned) : totalCallsPlanned}]`;

          let rawModelText = null;
          let normalizedDecision = null;
          let modelError = null;

          try {
            const decision = await getModelDecision({
              dryRun: args.dryRun,
              apiKey,
              model: args.model,
              persona: {
                persona: persona.persona,
                previous_month_spending: previousMonthSpending,
              },
              transaction,
              cardPayload: cardPayloads.get(card.card_id),
              apiRetries: args.apiRetries,
            });
            rawModelText = decision.rawText;
            normalizedDecision = decision.normalized;
            successCalls += 1;
          } catch (error) {
            modelError = error;
            failedCalls += 1;
            rawModelText = String(error instanceof Error ? error.stack ?? error.message : error);
            normalizedDecision = {
              applicable: false,
              discount_amount: 0,
              reasoning: `MODEL_ERROR: ${error instanceof Error ? error.message : String(error)}`,
              _raw_parsed_object: null,
            };
          }

          const policy = policies.get(card.card_id);
          const state = states.get(card.card_id);

          const post = applyPostProcessing({
            decision: normalizedDecision,
            transaction,
            policy,
            state,
          });

          matrix[personaKey][transaction.id][card.card_id] = post.finalAmount;
          totals[personaKey][card.card_id] += post.finalAmount;

          const logRecord = {
            ts_utc: new Date().toISOString(),
            call_index: totalCallsExecuted,
            persona: {
              persona: persona.persona,
              previous_month_spending: previousMonthSpending,
            },
            card: {
              card_id: card.card_id,
              card_name: card.card_name,
            },
            transaction: {
              id: transaction.id,
              date: transaction.date,
              time: transaction.time,
              merchant: transaction.merchant,
              amount: transaction.amount,
            },
            llm_raw_text: rawModelText,
            llm_normalized: {
              applicable: normalizedDecision.applicable,
              discount_amount: normalizedDecision.discount_amount,
              reasoning: normalizedDecision.reasoning,
            },
            llm_raw_parsed_object: normalizedDecision._raw_parsed_object,
            postprocess: {
              policy,
              before_postprocess_amount: post.beforePostprocessAmount,
              after_per_transaction_cap_amount: post.afterPerTransactionCapAmount,
              blocked_by: post.blockedBy,
              final_amount: post.finalAmount,
              state_snapshot: {
                monthly_count: state.monthlyCount,
                monthly_remaining_amount: state.monthlyRemainingAmount,
                total_discount: state.totalDiscount,
              },
            },
            model_error: modelError ? String(modelError instanceof Error ? modelError.message : modelError) : null,
          };

          logStream.write(`${JSON.stringify(logRecord)}\n`);

          console.log(
            `${progress} persona=${persona.persona} tx=${transaction.id} card=${card.card_id} llm=${normalizedDecision.discount_amount} final=${post.finalAmount}${post.blockedBy ? ` blocked=${post.blockedBy}` : ''}${modelError ? ' [MODEL_ERROR]' : ''}`
          );

          const effectiveMaxCalls = args.maxCalls !== null ? Math.min(args.maxCalls, totalCallsPlanned) : totalCallsPlanned;
          if (args.requestDelayMs > 0 && totalCallsExecuted < effectiveMaxCalls) {
            await sleep(args.requestDelayMs);
          }
        }

        if (args.maxCalls !== null && totalCallsExecuted >= args.maxCalls) {
          break;
        }
      }

      if (args.maxCalls !== null && totalCallsExecuted >= args.maxCalls) {
        break;
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      logStream.on('error', reject);
      logStream.end(resolve);
    });
  }

  const experimentSheetRows = buildExperimentSheetRows({
    personas,
    transactions,
    cards,
    matrix,
  });

  const comparisonSheetRows = buildComparisonSheetRows({
    personas,
    transactions,
    cards,
    matrix,
  });

  const logMetaSheetRows = buildLogMetaSheetRows({
    args,
    personas,
    transactions,
    cards,
    totalCallsPlanned,
    totalCallsExecuted,
    successCalls,
    failedCalls,
    outputXlsx: args.outputXlsx,
    outputLog: args.outputLog,
  });

  writeWorkbookXlsx(args.outputXlsx, [
    { name: 'Experiment_Result', rows: experimentSheetRows },
    { name: 'Error_Comparison', rows: comparisonSheetRows },
    { name: 'Log_Metadata', rows: logMetaSheetRows },
  ]);

  const summary = {
    generated_at_utc: new Date().toISOString(),
    model: args.model,
    dry_run: args.dryRun,
    db_path: args.dbPath,
    input_path: args.inputPath,
    output_xlsx: args.outputXlsx,
    output_log_jsonl: args.outputLog,
    personas: personas.map((persona) => ({
      persona: persona.persona,
      previous_month_spending: persona.previous_month_spending,
    })),
    card_ids: cards.map((card) => card.card_id),
    total_calls_planned: totalCallsPlanned,
    total_calls_executed: totalCallsExecuted,
    success_calls: successCalls,
    failed_calls: failedCalls,
    totals,
  };

  fs.writeFileSync(args.outputSummaryJson, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== Done ===');
  console.log(`Output XLSX: ${args.outputXlsx}`);
  console.log(`Output LLM log: ${args.outputLog}`);
  console.log(`Output summary JSON: ${args.outputSummaryJson}`);
  console.log(`Calls executed: ${totalCallsExecuted}/${totalCallsPlanned}`);
  console.log(`Success: ${successCalls}, Failed: ${failedCalls}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await runSimulation(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
