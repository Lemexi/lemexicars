// server.js — OLX watcher bot (Telegram + Apify)
// v2025-09-22-olx-lemexicars

import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { Pool } from 'pg';

/* ──────────────────────────────────────────────────────────────
   1) ENV
   ────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 8080;

// Telegram
const BOT_TOKEN = process.env.BOT_TOKEN;                        // 8146...:XXXXX
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || 'olxhook';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';    // опц. дефолтный чат
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Apify
const APIFY_TOKEN = process.env.APIFY_TOKEN;                    // токен Apify
const APIFY_ACTOR = process.env.APIFY_ACTOR || 'ecomscrape/olx-product-search-scraper';

// Поиск
const START_URLS = (process.env.START_URLS || '').split('\n')
  .map(s => s.trim()).filter(Boolean);
// пример одной строки:
// https://www.olx.pl/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100&search%5Bfilter_float_price:from%5D=1000&search%5Bfilter_float_price:to%5D=22000

const PRICE_MIN = Number(process.env.PRICE_MIN || 1000);
const PRICE_MAX = Number(process.env.PRICE_MAX || 22000);
const ITEMS_LIMIT = Number(process.env.ITEMS_LIMIT || 50);

// Планировщик
const ENABLE_CRON = (process.env.ENABLE_CRON || 'true').toLowerCase() === 'true';
const CRON_EVERY_MIN = Number(process.env.CRON_EVERY_MIN || 15);

// БД
const DATABASE_URL = process.env.DATABASE_URL || ''; // если пусто — используем in-memory
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

// In-memory дедуп (резерв на случай отсутствия БД)
const memorySeen = new Set();

/* ──────────────────────────────────────────────────────────────
   2) UTILS
   ────────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

function allowChat(chatId) {
  if (!ALLOWED_CHAT_IDS.length) return true;
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

async function tgSend(chatId, text, opts = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN not set');
  const url = `${TELEGRAM_API}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    ...opts,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error('Telegram sendMessage failed:', j);
  return j;
}

function fmtItem(it) {
  const title = it.title || it.name || 'Без названия';
  const price = it.price || it.priceText || '';
  const loc = it.location || it.city || '';
  const url = it.url || it.link || it.detailUrl || '';
  return `<b>${escapeHtml(title)}</b>\n${escapeHtml(price)} • ${escapeHtml(loc)}\n${url}`;
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractPriceNumber(it) {
  const raw = it.price || it.priceText || '';
  const m = String(raw).replace(/\s/g, '').match(/(\d[\d.,]*)/);
  if (!m) return null;
  return Number(m[1].replace(/\./g, '').replace(/,/g, '.'));
}

/* ──────────────────────────────────────────────────────────────
   3) DB INIT (опционально)
   ────────────────────────────────────────────────────────────── */
async function ensureDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_ads (
      id SERIAL PRIMARY KEY,
      ad_hash TEXT UNIQUE NOT NULL,
      url TEXT,
      title TEXT,
      price_num NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function seenHas(hash) {
  if (pool) {
    const { rows } = await pool.query('SELECT 1 FROM seen_ads WHERE ad_hash=$1 LIMIT 1', [hash]);
    return rows.length > 0;
  } else {
    return memorySeen.has(hash);
  }
}

async function seenAdd(hash, { url, title, price }) {
  if (pool) {
    await pool.query(
      'INSERT INTO seen_ads(ad_hash, url, title, price_num) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [hash, url || null, title || null, price ?? null]
    );
  } else {
    memorySeen.add(hash);
  }
}

/* ──────────────────────────────────────────────────────────────
   4) APIFY SCRAPER
   ────────────────────────────────────────────────────────────── */
async function runApifyOnce() {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');
  if (!START_URLS.length) throw new Error('START_URLS is empty');

  const startUrlsObjects = START_URLS.map(u => ({ url: u }));
  const startRunUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_ACTOR)}/runs?token=${APIFY_TOKEN}`;
  const input = {
    startUrls: startUrlsObjects,
    limit: ITEMS_LIMIT,
    maxItems: ITEMS_LIMIT,
    country: 'pl',
    proxy: { useApifyProxy: true }
  };

  // 1) стартуем
  const r = await fetch(startRunUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input })
  });
  const run = await r.json();
  if (!run?.data?.id) {
    console.error('Apify start failed:', run);
    throw new Error('Apify start failed');
  }
  const runId = run.data.id;

  // 2) ждём SUCCEEDED
  const runDetailUrl = `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`;
  for (;;) {
    const rr = await fetch(runDetailUrl);
    const dj = await rr.json();
    const status = dj?.data?.status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      console.error('Apify run failed:', dj);
      throw new Error(`Apify run status: ${status}`);
    }
    await new Promise(res => setTimeout(res, 1500));
  }

  // 3) читаем датасет
  const datasetId = run?.data?.defaultDatasetId;
  if (!datasetId) return [];
  const itemsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`;
  const ir = await fetch(itemsUrl);
  const items = await ir.json();
  return Array.isArray(items) ? items : [];
}

/* ──────────────────────────────────────────────────────────────
   5) PIPELINE: scrape → filter → dedupe → send
   ────────────────────────────────────────────────────────────── */
