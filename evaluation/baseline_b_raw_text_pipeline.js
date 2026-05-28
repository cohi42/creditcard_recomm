const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ORIGINAL_PIPELINE_PATH = path.resolve(__dirname, 'recommendation_testing_pipeline.js');
const DEFAULT_DB_FILE = 'cafe_v3.db';
const DEFAULT_DB_PATH = path.resolve(PROJECT_ROOT, 'db', DEFAULT_DB_FILE);
const DEFAULT_CARD_IDS = [10, 105, 161, 208, 231, 263, 574];
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_YEAR = 2026;
const DEFAULT_REQUEST_DELAY_MS = 250;
const DEFAULT_API_RETRIES = 5;
const DEFAULT_OUTPUT_DIR = path.resolve(PROJECT_ROOT, 'test_outputs', 'Baseline_simulation');

const CAFE_CATEGORY = '\uCE74\uD398';
const NOTICE_CATEGORY = '\uC720\uC758\uC0AC\uD56D';
const ETC_CATEGORY = '\uAE30\uD0C0';
const RAW_CATEGORIES = [CAFE_CATEGORY, NOTICE_CATEGORY, ETC_CATEGORY];

function loadOriginalPipelineModule() {
  const source = fs.readFileSync(ORIGINAL_PIPELINE_PATH, 'utf8');
  const mainMarker = '\nasync function main()';
  const markerIndex = source.indexOf(mainMarker);
  if (markerIndex < 0) {
    throw new Error(`Could not find main() marker in ${ORIGINAL_PIPELINE_PATH}`);
  }

  const exportNames = [
    'ensureDir',
    'loadDotEnv',
    'parseJsonFile',
    'normalizeTransactions',
    'loadCardData',
    'buildCardPolicy',
    'initCardState',
    'applyPostProcessing',
    'makeResultMatrix',
    'buildExperimentSheetRows',
    'buildComparisonSheetRows',
    'buildLogMetaSheetRows',
    'writeWorkbookXlsx',
    'callGeminiWithBackoff',
    'normalizeModelDecision',
    'sleep',
  ];

  const sourceWithoutMain = source.slice(0, markerIndex);
  const exportBlock = [
    '',
    'module.exports = {',
    exportNames.map((name) => `  ${name}: ${name}`).join(',\n'),
    '};',
    '',
  ].join('\n');

  const moduleObject = { exports: {} };
  const sandbox = {
    require,
    module: moduleObject,
    exports: moduleObject.exports,
    __dirname: path.dirname(ORIGINAL_PIPELINE_PATH),
    __filename: ORIGINAL_PIPELINE_PATH,
    console,
    process,
    fetch: globalThis.fetch,
    setTimeout,
    clearTimeout,
    Buffer,
  };

  vm.createContext(sandbox);
  vm.runInContext(sourceWithoutMain + exportBlock, sandbox, {
    filename: ORIGINAL_PIPELINE_PATH,
  });

  return moduleObject.exports;
}

const shared = loadOriginalPipelineModule();

