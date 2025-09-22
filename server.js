// server.js — Lemexi Cars (Apify edition, без Puppeteer)
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { Pool } from 'pg';

/* ===================== ENV ===================== */
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || CHAT_ALLOWED[0];

const DATABASE_URL = process.env.DATABASE_URL;

// фильтры
const PRICE_MIN = Number(process.env.PRICE_MIN || 1000);
const PRICE_MAX = Number(process.env.PRICE_MAX || 22000);

// «горячее предложение» — цена <= 85% от средней
const HOT_THRESHOLD     = Number(process.env.HOT_THRESHOLD || 0.85);
// для /top считаем «выгодными» скидки >= 20%
const HOT_DISCOUNT_MIN  = Number(process.env.HOT_DISCOUNT_MIN || 0.20);
const TOP_DAYS_DEFAULT  = Number(process.env.TOP_DAYS_DEFAULT || 7);

// сколько страниц эквивалентно будем просить у Actors (ограничим кол-во элементов)
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 100);

/* ===== Apify ===== */
const APIFY_TOKEN      = process.env.APIFY_TOKEN;

// ИД акторов из стора (можно переопределить через ENV)
const OLX_ACTOR       = process.env.OLX_ACTOR       || 'ecomscrape/olx-product-search-scraper';
const OTOMOTO_ACTOR   = process.env.OTOMOTO_ACTOR   || 'lexis-solutions/otomoto';

// стартовые URL под наш фильтр (можно менять через ENV)
const OLX_START_URL =
  process.env.OLX_START_URL ||
  'https://www.olx.pl/d/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

const OTOMOTO_START_URL =
  process.env.OTOMOTO_START_URL ||
  'https://www.otomoto.pl/osobowe/wroclaw?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

/* ===================== APP ===================== */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

