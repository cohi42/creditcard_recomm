const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CAFE_CATEGORY = '\uCE74\uD398';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_PARSE_RETRY_COUNT = 2;
const DEFAULT_API_RETRY_COUNT = 5;
const DEFAULT_REQUEST_DELAY_MS = 500;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_NOTICE_CATEGORY = '\uC720\uC758\uC0AC\uD56D';
const BASE_BACKOFF_MS = 1000;

const SIMPLE_FIELDS = [
  'discount_rate',
  'discount_amount',
  'discount_type',
  'frequency_limit',
  'per_transaction_limit',
  'monthly_discount_limit',
  'min_spend',
];

const SYSTEM_PROMPT = `
너는 신용카드 혜택의 1차 정형화 결과를 카드 공통 조건 텍스트로 보강하는 파서다.
입력으로 (1) 1차 정형화된 결과 JSON과 (2) 해당 카드의 공통 조건 텍스트가 주어진다.
공통 조건 텍스트를 읽고, 1차 결과에서 누락된 조건을 보강하라.

## 출력 JSON 스키마

{
  "benefits": [
    {
      "benefit_id": number,
      "discount_rate": number | null,
      "discount_amount": number | null,
      "discount_type": string | null,
      "frequency_limit": string | null,
      "per_transaction_limit": number | null,
      "monthly_discount_limit": number | null,
      "min_spend": number | null,
      "brands": [string],
      "performance_tiers": [
        {"min_spend": number, "max_spend": number | null, "monthly_limit": number}
      ],
      "exclusions": [string],
      "evidence": {
        "<필드명>": "<공통 조건 텍스트에서 인용한 원문 구절>"
      }
    }
  ]
}

## 원칙

1. discount_rate, discount_amount, discount_type, frequency_limit, per_transaction_limit, monthly_discount_limit, min_spend 같은 스칼라 필드는 1차 결과가 null일 때만 보강하라. 이미 값이 있으면 그대로 출력하라.
2. brands, performance_tiers, exclusions는 기존 배열이 비어 있지 않아도, 공통 조건 텍스트에 명시된 추가 항목이 있으면 기존 값을 유지한 채 새 항목을 추가하라.
3. brands, performance_tiers, exclusions에 이미 같은 의미의 항목이 있으면 중복 추가하지 마라.
4. 공통 조건 텍스트에 해당 조건이 명시되어 있지 않다면 보강하지 말고 null/빈 배열 또는 기존 배열 그대로 유지하라. 추론하지 마라.
5. 새로 채운 필드나 새로 추가한 배열 항목이 있다면, 그 근거가 된 공통 조건 텍스트의 원문 구절을 evidence 객체에 인용하라. 보강하지 않은 필드는 evidence에 넣지 마라.
6. 금액은 모두 원 단위 정수로 통일하라.
7. benefit_id는 입력 그대로 유지하라.
8. 반드시 순수 JSON만 출력하라.

## 예시

입력 1차 결과:
{"benefits":[{"benefit_id":123,"discount_rate":5,"discount_amount":null,"discount_type":"캐시백","frequency_limit":null,"per_transaction_limit":null,"monthly_discount_limit":null,"min_spend":null,"brands":["스타벅스","투썸플레이스","이디야"],"performance_tiers":[],"exclusions":["모바일 주문"]}]}

입력 공통 조건 텍스트:
"전월 이용금액 30만원 이상 시 제공. 백화점 및 대형마트 입점 매장 제외. 통합 월 할인한도: 30~70만원 1만원, 70~150만원 2만원, 150만원 이상 4만원."

출력:
{"benefits":[{"benefit_id":123,"discount_rate":5,"discount_amount":null,"discount_type":"캐시백","frequency_limit":null,"per_transaction_limit":null,"monthly_discount_limit":null,"min_spend":null,"brands":["스타벅스","투썸플레이스","이디야"],"performance_tiers":[{"min_spend":300000,"max_spend":700000,"monthly_limit":10000},{"min_spend":700000,"max_spend":1500000,"monthly_limit":20000},{"min_spend":1500000,"max_spend":null,"monthly_limit":40000}],"exclusions":["모바일 주문","백화점 및 대형마트 입점 매장"],"evidence":{"performance_tiers":"통합 월 할인한도: 30~70만원 1만원, 70~150만원 2만원, 150만원 이상 4만원","exclusions":"백화점 및 대형마트 입점 매장 제외"}}]}
`.trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCardsCsv(rawValue) {
  const ids = String(rawValue)
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (ids.length < 1) {
    throw new Error('--cards must contain at least one positive integer card id.');
  }

  return [...new Set(ids)].sort((a, b) => a - b);
}

