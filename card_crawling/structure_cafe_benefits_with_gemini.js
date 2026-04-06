const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CAFE_CATEGORY = '\uCE74\uD398';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_PARSE_RETRY_COUNT = 2;
const DEFAULT_API_RETRY_COUNT = 5;
const DEFAULT_REQUEST_DELAY_MS = 3200;
const DEFAULT_JOB_NAME = 'cafe_structuring_v1';
const BASE_BACKOFF_MS = 1000;

const SYSTEM_PROMPT = `
너는 신용카드 혜택 텍스트에서 정형 데이터를 추출하는 파서다.
입력으로 카페 카테고리의 혜택 원문 HTML이 주어지면, 아래 JSON 스키마에 맞춰 필드 값을 추출하라.

## 출력 JSON 스키마

{
  "benefits": [
    {
      "discount_rate": number | null,
      "discount_amount": number | null,
      "discount_type": string,
      "frequency_limit": string | null,
      "per_transaction_limit": number | null,
      "monthly_discount_limit": number | null,
      "min_spend": number | null,
      "brands": [string],
      "performance_tiers": [
        {"min_spend": number, "max_spend": number | null, "monthly_limit": number}
      ],
      "exclusions": [string]
    }
  ]
}

## 원칙

1. 가맹점별로 할인율이 다르면 별도 benefit 객체로 분리하라.
2. 전월 실적에 따라 월 한도가 다단계로 달라지면, min_spend와 monthly_discount_limit은 null로 두고 performance_tiers에 각 구간을 넣어라. 단일 실적 조건이면 min_spend에 넣고 performance_tiers는 빈 배열.
3. 금액은 모두 원 단위 정수로 통일하라.
4. 텍스트에서 확인할 수 없는 필드는 null로 남겨라.
5. 에디터 삽입 텍스트("Powered by Froala Editor" 등)는 무시하라.
6. 반드시 순수 JSON만 출력하라.

## 예시

입력: "스타벅스 20% 청구할인\\n- 월 2회/월 최대 3천원\\n- 백화점 및 대형마트 입점 매장 제외\\n- 상품권 구매, 기프트(선불)카드를 구입/충전한 금액은 할인에서 제외"

출력:
{"benefits":[{"discount_rate":20,"discount_amount":null,"discount_type":"청구할인","frequency_limit":"월 2회","per_transaction_limit":null,"monthly_discount_limit":3000,"min_spend":null,"brands":["스타벅스"],"performance_tiers":[],"exclusions":["백화점 및 대형마트 입점 매장","상품권 구매, 기프트(선불)카드 구입/충전"]}]}
`.trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = {
    dbPath: path.resolve(__dirname, '..', 'cards.db'),
    model: DEFAULT_MODEL,
    category: CAFE_CATEGORY,
    jobName: DEFAULT_JOB_NAME,
    parseRetryCount: DEFAULT_PARSE_RETRY_COUNT,
    apiRetryCount: DEFAULT_API_RETRY_COUNT,
    requestDelayMs: DEFAULT_REQUEST_DELAY_MS,
    failureLogPath: path.resolve(__dirname, 'logs', 'cafe_structuring_failures.log'),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db' && argv[index + 1]) {
      parsed.dbPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--model' && argv[index + 1]) {
      parsed.model = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--category' && argv[index + 1]) {
      parsed.category = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--job-name' && argv[index + 1]) {
      parsed.jobName = argv[index + 1];
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
    if (arg === '--failure-log' && argv[index + 1]) {
      parsed.failureLogPath = path.resolve(argv[index + 1]);
      index += 1;
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
  if (!parsed.jobName || !String(parsed.jobName).trim()) {
    throw new Error('--job-name must be a non-empty string.');
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage:
  node card_crawling/structure_cafe_benefits_with_gemini.js [options]

Options:
  --db <path>              SQLite DB path (default: ./cards.db)
  --model <name>           Gemini model (default: gemini-2.5-flash)
  --category <name>        Benefit category to process (default: ${CAFE_CATEGORY})
  --job-name <name>        Resume checkpoint key (default: ${DEFAULT_JOB_NAME})
  --parse-retries <n>      JSON parse retry count (default: 2)
  --api-retries <n>        API retry count with backoff (default: 5)
  --request-delay-ms <n>   Delay between items in ms (default: ${DEFAULT_REQUEST_DELAY_MS})
  --failure-log <path>     Failure log file path
  -h, --help               Show this help

Required environment variable:
  GEMINI_API_KEY
`);
  process.exit(0);
}

class ApiHttpError extends Error {
  constructor(status, bodyText) {
    super(`Gemini API HTTP ${status}: ${bodyText}`);
    this.name = 'ApiHttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

async function callGeminiOnce({ apiKey, model, rawInfo, useSystemInstruction }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const userPrompt = `다음 HTML 원문을 분석해 JSON만 출력하라.\n\n${rawInfo}`;
  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
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

async function callGeminiWithBackoff({ apiKey, model, rawInfo, apiRetryCount }) {
  let lastError = null;
  let useSystemInstruction = true;

  for (let attempt = 1; attempt <= apiRetryCount; attempt += 1) {
    try {
      return await callGeminiOnce({ apiKey, model, rawInfo, useSystemInstruction });
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
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('Empty Gemini text output');
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // continue
  }

  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch && codeFenceMatch[1]) {
    const fenced = codeFenceMatch[1].trim();
    JSON.parse(fenced);
    return fenced;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = trimmed.slice(firstBrace, lastBrace + 1);
    JSON.parse(sliced);
    return sliced;
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

function normalizeParsedBenefit(benefit) {
  const brandsRaw = Array.isArray(benefit?.brands) ? benefit.brands : [];
  const exclusionsRaw = Array.isArray(benefit?.exclusions) ? benefit.exclusions : [];
  const tiersRaw = Array.isArray(benefit?.performance_tiers) ? benefit.performance_tiers : [];

  const brands = [...new Set(brandsRaw.map(toStringOrNull).filter(Boolean))];
  const exclusions = [...new Set(exclusionsRaw.map(toStringOrNull).filter(Boolean))];

  const performanceTiers = [];
  for (const tier of tiersRaw) {
    const minSpend = toIntegerOrNull(tier?.min_spend);
    const maxSpend = toIntegerOrNull(tier?.max_spend);
    const monthlyLimit = toIntegerOrNull(tier?.monthly_limit);

    if (minSpend === null && maxSpend === null && monthlyLimit === null) {
      continue;
    }

    performanceTiers.push({
      min_spend: minSpend,
      max_spend: maxSpend,
      monthly_limit: monthlyLimit,
    });
  }

  return {
    discount_rate: toNumberOrNull(benefit?.discount_rate),
    discount_amount: toIntegerOrNull(benefit?.discount_amount),
    discount_type: toStringOrNull(benefit?.discount_type),
    frequency_limit: toStringOrNull(benefit?.frequency_limit),
    per_transaction_limit: toIntegerOrNull(benefit?.per_transaction_limit),
    monthly_discount_limit: toIntegerOrNull(benefit?.monthly_discount_limit),
    min_spend: toIntegerOrNull(benefit?.min_spend),
    brands,
    performance_tiers: performanceTiers,
    exclusions,
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
  if (parsed.benefits.length < 1) {
    throw new Error('Parsed output has empty benefits array');
  }

  const normalizedBenefits = parsed.benefits.map(normalizeParsedBenefit);
  return { benefits: normalizedBenefits };
}

function ensureDirForFile(filePath) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function appendFailureLog(logPath, payload) {
  ensureDirForFile(logPath);
  const line = [
    `[${new Date().toISOString()}]`,
    `benefit_id=${payload.benefitId}`,
    `card_id=${payload.cardId}`,
    `attempt=${payload.attempt}`,
    `error=${String(payload.error).replace(/\r?\n/g, ' ')}`,
  ].join(' | ');
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

function ensureCheckpointTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_processing_checkpoints (
      job_name TEXT NOT NULL,
      benefit_id INTEGER NOT NULL,
      category TEXT,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_name, benefit_id),
      FOREIGN KEY (benefit_id) REFERENCES benefits(benefit_id)
    )
  `);
}

function buildDbStatements(db) {
  return {
    countTargetsByCategory: db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM benefits
      WHERE category = ?
    `),

    countCheckpointsByCategory: db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM llm_processing_checkpoints
      WHERE job_name = ? AND category = ?
    `),

    seedCheckpointsFromStructured: db.prepare(`
      INSERT OR IGNORE INTO llm_processing_checkpoints (
        job_name,
        benefit_id,
        category,
        processed_at
      )
      SELECT
        ?,
        b.benefit_id,
        b.category,
        datetime('now')
      FROM benefits AS b
      WHERE b.category = ?
        AND (
          b.discount_rate IS NOT NULL
          OR b.discount_amount IS NOT NULL
          OR b.discount_type IS NOT NULL
          OR b.frequency_limit IS NOT NULL
          OR b.per_transaction_limit IS NOT NULL
          OR b.monthly_discount_limit IS NOT NULL
          OR b.min_spend IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM benefit_brands AS bb WHERE bb.benefit_id = b.benefit_id
          )
          OR EXISTS (
            SELECT 1 FROM performance_tiers AS pt WHERE pt.benefit_id = b.benefit_id
          )
          OR EXISTS (
            SELECT 1 FROM exclusions AS ex WHERE ex.benefit_id = b.benefit_id
          )
        )
    `),

    selectPendingTargets: db.prepare(`
      SELECT b.benefit_id, b.card_id, b.category, b.raw_info
      FROM benefits AS b
      WHERE b.category = ?
        AND NOT EXISTS (
          SELECT 1
          FROM llm_processing_checkpoints AS cp
          WHERE cp.job_name = ? AND cp.benefit_id = b.benefit_id
        )
      ORDER BY b.benefit_id
    `),

    updateBenefit: db.prepare(`
      UPDATE benefits
      SET
        discount_rate = ?,
        discount_amount = ?,
        discount_type = ?,
        frequency_limit = ?,
        per_transaction_limit = ?,
        monthly_discount_limit = ?,
        min_spend = ?
      WHERE benefit_id = ?
    `),

    insertBenefit: db.prepare(`
      INSERT INTO benefits (
        card_id,
        category,
        discount_rate,
        discount_amount,
        discount_type,
        frequency_limit,
        per_transaction_limit,
        monthly_discount_limit,
        min_spend,
        raw_info
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    deleteBenefitBrands: db.prepare(`DELETE FROM benefit_brands WHERE benefit_id = ?`),
    deletePerformanceTiers: db.prepare(`DELETE FROM performance_tiers WHERE benefit_id = ?`),
    deleteExclusions: db.prepare(`DELETE FROM exclusions WHERE benefit_id = ?`),

    insertBrand: db.prepare(`INSERT OR IGNORE INTO brands (brand_name) VALUES (?)`),
    selectBrandId: db.prepare(`SELECT brand_id FROM brands WHERE brand_name = ?`),
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

    markProcessedCheckpoint: db.prepare(`
      INSERT OR IGNORE INTO llm_processing_checkpoints (
        job_name,
        benefit_id,
        category,
        processed_at
      ) VALUES (?, ?, ?, datetime('now'))
    `),

    countDiscountRateNotNull: db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM benefits
      WHERE category = ? AND discount_rate IS NOT NULL
    `),
  };
}

