import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import puppeteer from 'puppeteer';
import { Pool } from 'pg';

/* ══════════════ 0) ENV ══════════════ */
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || CHAT_ALLOWED[0];

const DATABASE_URL = process.env.DATABASE_URL;

const PRICE_MIN = Number(process.env.PRICE_MIN || 1000);
const PRICE_MAX = Number(process.env.PRICE_MAX || 22000);
const HOT_THRESHOLD = Number(process.env.HOT_THRESHOLD || 0.85);

const OLX_SEARCH_URL =
  process.env.OLX_SEARCH_URL ||
  'https://www.olx.pl/d/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

const OTOMOTO_SEARCH_URL =
  process.env.OTOMOTO_SEARCH_URL ||
  'https://www.otomoto.pl/osobowe/wroclaw?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

/* ══════════════ 1) APP ══════════════ */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

/* ══════════════ 2) DB ══════════════ */
const pool = new Pool({ connectionString: DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_seen (
      site TEXT NOT NULL,
      ad_id TEXT NOT NULL,
      title TEXT,
      make TEXT,
      model TEXT,
      year INTEGER,
      price NUMERIC,
      url TEXT,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (site, ad_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_stats (
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      count BIGINT NOT NULL DEFAULT 0,
      avg_price NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (make, model, year)
    );
  `);
}

async function alreadySeen(site, adId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM ads_seen WHERE site=$1 AND ad_id=$2 LIMIT 1',
    [site, adId]
  );
  return rows.length > 0;
}
async function markSeen(site, ad) {
  await pool.query(
    `INSERT INTO ads_seen(site, ad_id, title, make, model, year, price, url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [site, ad.id, ad.title, ad.make, ad.model, ad.year, ad.price, ad.url]
  );
}
async function updateStats(ad) {
  const { make, model, year, price } = ad;
  if (!make || !model || !year || !price) return {};
  const key = [make, model, year];
  const { rows } = await pool.query(
    'SELECT count, avg_price FROM model_stats WHERE make=$1 AND model=$2 AND year=$3',
    key
  );
  if (!rows.length) {
    await pool.query(
      'INSERT INTO model_stats(make, model, year, count, avg_price) VALUES($1,$2,$3,1,$4)',
      [make, model, year, price]
    );
    return { old_avg: null, new_avg: Number(price), new_count: 1 };
  } else {
    const old_count = Number(rows[0].count);
    const old_avg = Number(rows[0].avg_price);
    const new_count = old_count + 1;
    const new_avg = (old_avg * old_count + Number(price)) / new_count;
    await pool.query(
      'UPDATE model_stats SET count=$1, avg_price=$2 WHERE make=$3 AND model=$4 AND year=$5',
      [new_count, new_avg, make, model, year]
    );
    return { old_avg, new_avg, new_count };
  }
}

/* ══════════════ 3) Telegram ══════════════ */
async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!j.ok) console.error('TG API error:', j);
  return j;
}
function isAllowed(chatId) {
  return CHAT_ALLOWED.includes(String(chatId));
}
async function reply(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: false });
}
async function notify(text) {
  if (!TELEGRAM_CHAT_ID) return;
  return reply(TELEGRAM_CHAT_ID, text);
}