function parseArgs(argv) {
  const parsed = {
    sourceDbPath: path.resolve(PROJECT_ROOT, 'db', 'cards.db'),
    outputDbPath: path.resolve(PROJECT_ROOT, 'db', 'cafe_v2.db'),
    logPath: path.resolve(__dirname, 'enrichment_log.json'),
    debugDir: path.resolve(__dirname, 'enrichment_debug'),
    model: DEFAULT_MODEL,
    cardIds: null,
    parseRetryCount: DEFAULT_PARSE_RETRY_COUNT,
    apiRetryCount: DEFAULT_API_RETRY_COUNT,
    requestDelayMs: DEFAULT_REQUEST_DELAY_MS,
    concurrency: DEFAULT_CONCURRENCY,
    noticeCategory: DEFAULT_NOTICE_CATEGORY,
    overwriteOutput: false,
    resume: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === '--source-db' || arg === '--db') && argv[index + 1]) {
      parsed.sourceDbPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--output-db' && argv[index + 1]) {
      parsed.outputDbPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--log' && argv[index + 1]) {
      parsed.logPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--debug-dir' && argv[index + 1]) {
      parsed.debugDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--cards' && argv[index + 1]) {
      parsed.cardIds = parseCardsCsv(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--model' && argv[index + 1]) {
      parsed.model = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--parse-retries' && argv[index + 1]) {
      parsed.parseRetryCount = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === '--api-retries' && argv[index + 1]) {
      parsed.apiRetryCount = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === '--request-delay-ms' && argv[index + 1]) {
      parsed.requestDelayMs = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === '--concurrency' && argv[index + 1]) {
      parsed.concurrency = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === '--notice-category' && argv[index + 1]) {
      parsed.noticeCategory = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--overwrite-output') {
      parsed.overwriteOutput = true;
      continue;
    }
    if (arg === '--resume') {
      parsed.resume = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    }
  }

  if (!Number.isInteger(parsed.parseRetryCount) || parsed.parseRetryCount < 0) {
    throw new Error(`--parse-retries must be an integer >= 0 (got: ${parsed.parseRetryCount})`);
  }
  if (!Number.isInteger(parsed.apiRetryCount) || parsed.apiRetryCount < 1) {
    throw new Error(`--api-retries must be an integer >= 1 (got: ${parsed.apiRetryCount})`);
  }
  if (!Number.isInteger(parsed.requestDelayMs) || parsed.requestDelayMs < 0) {
    throw new Error(
      `--request-delay-ms must be an integer >= 0 (got: ${parsed.requestDelayMs})`
    );
  }
  if (!Number.isInteger(parsed.concurrency) || parsed.concurrency < 1) {
    throw new Error(`--concurrency must be an integer >= 1 (got: ${parsed.concurrency})`);
  }
  if (!parsed.noticeCategory || typeof parsed.noticeCategory !== 'string') {
    throw new Error('--notice-category must be a non-empty string.');
  }
  if (parsed.overwriteOutput && parsed.resume) {
    throw new Error('--overwrite-output and --resume cannot be used together.');
  }
  if (path.resolve(parsed.sourceDbPath) === path.resolve(parsed.outputDbPath)) {
    throw new Error('Source DB and output DB must be different files.');
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage:
  node structurization/enrich_cafe_benefits_with_notices.js [options]

Options:
  --db <path>                Source SQLite DB path (default: ./db/cards.db)
  --source-db <path>         Same as --db
  --output-db <path>         Output SQLite DB path (default: ./db/cafe_v2.db)
  --log <path>               Enrichment log JSON path (default: ./structurization/enrichment_log.json)
  --debug-dir <path>         Failed parse debug directory (default: ./structurization/enrichment_debug)
  --cards <csv>              Card ids to process, e.g. 10,45,105
  --model <name>             Gemini model (default: gemini-2.5-flash)
  --parse-retries <n>        JSON parse retry count (default: 2)
  --api-retries <n>          API retry count with backoff (default: 5)
  --request-delay-ms <n>     Delay between cards in ms (default: ${DEFAULT_REQUEST_DELAY_MS})
  --concurrency <n>          Parallel card workers (default: ${DEFAULT_CONCURRENCY})
  --notice-category <name>   Category to use as card-level common notes (default: 유의사항)
  --overwrite-output         Replace output DB by copying source DB before processing
  --resume                   Keep existing output DB and continue processing selected cards
  -h, --help                 Show this help

Required environment variable:
  GEMINI_API_KEY
`);
  process.exit(0);
}

function ensureDirForFile(filePath) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseDotEnvValue(rawValue) {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    if (!process.env[key]) {
      process.env[key] = parseDotEnvValue(trimmed.slice(equalIndex + 1));
    }
  }
}

function prepareOutputDb({ sourceDbPath, outputDbPath, overwriteOutput, resume }) {
  if (resume) {
    if (!fs.existsSync(outputDbPath)) {
      throw new Error(`Cannot resume because output DB does not exist: ${outputDbPath}`);
    }
    return;
  }

  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source DB not found: ${sourceDbPath}`);
  }
  if (fs.existsSync(outputDbPath) && !overwriteOutput) {
    throw new Error(
      `Output DB already exists: ${outputDbPath}. Use --resume to continue it, or --overwrite-output to rebuild it from the source DB.`
    );
  }

  ensureDirForFile(outputDbPath);
  if (fs.existsSync(outputDbPath)) {
    fs.unlinkSync(outputDbPath);
  }
  fs.copyFileSync(sourceDbPath, outputDbPath);
}