function writeSingleBenefitToDb(statements, targetRow, targetBenefitId, normalizedBenefit) {
  statements.updateBenefit.run(
    normalizedBenefit.discount_rate,
    normalizedBenefit.discount_amount,
    normalizedBenefit.discount_type,
    normalizedBenefit.frequency_limit,
    normalizedBenefit.per_transaction_limit,
    normalizedBenefit.monthly_discount_limit,
    normalizedBenefit.min_spend,
    targetBenefitId
  );

  statements.deleteBenefitBrands.run(targetBenefitId);
  statements.deletePerformanceTiers.run(targetBenefitId);
  statements.deleteExclusions.run(targetBenefitId);

  for (const brandName of normalizedBenefit.brands) {
    statements.insertBrand.run(brandName);
    const row = statements.selectBrandId.get(brandName);
    if (!row || row.brand_id === undefined || row.brand_id === null) {
      throw new Error(`Could not resolve brand_id for brand='${brandName}'`);
    }
    statements.insertBenefitBrand.run(targetBenefitId, row.brand_id);
  }

  for (const tier of normalizedBenefit.performance_tiers) {
    statements.insertPerformanceTier.run(
      targetBenefitId,
      tier.min_spend,
      tier.max_spend,
      tier.monthly_limit
    );
  }

  for (const exclusionText of normalizedBenefit.exclusions) {
    statements.insertExclusion.run(targetBenefitId, exclusionText);
  }

  return targetBenefitId;
}