/* ══════════════ 4) Helpers ══════════════ */
function normSpaces(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function parsePriceToNumber(s = '') {
  const n = Number(String(s).replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function extractYear(title = '') {
  const m = String(title).match(/\b(19\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}
function splitMakeModel(title = '') {
  const parts = normSpaces(title).split(' ').filter(Boolean);
  return {
    make: parts[0] || 'Unknown',
    model: parts.slice(1, 3).join(' ') || 'UNKNOWN'
  };
}

/* ══════════════ 5) Puppeteer Parser ══════════════ */
async function parseWithPuppeteer(url, site) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let items = await page.evaluate(() => {
    const res = [];
    document.querySelectorAll('article, div.css-1sw7q4x').forEach(el => {
      const a = el.querySelector('a[href]');
      const titleEl = el.querySelector('h2, h3, h6, a[data-testid="ad-title"]');
      const priceEl = el.querySelector('[data-testid="ad-price"], .css-13afqrm, .css-1q7qk2x, .ooa-1bmnxg7');
      if (!a || !titleEl || !priceEl) return;
      res.push({
        url: a.href.startsWith('http') ? a.href : 'https://www.' + location.host + a.getAttribute('href'),
        title: titleEl.innerText,
        priceText: priceEl.innerText
      });
    });
    return res;
  });

  await browser.close();

  return items.map(x => {
    const price = parsePriceToNumber(x.priceText);
    const year = extractYear(x.title);
    const { make, model } = splitMakeModel(x.title);
    return {
      id: (x.url.split('/').filter(Boolean).pop() || x.url).replace(/[^0-9a-z\-]/gi, ''),
      title: x.title,
      make, model, year, price, url: x.url
    };
  }).filter(it => it.price >= PRICE_MIN && it.price <= PRICE_MAX);
}

async function parseOlxList() {
  return parseWithPuppeteer(OLX_SEARCH_URL, 'OLX');
}
async function parseOtomotoList() {
  return parseWithPuppeteer(OTOMOTO_SEARCH_URL, 'OTOMOTO');
}

/* ══════════════ 6) Monitor ══════════════ */
let timer = null;
let lastRunInfo = { ts: null, found: 0, sent: 0, notes: [] };

async function monitorOnce() {
  await initDb();
  let found = 0, sent = 0, notes = [];
  const sources = [
    { name: 'OLX', fn: parseOlxList },
    { name: 'OTOMOTO', fn: parseOtomotoList }
  ];
  for (const s of sources) {
    try {
      const ads = await s.fn();
      found += ads.length;
      for (const ad of ads) {
        const seen = await alreadySeen(s.name.toLowerCase(), ad.id);
        if (seen) continue;
        await markSeen(s.name.toLowerCase(), ad);
        const stats = await updateStats(ad);

        let isHot = false;
        if (stats.old_avg && ad.price <= stats.old_avg * HOT_THRESHOLD) isHot = true;

        let text =
          (isHot ? '🔥 ГОРЯЧЕЕ ПРЕДЛОЖЕНИЕ!\n' : '') +
          `${s.name}: ${ad.title}\nЦена: ${ad.price} PLN\nМарка: ${ad.make}\nМодель: ${ad.model}\nГод: ${ad.year || '—'}\n${ad.url}\n`;

        if (stats.new_count) {
          text += `Средняя (${stats.new_count}) для ${ad.make} ${ad.model} ${ad.year || ''}: ${Math.round(stats.new_avg)} PLN\n`;
        }
        await notify(text);
        sent++;
      }
    } catch (e) {
      notes.push(`${s.name} error: ${e.message}`);
      console.error(s.name, 'error', e);
    }
  }
  lastRunInfo = { ts: new Date().toISOString(), found, sent, notes };
  return lastRunInfo;
}
function startMonitor(everyMinutes = 15) {
  if (timer) clearInterval(timer);
  timer = setInterval(monitorOnce, everyMinutes * 60 * 1000);
}
function stopMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ══════════════ 7) Routes ══════════════ */
app.get('/', (_req, res) => res.send('lemexicars online 🚗'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/tg', async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg) return res.json({ ok: true });
    const chatId = msg.chat?.id;
    const text = (msg.text || '').trim();

    if (!isAllowed(chatId)) {
      await reply(chatId, 'У вас нет прав');
      return res.json({ ok: true });
    }

    if (/^\/ping\b/i.test(text)) await reply(chatId, 'pong ✅');
    else if (/^\/help\b/i.test(text)) await reply(chatId, '/ping /watch /stop /status /top');
    else if (/^\/watch\b/i.test(text)) {
      const m = text.match(/\/watch\s+(\d+)/i);
      const every = m ? Number(m[1]) : 15;
      await reply(chatId, `⏱ Запускаю мониторинг каждые ${every} мин.`);
      startMonitor(every);
      monitorOnce();
    } else if (/^\/stop\b/i.test(text)) {
      stopMonitor(); await reply(chatId, '⏹ Мониторинг остановлен.');
    } else if (/^\/status\b/i.test(text)) {
      const { rows: seenCount } = await pool.query('SELECT COUNT(*)::int AS c FROM ads_seen');
      await reply(chatId, `Статус: ${timer ? '🟢' : '🔴'}\nНайдено: ${lastRunInfo.found}\nОтправлено: ${lastRunInfo.sent}\nОшибки: ${lastRunInfo.notes.join(' | ') || 'нет'}\nОбъявлений в базе: ${seenCount[0]?.c}`);
    } else if (/^\/top\b/i.test(text)) {
      const { rows } = await pool.query('SELECT make, model, year, avg_price, count FROM model_stats ORDER BY avg_price ASC LIMIT 5');
      if (!rows.length) await reply(chatId, 'Нет данных.');
      else {
        let out = '📊 Топ дешёвых моделей:\n';
        rows.forEach(r => { out += `${r.make} ${r.model} ${r.year || ''} → ср. ${Math.round(r.avg_price)} PLN (${r.count})\n`; });
        await reply(chatId, out);
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.json({ ok: true });
  }
});

/* ══════════════ 8) Start ══════════════ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('lemexicars up on', PORT));