class ApiHttpError extends Error {
  constructor(status, bodyText) {
    super(`Gemini API HTTP ${status}: ${bodyText}`);
    this.name = 'ApiHttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

async function callGeminiOnce({ apiKey, model, inputText, useSystemInstruction }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: inputText }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
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

  const text = await response.text();
  if (!response.ok) {
    throw new ApiHttpError(response.status, text);
  }

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(text);
  } catch {
    throw new Error(`Gemini API returned non-JSON response: ${text.slice(0, 500)}`);
  }

  const candidate = parsedResponse?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error(`Gemini API response missing content parts: ${text.slice(0, 500)}`);
  }

  const joinedText = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();

  if (!joinedText) {
    throw new Error(`Gemini API response has empty text: ${text.slice(0, 500)}`);
  }

  return joinedText;
}

function looksLikeUnknownSystemInstructionError(error) {
  if (!(error instanceof ApiHttpError)) return false;
  if (error.status !== 400) return false;
  const lowered = String(error.bodyText).toLowerCase();
  return lowered.includes('system_instruction') || lowered.includes('systeminstruction');
}

async function callGeminiWithBackoff({ apiKey, model, inputText, apiRetryCount }) {
  let lastError = null;
  let useSystemInstruction = true;

  for (let attempt = 1; attempt <= apiRetryCount; attempt += 1) {
    try {
      return await callGeminiOnce({ apiKey, model, inputText, useSystemInstruction });
    } catch (error) {
      if (useSystemInstruction && looksLikeUnknownSystemInstructionError(error)) {
        useSystemInstruction = false;
        continue;
      }

      lastError = error;
      if (attempt >= apiRetryCount) {
        break;
      }

      const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      const jitterMs = Math.floor(Math.random() * 250);
      await sleep(backoffMs + jitterMs);
    }
  }

  throw lastError;
}

function extractJsonText(rawText) {
  const trimmed = String(rawText).trim();
  if (!trimmed) {
    throw new Error('Empty Gemini text output');
  }

  const repairJsonText = (text) =>
    text
      .replace(/^\uFEFF/, '')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');

  const parseableText = (text) => {
    try {
      JSON.parse(text);
      return text;
    } catch {
      const repaired = repairJsonText(text);
      JSON.parse(repaired);
      return repaired;
    }
  };

  try {
    return parseableText(trimmed);
  } catch {
    // continue
  }

  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch && codeFenceMatch[1]) {
    const fenced = codeFenceMatch[1].trim();
    return parseableText(fenced);
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = trimmed.slice(firstBrace, lastBrace + 1);
    return parseableText(sliced);
  }

  throw new Error(`Could not locate valid JSON in model output: ${trimmed.slice(0, 500)}`);
}

function toIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function toStringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeStringArray(value) {
  const rawValues = Array.isArray(value) ? value : [];
  return [...new Set(rawValues.map(toStringOrNull).filter(Boolean))];
}