async function scrapeOnce() {
  const items = await runApifyOnce();
  console.log('APIFY items count:', items?.length || 0);

  const filtered = [];
  for (const it of items) {
    const priceNum = extractPriceNumber(it);
    if (priceNum != null) {
      if (priceNum < PRICE_MIN || priceNum > PRICE_MAX) continue;
    }
    filtered.push(it);
  }
  return filtered;
}

function adHash(it) {
  const u = it.url || it.link || it.detailUrl || '';
  return u.replace(/[#?].*$/, ''); // урезаем query/hash для стабильности
}

async function pushNewItems(items, chatId) {
  let sent = 0, skipped = 0, filtered = 0;
  for (const it of items) {
    // второй рубеж фильтра — вдруг цена не распарсилась в первом шаге
    const pn = extractPriceNumber(it);
    if (pn != null && (pn < PRICE_MIN || pn > PRICE_MAX)) {
      filtered++;
      continue;
    }

    const h = adHash(it);
    const already = await seenHas(h);
    if (already) { skipped++; continue; }

    await seenAdd(h, { url: it.url || it.link, title: it.title || it.name, price: pn ?? null });
    await tgSend(chatId, fmtItem(it));
    sent++;
  }
  return { sent, filtered, skipped };
}

async function runScrapeAndNotify(chatId) {
  const startMsg = `🔎 Запускаю скрапинг OLX…\nЛимит: ${ITEMS_LIMIT}, цена: ${PRICE_MIN}–${PRICE_MAX}`;
  await tgSend(chatId, startMsg);

  try {
    const items = await scrapeOnce();
    const { sent, filtered, skipped } = await pushNewItems(items, chatId);
    await tgSend(chatId, `✅ Готово. Новых: ${sent}, отфильтровано: ${filtered}, повторов: ${skipped}.`);
  } catch (err) {
    console.error('scrape error', err);
    await tgSend(chatId, `❌ Ошибка скрейпа: ${err.message || err}`);
  }
}

/* ──────────────────────────────────────────────────────────────
   6) TELEGRAM HANDLERS
   ────────────────────────────────────────────────────────────── */
app.post(`/tg/webhook`, async (req, res) => {
  const { secret } = req.query;
  if (secret !== TG_WEBHOOK_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });

  try {
    const update = req.body;
    if (!update?.message) return res.json({ ok: true });

    const msg = update.message;
    const chatId = msg.chat.id;

    if (!allowChat(chatId)) {
      await tgSend(chatId, '⛔️ Доступ ограничен.');
      return res.json({ ok: true });
    }

    const text = (msg.text || '').trim();

    if (/^\/start\b/i.test(text)) {
      await tgSend(chatId,
        `Привет! Я слежу за OLX по заданным ссылкам и ценам.\n` +
        `Команды:\n` +
        `/scrape — проверить сейчас\n` +
        `/help — помощь`
      );
    } else if (/^\/help\b/i.test(text)) {
      await tgSend(chatId,
        `Как работать:\n` +
        `1) В .env укажи START_URLS (по одной ссылке в строке), PRICE_MIN/MAX.\n` +
        `2) Команда /scrape запустит проверку.\n` +
        `3) Я пришлю все НОВЫЕ подходящие объявления.\n` +
        `Таймер: каждые ${CRON_EVERY_MIN} мин: ${ENABLE_CRON ? 'включен' : 'выключен'}.`
      );
    } else if (/^\/scrape\b/i.test(text)) {
      await runScrapeAndNotify(chatId);
    } else {
      await tgSend(chatId, 'Не понял. Используй /scrape или /help.');
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Простой тест без Telegram webhook: GET /tg/test?secret=...&text=...
app.get('/tg/test', async (req, res) => {
  const { secret, text, chatId } = req.query;
  if (secret !== TG_WEBHOOK_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
  const id = chatId || TELEGRAM_CHAT_ID;
  if (!id) return res.status(400).json({ ok: false, error: 'no chatId' });
  const r = await tgSend(id, text || 'pong');
  res.json(r);
});

/* ──────────────────────────────────────────────────────────────
   7) HEALTH + ROOT
   ────────────────────────────────────────────────────────────── */
app.get('/', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/health', (req, res) => res.json({ ok: true }));

/* ──────────────────────────────────────────────────────────────
   8) CRON (каждые N минут)
   ────────────────────────────────────────────────────────────── */
function startCron() {
  if (!ENABLE_CRON) return;
  if (!TELEGRAM_CHAT_ID) {
    console.warn('CRON disabled: TELEGRAM_CHAT_ID not set');
    return;
  }
  const ms = CRON_EVERY_MIN * 60 * 1000;
  setInterval(() => runScrapeAndNotify(TELEGRAM_CHAT_ID), ms);
  console.log(`CRON started: every ${CRON_EVERY_MIN} min`);
}

/* ──────────────────────────────────────────────────────────────
   9) START
   ────────────────────────────────────────────────────────────── */
(async () => {
  try {
    if (pool) await ensureDb();
    app.listen(PORT, () => console.log('Listening on', PORT));
    startCron();
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();
