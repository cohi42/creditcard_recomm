const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..');
const dbPath = path.join(projectRoot, 'cards.db');
const rawDir = path.join(__dirname, 'data', 'raw');

function mapIsCredit(cType) {
  if (cType === 'D') return 0;
  if (cType === 'C' || cType === 'P' || cType === 'M') return 1;
  return null;
}

if (!fs.existsSync(rawDir)) {
  throw new Error(`Raw data directory not found: ${rawDir}`);
}

if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE cards (
  card_id INTEGER PRIMARY KEY,
  card_name TEXT,
  card_company TEXT,
  annual_fee TEXT,
  is_credit INTEGER,
  raw_json TEXT
);

CREATE TABLE brands (
  brand_id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_name TEXT UNIQUE
);

CREATE TABLE benefits (
  benefit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  category TEXT,
  discount_rate REAL,
  discount_amount INTEGER,
  discount_type TEXT,
  frequency_limit TEXT,
  per_transaction_limit INTEGER,
  monthly_discount_limit INTEGER,
  min_spend INTEGER,
  raw_info TEXT,
  FOREIGN KEY (card_id) REFERENCES cards(card_id)
);

CREATE TABLE benefit_brands (
  benefit_id INTEGER NOT NULL,
  brand_id INTEGER NOT NULL,
  PRIMARY KEY (benefit_id, brand_id),
  FOREIGN KEY (benefit_id) REFERENCES benefits(benefit_id),
  FOREIGN KEY (brand_id) REFERENCES brands(brand_id)
);

CREATE TABLE performance_tiers (
  tier_id INTEGER PRIMARY KEY AUTOINCREMENT,
  benefit_id INTEGER NOT NULL,
  min_spend INTEGER,
  max_spend INTEGER,
  monthly_limit INTEGER,
  FOREIGN KEY (benefit_id) REFERENCES benefits(benefit_id)
);

CREATE TABLE exclusions (
  exclusion_id INTEGER PRIMARY KEY AUTOINCREMENT,
  benefit_id INTEGER NOT NULL,
  exclusion_type TEXT,
  FOREIGN KEY (benefit_id) REFERENCES benefits(benefit_id)
);

CREATE INDEX idx_benefits_card_category ON benefits (card_id, category);

CREATE VIEW v_card_notice AS
WITH note_rows AS (
  SELECT
    b.card_id,
    b.benefit_id,
    TRIM(b.raw_info) AS note_text
  FROM benefits AS b
  WHERE b.category = '유의사항'
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
  '[공통 유의사항 시작]\n' || COALESCE(n.notice_text, '') || '\n[공통 유의사항 끝]' AS common_notes_block
FROM benefits AS b
LEFT JOIN v_card_notice AS n ON n.card_id = b.card_id
WHERE b.category <> '유의사항';

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

const insertCardStmt = db.prepare(`
INSERT INTO cards (
  card_id,
  card_name,
  card_company,
  annual_fee,
  is_credit,
  raw_json
) VALUES (?, ?, ?, ?, ?, ?)
`);

const insertBenefitStmt = db.prepare(`
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
) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)
`);

const files = fs
  .readdirSync(rawDir)
  .filter((name) => name.endsWith('.json'))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

let cardCount = 0;
let benefitCount = 0;

db.exec('BEGIN');
try {
  for (const fileName of files) {
    const filePath = path.join(rawDir, fileName);
    const rawText = fs.readFileSync(filePath, 'utf8');
    const card = JSON.parse(rawText);

    insertCardStmt.run(
      card.idx,
      card.name ?? null,
      card.corp?.name ?? null,
      card.annual_fee_basic ?? null,
      mapIsCredit(card.c_type),
      rawText
    );
    cardCount += 1;

    const keyBenefits = Array.isArray(card.key_benefit) ? card.key_benefit : [];
    for (const benefit of keyBenefits) {
      insertBenefitStmt.run(
        card.idx,
        benefit?.cate?.name ?? null,
        benefit?.info ?? null
      );
      benefitCount += 1;
    }
  }

  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  db.close();
  throw error;
}

const cardsInDb = db.prepare('SELECT COUNT(*) AS cnt FROM cards').get().cnt;
const benefitsInDb = db.prepare('SELECT COUNT(*) AS cnt FROM benefits').get().cnt;

db.close();

console.log(`Created DB: ${dbPath}`);
console.log(`JSON files found: ${files.length}`);
console.log(`Inserted cards: ${cardCount} (verified: ${cardsInDb})`);
console.log(`Inserted benefits: ${benefitCount} (verified: ${benefitsInDb})`);