function normalizeDedupeText(value) {
  let text = toStringOrNull(value);
  if (!text) {
    return null;
  }

  text = text.replace(/\s+/g, '').toLowerCase();
  const suffixes = ['코리아', '매장', '샵', '점', '건'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (text.endsWith(suffix) && text.length > suffix.length) {
        text = text.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }

  return text || null;
}

function tierDedupeKey(tier) {
  const minSpend = tier?.min_spend === null || tier?.min_spend === undefined ? 'NULL' : String(tier.min_spend);
  const maxSpend = tier?.max_spend === null || tier?.max_spend === undefined ? 'NULL' : String(tier.max_spend);
  return `${minSpend}|${maxSpend}`;
}

function normalizePerformanceTiers(value) {
  const rawTiers = Array.isArray(value) ? value : [];
  const seen = new Set();
  const tiers = [];

  for (const tier of rawTiers) {
    const normalizedTier = {
      min_spend: toIntegerOrNull(tier?.min_spend),
      max_spend: toIntegerOrNull(tier?.max_spend),
      monthly_limit: toIntegerOrNull(tier?.monthly_limit),
    };

    if (
      normalizedTier.min_spend === null &&
      normalizedTier.max_spend === null &&
      normalizedTier.monthly_limit === null
    ) {
      continue;
    }

    const key = JSON.stringify(normalizedTier);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tiers.push(normalizedTier);
  }

  return tiers;
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const evidence = {};
  for (const [field, rawText] of Object.entries(value)) {
    const text = toStringOrNull(rawText);
    if (text) {
      evidence[field] = text;
    }
  }
  return evidence;
}

function normalizeModelBenefit(value) {
  const benefitId = toIntegerOrNull(value?.benefit_id);
  if (benefitId === null) {
    return null;
  }

  return {
    benefit_id: benefitId,
    discount_rate: toNumberOrNull(value?.discount_rate),
    discount_amount: toIntegerOrNull(value?.discount_amount),
    discount_type: toStringOrNull(value?.discount_type),
    frequency_limit: toStringOrNull(value?.frequency_limit),
    per_transaction_limit: toIntegerOrNull(value?.per_transaction_limit),
    monthly_discount_limit: toIntegerOrNull(value?.monthly_discount_limit),
    min_spend: toIntegerOrNull(value?.min_spend),
    brands: normalizeStringArray(value?.brands),
    performance_tiers: normalizePerformanceTiers(value?.performance_tiers),
    exclusions: normalizeStringArray(value?.exclusions),
    evidence: normalizeEvidence(value?.evidence),
  };
}

function parseAndNormalizeModelOutput(rawText) {
  const jsonText = extractJsonText(rawText);
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Parsed output is not an object');
  }
  if (!Array.isArray(parsed.benefits)) {
    throw new Error('Parsed output is missing benefits array');
  }

  return {
    benefits: parsed.benefits.map(normalizeModelBenefit).filter(Boolean),
  };
}

