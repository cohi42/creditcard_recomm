const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DEFAULT_GT_JSON = path.resolve(__dirname, 'ground_truth.json');

function parseArgs(argv) {
  const parsed = {
    groundTruthJson: DEFAULT_GT_JSON,
    experimentXlsx: null,
    scoreXlsx: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--ground-truth-json' && argv[index + 1]) {
      parsed.groundTruthJson = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if ((arg === '--experiment-xlsx' || arg === '--output-xlsx') && argv[index + 1]) {
      parsed.experimentXlsx = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if ((arg === '--score-xlsx' || arg === '--score-output') && argv[index + 1]) {
      parsed.scoreXlsx = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    }
  }

  if (parsed.experimentXlsx && !parsed.scoreXlsx) {
    parsed.scoreXlsx = path.resolve(path.dirname(parsed.experimentXlsx), 'score_comparison.xlsx');
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage:
  node evaluation/score_simulation_outputs.js [options]

Options:
  --ground-truth-json <path>   fixed GT JSON path
                               default: ./evaluation/ground_truth.json
  --experiment-xlsx <path>     pipeline output XLSX to score
  --score-xlsx <path>          score comparison XLSX path
                               default: <experiment-xlsx dir>/score_comparison.xlsx
  -h, --help                   show this help

Examples:
  node evaluation/score_simulation_outputs.js --experiment-xlsx test_outputs/test_baseline_simulation/test_experiment_result.xlsx
`);
  process.exit(0);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getXmlAttr(xml, name) {
  const pattern = new RegExp(`\\s${name}="([^"]*)"`);
  const match = String(xml).match(pattern);
  return match ? decodeXmlEntities(match[1]) : '';
}

function colIndexFromRef(cellRef) {
  const letters = String(cellRef).replace(/\d/g, '').toUpperCase();
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
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

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeInteger(value) {
  const numeric = normalizeNumber(value);
  return numeric === null ? null : Math.round(numeric);
}

function normalizeTime(rawValue) {
  const raw = String(rawValue ?? '').trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric < 1) {
    const minutes = Math.round(numeric * 24 * 60);
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return raw;
}

function normalizeDate(rawValue) {
  return String(rawValue ?? '').trim();
}

function findEndOfCentralDirectory(buffer) {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      return index;
    }
  }
  throw new Error('Invalid XLSX/ZIP: end of central directory not found.');
}

