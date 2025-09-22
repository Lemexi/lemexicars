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

const WATCH_INTERVAL_MIN = Number(process.env.WATCH_INTERVAL_MIN || 15);
const TOP_DISCOUNT       = Math.min(Math.max(Number(process.env.TOP_DISCOUNT || 0.2), 0.05), 0.5);

const WEBHOOK_SECRET     = process.env.TELEGRAM_WEBHOOK_SECRET || 'olxhook';

const START_URLS = (process.env.START_URLS || '').split('\n')
  .map(s => s.trim()).filter(Boolean);
if (START_URLS.length === 0) {
  START_URLS.push('https://www.olx.pl/d/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100');
}

/* ========== APP ========== */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const PORT = process.env.PORT || 8080;

/* ========== STATE ========== */
const seen = new Set();                 // дедупликация на время жизни процесса
const watchers = new Map();             // chatId -> {timer, startedAt}

/* ========== HELPERS ========== */
function tgAllowed(chatId) {
  if (!ALLOWED_CHAT_IDS.length) return true;
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

async function tgSend(text, chatId = TELEGRAM_CHAT_ID, opts = {}) {
  if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN not set');
  if (!tgAllowed(chatId)) return { ok: false, reason: 'not allowed' };

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    ...opts,
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
Ссылка: ${url}`;
}

function passFilters(it) {
  const priceNum = parsePrice(it.price);
  if (priceNum != null) {
    if (priceNum < PRICE_MIN) return false;
    if (priceNum > PRICE_MAX) return false;
  }
  return true;
}

/* простейший парсер бренда/модели из заголовка */
const BRANDS = [
  'audi','bmw','ford','toyota','volkswagen','vw','skoda','mercedes','kia','hyundai','renault',
  'peugeot','opel','volvo','mazda','nissan','honda','seat','fiat','citroen','dacia','mini'
];

function extractMakeModel(titleRaw = '') {
  const t = titleRaw.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż\s-]/g, ' ').replace(/\s+/g,' ').trim();
  const words = t.split(' ');
  let make = null, model = null;
  for (let i=0;i<words.length;i++) {
    const w = words[i];
    if (BRANDS.includes(w)) {
      make = w === 'vw' ? 'volkswagen' : w;
      model = words[i+1] || null;
      break;
    }
  }
  if (!make && words.length >= 2) {
    make = words[0];
    model = words[1];
  }
  return { make, model, key: (make && model) ? `${make} ${model}` : null };
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
  return j.data || j;
}

async function apifyWaitForRun(runId, timeoutMs = 360000) {
  const start = Date.now();
  while (true) {
    const r = await fetch(`https://api.apify.com/v2/runs/${runId}?token=${APIFY_TOKEN}`);
    const j = await r.json();
    const run = j.data || j;
    const status = run.status;
    if (status === 'SUCCEEDED') return run;
    if (['FAILED','TIMED_OUT','ABORTED'].includes(status)) throw new Error('Run status: ' + status);
    if (Date.now() - start > timeoutMs) throw new Error('Run wait timeout');
    await new Promise(res => setTimeout(res, 5000));
  }
}

async function apifyFetchItems(datasetId) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=1&token=${APIFY_TOKEN}`;
  const r = await fetch(url);
  return await r.json();
}

/* ========== SCRAPE RUNS ========== */
async function scrapeOnce() {
  const run = await apifyStartRun();
  const runId = run.id || (run.data && run.data.id);
  if (!runId) throw new Error('No run id from Apify');

  const finished = await apifyWaitForRun(runId);
  const datasetId = finished.defaultDatasetId || (finished.data && finished.data.defaultDatasetId);
  if (!datasetId) throw new Error('No datasetId');

  const items = await apifyFetchItems(datasetId);
  return items;
}

/* отправка обычных «новых» с учётом фильтров и дедупа */
async function pushNewItems(items, chatId = TELEGRAM_CHAT_ID) {
  let sent = 0, filtered = 0, skipped = 0;
  for (const it of items) {
    const url = it.url || it.detailUrl || it.link;
    if (!url) { skipped++; continue; }
    if (seen.has(url)) { skipped++; continue; }
    if (!passFilters(it)) { filtered++; continue; }
    await tgSend(formatItem(it), chatId);
    seen.add(url);
    sent++;
  }
  return { sent, filtered, skipped };
}

/* поиск «топ-сделок» по моделям (цена ниже среднего на X%) */
function findTopDeals(items, discount = TOP_DISCOUNT) {
  // 1) сгруппировать по make+model
  const groups = new Map(); // key -> {sum,count,items[]}
  for (const it of items) {
    const price = parsePrice(it.price);
    if (price == null) continue;
    const { key } = extractMakeModel(it.title || '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { sum:0, count:0, items:[] });
    const g = groups.get(key);
    g.sum += price; g.count += 1; g.items.push({ it, price });
  }
  // 2) средняя и выбор «ниже среднего на discount»
  const deals = [];
  for (const [key, g] of groups.entries()) {
    if (g.count < 3) continue; // минимум 3 объявления для устойчивой средней
    const avg = g.sum / g.count;
    const threshold = avg * (1 - discount);
    for (const { it, price } of g.items) {
      if (price <= threshold) {
        const below = Math.round((1 - price/avg)*100); // % ниже среднего
        deals.push({ it, price, avg, below, key });
      }
    }
  }
  // сортируем по величине «выгодности»
  deals.sort((a,b)=> b.below - a.below);
  return deals;
}

function formatDeal(d) {
  const { it, price, avg, below, key } = d;
  const url = it.url || it.detailUrl || it.link || '';
  const city = it.location || it.city || '—';
  return `🔥 <b>Выгодное предложение</b> (${key})