function writeParseDebugArtifact({ debugDir, cardId, parseAttempt, inputText, rawModelText, error }) {
  if (!debugDir) {
    return;
  }

  fs.mkdirSync(debugDir, { recursive: true });
  const safeCardId = Number.isInteger(cardId) ? cardId : 'unknown';
  const filePath = path.join(
    debugDir,
    `card_${safeCardId}_parse_attempt_${parseAttempt}.json`
  );
  const payload = {
    card_id: cardId,
    parse_attempt: parseAttempt,
    error: error instanceof Error ? error.message : String(error),
    input_text: inputText,
    raw_model_text: rawModelText,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function getNormalizedEnrichmentWithRetries({
  apiKey,
  model,
  inputText,
  cardId,
  debugDir,
  parseRetryCount,
  apiRetryCount,
}) {
  let lastError = null;
  for (let parseAttempt = 0; parseAttempt <= parseRetryCount; parseAttempt += 1) {
    let rawModelText = null;
    try {
      rawModelText = await callGeminiWithBackoff({
        apiKey,
        model,
        inputText,
        apiRetryCount,
      });
      return parseAndNormalizeModelOutput(rawModelText);
    } catch (error) {
      lastError = error;
      if (rawModelText !== null) {
        writeParseDebugArtifact({
          debugDir,
          cardId,
          parseAttempt: parseAttempt + 1,
          inputText,
          rawModelText,
          error,
        });
      }
      if (parseAttempt >= parseRetryCount) {
        break;
      }
    }
  }
  throw lastError;
}

function toSqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureModelInputViews(db, noticeCategory) {
  const noticeCategorySql = toSqlStringLiteral(noticeCategory);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_benefits_card_category ON benefits (card_id, category);

    DROP VIEW IF EXISTS v_benefits_for_model;
    DROP VIEW IF EXISTS v_benefits_for_recommendation;
    DROP VIEW IF EXISTS v_benefits_for_structuring;
    DROP VIEW IF EXISTS v_card_notice;

    CREATE VIEW v_card_notice AS
    WITH note_rows AS (
      SELECT
        b.card_id,
        b.benefit_id,
        TRIM(b.raw_info) AS note_text
      FROM benefits AS b
      WHERE b.category = ${noticeCategorySql}
        AND COALESCE(TRIM(b.raw_info), '') <> ''
    ),
    note_rollup AS (
      SELECT
        card_id,
        GROUP_CONCAT(note_text, '\n\n[[COMMON_NOTE_SPLIT]]\n\n') OVER (
          PARTITION BY card_id
          ORDER BY benefit_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS notice_text,
        COUNT(*) OVER (PARTITION BY card_id) AS notice_count,
        ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY benefit_id DESC) AS rn
      FROM note_rows
    )
    SELECT
      card_id,
      notice_text,
      notice_count
    FROM note_rollup
    WHERE rn = 1;

    CREATE VIEW v_benefits_for_structuring AS
    SELECT
      b.benefit_id,
      b.card_id,
      b.category,
      b.raw_info,
      n.notice_text AS common_notes,
      COALESCE(n.notice_count, 0) AS common_note_count,
      '[혜택 원문 시작]\n' || COALESCE(b.raw_info, '') || '\n[혜택 원문 끝]' AS effective_info,
      '[공통 조건 텍스트 시작]\n' || COALESCE(n.notice_text, '') || '\n[공통 조건 텍스트 끝]' AS common_notes_block
    FROM benefits AS b
    LEFT JOIN v_card_notice AS n ON n.card_id = b.card_id
    WHERE b.category <> ${noticeCategorySql};

    CREATE VIEW v_benefits_for_recommendation AS
    SELECT
      s.benefit_id,
      s.card_id,
      s.category,
      s.raw_info,
      s.common_notes,
      s.common_note_count,
      CASE
        WHEN s.common_notes IS NULL OR s.common_notes = ''
          THEN s.effective_info
        ELSE
          s.effective_info
          || '\n\n'
          || s.common_notes_block
      END AS effective_info
    FROM v_benefits_for_structuring AS s;

    CREATE VIEW v_benefits_for_model AS
    SELECT
      benefit_id,
      card_id,
      category,
      raw_info,
      common_notes,
      common_note_count,
      effective_info
    FROM v_benefits_for_recommendation;
  `);
}

function dropModelInputViews(db) {
  db.exec(`
    DROP VIEW IF EXISTS v_benefits_for_model;
    DROP VIEW IF EXISTS v_benefits_for_recommendation;
    DROP VIEW IF EXISTS v_benefits_for_structuring;
    DROP VIEW IF EXISTS v_card_notice;
  `);
}

function buildDbStatements(db) {
  const updateSimpleFields = {};
  for (const field of SIMPLE_FIELDS) {
    updateSimpleFields[field] = db.prepare(`
      UPDATE benefits
      SET ${field} = ?
      WHERE benefit_id = ? AND ${field} IS NULL
    `);
  }

  return {
    updateSimpleFields,

    selectTargetCardIds: db.prepare(`
      SELECT DISTINCT card_id
      FROM benefits
      WHERE category = ?
      ORDER BY card_id
    `),

    selectCafeBenefitsByCardId: db.prepare(`
      SELECT
        benefit_id,
        discount_rate,
        discount_amount,
        discount_type,
        frequency_limit,
        per_transaction_limit,
        monthly_discount_limit,
        min_spend
      FROM benefits
      WHERE card_id = ? AND category = ?
      ORDER BY benefit_id
    `),

    selectBrandsByBenefitId: db.prepare(`
      SELECT br.brand_name
      FROM benefit_brands AS bb
      JOIN brands AS br ON br.brand_id = bb.brand_id
      WHERE bb.benefit_id = ?
      ORDER BY bb.brand_id
    `),

    selectPerformanceTiersByBenefitId: db.prepare(`
      SELECT min_spend, max_spend, monthly_limit
      FROM performance_tiers
      WHERE benefit_id = ?
      ORDER BY tier_id
    `),

    selectExclusionsByBenefitId: db.prepare(`
      SELECT exclusion_type
      FROM exclusions
      WHERE benefit_id = ?
      ORDER BY exclusion_id
    `),

    selectNoticeByCardId: db.prepare(`
      SELECT notice_text, notice_count
      FROM v_card_notice
      WHERE card_id = ?
    `),

    insertBrand: db.prepare(`
      INSERT OR IGNORE INTO brands (brand_name)
      VALUES (?)
    `),

    selectBrandId: db.prepare(`
      SELECT brand_id
      FROM brands
      WHERE brand_name = ?
    `),

    insertBenefitBrand: db.prepare(`
      INSERT OR IGNORE INTO benefit_brands (benefit_id, brand_id)
      VALUES (?, ?)
    `),

    insertPerformanceTier: db.prepare(`
      INSERT INTO performance_tiers (benefit_id, min_spend, max_spend, monthly_limit)
      VALUES (?, ?, ?, ?)
    `),

    insertExclusion: db.prepare(`
      INSERT INTO exclusions (benefit_id, exclusion_type)
      VALUES (?, ?)
    `),
  };
}

function getTargetCardIds(statements, requestedCardIds) {
  if (Array.isArray(requestedCardIds)) {
    return requestedCardIds;
  }
  return statements.selectTargetCardIds.all(CAFE_CATEGORY).map((row) => row.card_id);
}

function getNoticeForCard(statements, cardId) {
  const notice = statements.selectNoticeByCardId.get(cardId);
  return {
    notice_text: notice?.notice_text ?? '',
    notice_count: Number.isInteger(notice?.notice_count) ? notice.notice_count : 0,
  };
}

function serializeCafeBenefitsForCard(statements, cardId) {
  const rows = statements.selectCafeBenefitsByCardId.all(cardId, CAFE_CATEGORY);
  const benefits = rows.map((row) => {
    const brands = statements.selectBrandsByBenefitId
      .all(row.benefit_id)
      .map((brandRow) => brandRow.brand_name)
      .filter((brandName) => brandName !== null && brandName !== undefined);

    const performanceTiers = statements.selectPerformanceTiersByBenefitId
      .all(row.benefit_id)
      .map((tierRow) => ({
        min_spend: tierRow.min_spend,
        max_spend: tierRow.max_spend,
        monthly_limit: tierRow.monthly_limit,
      }));

    const exclusions = statements.selectExclusionsByBenefitId
      .all(row.benefit_id)
      .map((exclusionRow) => exclusionRow.exclusion_type)
      .filter((exclusionText) => exclusionText !== null && exclusionText !== undefined);

    return {
      benefit_id: row.benefit_id,
      discount_rate: row.discount_rate,
      discount_amount: row.discount_amount,
      discount_type: row.discount_type,
      frequency_limit: row.frequency_limit,
      per_transaction_limit: row.per_transaction_limit,
      monthly_discount_limit: row.monthly_discount_limit,
      min_spend: row.min_spend,
      brands,
      performance_tiers: performanceTiers,
      exclusions,
    };
  });

  return { benefits };
}

function buildModelInput(primaryResult, noticeText) {
  return [
    '다음 1차 정형화 결과 JSON과 공통 조건 텍스트를 분석해 JSON만 출력하라.',
    '',
    '[1차 정형화 결과 JSON]',
    JSON.stringify(primaryResult, null, 2),
    '',
    '[공통 조건 텍스트 시작]',
    noticeText,
    '[공통 조건 텍스트 끝]',
  ].join('\n');
}

function readExistingLogEntries(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  const text = fs.readFileSync(logPath, 'utf8').trim();
  if (!text) {
    return [];
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Existing log is not a JSON array: ${logPath}`);
  }
  return parsed;
}