/* ===================== DB (Neon/Postgres) ===================== */
const pool = new Pool({ connectionString: DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_seen (
      site  TEXT NOT NULL,
      ad_id TEXT NOT NULL,
      title TEXT,
      make  TEXT,
      model TEXT,
      year  INTEGER,
      price NUMERIC,
      url   TEXT,
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
  if (!site || !adId) return true;
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

  const q = 'SELECT count, avg_price FROM model_stats WHERE make=$1 AND model=$2 AND year=$3';
  const { rows } = await pool.query(q, [make, model, year]);

  if (!rows.length) {
    await pool.query(
      'INSERT INTO model_stats(make,model,year,count,avg_price) VALUES($1,$2,$3,1,$4)',
      [make, model, year, price]
    );
    return { old_avg:null, new_avg:Number(price), new_count:1 };
  } else {
    const old_count = Number(rows[0].count);
    const old_avg   = Number(rows[0].avg_price);
    const new_count = old_count + 1;
    const new_avg   = (old_avg * old_count + Number(price)) / new_count;
    await pool.query(
      'UPDATE model_stats SET count=$1, avg_price=$2 WHERE make=$3 AND model=$4 AND year=$5',
      [new_count, new_avg, make, model, year]
    );
    return { old_avg, new_avg, new_count };
  }
}

/* ===================== Telegram helpers ===================== */
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
async function notify(text) { if (TELEGRAM_CHAT_ID) return reply(TELEGRAM_CHAT_ID, text); }
function chunk(str, n=3500){ const a=[]; let s=String(str); while(s.length>n){let i=s.lastIndexOf('\n',n); if(i<0)i=n; a.push(s.slice(0,i)); s=s.slice(i);} if(s)a.push(s); return a; }

/* ===================== Utils ===================== */
const norm   = s => String(s||'').replace(/\s+/g,' ').trim();
const priceN = s => {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const n=Number(String(s).replace(/[^\d]/g,''));
  return Number.isFinite(n)?n:null;
};
const yearOf = t => { const m=String(t||'').match(/\b(19\d{2}|20\d{2})\b/); return m?Number(m[1]):null; };
function splitMM(title=''){
  const p=norm(title).split(' ').filter(Boolean);
  return { make:(p[0]||'Unknown'), model:(p.slice(1,3).join(' ')||'UNKNOWN') };
}

/* ===================== Apify helpers ===================== */
/**
 * Бьём в актор через "run-sync-get-dataset-items" и сразу получаем JSON.
 * @param {string} actorSlug e.g. "ecomscrape/olx-product-search-scraper"
 * @param {object} input — см. описание актора
 * @returns {Promise<Array<Object>>} items
 */
async function apifyRunGetItems(actorSlug, input) {
  const url = `https://api.apify.com/v2/acts/${actorSlug.replace('/','~')}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(input || {})
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`Apify ${actorSlug} HTTP ${r.status} ${t?.slice(0,200)}`);
  }
  const items = await r.json();
  return Array.isArray(items) ? items : [];
}

/* ===== Маппинг OLX результата в нашу структуру =====
   OLX Product Search Scraper (ecomscrape):
   поля обычно: id / url / name / price / details[] (model/year/...)
*/
function mapOlx(items=[]) {
  const out=[];
  for (const it of items) {
    const id = String(it.id || it.uuid || it.url || '').replace(/[^0-9a-z\-]/gi,'');
    const title = norm(it.name || it.title || '');
    const price = priceN(it.price || it.price_number || it.priceValue || (it.price_text||''));
    const url   = it.url || it.link || '';
    if (!id || !title || !price || !url) continue;

    let year = Number(it.year || it.production_year || null);
    if (!year) year = yearOf(title);

    // попробуем достать make/model из деталей
    let make=null, model=null;
    if (Array.isArray(it.details)) {
      for (const d of it.details) {
        const key = String(d.key||'').toLowerCase();
        if (!make && (key==='make' || key==='brand')) make = d.value || d.normalized_value || null;
        if (!model && key==='model') model = d.value || d.normalized_value || null;
        if (!year && key==='year') year = Number(d.value || d.normalized_value);
      }
    }
    if (!make || !model) {
      const mm = splitMM(title); make = make || mm.make; model = model || mm.model;
    }
    out.push({ id, title, make, model, year, price, url });
  }
  return out;
}

/* ===== Маппинг OTOMOTO результата =====
   Otomoto.pl Scraper (lexis-solutions/otomoto):
   обычно: id / url / title / price / year / make / model
*/
function mapOtomoto(items=[]) {
  const out=[];
  for (const it of items) {
    const id = String(it.id || it.ad_id || it.url || '').replace(/[^0-9a-z\-]/gi,'');
    const title = norm(it.title || it.name || '');
    const price = priceN(it.price || it.price_number || it.priceValue || (it.price_text||''));
    const url   = it.url || it.link || '';
    if (!id || !title || !price || !url) continue;

    const make  = it.make || it.brand || splitMM(title).make;
    const model = it.model || splitMM(title).model;
    let year    = Number(it.year || it.production_year || null);
    if (!year) year = yearOf(title);

    out.push({ id, title, make, model, year, price, url });
  }
  return out;
}

/* ===== Обёртки источников через Apify ===== */
async function parseOlxList() {
  const input = {
    startUrls: [{ url: OLX_START_URL }],
    maxItems: MAX_ITEMS
  };
  const items = await apifyRunGetItems(OLX_ACTOR, input);
  return mapOlx(items)
    .filter(i => i.price>=PRICE_MIN && i.price<=PRICE_MAX);
}

async function parseOtomotoList() {
  // у community-актора поля могут отличаться; стартового URL достаточно
  const input = {
    startUrls: [{ url: OTOMOTO_START_URL }],
    maxItems: MAX_ITEMS
  };
  const items = await apifyRunGetItems(OTOMOTO_ACTOR, input);
  return mapOtomoto(items)
    .filter(i => i.price>=PRICE_MIN && i.price<=PRICE_MAX);
}

/* ===================== Monitor loop ===================== */
let timer=null;
let lastRunInfo = { ts:null, found:0, sent:0, notes:[] };

async function monitorOnce(){
  await initDb();
  const notes=[]; let found=0, sent=0;
  const sources=[ {name:'OLX', fn:parseOlxList}, {name:'OTOMOTO', fn:parseOtomotoList} ];

  for (const s of sources){
    try{
      const ads = await s.fn(); found += ads.length;
      for (const ad of ads){
        if (await alreadySeen(s.name.toLowerCase(), ad.id)) continue;
        await markSeen(s.name.toLowerCase(), ad);
        const st = await updateStats(ad);

        let hot=false;
        if (st.old_avg !== null && Number(st.old_avg) > 0) {
          hot = Number(ad.price) <= Number(st.old_avg) * HOT_THRESHOLD;
        }

        let text = (hot ? '🔥 ГОРЯЧЕЕ ПРЕДЛОЖЕНИЕ!\n' : '') +
          `${s.name}: ${ad.title}\nЦена: ${ad.price} PLN\nМарка: ${ad.make}\nМодель: ${ad.model}\nГод: ${ad.year || '—'}\n${ad.url}\n`;
        if (st.new_count) {
          const avg = Number(st.old_avg ?? st.new_avg);
          if (avg && Number.isFinite(avg)) {
            text += `Средняя (${st.new_count}) для ${ad.make} ${ad.model} ${ad.year || ''}: ${Math.round(avg)} PLN\n`;
            if (hot) text += `Порог: ${Math.round(HOT_THRESHOLD*100)}% от средней\n`;
          }
        }
        await notify(text); sent++;
      }
    }catch(e){
      notes.push(`${s.name} error: ${e.message}`); console.error(`${s.name} error`, e);
    }
  }

  lastRunInfo = { ts: new Date().toISOString(), found, sent, notes };
  return lastRunInfo;
}
function startMonitor(mins=15){ if (timer) clearInterval(timer); timer=setInterval(monitorOnce, Math.max(1,mins)*60*1000); }
function stopMonitor(){ if (timer) clearInterval(timer); timer=null; }

/* ===================== /top из базы ===================== */
async function queryTopDeals(N=10, days=TOP_DAYS_DEFAULT){
  await initDb();
  const sql = `
    WITH recent AS (
      SELECT site, ad_id, title, make, model, year, price::numeric AS price, url, seen_at
      FROM ads_seen
      WHERE seen_at >= NOW() - $1::interval
        AND price BETWEEN $2 AND $3
    ),
    avg_mmy AS (
      SELECT make, model, year, AVG(price)::numeric AS avg_price, COUNT(*) cnt
      FROM recent WHERE make IS NOT NULL AND model IS NOT NULL
      GROUP BY make, model, year
    ),
    avg_mm AS (
      SELECT make, model, AVG(price)::numeric AS avg_price_mm, COUNT(*) cnt_mm
      FROM recent WHERE make IS NOT NULL AND model IS NOT NULL
      GROUP BY make, model
    )
    SELECT r.*,
           COALESCE(a.avg_price, am.avg_price_mm) AS avg_price,
           CASE WHEN COALESCE(a.avg_price, am.avg_price_mm, 0) > 0
                THEN (1 - (r.price / COALESCE(a.avg_price, am.avg_price_mm)))::numeric
                ELSE NULL END AS discount
    FROM recent r
    LEFT JOIN avg_mmy a ON a.make=r.make AND a.model=r.model AND (a.year=r.year OR (a.year IS NULL AND r.year IS NULL))
    LEFT JOIN avg_mm  am ON am.make=r.make AND am.model=r.model
    WHERE COALESCE(a.avg_price, am.avg_price_mm) IS NOT NULL
      AND (1 - (r.price / COALESCE(a.avg_price, am.avg_price_mm))) >= $4
    ORDER BY discount DESC NULLS LAST, r.seen_at DESC
    LIMIT $5
  `;
  const { rows } = await pool.query(sql, [`${days} days`, PRICE_MIN, PRICE_MAX, HOT_DISCOUNT_MIN, N]);
  return rows;
}

/* ===================== Routes + Webhook ===================== */
app.get('/', (_req,res)=>res.send('lemexicars online 🚗 (Apify)'));
app.get('/health', (_req,res)=>res.json({ ok:true }));

// Диагностика: смотреть, что отдаёт Apify прямо сейчас
app.get('/olx-test', async (_req, res) => {
  try {
    const data = await parseOlxList();
    res.json({ ok:true, count: data.length, sample: data.slice(0,5) });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.get('/otomoto-test', async (_req, res) => {
  try {
    const data = await parseOtomotoList();
    res.json({ ok:true, count: data.length, sample: data.slice(0,5) });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// опционально: быстрый сет вебхука
app.get('/set-webhook', async (_req, res) => {
  if (!process.env.PUBLIC_URL) {
    return res.json({ ok:false, error: 'Set PUBLIC_URL env to use /set-webhook' });
  }
  const url = `${process.env.PUBLIC_URL}/tg`;
  const j = await tg('setWebhook', { url });
  res.json({ ok:true, result: j });
});

app.post('/tg', async (req,res)=>{
  try{
    const update=req.body;
    const msg=update.message || update.edited_message || update.channel_post;
    if (!msg) return res.json({ ok:true });

    const chatId = msg.chat?.id;
    const text = (msg.text || '').trim();

    if (!isAllowed(chatId)) { await reply(chatId,'У вас нет прав'); return res.json({ ok:true }); }

    if (/^\/ping\b/i.test(text)) {
      await reply(chatId,'pong ✅');

    } else if (/^\/help\b/i.test(text)) {
      await reply(chatId,[
        'Команды:',
        '/ping — проверить связь',
        '/watch [мин] — запустить мониторинг (по умолчанию 15)',
        '/stop — остановить мониторинг',
        '/status — статус и метрики',
        '/scan — разовый обход источников',
        `/top [N] [days] — топ скидок (≥${Math.round(HOT_DISCOUNT_MIN*100)}%)`
      ].join('\n'));

    } else if (/^\/watch\b/i.test(text)) {
      const m=text.match(/\/watch\s+(\d+)/i); const every=m?Number(m[1]):15;
      await reply(chatId,`⏱ Запускаю мониторинг каждые ${every} мин. (источники: OLX+Otomoto, max ${MAX_ITEMS} элементов).`);
      startMonitor(every); monitorOnce().catch(e=>console.error('first run',e));

    } else if (/^\/stop\b/i.test(text)) {
      stopMonitor(); await reply(chatId,'⏹ Мониторинг остановлен.');

    } else if (/^\/status\b/i.test(text)) {
      await initDb();
      const { rows: seenCount } = await pool.query('SELECT COUNT(*)::int AS c FROM ads_seen');
      const { rows: statsCount } = await pool.query('SELECT COUNT(*)::int AS c FROM model_stats');
      const i=lastRunInfo;
      await reply(chatId,[
        `Статус: ${timer?'🟢 запущен':'🔴 остановлен'}`,
        `Последний прогон: ${i.ts || '—'}`,
        `Найдено: ${i.found||0}, отправлено: ${i.sent||0}`,
        i.notes?.length ? `Заметки: ${i.notes.join(' | ')}` : '',
        `База: ads_seen=${seenCount[0]?.c||0}, model_stats=${statsCount[0]?.c||0}`,
        `Фильтр: ${PRICE_MIN}–${PRICE_MAX} PLN, hot=${Math.round(HOT_THRESHOLD*100)}%`,
        `TOP: окно ${TOP_DAYS_DEFAULT} дн., мин. скидка ${Math.round(HOT_DISCOUNT_MIN*100)}%, maxItems=${MAX_ITEMS}`
      ].filter(Boolean).join('\n'));

    } else if (/^\/scan\b/i.test(text)) {
      await reply(chatId, '🔎 Делаю разовый обход источников через Apify…');
      try {
        const info = await monitorOnce();
        await reply(chatId, `Готово. Найдено: ${info.found}, отправлено: ${info.sent}. Теперь можно смотреть /top.`);
      } catch (e) {
        await reply(chatId, `Ошибка сканирования: ${e.message}`);
      }

    } else if (/^\/top\b/i.test(text)) {
      await initDb();
      const m=text.match(/\/top(?:\s+(\d+))?(?:\s+(\d+))?/i);
      const N=m&&m[1]?Math.max(1,Math.min(30,Number(m[1]))):10;
      const days=m&&m[2]?Math.max(1,Math.min(90,Number(m[2]))):TOP_DAYS_DEFAULT;

      const { rows: cntRows } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM ads_seen WHERE seen_at >= NOW() - $1::interval',
        [`${days} days`]
      );
      if ((cntRows[0]?.c || 0) === 0) {
        await reply(chatId, '🗃️ База пуста за выбранный период — делаю разовый обход...');
        await monitorOnce().catch(e => console.error('scan for top', e));
      }

      const rows = await queryTopDeals(N, days);
      if (!rows.length) {
        await reply(chatId, `За последние ${days} дн. выгодных предложений (скидка ≥ ${Math.round(HOT_DISCOUNT_MIN*100)}%) не найдено.`);
      } else {
        let out=`🔝 Топ-${rows.length} предложений за ${days} дн. (скидка ≥ ${Math.round(HOT_DISCOUNT_MIN*100)}%):\n`;
        rows.forEach((r,i)=>{
          const avg=Number(r.avg_price); const dPct=Math.round(Number(r.discount||0)*100);
          out+=`\n${i+1}) ${String(r.site).toUpperCase()}: ${r.title}\n`;
          out+=`Цена: ${Math.round(Number(r.price))} PLN • Средняя: ${Math.round(avg)} PLN • Скидка: -${dPct}%\n`;
          out+=`${r.url}\n`;
        });
        for (const c of chunk(out)) await reply(chatId,c);
      }
    }

    return res.json({ ok:true });
  }catch(e){
    console.error('Webhook error:', e);
    return res.json({ ok:true });
  }
});

/* ===================== Start ===================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('lemexicars (Apify) up on', PORT));