function readZipEntries(filePath) {
  const buffer = fs.readFileSync(filePath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const endOffset = centralDirOffset + centralDirSize;
  const entries = new Map();

  let offset = centralDirOffset;
  while (offset < endOffset) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x02014b50) {
      throw new Error(`Invalid central directory signature at offset ${offset}.`);
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer
      .slice(offset + 46, offset + 46 + fileNameLength)
      .toString('utf8');

    const localSignature = buffer.readUInt32LE(localHeaderOffset);
    if (localSignature !== 0x04034b50) {
      throw new Error(`Invalid local file header for ${fileName}.`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);

    let data;
    if (compressionMethod === 0) {
      data = compressed;
    } else if (compressionMethod === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${fileName}.`);
    }

    entries.set(fileName, data);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function readTextEntry(entries, name) {
  const data = entries.get(name);
  if (!data) return null;
  return data.toString('utf8');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRegex = /<si\b[\s\S]*?<\/si>/g;
  for (const siMatch of xml.matchAll(siRegex)) {
    const siXml = siMatch[0];
    const parts = [];
    const textRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    for (const textMatch of siXml.matchAll(textRegex)) {
      parts.push(decodeXmlEntities(textMatch[1]));
    }
    strings.push(parts.join(''));
  }
  return strings;
}

function parseWorkbook(entries) {
  const workbookXml = readTextEntry(entries, 'xl/workbook.xml');
  const relsXml = readTextEntry(entries, 'xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relsXml) {
    throw new Error('Invalid XLSX: workbook metadata missing.');
  }

  const relsById = new Map();
  const relRegex = /<Relationship\b[^>]*>/g;
  for (const relMatch of relsXml.matchAll(relRegex)) {
    const relXml = relMatch[0];
    relsById.set(getXmlAttr(relXml, 'Id'), getXmlAttr(relXml, 'Target'));
  }

  const sheets = new Map();
  const sheetRegex = /<sheet\b[^>]*>/g;
  for (const sheetMatch of workbookXml.matchAll(sheetRegex)) {
    const sheetXml = sheetMatch[0];
    const name = getXmlAttr(sheetXml, 'name');
    const relId = getXmlAttr(sheetXml, 'r:id');
    let target = relsById.get(relId);
    if (!target) continue;
    if (!target.startsWith('xl/')) {
      target = `xl/${target.replace(/^\//, '')}`;
    }
    sheets.set(name, target);
  }

  return sheets;
}

function readWorksheetRows(filePath, sheetName) {
  const entries = readZipEntries(filePath);
  const sheets = parseWorkbook(entries);
  const sheetPath = sheets.get(sheetName);
  if (!sheetPath) {
    throw new Error(`Sheet not found in ${filePath}: ${sheetName}`);
  }

  const sharedStrings = parseSharedStrings(readTextEntry(entries, 'xl/sharedStrings.xml'));
  const sheetXml = readTextEntry(entries, sheetPath);
  if (!sheetXml) {
    throw new Error(`Worksheet XML missing: ${sheetPath}`);
  }

  const rows = [];
  const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  for (const rowMatch of sheetXml.matchAll(rowRegex)) {
    const rowNumber = Number(getXmlAttr(rowMatch[1], 'r')) || rows.length + 1;
    const cells = {};
    const cellRegex = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    for (const cellMatch of rowMatch[2].matchAll(cellRegex)) {
      const attrs = cellMatch[2] ?? cellMatch[1];
      const body = cellMatch[3] ?? '';
      const ref = getXmlAttr(attrs, 'r');
      const type = getXmlAttr(attrs, 't');
      const colIndex = colIndexFromRef(ref);

      let value = '';
      if (type === 's') {
        const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        const sharedIndex = valueMatch ? Number(valueMatch[1]) : NaN;
        value = Number.isInteger(sharedIndex) ? sharedStrings[sharedIndex] ?? '' : '';
      } else if (type === 'inlineStr') {
        const parts = [];
        const textRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        for (const textMatch of body.matchAll(textRegex)) {
          parts.push(decodeXmlEntities(textMatch[1]));
        }
        value = parts.join('');
      } else {
        const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        value = valueMatch ? decodeXmlEntities(valueMatch[1]) : '';
      }

      cells[colIndex] = value;
    }
    rows[rowNumber] = cells;
  }

  return rows;
}

function rowValue(row, colIndex) {
  return row?.[colIndex] ?? '';
}

function loadGroundTruthJson(groundTruthJsonPath) {
  if (!fs.existsSync(groundTruthJsonPath)) {
    throw new Error(`Ground truth JSON not found: ${groundTruthJsonPath}`);
  }
  return JSON.parse(fs.readFileSync(groundTruthJsonPath, 'utf8'));
}

function parseExperimentResultXlsx(experimentXlsx) {
  if (!fs.existsSync(experimentXlsx)) {
    throw new Error(`Experiment XLSX not found: ${experimentXlsx}`);
  }

  const rows = readWorksheetRows(experimentXlsx, 'Experiment_Result');
  const header = rows[1] ?? {};
  const columns = [];
  for (let col = 6; col <= 200; col += 1) {
    const value = String(rowValue(header, col) ?? '').trim();
    if (!value) continue;
    const match = value.match(/^(.+)_card_(\d+)$/);
    if (!match) continue;
    columns.push({
      col,
      persona: match[1],
      card_id: Number(match[2]),
      header: value,
    });
  }

  const actualByKey = new Map();
  const transactionById = new Map();
  for (let rowNumber = 2; rowNumber < rows.length; rowNumber += 1) {
    const row = rows[rowNumber];
    const id = normalizeInteger(rowValue(row, 1));
    if (id === null) continue;

    transactionById.set(id, {
      id,
      date: normalizeDate(rowValue(row, 2)),
      time: normalizeTime(rowValue(row, 3)),
      merchant: String(rowValue(row, 4) ?? ''),
      amount: normalizeInteger(rowValue(row, 5)) ?? 0,
    });

    for (const column of columns) {
      actualByKey.set(
        makeKey(id, column.persona, column.card_id),
        normalizeInteger(rowValue(row, column.col)) ?? 0
      );
    }
  }

  return { actualByKey, transactionById };
}

function makeKey(transactionId, persona, cardId) {
  return `${transactionId}|${persona}|${cardId}`;
}

function buildScoreRows({ groundTruth, experiment }) {
  const transactionById = new Map(
    groundTruth.transactions.map((transaction) => [transaction.id, transaction])
  );
  const rows = [
    [
      'transaction_id',
      'date',
      'time',
      'merchant',
      'amount',
      'persona',
      'card_id',
      'expected_amount',
      'actual_amount',
      'diff_gt_minus_actual',
      'match',
    ],
  ];

  for (const item of groundTruth.values) {
    const transaction = transactionById.get(item.transaction_id) ?? {};
    const key = makeKey(item.transaction_id, item.persona, item.card_id);
    const actual = experiment.actualByKey.has(key) ? experiment.actualByKey.get(key) : null;
    const expected = item.expected_amount;
    const diff = actual === null ? '' : expected - actual;
    const match = actual === null ? 'MISSING' : actual === expected ? 'TRUE' : 'FALSE';

    rows.push([
      item.transaction_id,
      transaction.date ?? '',
      transaction.time ?? '',
      transaction.merchant ?? '',
      transaction.amount ?? '',
      item.persona,
      item.card_id,
      expected,
      actual === null ? '' : actual,
      diff,
      match,
    ]);
  }

  return rows;
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
      const value = row[colIndex];
      if (value === null || value === undefined || value === '') continue;

      const ref = cellRef(rowNumber, colIndex + 1);
      if (typeof value === 'number' && Number.isFinite(value)) {
        cellXmlParts.push(`<c r="${ref}"><v>${value}</v></c>`);
      } else {
        const text = escapeXml(String(value));
        cellXmlParts.push(`<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`);
      }
    }

    if (cellXmlParts.length > 0) {
      rowXmlParts.push(`<row r="${rowNumber}">${cellXmlParts.join('')}</row>`);
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${cellRef(Math.max(rows.length, 1), Math.max(maxCol, 1))}"/>`,
    '<sheetData>',
    rowXmlParts.join(''),
    '</sheetData>',
    '</worksheet>',
  ].join('');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(entries) {
  const now = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const dataBuffer = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data), 'utf8');
    const compressed = zlib.deflateRawSync(dataBuffer);
    const crc = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(now.dosTime, 10);
    localHeader.writeUInt16LE(now.dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(now.dosTime, 12);
    centralHeader.writeUInt16LE(now.dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function writeScoreWorkbook(outputPath, rows) {
  const sheetXml = buildWorksheetXml(rows);
  const entries = [
    {
      name: '[Content_Types].xml',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
        '</Types>',
      ].join(''),
    },
    {
      name: '_rels/.rels',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
        '</Relationships>',
      ].join(''),
    },
    {
      name: 'xl/workbook.xml',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<sheets><sheet name="Score_Comparison" sheetId="1" r:id="rId1"/></sheets>',
        '</workbook>',
      ].join(''),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
        '</Relationships>',
      ].join(''),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: sheetXml,
    },
  ];

  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, createZip(entries));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.experimentXlsx) {
    throw new Error('Missing required --experiment-xlsx <path> for score comparison.');
  }

  const groundTruth = loadGroundTruthJson(args.groundTruthJson);
  console.log(`Ground truth JSON: ${args.groundTruthJson}`);
  console.log(
    `Ground truth rows: transactions=${groundTruth.transactions.length}, values=${groundTruth.values.length}`
  );

  const experiment = parseExperimentResultXlsx(args.experimentXlsx);
  const scoreRows = buildScoreRows({ groundTruth, experiment });
  writeScoreWorkbook(args.scoreXlsx, scoreRows);
  console.log(`Score comparison XLSX: ${args.scoreXlsx}`);
  console.log(`Score rows: ${scoreRows.length - 1}`);
}

main();