function writeLogEntries(logPath, logEntries) {
  ensureDirForFile(logPath);
  fs.writeFileSync(logPath, `${JSON.stringify(logEntries, null, 2)}\n`, 'utf8');
}

function setLogEntry(logEntries, entry) {
  const existingIndex = logEntries.findIndex((logEntry) => logEntry.card_id === entry.card_id);
  if (existingIndex >= 0) {
    logEntries[existingIndex] = entry;
  } else {
    logEntries.push(entry);
  }
}

function ensureLogBucket(logObject, benefitId) {
  const key = `benefit_id_${benefitId}`;
  if (!logObject[key]) {
    logObject[key] = {};
  }
  return logObject[key];
}

function removeEmptyLogBuckets(logObject) {
  for (const [key, value] of Object.entries(logObject)) {
    if (!value || Object.keys(value).length === 0) {
      delete logObject[key];
    }
  }
}

function recordFilledField({ filled, evidence, benefitId, field, value, evidenceText }) {
  ensureLogBucket(filled, benefitId)[field] = value;
  if (evidenceText) {
    ensureLogBucket(evidence, benefitId)[field] = evidenceText;
  }
}

function createDependentWriteStats() {
  return {
    inserts: {
      exclusions: 0,
      benefit_brands: 0,
      performance_tiers: 0,
    },
    deduped: {
      exclusions: 0,
      benefit_brands: 0,
      performance_tiers: 0,
    },
  };
}

function addDependentWriteStats(target, source) {
  for (const section of ['inserts', 'deduped']) {
    for (const tableName of ['exclusions', 'benefit_brands', 'performance_tiers']) {
      target[section][tableName] += source?.[section]?.[tableName] ?? 0;
    }
  }
}

function applySimpleFieldEnrichment({ statements, originalBenefit, modelBenefit, filled, evidence }) {
  for (const field of SIMPLE_FIELDS) {
    if (originalBenefit[field] !== null) {
      continue;
    }

    const modelValue = modelBenefit[field];
    if (modelValue === null || modelValue === undefined) {
      continue;
    }

    const result = statements.updateSimpleFields[field].run(modelValue, originalBenefit.benefit_id);
    if ((result.changes ?? 0) > 0) {
      recordFilledField({
        filled,
        evidence,
        benefitId: originalBenefit.benefit_id,
        field,
        value: modelValue,
        evidenceText: modelBenefit.evidence[field],
      });
    }
  }
}

function applyBrandEnrichment({ statements, originalBenefit, modelBenefit, filled, evidence, dependentStats }) {
  if (modelBenefit.brands.length < 1) {
    return;
  }

  const seenKeys = new Set(
    originalBenefit.brands.map(normalizeDedupeText).filter(Boolean)
  );
  const insertedBrands = [];
  for (const brandName of modelBenefit.brands) {
    const key = normalizeDedupeText(brandName);
    if (!key || seenKeys.has(key)) {
      dependentStats.deduped.benefit_brands += 1;
      continue;
    }
    seenKeys.add(key);

    statements.insertBrand.run(brandName);
    const brandRow = statements.selectBrandId.get(brandName);
    if (!brandRow || brandRow.brand_id === undefined || brandRow.brand_id === null) {
      throw new Error(`Could not resolve brand_id for brand='${brandName}'`);
    }

    const result = statements.insertBenefitBrand.run(originalBenefit.benefit_id, brandRow.brand_id);
    if ((result.changes ?? 0) > 0) {
      insertedBrands.push(brandName);
      dependentStats.inserts.benefit_brands += 1;
    } else {
      dependentStats.deduped.benefit_brands += 1;
    }
  }

  if (insertedBrands.length > 0) {
    recordFilledField({
      filled,
      evidence,
      benefitId: originalBenefit.benefit_id,
      field: 'brands',
      value: insertedBrands,
      evidenceText: modelBenefit.evidence.brands,
    });
  }
}

