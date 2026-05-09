const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG_PATH = path.resolve(__dirname, 'enrichment_log.json');
const DEFAULT_OUTPUT_PATH = path.resolve(__dirname, 'notice_enrichment_delta.json');

function parseArgs(argv) {
  const parsed = {
    logPath: DEFAULT_LOG_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--log' && argv[index + 1]) {
      parsed.logPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--output' && argv[index + 1]) {
      parsed.outputPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    }
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage:
  node structurization/export_notice_enrichment_delta.js [options]

Options:
  --log <path>       Enrichment log JSON path (default: ./structurization/enrichment_log.json)
  --output <path>    Output JSON path (default: ./structurization/notice_enrichment_delta.json)
  -h, --help         Show this help
`);
  process.exit(0);
}

function ensureDirForFile(filePath) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseBenefitId(benefitKey) {
  const match = String(benefitKey).match(/^benefit_id_(\d+)$/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function stableValueKey(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;

  if (Array.isArray(value)) {
    return `array:${JSON.stringify(value.map((item) => stableValueKey(item)))}`;
  }

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return `object:${JSON.stringify(sorted)}`;
}

function normalizeValueItems(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && item !== undefined && item !== '');
  }
  if (value === null || value === undefined || value === '') {
    return [];
  }
  return [value];
}

function getOrCreateCardDelta(cardMap, cardId) {
  if (!cardMap.has(cardId)) {
    cardMap.set(cardId, {
      card_id: cardId,
      fields: new Map(),
    });
  }
  return cardMap.get(cardId);
}

function getOrCreateFieldMap(cardDelta, field) {
  if (!cardDelta.fields.has(field)) {
    cardDelta.fields.set(field, new Map());
  }
  return cardDelta.fields.get(field);
}

function addCardFieldValue({ cardMap, cardId, benefitId, field, value, evidenceText }) {
  const cardDelta = getOrCreateCardDelta(cardMap, cardId);
  const fieldMap = getOrCreateFieldMap(cardDelta, field);
  const valueKey = stableValueKey(value);

  if (!fieldMap.has(valueKey)) {
    fieldMap.set(valueKey, {
      value,
      source_benefit_ids: new Set(),
      evidence: new Set(),
    });
  }

  const entry = fieldMap.get(valueKey);
  entry.source_benefit_ids.add(benefitId);
  if (evidenceText) {
    entry.evidence.add(evidenceText);
  }
}

function serializeCardDeltas(cardMap) {
  return [...cardMap.values()]
    .sort((left, right) => left.card_id - right.card_id)
    .map((cardDelta) => {
      const fields = {};
      for (const [field, valueMap] of [...cardDelta.fields.entries()].sort()) {
        fields[field] = [...valueMap.values()].map((entry) => ({
          value: entry.value,
          source_benefit_ids: [...entry.source_benefit_ids].sort((left, right) => left - right),
          evidence: [...entry.evidence],
        }));
      }

      return {
        card_id: cardDelta.card_id,
        fields,
      };
    });
}

function buildDeltaExport(logEntries) {
  const benefitDeltas = [];
  const cardMap = new Map();
  const statusCounts = new Map();
  const fieldCountsByBenefit = new Map();
  const fieldValueCountsByCard = new Map();

  for (const entry of logEntries) {
    statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + 1);
    if (entry.status !== 'enriched' || !entry.filled || typeof entry.filled !== 'object') {
      continue;
    }

    for (const [benefitKey, fields] of Object.entries(entry.filled)) {
      const benefitId = parseBenefitId(benefitKey);
      if (!Number.isInteger(benefitId) || !fields || typeof fields !== 'object') {
        continue;
      }

      const benefitEvidence = entry.evidence?.[benefitKey] ?? {};
      const cleanFields = {};
      const cleanEvidence = {};

      for (const [field, value] of Object.entries(fields)) {
        cleanFields[field] = value;
        if (benefitEvidence[field]) {
          cleanEvidence[field] = benefitEvidence[field];
        }

        fieldCountsByBenefit.set(field, (fieldCountsByBenefit.get(field) ?? 0) + 1);

        const valueItems = normalizeValueItems(value);
        fieldValueCountsByCard.set(field, (fieldValueCountsByCard.get(field) ?? 0) + valueItems.length);
        for (const valueItem of valueItems) {
          addCardFieldValue({
            cardMap,
            cardId: entry.card_id,
            benefitId,
            field,
            value: valueItem,
            evidenceText: benefitEvidence[field],
          });
        }
      }

      benefitDeltas.push({
        card_id: entry.card_id,
        benefit_id: benefitId,
        fields: cleanFields,
        evidence: cleanEvidence,
      });
    }
  }

  benefitDeltas.sort((left, right) => {
    if (left.card_id !== right.card_id) return left.card_id - right.card_id;
    return left.benefit_id - right.benefit_id;
  });

  return {
    generated_at_utc: new Date().toISOString(),
    source: {
      type: 'notice_enrichment_log',
      note: 'Only values newly filled from card-level notice text are included.',
    },
    summary: {
      log_entries: logEntries.length,
      status_counts: Object.fromEntries([...statusCounts.entries()].sort()),
      cards_with_delta: cardMap.size,
      benefit_deltas: benefitDeltas.length,
      field_counts_by_benefit: Object.fromEntries(
        [...fieldCountsByBenefit.entries()].sort((left, right) => right[1] - left[1])
      ),
      field_value_counts_before_card_dedupe: Object.fromEntries(
        [...fieldValueCountsByCard.entries()].sort((left, right) => right[1] - left[1])
      ),
    },
    benefit_deltas: benefitDeltas,
    card_common_deltas: serializeCardDeltas(cardMap),
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.logPath)) {
    throw new Error(`Enrichment log not found: ${args.logPath}`);
  }

  const logEntries = JSON.parse(fs.readFileSync(args.logPath, 'utf8'));
  if (!Array.isArray(logEntries)) {
    throw new Error(`Enrichment log must be a JSON array: ${args.logPath}`);
  }

  const output = buildDeltaExport(logEntries);
  ensureDirForFile(args.outputPath);
  fs.writeFileSync(args.outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`Wrote notice enrichment delta: ${args.outputPath}`);
  console.log(`Cards with delta: ${output.summary.cards_with_delta}`);
  console.log(`Benefit deltas: ${output.summary.benefit_deltas}`);
}

main();
