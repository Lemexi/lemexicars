// db.js — SQLite дедуп
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.SQLITE_PATH || './data/seen_ads.sqlite';
const DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const db = new Database(DB_PATH, { verbose: null });
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS seen_ads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_hash       TEXT UNIQUE NOT NULL,
  url           TEXT,
  title         TEXT,
  price_num     REAL,
  published_at  TEXT,
  sent_reason   TEXT,      -- 'scrape' | 'top'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seen_hash ON seen_ads(ad_hash);
`);

const stmtHas = db.prepare('SELECT 1 FROM seen_ads WHERE ad_hash = ? LIMIT 1');
const stmtIns = db.prepare(`
  INSERT OR IGNORE INTO seen_ads(ad_hash, url, title, price_num, published_at, sent_reason)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtCount = db.prepare('SELECT COUNT(1) AS c FROM seen_ads');

export function hasSeen(hash) {
  return !!stmtHas.get(hash);
}
export function markSeen(hash, { url, title, price, publishedAt, reason }) {
  stmtIns.run(hash, url || null, title || null, price ?? null, publishedAt || null, reason || null);
}
export function countSeen() {
  const row = stmtCount.get();
  return Number(row?.c || 0);
}
export function closeDb() {
  db.close();
}
