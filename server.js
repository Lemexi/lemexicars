import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';

/* ========== ENV ========== */
const APIFY_TOKEN       = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID    = process.env.APIFY_ACTOR_ID || 'ecomscrape~olx-product-search-scraper';

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const ALLOWED_CHAT_IDS  = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const ITEMS_LIMIT       = Number(process.env.ITEMS_LIMIT || 100);
const PRICE_MIN         = Number(process.env.PRICE_MIN || 0);
const PRICE_MAX         = Number(process.env.PRICE_MAX || 999999999);

const START_URLS = (process.env.START_URLS || '').split('\n')
  .map(s => s.trim()).filter(Boolean);
// На всякий случай — дефолт с твоего скрина (Вроцлав +100км)
if (START_URLS.length === 0) {
  START_URLS.push(
    'https://www.olx.pl/d/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100'
  );
}

/* ========== APP ========== */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const PORT = process.env.PORT || 8080;

/* ========== HELPERS ========== */
const seen = new Set(); // простая дедупликация за время жизни процесса

function tgAllowed(chatId) {
  if (!ALLOWED_CHAT_IDS.length) return true;
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

async function tgSend(text, chatId = TELEGRAM_CHAT_ID) {
  if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN not set');
  if (!tgAllowed(chatId)) {
    console.log('Blocked send to non-allowed chat:', chatId);
    return { ok: false, reason: 'not allowed' };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error('Telegram error:', j);
  return j;
}

function parsePrice(raw) {
  if (raw == null) return null;
  // Приходит как число или как строка с пробелами/валютой — нормализуем:
  const m = String(raw).replace(/[^\d]/g, '');
  return m ? Number(m) : null;
}

function formatItem(it) {
  const priceNum = parsePrice(it.price);
  const priceStr = (priceNum != null) ? `${priceNum.toLocaleString('pl-PL')} PLN` : '—';
  const title = it.title || 'Без названия';
  const city  = it.location || it.city || '—';
  const url   = it.url || it.detailUrl || it.link || '';

  return `<b>${title}</b>
Цена: <b>${priceStr}</b>
Город: ${city}
Источник: ${url}`;
}

function passFilters(it) {
  const priceNum = parsePrice(it.price);
  if (priceNum != null) {
    if (priceNum < PRICE_MIN) return false;
    if (priceNum > PRICE_MAX) return false;
  }
  return true;
}

/* ========== APIFY CALLS ========== */
async function apifyStartRun(startUrls = START_URLS) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`;
  const body = {
    input: {
      startUrls,
      limit: ITEMS_LIMIT,
      country: "pl",
      proxy: { useApifyProxy: true }
    }
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error('Apify start error: '+JSON.stringify(j.error));
  // run data может быть в j.data или в корне — поддержим оба
  return j.data || j;
}

async function apifyWaitForRun(runId, timeoutMs = 180000) {
  const start = Date.now();
  while (true) {
    const r = await fetch(`https://api.apify.com/v2/runs/${runId}?token=${APIFY_TOKEN}`);
    const j = await r.json();
    const run = j.data || j;
    const status = run.status;
    if (status === 'SUCCEEDED') return run;
    if (status === 'FAILED' || status === 'TIMED_OUT' || status === 'ABORTED') {
      throw new Error('Run finished with status: ' + status);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Run wait timeout');
    }
    await new Promise(res => setTimeout(res, 5000));
  }
}

async function apifyFetchItems(datasetId) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=1&token=${APIFY_TOKEN}`;
  const r = await fetch(url);
  return await r.json();
}

/* ========== CORE: one-shot scrape & push ========== */
async function runOnce() {
  const startMsg = `Запускаю скрапинг OLX…\nФильтр цена: ${PRICE_MIN}–${PRICE_MAX} PLN\nURLs: ${START_URLS.length}`;
  await tgSend(startMsg);

  const run = await apifyStartRun();
  const runId = run.id || (run.data && run.data.id);
  if (!runId) throw new Error('No run id from Apify');

  const finished = await apifyWaitForRun(runId, 360000); // до 6 минут
  const datasetId = finished.defaultDatasetId || (finished.data && finished.data.defaultDatasetId);
  if (!datasetId) throw new Error('No datasetId');

  const items = await apifyFetchItems(datasetId);

  let sent = 0, skipped = 0, filtered = 0;
  for (const it of items) {
    const url = it.url || it.detailUrl || it.link;
    if (!url) { skipped++; continue; }
    if (seen.has(url)) { skipped++; continue; }
    if (!passFilters(it)) { filtered++; continue; }

    const msg = formatItem(it);
    await tgSend(msg);
    seen.add(url);
    sent++;
  }

  await tgSend(`Готово. Новых: ${sent}, отфильтровано: ${filtered}, повторов: ${skipped}.`);
  return { sent, filtered, skipped };
}

/* ========== ROUTES ========== */
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Ручной запуск скрапинга
app.post('/scrape', async (req, res) => {
  try {
    const result = await runOnce();
    res.json({ ok: true, result });
  } catch (e) {
    console.error(e);
    await tgSend(`Ошибка скрапа: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========== START ========== */
app.listen(PORT, () => {
  console.log('Server on http://localhost:' + PORT);
});