function parseArgs(argv) {
  const parsed = {
    dbPath: DEFAULT_DB_PATH,
    inputPath: path.resolve(__dirname, 'evaluation_input.json'),
    outputDir: DEFAULT_OUTPUT_DIR,
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
    resume: true,
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
    if (arg === '--no-resume') {
      parsed.resume = false;
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
  node evaluation/baseline_b_raw_text_pipeline.js [options]

Options:
  --db <path>                 SQLite DB path (default: ./db/${DEFAULT_DB_FILE})
  --input <path>              evaluation_input.json path (default: ./evaluation/evaluation_input.json)
  --output-dir <path>         output directory (default: ./test_outputs/Baseline_simulation)
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
  --no-resume                 ignore previous output log and call every case again
  -h, --help                  show this help

Environment variable:
  GEMINI_API_KEY
`);
  process.exit(0);
}

function uniqueRawSections(rows) {
  const seen = new Set();
  const sections = [];
  for (const row of rows) {
    const rawInfo = String(row.raw_info ?? '').trim();
    if (!rawInfo) continue;

    const key = `${row.category}\u0000${rawInfo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push({
      category: row.category,
      raw_info: rawInfo,
    });
  }
  return sections;
}

function loadRawCardPayloads(dbPath, cards) {
  const db = new DatabaseSync(dbPath);
  const payloads = new Map();
  const statement = db.prepare(
    `SELECT benefit_id, category, raw_info
     FROM benefits
     WHERE card_id = ?
       AND category IN (?, ?, ?)
     ORDER BY
       CASE category
         WHEN ? THEN 1
         WHEN ? THEN 2
         WHEN ? THEN 3
         ELSE 4
       END,
       benefit_id`
  );

  try {
    for (const card of cards) {
      const rows = statement.all(
        card.card_id,
        ...RAW_CATEGORIES,
        CAFE_CATEGORY,
        NOTICE_CATEGORY,
        ETC_CATEGORY
      );
      const rawSections = uniqueRawSections(rows);
      if (!rawSections.some((section) => section.category === CAFE_CATEGORY)) {
        throw new Error(`No raw cafe text found in DB for card_id=${card.card_id}`);
      }

      payloads.set(card.card_id, {
        card_id: card.card_id,
        card_name: card.card_name,
        card_company: card.card_company,
        raw_benefit_text: rawSections,
      });
    }
  } finally {
    db.close();
  }

  return payloads;
}

function recordCacheKey({ persona, previousMonthSpending, transaction, card }) {
  return JSON.stringify({
    persona: String(persona.persona),
    previous_month_spending: previousMonthSpending,
    transaction: {
      id: transaction.id,
      date: transaction.date,
      time: transaction.time,
      merchant: transaction.merchant,
      amount: transaction.amount,
    },
    card_id: card.card_id,
  });
}

function cachedRecordKey(record) {
  return JSON.stringify({
    persona: String(record?.persona?.persona),
    previous_month_spending: Number(record?.persona?.previous_month_spending) || 0,
    transaction: {
      id: Number(record?.transaction?.id),
      date: String(record?.transaction?.date),
      time: String(record?.transaction?.time),
      merchant: String(record?.transaction?.merchant),
      amount: Number(record?.transaction?.amount),
    },
    card_id: Number(record?.card?.card_id),
  });
}

function isReusableCachedRecord(record) {
  if (!record || record.model_error) return false;
  if (!record.llm_normalized || typeof record.llm_normalized !== 'object') return false;
  if (typeof record.llm_normalized.applicable !== 'boolean') return false;
  if (!Number.isFinite(Number(record.llm_normalized.discount_amount))) return false;
  return true;
}

function loadReusableDecisionCache(logPath) {
  const cache = new Map();
  const stats = {
    existing_records: 0,
    reusable_records: 0,
    error_records: 0,
    ignored_records: 0,
  };

  if (!fs.existsSync(logPath)) {
    return { cache, stats };
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  for (const line of lines) {
    stats.existing_records += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.ignored_records += 1;
      continue;
    }

    if (record?.model_error) {
      stats.error_records += 1;
      continue;
    }
    if (!isReusableCachedRecord(record)) {
      stats.ignored_records += 1;
      continue;
    }

    cache.set(cachedRecordKey(record), record);
    stats.reusable_records = cache.size;
  }

  return { cache, stats };
}

function normalizedDecisionFromCachedRecord(record) {
  return {
    applicable: Boolean(record.llm_normalized.applicable),
    discount_amount: Math.max(0, Math.floor(Number(record.llm_normalized.discount_amount) || 0)),
    reasoning:
      typeof record.llm_normalized.reasoning === 'string' ? record.llm_normalized.reasoning : '',
    _raw_parsed_object: record.llm_raw_parsed_object ?? null,
  };
}

function buildRawUserPrompt({ persona, transaction, cardPayload }) {
  return [
    '아래 정보를 바탕으로 거래 1건에 대한 할인 적용 여부를 판단하라.',
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
    '### CardRawBenefitText',
    JSON.stringify(cardPayload),
  ].join('\n\n');
}

async function getRawModelDecision({
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

  const userPrompt = buildRawUserPrompt({ persona, transaction, cardPayload });
  const rawText = await shared.callGeminiWithBackoff({
    apiKey,
    model,
    userPrompt,
    apiRetries,
  });
  const normalized = shared.normalizeModelDecision(rawText);
  return { rawText, normalized };
}

async function runBaselineSimulation(args) {
  if (!fs.existsSync(args.dbPath)) {
    throw new Error(`DB not found: ${args.dbPath}`);
  }
  if (!fs.existsSync(args.inputPath)) {
    throw new Error(`Input JSON not found: ${args.inputPath}`);
  }

  shared.loadDotEnv(path.resolve(PROJECT_ROOT, '.env'));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!args.dryRun && !apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }

  shared.ensureDir(args.outputDir);

  const evaluationInput = shared.parseJsonFile(args.inputPath);
  const personas = Array.isArray(evaluationInput.personas) ? evaluationInput.personas : [];
  const transactions = shared.normalizeTransactions(
    Array.isArray(evaluationInput.transactions) ? evaluationInput.transactions : [],
    args.year
  );

  if (personas.length < 1) {
    throw new Error('No personas found in evaluation_input.json.');
  }
  if (transactions.length < 1) {
    throw new Error('No transactions found in evaluation_input.json.');
  }

  const cards = shared.loadCardData(args.dbPath, args.cardIds);
  const cardPayloads = loadRawCardPayloads(args.dbPath, cards);
  const matrix = shared.makeResultMatrix(personas, transactions, cards);
  const totals = {};
  const { cache: decisionCache, stats: cacheStats } =
    args.resume && !args.dryRun
      ? loadReusableDecisionCache(args.outputLog)
      : { cache: new Map(), stats: null };

  for (const persona of personas) {
    const personaKey = String(persona.persona);
    totals[personaKey] = {};
    for (const card of cards) {
      totals[personaKey][card.card_id] = 0;
    }
  }

  if (cacheStats) {
    console.log(
      `Resume cache: reusable=${cacheStats.reusable_records}, errors_to_retry=${cacheStats.error_records}, ignored=${cacheStats.ignored_records}, existing=${cacheStats.existing_records}`
    );
  }

  const logStream = fs.createWriteStream(args.outputLog, { encoding: 'utf8' });
  const totalCallsPlanned = personas.length * transactions.length * cards.length;
  let totalCallsExecuted = 0;
  let successCalls = 0;
  let failedCalls = 0;
  let cacheHits = 0;
  let apiCallsAttempted = 0;

  try {
    for (const persona of personas) {
      const personaKey = String(persona.persona);
      const previousMonthSpending = Number(persona.previous_month_spending) || 0;

      const policies = new Map();
      const states = new Map();

      for (const card of cards) {
        const policy = shared.buildCardPolicy(card, previousMonthSpending);
        policies.set(card.card_id, policy);
        states.set(card.card_id, shared.initCardState(policy));
      }

      for (const transaction of transactions) {
        for (const card of cards) {
          if (args.maxCalls !== null && totalCallsExecuted >= args.maxCalls) {
            break;
          }

          totalCallsExecuted += 1;
          const effectivePlanned =
            args.maxCalls !== null ? Math.min(args.maxCalls, totalCallsPlanned) : totalCallsPlanned;
          const progress = `[${totalCallsExecuted}/${effectivePlanned}]`;

          let rawModelText = null;
          let normalizedDecision = null;
          let modelError = null;
          let fromCache = false;

          const cacheKey = recordCacheKey({
            persona,
            previousMonthSpending,
            transaction,
            card,
          });
          const cachedRecord = decisionCache.get(cacheKey);

          if (cachedRecord) {
            fromCache = true;
            cacheHits += 1;
            rawModelText = cachedRecord.llm_raw_text ?? null;
            normalizedDecision = normalizedDecisionFromCachedRecord(cachedRecord);
            successCalls += 1;
          } else {
            apiCallsAttempted += 1;
            try {
              const decision = await getRawModelDecision({
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
          }

          const policy = policies.get(card.card_id);
          const state = states.get(card.card_id);
          const post = shared.applyPostProcessing({
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
            model_error: modelError
              ? String(modelError instanceof Error ? modelError.message : modelError)
              : null,
          };

          logStream.write(`${JSON.stringify(logRecord)}\n`);

          console.log(
            `${progress} persona=${persona.persona} tx=${transaction.id} card=${card.card_id} source=${fromCache ? 'cache' : 'api'} llm=${normalizedDecision.discount_amount} final=${post.finalAmount}${post.blockedBy ? ` blocked=${post.blockedBy}` : ''}${modelError ? ' [MODEL_ERROR]' : ''}`
          );

          if (!fromCache && args.requestDelayMs > 0 && totalCallsExecuted < effectivePlanned) {
            await shared.sleep(args.requestDelayMs);
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

  const experimentSheetRows = shared.buildExperimentSheetRows({
    personas,
    transactions,
    cards,
    matrix,
  });
  const comparisonSheetRows = shared.buildComparisonSheetRows({
    personas,
    transactions,
    cards,
    matrix,
  });
  const logMetaSheetRows = shared.buildLogMetaSheetRows({
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

  shared.writeWorkbookXlsx(args.outputXlsx, [
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
  console.log(`Cache hits: ${cacheHits}, API calls attempted: ${apiCallsAttempted}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await runBaselineSimulation(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
