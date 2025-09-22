import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import cheerio from 'cheerio';
import { Pool } from 'pg';

/* ──────────────────────────────────────────────────────────────
   0) ENV
   ────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────
   1) APP
   ────────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

/* ──────────────────────────────────────────────────────────────
   2) DB
   ────────────────────────────────────────────────────────────── */
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
  if (!make || !model || !year || !price) {
    return { old_avg: null, new_avg: null, new_count: null };
  }
  const key = [make, model, year];
  const { rows } = await pool.query(
    'SELECT count, avg_price FROM model_stats WHERE make=$1 AND model=$2 AND year=$3',
    key
  );
  if (rows.length === 0) {
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

/* ──────────────────────────────────────────────────────────────
   3) Telegram helpers
   ────────────────────────────────────────────────────────────── */
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
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: false
  });
}
async function notify(text) {
  if (!TELEGRAM_CHAT_ID) return;
  return reply(TELEGRAM_CHAT_ID, text);
}

/* ──────────────────────────────────────────────────────────────
   4) Parsers (без API) — OLX, OTOMOTO
   ────────────────────────────────────────────────────────────── */
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
  const t = normSpaces(title).replace(/\,/g, ' ');
  const ym = t.match(/\b(19\d{2}|20\d{2})\b/);
  const head = ym ? t.slice(0, ym.index).trim() : t;
  const parts = head.split(' ').filter(Boolean);
  const make = (parts[0] || '').toLowerCase();
  // склеим 1–2 слова на модель, чтобы поймать “W211”, “3 Series”, “A4”
  const model = parts.slice(1, 3).join(' ').toLowerCase();
  return {
    make: make ? make[0].toUpperCase() + make.slice(1) : 'Unknown',
    model: model ? model.toUpperCase() : 'UNKNOWN'
  };
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'accept-language': 'pl-PL,pl;q=0.9,en;q=0.8'
    }
  });
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
  return await r.text();
}

/* OLX: список объявлений.
   Селекторы подобраны для текущей сетки OLX; если что — правим здесь. */
async function parseOlxList() {
  const html = await fetchHtml(OLX_SEARCH_URL);
  const $ = cheerio.load(html);

  const items = [];
  $('div.css-1sw7q4x') // карточка (OLX listing grid)
    .each((_, el) => {
      const a = $(el).find('a[href]').first();
      const url = a.attr('href');
      const title = normSpaces($(el).find('h6').first().text()) ||
                    normSpaces($(el).find('h3').first().text());
      const priceText = normSpaces($(el).find('p.css-13afqrm').text()) ||
                        normSpaces($(el).find('p.css-1q7qk2x').text()) ||
                        normSpaces($(el).find('[data-testid="ad-price"]').text());
      const price = parsePriceToNumber(priceText);
      if (!url || !title || !price) return;

      // нормализуем URL (иногда приходит относительный)
      const fullUrl = url.startsWith('http') ? url : `https://www.olx.pl${url}`;
      // ad_id — возьмем хвост URL без не-алфанумерик
      const ad_id = (fullUrl.split('/').filter(Boolean).pop() || fullUrl)
        .replace(/[^0-9a-z\-]/gi, '');

      const year = extractYear(title);
      const { make, model } = splitMakeModel(title);

      items.push({
        id: ad_id,
        title,
        make,
        model,
        year,
        price,
        url: fullUrl
      });
    });

  // фильтры цены на всякий случай
  return items.filter(it => it.price >= PRICE_MIN && it.price <= PRICE_MAX);
}

/* OTOMOTO: список объявлений.
   Селекторы для текущих карточек; если изменятся — обновим. */
async function parseOtomotoList() {
  const html = await fetchHtml(OTOMOTO_SEARCH_URL);
  const $ = cheerio.load(html);

  const items = [];
  // карточка объявления может иметь разные классы, возьмем <article>
  $('article').each((_, el) => {
    const a = $(el).find('a[href]').first();
    let url = a.attr('href');
    if (!url) return;
    if (!url.startsWith('http')) url = `https://www.otomoto.pl${url}`;

    const title =
      normSpaces($(el).find('h2').first().text()) ||
      normSpaces($(el).find('a[data-testid="ad-title"]').text());

    const priceText =
      normSpaces($(el).find('[data-testid="ad-price"]').first().text()) ||
      normSpaces($(el).find('.ooa-1bmnxg7').first().text());

    const price = parsePriceToNumber(priceText);
    if (!title || !price) return;

    const ad_id = (url.split('/').filter(Boolean).pop() || url)
      .replace(/[^0-9a-z\-]/gi, '');

    const year = extractYear(title);
    const { make, model } = splitMakeModel(title);

    items.push({
      id: ad_id,
      title,
      make,
      model,
      year,
      price,
      url
    });
  });

  return items.filter(it => it.price >= PRICE_MIN && it.price <= PRICE_MAX);
}

/* ──────────────────────────────────────────────────────────────
   5) Monitor logic
   ────────────────────────────────────────────────────────────── */