function applyPerformanceTierEnrichment({ statements, originalBenefit, modelBenefit, filled, evidence, dependentStats }) {
  if (modelBenefit.performance_tiers.length < 1) {
    return;
  }

  const seenKeys = new Set(originalBenefit.performance_tiers.map(tierDedupeKey));
  const insertedTiers = [];
  for (const tier of modelBenefit.performance_tiers) {
    const key = tierDedupeKey(tier);
    if (seenKeys.has(key)) {
      dependentStats.deduped.performance_tiers += 1;
      continue;
    }
    seenKeys.add(key);

    const result = statements.insertPerformanceTier.run(
      originalBenefit.benefit_id,
      tier.min_spend,
      tier.max_spend,
      tier.monthly_limit
    );
    if ((result.changes ?? 0) > 0) {
      insertedTiers.push(tier);
      dependentStats.inserts.performance_tiers += 1;
    }
  }

  if (insertedTiers.length > 0) {
    recordFilledField({
      filled,
      evidence,
      benefitId: originalBenefit.benefit_id,
      field: 'performance_tiers',
      value: insertedTiers,
      evidenceText: modelBenefit.evidence.performance_tiers,
    });
  }
}

function applyExclusionEnrichment({ statements, originalBenefit, modelBenefit, filled, evidence, dependentStats }) {
  if (modelBenefit.exclusions.length < 1) {
    return;
  }

  const seenKeys = new Set(
    originalBenefit.exclusions.map(normalizeDedupeText).filter(Boolean)
  );
  const insertedExclusions = [];
  for (const exclusionText of modelBenefit.exclusions) {
    const key = normalizeDedupeText(exclusionText);
    if (!key || seenKeys.has(key)) {
      dependentStats.deduped.exclusions += 1;
      continue;
    }
    seenKeys.add(key);

    const result = statements.insertExclusion.run(originalBenefit.benefit_id, exclusionText);
    if ((result.changes ?? 0) > 0) {
      insertedExclusions.push(exclusionText);
      dependentStats.inserts.exclusions += 1;
    }
  }

  if (insertedExclusions.length > 0) {
    recordFilledField({
      filled,
      evidence,
      benefitId: originalBenefit.benefit_id,
      field: 'exclusions',
      value: insertedExclusions,
      evidenceText: modelBenefit.evidence.exclusions,
    });
  }
}

function applyModelEnrichmentToDb(statements, primaryResult, normalizedModelResult) {
  const primaryByBenefitId = new Map(
    primaryResult.benefits.map((benefit) => [benefit.benefit_id, benefit])
  );

  const filled = {};
  const evidence = {};
  const dependentStats = createDependentWriteStats();

  for (const modelBenefit of normalizedModelResult.benefits) {
    const originalBenefit = primaryByBenefitId.get(modelBenefit.benefit_id);
    if (!originalBenefit) {
      continue;
    }

    applySimpleFieldEnrichment({ statements, originalBenefit, modelBenefit, filled, evidence });
    applyBrandEnrichment({ statements, originalBenefit, modelBenefit, filled, evidence, dependentStats });
    applyPerformanceTierEnrichment({ statements, originalBenefit, modelBenefit, filled, evidence, dependentStats });
    applyExclusionEnrichment({ statements, originalBenefit, modelBenefit, filled, evidence, dependentStats });
  }

  removeEmptyLogBuckets(filled);
  removeEmptyLogBuckets(evidence);
  return { filled, evidence, dependentStats };
}

