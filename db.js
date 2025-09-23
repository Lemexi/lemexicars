// db.js — SQLite: дедуп + кэш рыночной цены (market_stats)
// v1.2
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.SQLITE_PATH || './data/seen_ads.sqlite';
const DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* ─────────────────────────── Schema ─────────────────────────── */
db.exec(`
CREATE TABLE IF NOT EXISTS seen_ads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_hash       TEXT UNIQUE NOT NULL,
  url           TEXT,
  title         TEXT,
  price_num     REAL,
  published_at  TEXT,
  sent_reason   TEXT,             -- 'scrape' | 'top' | 'drop'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seen_hash    ON seen_ads(ad_hash);
CREATE INDEX IF NOT EXISTS idx_seen_created ON seen_ads(created_at);

CREATE TABLE IF NOT EXISTS market_stats (
  group_key     TEXT PRIMARY KEY, -- brand|model|fuel|yearBin|kmBin
  brand         TEXT,
  model         TEXT,
  fuel          TEXT,
  year_bin      TEXT,
  km_bin        TEXT,
  sample_count  INTEGER NOT NULL,
  price_median  REAL NOT NULL,    -- медиана/устойчивое среднее
  price_p25     REAL,             -- необязательно, для справки
  price_p75     REAL,             -- необязательно, для справки
  updated_at    TEXT NOT NULL     -- ISO-строка
);

CREATE INDEX IF NOT EXISTS idx_market_brand ON market_stats(brand, model);
`);

/* ─────────────────────── Prepared statements ─────────────────── */
const stmtSeenHas = db.prepare(`SELECT 1 FROM seen_ads WHERE ad_hash=? LIMIT 1`);
const stmtSeenIns = db.prepare(`
  INSERT OR IGNORE INTO seen_ads (ad_hash, url, title, price_num, published_at, sent_reason)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtSeenCount = db.prepare(`SELECT COUNT(1) AS c FROM seen_ads`);

const stmtMarketGet = db.prepare(`SELECT * FROM market_stats WHERE group_key=?`);
const stmtMarketUpsert = db.prepare(`
  INSERT INTO market_stats (group_key, brand, model, fuel, year_bin, km_bin, sample_count, price_median, price_p25, price_p75, updated_at)
  VALUES (@group_key, @brand, @model, @fuel, @year_bin, @km_bin, @sample_count, @price_median, @price_p25, @price_p75, @updated_at)
  ON CONFLICT(group_key) DO UPDATE SET
    brand=excluded.brand,
    model=excluded.model,
    fuel=excluded.fuel,
    year_bin=excluded.year_bin,
    km_bin=excluded.km_bin,
    sample_count=excluded.sample_count,
    price_median=excluded.price_median,
    price_p25=excluded.price_p25,
    price_p75=excluded.price_p75,
    updated_at=excluded.updated_at
`);

/* ───────────────────────────── Seen API ──────────────────────── */
export function hasSeen(hash) {
  return !!stmtSeenHas.get(hash);
}

export function markSeen(hash, { url, title, price, publishedAt, reason }) {
  stmtSeenIns.run(hash, url || null, title || null, price ?? null, publishedAt || null, reason || null);
}

export function countSeen() {
  const row = stmtSeenCount.get();
  return Number(row?.c || 0);
}

/* ─────────────────────────── Market API ──────────────────────── */
/**
 * Получить кэш рынка по ключу группы.
 * @returns {null|{group_key,brand,model,fuel,year_bin,km_bin,sample_count,price_median,price_p25,price_p75,updated_at}}
 */
export function getMarket(groupKey) {
  return stmtMarketGet.get(groupKey) || null;
}

/**
 * Сохранить/обновить кэш рынка.
 * obj: {
 *   group_key, brand, model, fuel, year_bin, km_bin,
 *   sample_count, price_median, price_p25, price_p75, updated_at(ISO)
 * }
 */
export function upsertMarket(obj) {
  if (!obj?.group_key) throw new Error('upsertMarket: group_key required');
  const payload = {
    price_p25: null,
    price_p75: null,
    ...obj,
    updated_at: obj.updated_at || new Date().toISOString(),
  };
  stmtMarketUpsert.run(payload);
  return payload;
}

/**
 * Проверка свежести кэша рынка.
 * @param {string} groupKey
 * @param {number} maxAgeMin - сколько минут кэш считается свежим
 * @returns {{fresh: boolean, row: object|null, ageMin: number|null}}
 */
export function isMarketFresh(groupKey, maxAgeMin = 120) {
  const row = getMarket(groupKey);
  if (!row) return { fresh: false, row: null, ageMin: null };
  const t = Date.parse(row.updated_at);
  if (Number.isNaN(t)) return { fresh: false, row, ageMin: null };
  const ageMin = Math.floor((Date.now() - t) / 60000);
  return { fresh: ageMin <= maxAgeMin, row, ageMin };
}

/* ─────────────────────────── Helpers ─────────────────────────── */
/**
 * Утилита: вычислить устойчивую медиану/квартили и сформировать запись market_stats.
 * @param {number[]} numbers — цены
 * @param {object} meta — { group_key, brand, model, fuel, year_bin, km_bin }
 */
export function buildMarketRow(numbers = [], meta = {}) {
  const vals = numbers.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (vals.length === 0) return null;

  const q = (p) => {
    const idx = (vals.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return vals[lo];
    return vals[lo] + (vals[hi] - vals[lo]) * (idx - lo);
  };

  const p25 = q(0.25);
  const p50 = q(0.50);
  const p75 = q(0.75);

  return {
    group_key: meta.group_key,
    brand: meta.brand || null,
    model: meta.model || null,
    fuel: meta.fuel || null,
    year_bin: meta.year_bin || null,
    km_bin: meta.km_bin || null,
    sample_count: vals.length,
    price_median: p50,
    price_p25: p25,
    price_p75: p75,
    updated_at: new Date().toISOString(),
  };
}

/* ─────────────────────────── Exports ─────────────────────────── */
export function closeDb() { db.close(); }
export default db;