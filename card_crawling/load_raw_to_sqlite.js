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