function applyParsedBenefitsToDb(statements, targetRow, normalizedBenefits) {
  const createdBenefitIds = [];

  for (let index = 0; index < normalizedBenefits.length; index += 1) {
    const normalizedBenefit = normalizedBenefits[index];
    let benefitId = null;

    if (index === 0) {
      benefitId = targetRow.benefit_id;
    } else {
      const result = statements.insertBenefit.run(
        targetRow.card_id,
        targetRow.category,
        normalizedBenefit.discount_rate,
        normalizedBenefit.discount_amount,
        normalizedBenefit.discount_type,
        normalizedBenefit.frequency_limit,
        normalizedBenefit.per_transaction_limit,
        normalizedBenefit.monthly_discount_limit,
        normalizedBenefit.min_spend,
        targetRow.raw_info
      );
      benefitId = result.lastInsertRowid;
    }

    writeSingleBenefitToDb(statements, targetRow, benefitId, normalizedBenefit);
    createdBenefitIds.push(benefitId);
  }

  return createdBenefitIds;
}

function markBenefitsAsProcessed(statements, { jobName, category, benefitIds }) {
  for (const benefitId of benefitIds) {
    statements.markProcessedCheckpoint.run(jobName, benefitId, category);
  }
}

async function getNormalizedBenefitsWithRetries({
  apiKey,
  model,
  rawInfo,
  parseRetryCount,
  apiRetryCount,
}) {
  let lastError = null;
  for (let parseAttempt = 0; parseAttempt <= parseRetryCount; parseAttempt += 1) {
    try {
      const rawModelText = await callGeminiWithBackoff({
        apiKey,
        model,
        rawInfo,
        apiRetryCount,
      });
      return parseAndNormalizeModelOutput(rawModelText).benefits;
    } catch (error) {
      lastError = error;
      if (parseAttempt >= parseRetryCount) {
        break;
      }
    }
  }
  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }
  if (!fs.existsSync(args.dbPath)) {
    throw new Error(`DB file not found: ${args.dbPath}`);
  }

  const db = new DatabaseSync(args.dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  ensureCheckpointTable(db);

  const statements = buildDbStatements(db);
  const totalTargetCount = statements.countTargetsByCategory.get(args.category).cnt;
  const seeded = statements.seedCheckpointsFromStructured.run(args.jobName, args.category);
  const targetRows = statements.selectPendingTargets.all(args.category, args.jobName);
  const pendingCount = targetRows.length;
  const checkpointCount = statements.countCheckpointsByCategory.get(args.jobName, args.category).cnt;
  const skippedCount = totalTargetCount - pendingCount;

  console.log(`DB path: ${args.dbPath}`);
  console.log(`Model: ${args.model}`);
  console.log(`Category: ${args.category}`);
  console.log(`Job name: ${args.jobName}`);
  console.log(`Target rows (all): ${totalTargetCount}`);
  console.log(`Checkpoint rows seeded this run: ${seeded.changes ?? 0}`);
  console.log(`Checkpoint rows (current): ${checkpointCount}`);
  console.log(`Target rows (pending): ${pendingCount}`);
  console.log(`Skipped already processed: ${skippedCount}`);
  console.log(`Request delay (ms): ${args.requestDelayMs}`);
  console.log(`Failure log: ${args.failureLogPath}`);

  let successCount = 0;
  let failureCount = 0;
  let splitCount = 0;

  for (let index = 0; index < targetRows.length; index += 1) {
    const row = targetRows[index];
    const progressLabel = `[${index + 1}/${pendingCount}] benefit_id=${row.benefit_id}`;
    console.log(`${progressLabel} processing...`);

    try {
      const normalizedBenefits = await getNormalizedBenefitsWithRetries({
        apiKey,
        model: args.model,
        rawInfo: row.raw_info ?? '',
        parseRetryCount: args.parseRetryCount,
        apiRetryCount: args.apiRetryCount,
      });

      db.exec('BEGIN');
      try {
        const createdBenefitIds = applyParsedBenefitsToDb(statements, row, normalizedBenefits);
        markBenefitsAsProcessed(statements, {
          jobName: args.jobName,
          category: row.category,
          benefitIds: createdBenefitIds,
        });
        db.exec('COMMIT');

        if (createdBenefitIds.length > 1) {
          splitCount += 1;
        }

        successCount += 1;
        console.log(
          `${progressLabel} success (benefits=${normalizedBenefits.length}, split=${
            createdBenefitIds.length > 1
          })`
        );
      } catch (dbError) {
        db.exec('ROLLBACK');
        throw dbError;
      }
    } catch (error) {
      failureCount += 1;
      appendFailureLog(args.failureLogPath, {
        benefitId: row.benefit_id,
        cardId: row.card_id,
        attempt: `${args.parseRetryCount + 1} parse-attempt(s), ${args.apiRetryCount} api-attempt(s)`,
        error: error instanceof Error ? error.message : String(error),
      });
      console.log(`${progressLabel} failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (args.requestDelayMs > 0 && index < targetRows.length - 1) {
      await sleep(args.requestDelayMs);
    }
  }

  const discountRateNotNullCount = statements.countDiscountRateNotNull.get(args.category).cnt;
  db.close();

  console.log('\n=== Summary ===');
  console.log(`Total target rows: ${totalTargetCount}`);
  console.log(`Skipped already processed: ${skippedCount}`);
  console.log(`Processed in this run: ${pendingCount}`);
  console.log(`Success: ${successCount}`);
  console.log(`Failure: ${failureCount}`);
  console.log(`Rows split (benefits array length >= 2): ${splitCount}`);
  console.log(
    `SELECT count(*) FROM benefits WHERE category='${args.category}' AND discount_rate IS NOT NULL => ${discountRateNotNullCount}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