Цена: <b>${price.toLocaleString('pl-PL')} PLN</b> (на ~${below}% ниже среднего ~${Math.round(avg).toLocaleString('pl-PL')} PLN)
Город: ${city}
Ссылка: ${url}`;
}

/* ========== PUBLIC FLOWS ========== */
async function runScrapeAndPush(chatId = TELEGRAM_CHAT_ID) {
  await tgSend(`Запускаю скрапинг OLX… (лимит ${ITEMS_LIMIT}, цена ${PRICE_MIN}-${PRICE_MAX})`, chatId);
  const items = await scrapeOnce();
  const { sent, filtered, skipped } = await pushNewItems(items, chatId);
  await tgSend(`Готово. Новых: ${sent}, отфильтровано: ${filtered}, повторов: ${skipped}.`, chatId);
}

async function runTop(chatId = TELEGRAM_CHAT_ID, discount = TOP_DISCOUNT) {
  await tgSend(`Ищу «топ-сделки» (ниже среднего на ${Math.round(discount*100)}%)…`, chatId);
  const items = await scrapeOnce();
  const deals = findTopDeals(items, discount);
  if (!deals.length) {
    await tgSend('Пока выгодных предложений не нашёл.', chatId);
    return;
  }
  const maxToSend = Math.min(deals.length, 10);
  for (let i=0; i<maxToSend; i++) {
    await tgSend(formatDeal(deals[i]), chatId);
  }
  await tgSend(`Отправил ${maxToSend} лучш.${deals.length>10?` Показаны первые ${maxToSend}.`:''}`, chatId);
}

/* ========== Telegram webhook ========== */
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;
    if (!update.message) return res.json({ ok:true });

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (!tgAllowed(chatId)) {
      console.log('Ignored message from chat', chatId);
      return res.json({ ok:true });
    }

    // команды
    if (text.startsWith('/watch')) {
      if (watchers.has(chatId)) {
        await tgSend(`Уже слежу каждые ${WATCH_INTERVAL_MIN} мин. (/stop — остановить)`, chatId);
      } else {
        // сразу один запуск
        runScrapeAndPush(chatId).catch(e=>tgSend('Ошибка: '+e.message, chatId));
        // и периодический интервал
        const ms = Math.max(WATCH_INTERVAL_MIN, 5) * 60 * 1000;
        const timer = setInterval(() => {
          runScrapeAndPush(chatId).catch(e=>tgSend('Ошибка: '+e.message, chatId));
        }, ms);
        watchers.set(chatId, { timer, startedAt: Date.now(), everyMs: ms });
        await tgSend(`Запустил мониторинг каждые ${Math.round(ms/60000)} минут. (/stop — остановить)`, chatId);
      }
      return res.json({ ok:true });
    }

    if (text.startsWith('/stop')) {
      const w = watchers.get(chatId);
      if (w) {
        clearInterval(w.timer);
        watchers.delete(chatId);
        await tgSend('Мониторинг остановлен.', chatId);
      } else {
        await tgSend('Мониторинг и так не запущен.', chatId);
      }
      return res.json({ ok:true });
    }

    if (text.startsWith('/top')) {
      // можно указать скидку: /top 0.15 или /top 15
      const parts = text.split(/\s+/);
      let d = TOP_DISCOUNT;
      if (parts[1]) {
        const val = Number(parts[1].replace('%',''));
        if (!isNaN(val)) d = val > 1 ? val/100 : val;
      }
      runTop(chatId, d).catch(e=>tgSend('Ошибка: '+e.message, chatId));
      return res.json({ ok:true });
    }

    if (text.startsWith('/scrape')) {
      runScrapeAndPush(chatId).catch(e=>tgSend('Ошибка: '+e.message, chatId));
      return res.json({ ok:true });
    }

    if (text.startsWith('/help')) {
      await tgSend(`<b>Доступные команды</b>
/watch — начать мониторинг каждые ${WATCH_INTERVAL_MIN} мин
/stop — остановить мониторинг
/top [0.15|15] — показать выгодные предложения (ниже среднего на N%)
/scrape — разовый скрап сейчас
/help — помощь`, chatId, { disable_web_page_preview: true });
      return res.json({ ok:true });
    }

    // по умолчанию — подсказка
    await tgSend('Команды: /watch, /stop, /top, /scrape, /help', chatId);
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ok:true });
  }
});

/* ========== Service routes ========== */
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Ручной HTTP-запуск без Telegram
app.post('/scrape', async (req, res) => {
  try {
    await runScrapeAndPush(TELEGRAM_CHAT_ID);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    await tgSend(`Ошибка скрапа: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========== START ========== */
app.listen(PORT, () => {
  console.log('Server on http://localhost:' + PORT);
  console.log('Telegram webhook path: /telegram/' + WEBHOOK_SECRET);
});