let timer = null;
let lastRunInfo = { ts: null, found: 0, sent: 0, notes: [] };

async function monitorOnce() {
  await initDb();
  const notes = [];
  let found = 0;
  let sent = 0;

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
        if (stats.old_avg !== null && Number(stats.old_avg) > 0) {
          if (Number(ad.price) <= Number(stats.old_avg) * HOT_THRESHOLD) {
            isHot = true;
          }
        }

        let text =
          (isHot ? '🔥 ГОРЯЧЕЕ ПРЕДЛОЖЕНИЕ!\n' : '') +
          `${s.name}: ${ad.title}\n` +
          `Цена: ${ad.price} PLN\n` +
          `Марка: ${ad.make}\n` +
          `Модель: ${ad.model}\n` +
          `Год: ${ad.year || '—'}\n` +
          `${ad.url}\n`;

        if (stats.new_count) {
          const avg = Number(stats.old_avg ?? stats.new_avg);
          if (avg && Number.isFinite(avg)) {
            text += `Средняя (${stats.new_count}) для ${ad.make} ${ad.model} ${ad.year || ''}: ${Math.round(avg)} PLN\n`;
            if (isHot) {
              text += `Порог: ${Math.round(HOT_THRESHOLD * 100)}% от средней\n`;
            }
          }
        }

        await notify(text);
        sent++;
      }
    } catch (e) {
      notes.push(`${s.name} parse error: ${e.message}`);
      console.error(`${s.name} error`, e);
    }
  }

  lastRunInfo = { ts: new Date().toISOString(), found, sent, notes };
  return lastRunInfo;
}

function startMonitor(everyMinutes = 15) {
  if (timer) clearInterval(timer);
  timer = setInterval(monitorOnce, Math.max(1, everyMinutes) * 60 * 1000);
}
function stopMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ──────────────────────────────────────────────────────────────
   6) Routes + Webhook
   ────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => res.send('lemexicars online 🚗'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/set-webhook', async (_req, res) => {
  const url = `https://lemexicars.onrender.com/tg`; // хардкод https
  const j = await tg('setWebhook', { url });
  res.json({ ok: true, result: j });
});

app.post('/tg', async (req, res) => {
  try {
    const update = req.body;
    const msg = update.message || update.edited_message || update.channel_post;
    if (!msg) return res.json({ ok: true });

    const chatId = msg.chat?.id;
    const text = (msg.text || '').trim();

    // доступ только для разрешенной группы
    if (!isAllowed(chatId)) {
      await reply(chatId, 'У вас нет прав');
      if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') {
        await tg('leaveChat', { chat_id: chatId }).catch(() => {});
      }
      return res.json({ ok: true });
    }

    // команды
    if (/^\/ping\b/i.test(text)) {
      await reply(chatId, 'pong ✅');
      return res.json({ ok: true });
    }

    if (/^\/help\b/i.test(text)) {
      await reply(
        chatId,
        [
          'Команды:',
          '/ping — проверить связь',
          '/watch [минуты] — запустить мониторинг (по умолчанию 15)',
          '/stop — остановить мониторинг',
          '/status — статус и метрики'
        ].join('\n')
      );
      return res.json({ ok: true });
    }

    if (/^\/watch\b/i.test(text)) {
      const m = text.match(/\/watch\s+(\d+)/i);
      const every = m ? Number(m[1]) : 15;
      await reply(chatId, `⏱ Запускаю мониторинг каждые ${every} мин.\nФильтры: Wrocław+100km, ${PRICE_MIN}–${PRICE_MAX} PLN.`);
      startMonitor(every);
      // первый прогон сразу
      monitorOnce().catch(e => console.error('first run err', e));
      return res.json({ ok: true });
    }

    if (/^\/stop\b/i.test(text)) {
      stopMonitor();
      await reply(chatId, '⏹ Мониторинг остановлен.');
      return res.json({ ok: true });
    }

    if (/^\/status\b/i.test(text)) {
      const { rows: seenCount } = await pool.query('SELECT COUNT(*)::int AS c FROM ads_seen');
      const { rows: statsCount } = await pool.query('SELECT COUNT(*)::int AS c FROM model_stats');
      const info = lastRunInfo;
      await reply(
        chatId,
        [
          `Статус: ${timer ? '🟢 запущен' : '🔴 остановлен'}`,
          `Последний прогон: ${info.ts || '—'}`,
          `Найдено: ${info.found || 0}, отправлено: ${info.sent || 0}`,
          info.notes?.length ? `Заметки: ${info.notes.join(' | ')}` : '',
          `База: ads_seen=${seenCount[0]?.c || 0}, model_stats=${statsCount[0]?.c || 0}`,
          `Фильтр: ${PRICE_MIN}–${PRICE_MAX} PLN, порог hot=${Math.round(HOT_THRESHOLD * 100)}%`
        ].filter(Boolean).join('\n')
      );
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.json({ ok: true });
  }
});

/* ──────────────────────────────────────────────────────────────
   7) Start
   ────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('lemexicars up on', PORT));