async function processCard({
  db,
  statements,
  apiKey,
  args,
  cardId,
  progressLabel,
  logEntries,
}) {
  console.log(`${progressLabel} 카드 ID ${cardId} 처리 중...`);

  const notice = getNoticeForCard(statements, cardId);
  if (notice.notice_count === 0) {
    setLogEntry(logEntries, {
      card_id: cardId,
      status: 'skipped',
      reason: 'no_notice',
    });
    return { status: 'skipped', llmCalled: false };
  }

  const primaryResult = serializeCafeBenefitsForCard(statements, cardId);
  if (primaryResult.benefits.length === 0) {
    setLogEntry(logEntries, {
      card_id: cardId,
      status: 'skipped',
      reason: 'no_cafe_benefits',
    });
    return { status: 'skipped', llmCalled: false };
  }

  const inputText = buildModelInput(primaryResult, notice.notice_text);
  let normalizedModelResult = null;
  try {
    normalizedModelResult = await getNormalizedEnrichmentWithRetries({
      apiKey,
      model: args.model,
      inputText,
      cardId,
      debugDir: args.debugDir,
      parseRetryCount: args.parseRetryCount,
      apiRetryCount: args.apiRetryCount,
    });
  } catch (error) {
    error.llmCalled = true;
    throw error;
  }

  db.exec('BEGIN');
  let applyResult = null;
  try {
    applyResult = applyModelEnrichmentToDb(statements, primaryResult, normalizedModelResult);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    error.llmCalled = true;
    throw error;
  }

  if (Object.keys(applyResult.filled).length > 0) {
    setLogEntry(logEntries, {
      card_id: cardId,
      status: 'enriched',
      filled: applyResult.filled,
      evidence: applyResult.evidence,
    });
    return { status: 'enriched', llmCalled: true, dependentStats: applyResult.dependentStats };
  }

  setLogEntry(logEntries, {
    card_id: cardId,
    status: 'unchanged',
    reason: 'no_fields_filled',
  });
  return { status: 'unchanged', llmCalled: true, dependentStats: applyResult.dependentStats };
}

async function main() {
  const args = parseArgs(process.argv);
  loadDotEnv(path.resolve(PROJECT_ROOT, '.env'));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }

  prepareOutputDb(args);

  const logEntries = args.resume ? readExistingLogEntries(args.logPath) : [];
  writeLogEntries(args.logPath, logEntries);

  const stats = {
    total: 0,
    llmCalls: 0,
    enriched: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    dependentWrites: createDependentWriteStats(),
  };

  let db = null;
  try {
    db = new DatabaseSync(args.outputDbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    ensureModelInputViews(db, args.noticeCategory);

    const statements = buildDbStatements(db);
    const allCardIds = getTargetCardIds(statements, args.cardIds);
    const completedCardIds = args.resume
      ? new Set(
          logEntries
            .filter((entry) => ['enriched', 'unchanged', 'skipped'].includes(entry.status))
            .map((entry) => entry.card_id)
        )
      : new Set();
    const cardIds = allCardIds.filter((cardId) => !completedCardIds.has(cardId));
    stats.total = cardIds.length;

    let nextIndex = 0;
    const processNextCard = async () => {
      while (nextIndex < cardIds.length) {
        const index = nextIndex;
        nextIndex += 1;

      const cardId = cardIds[index];
      const progressLabel = `[${index + 1}/${cardIds.length}]`;

      try {
        const result = await processCard({
          db,
          statements,
          apiKey,
          args,
          cardId,
          progressLabel,
          logEntries,
        });

        if (result.llmCalled) {
          stats.llmCalls += 1;
        }
        if (result.dependentStats) {
          addDependentWriteStats(stats.dependentWrites, result.dependentStats);
        }
        if (result.status === 'enriched') {
          stats.enriched += 1;
        } else if (result.status === 'unchanged') {
          stats.unchanged += 1;
        } else if (result.status === 'skipped') {
          stats.skipped += 1;
        }
      } catch (error) {
        if (error?.llmCalled) {
          stats.llmCalls += 1;
        }
        stats.failed += 1;
        setLogEntry(logEntries, {
          card_id: cardId,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
        console.log(
          `${progressLabel} 카드 ID ${cardId} 실패: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

        writeLogEntries(args.logPath, logEntries);

      if (args.requestDelayMs > 0 && index < cardIds.length - 1) {
        await sleep(args.requestDelayMs);
      }
      }
    };

    const workerCount = Math.min(args.concurrency, cardIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => processNextCard()));

    dropModelInputViews(db);
  } finally {
    if (db) {
      db.close();
    }

    writeLogEntries(args.logPath, logEntries);
  }

  console.log('\n=== Summary ===');
  console.log(`Total cards: ${stats.total}`);
  console.log(`LLM calls: ${stats.llmCalls}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Enriched: ${stats.enriched}`);
  console.log(`Unchanged: ${stats.unchanged}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(
    `Dependent inserts: EXCLUSIONS ${stats.dependentWrites.inserts.exclusions}, BENEFIT_BRANDS ${stats.dependentWrites.inserts.benefit_brands}, PERFORMANCE_TIERS ${stats.dependentWrites.inserts.performance_tiers}`
  );
  console.log(
    `Dependent deduped: EXCLUSIONS ${stats.dependentWrites.deduped.exclusions}, BENEFIT_BRANDS ${stats.dependentWrites.deduped.benefit_brands}, PERFORMANCE_TIERS ${stats.dependentWrites.deduped.performance_tiers}`
  );
  console.log(`Output DB: ${args.outputDbPath}`);
  console.log(`Log: ${args.logPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
