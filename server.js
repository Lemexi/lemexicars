import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import puppeteer from 'puppeteer-core';
import { Pool } from 'pg';

/* ─────────────────────────────────────────
   0) ENV
   ───────────────────────────────────────── */
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || CHAT_ALLOWED[0];

const DATABASE_URL = process.env.DATABASE_URL;

const PRICE_MIN = Number(process.env.PRICE_MIN || 1000);
const PRICE_MAX = Number(process.env.PRICE_MAX || 22000);
const HOT_THRESHOLD = Number(process.env.HOT_THRESHOLD || 0.85); // 85% от средней

const PAGES = Number(process.env.PAGES || 3);

const OLX_SEARCH_URL =
  process.env.OLX_SEARCH_URL ||
  'https://www.olx.pl/d/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

const OTOMOTO_SEARCH_URL =
  process.env.OTOMOTO_SEARCH_URL ||
  'https://www.otomoto.pl/osobowe/wroclaw?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

/* ─────────────────────────────────────────
   1) APP
   ───────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

/* ─────────────────────────────────────────
   2) DB (Neon)
   ───────────────────────────────────────── */
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
  if (!site || !adId) return true; // не лезем в БД с пустыми значениями
  const { rows } = await pool.query(
    'SELECT 1 FROM ads_seen WHERE site=$1 AND ad_id=$2 LIMIT 1',
    [site, adId]
  );
  return rows.length > 0;
}
async function markSeen(site, ad) {
  if (!site || !ad?.id) return;
  await pool.query(
    `INSERT INTO ads_seen(site, ad_id, title, make, model, year, price, url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [site, ad.id, ad.title, ad.make, ad.model, ad.year, ad.price, ad.url]
  );
}
async function updateStats(ad) {
  const { make, model, year, price } = ad || {};
  if (!make || !model || !year || !price) return { old_avg:null, new_avg:null, new_count:null };
  const key = [make, model, year];
  const { rows } = await pool.query(
    'SELECT count, avg_price FROM model_stats WHERE make=$1 AND model=$2 AND year=$3',
    key
  );
  if (!rows.length) {
    await pool.query(
      'INSERT INTO model_stats(make,model,year,count,avg_price) VALUES($1,$2,$3,1,$4)',
      [make, model, year, price]
    );
    return { old_avg:null, new_avg:Number(price), new_count:1 };
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

/* ─────────────────────────────────────────
   3) Telegram helpers
   ───────────────────────────────────────── */
async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!j.ok) console.error('TG API error:', j);
  return j;
}
function isAllowed(chatId) { return CHAT_ALLOWED.includes(String(chatId)); }
async function reply(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: false });
}
async function notify(text) { if (!TELEGRAM_CHAT_ID) return; return reply(TELEGRAM_CHAT_ID, text); }
function chunkMessages(str, maxLen = 3500) {
  const out = []; let s = String(str);
  while (s.length > maxLen) {
    let cut = s.lastIndexOf('\n', maxLen); if (cut < 0) cut = maxLen;
    out.push(s.slice(0, cut)); s = s.slice(cut);
  }
  if (s) out.push(s); return out;
}

/* ─────────────────────────────────────────
   4) Utils
   ───────────────────────────────────────── */
function normSpaces(s=''){ return String(s||'').replace(/\s+/g,' ').trim(); }
function parsePriceToNumber(s=''){ const n=Number(String(s).replace(/[^\d]/g,'')); return Number.isFinite(n)?n:null; }
function extractYear(title=''){ const m=String(title).match(/\b(19\d{2}|20\d{2})\b/); return m?Number(m[1]):null; }
function splitMakeModel(title=''){
  const t=normSpaces(title), parts=t.split(' ').filter(Boolean);
  const make=parts[0]||'Unknown'; const model=parts.slice(1,3).join(' ')||'UNKNOWN';
  return { make, model };
}
function withPage(url, p){ return p<=1?url : url+(url.includes('?')?`&page=${p}`:`?page=${p}`); }

/* ─────────────────────────────────────────
   5) Puppeteer
   ───────────────────────────────────────── */
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'; // из Dockerfile
let browser = null;

async function getHtmlWithBrowser(url) {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: EXEC_PATH,
      args: ['--no-sandbox','--disable-dev-shm-usage','--single-process']
    });
  }
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' });
  await page.setViewport({ width: 1366, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image','media','font'].includes(req.resourceType())) return req.abort();
    req.continue();
  });

  await page.goto(url, { waitUntil:'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(600);
  const html = await page.content();
  await page.close();
  return html;
}

/* ─────────────────────────────────────────
   6) Parsers (через браузер, по 1..PAGES)
   ───────────────────────────────────────── */
async function scrapeCardsFromHtml(html, siteBase){
  // Небольшой парсер на основе DOM-структур обеих площадок
  // (берём <article> или div.css-1sw7q4x)
  const pattern = /<a[^>]*href="([^"]+)"[^>]*>(?:.*?)<\/a>.*?(?:<h2[^>]*>|<h3[^>]*>|<h6[^>]*>|data-testid="ad-title")[^>]*>(.*?)<\/(?:h2|h3|h6|a)>.*?(?:data-testid="ad-price"[^>]*>|\bclass="[^"]*(?:ooa-1bmnxg7|css-13afqrm|css-1q7qk2x)[^"]*")[^>]*>(.*?)</gis;

  const items = [];
  let m;
  while ((m = pattern.exec(html)) !== null) {
    let url = m[1]; const titleRaw = m[2]; const priceRaw = m[3];
    if (!url || !titleRaw || !priceRaw) continue;
    if (!/^https?:\/\//i.test(url)) {
      const host = siteBase === 'OLX' ? 'https://www.olx.pl' : 'https://www.otomoto.pl';
      url = host + url;
    }
    const title = normSpaces(titleRaw.replace(/<[^>]+>/g,''));
    const price = parsePriceToNumber(priceRaw);
    if (!price) continue;

    const year = extractYear(title);
    const { make, model } = splitMakeModel(title);
    items.push({
      id: (url.split('/').filter(Boolean).pop() || url).replace(/[^0-9a-z\-]/gi,''),
      title, make, model, year, price, url
    });
  }
  return items.filter(i => i.price>=PRICE_MIN && i.price<=PRICE_MAX);
}

async function parseSite(baseUrl, siteName) {
  const all = [];
  for (let p=1; p<=PAGES; p++) {
    const html = await getHtmlWithBrowser(withPage(baseUrl, p));
    const chunk = await scrapeCardsFromHtml(html, siteName);
    all.push(...chunk);
  }
  return all;
}
const parseOlxList = () => parseSite(OLX_SEARCH_URL, 'OLX');
const parseOtomotoList = () => parseSite(OTOMOTO_SEARCH_URL, 'OTOMOTO');

/* ─────────────────────────────────────────
   7) Monitor
   ───────────────────────────────────────── */
let timer = null;
let lastRunInfo = { ts:null, found:0, sent:0, notes:[] };

async function monitorOnce(){
  await initDb();
  const notes=[]; let found=0, sent=0;
  const sources=[ {name:'OLX', fn:parseOlxList}, {name:'OTOMOTO', fn:parseOtomotoList} ];

  for (const s of sources){
    try {
      const ads = await s.fn();
      found += ads.length;

      for (const ad of ads) {
        const seen = await alreadySeen(s.name.toLowerCase(), ad.id);
        if (seen) continue;
        await markSeen(s.name.toLowerCase(), ad);
        const st = await updateStats(ad);

        let isHot = false;
        if (st.old_avg !== null && Number(st.old_avg) > 0) {
          if (Number(ad.price) <= Number(st.old_avg) * HOT_THRESHOLD) isHot = true;
        }

        let text =
          (isHot ? '🔥 ГОРЯЧЕЕ ПРЕДЛОЖЕНИЕ!\n' : '') +
          `${s.name}: ${ad.title}\n` +
          `Цена: ${ad.price} PLN\n` +
          `Марка: ${ad.make}\n` +
          `Модель: ${ad.model}\n` +
          `Год: ${ad.year || '—'}\n` +
          `${ad.url}\n`;

        if (st.new_count) {
          const avg = Number(st.old_avg ?? st.new_avg);
          if (avg && Number.isFinite(avg)) {
            text += `Средняя (${st.new_count}) для ${ad.make} ${ad.model} ${ad.year || ''}: ${Math.round(avg)} PLN\n`;
            if (isHot) text += `Порог: ${Math.round(HOT_THRESHOLD*100)}% от средней\n`;
          }
        }

        await notify(text);
        sent++;
      }
    } catch (e) {
      notes.push(`${s.name} error: ${e.message}`);
      console.error(`${s.name} error`, e);
    }
  }

  lastRunInfo = { ts:new Date().toISOString(), found, sent, notes };
  return lastRunInfo;
}

function startMonitor(everyMinutes=15){
  if (timer) clearInterval(timer);
  timer = setInterval(monitorOnce, Math.max(1,everyMinutes)*60*1000);
}
function stopMonitor(){ if (timer) clearInterval(timer); timer=null; }

/* ─────────────────────────────────────────
   8) Routes + Webhook
   ───────────────────────────────────────── */
app.get('/', (_req,res) => res.send('lemexicars online 🚗'));
app.get('/health', (_req,res) => res.json({ ok:true }));

app.post('/tg', async (req,res) => {
  try{
    const update = req.body;
    const msg = update.message || update.edited_message || update.channel_post;
    if (!msg) return res.json({ ok:true });

    const chatId = msg.chat?.id;
    const text = (msg.text || '').trim();

    if (!isAllowed(chatId)) {
      await reply(chatId, 'У вас нет прав');
      return res.json({ ok:true });
    }

    if (/^\/ping\b/i.test(text)) {
      await reply(chatId, 'pong ✅');
    } else if (/^\/help\b/i.test(text)) {
      await reply(chatId, [
        'Команды:',
        '/ping — проверить связь',
        '/watch [минуты] — запустить мониторинг (по умолчанию 15)',
        '/stop — остановить мониторинг',
        '/status — статус последнего прогона'
      ].join('\n'));
    } else if (/^\/watch\b/i.test(text)) {
      const m = text.match(/\/watch\s+(\d+)/i);
      const every = m ? Number(m[1]) : 15;
      await reply(chatId, `⏱ Запускаю мониторинг каждые ${every} мин. (страниц/источник: ${PAGES})\nФильтры: Wrocław+100km, ${PRICE_MIN}–${PRICE_MAX} PLN.`);
      startMonitor(every);
      monitorOnce().catch(e=>console.error('first run', e)); // первый прогон сразу
    } else if (/^\/stop\b/i.test(text)) {
      stopMonitor();
      await reply(chatId, '⏹ Мониторинг остановлен.');
    } else if (/^\/status\b/i.test(text)) {
      await initDb();
      const { rows: seenCount } = await pool.query('SELECT COUNT(*)::int AS c FROM ads_seen');
      const { rows: statsCount } = await pool.query('SELECT COUNT(*)::int AS c FROM model_stats');
      const i = lastRunInfo;
      await reply(chatId, [
        `Статус: ${timer ? '🟢 запущен' : '🔴 остановлен'}`,
        `Последний прогон: ${i.ts || '—'}`,
        `Найдено: ${i.found || 0}, отправлено: ${i.sent || 0}`,
        i.notes?.length ? `Заметки: ${i.notes.join(' | ')}` : '',
        `База: ads_seen=${seenCount[0]?.c || 0}, model_stats=${statsCount[0]?.c || 0}`,
      ].filter(Boolean).join('\n'));
    }

    return res.json({ ok:true });
  }catch(e){
    console.error('Webhook error:', e);
    return res.json({ ok:true });
  }
});

/* ─────────────────────────────────────────
   9) Start
   ───────────────────────────────────────── */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('lemexicars up on', PORT));