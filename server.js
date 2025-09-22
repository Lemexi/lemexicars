// server.js — Lemexi Cars (OLX via Apify, no Puppeteer)
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { Pool } from 'pg';

/* ===================== ENV ===================== */
// — Телеграм
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || CHAT_ALLOWED[0];

// — База (Neon)
const DATABASE_URL = process.env.DATABASE_URL;

// — Фильтры
const PRICE_MIN = Number(process.env.PRICE_MIN || 1000);
const PRICE_MAX = Number(process.env.PRICE_MAX || 22000);

// «горячее предложение» — цена <= 85% от средней
const HOT_THRESHOLD     = Number(process.env.HOT_THRESHOLD || 0.85);
// для /top считаем «выгодными» скидки >= 20%
const HOT_DISCOUNT_MIN  = Number(process.env.HOT_DISCOUNT_MIN || 0.20);
const TOP_DAYS_DEFAULT  = Number(process.env.TOP_DAYS_DEFAULT || 7);

// сколько страниц «виртуально» собирать (ограничение по кол-ву объявлений)
const PAGES = Number(process.env.PAGES || 3);

// OLX поиск (Wrocław +100 км, бюджет по умолчанию)
const OLX_SEARCH_URL =
  process.env.OLX_SEARCH_URL ||
  'https://www.olx.pl/d/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

// === APIFY ===
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_OLX_ACTOR =
  process.env.APIFY_OLX_ACTOR ||
  'ecomscrape/olx-product-search-scraper';

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
  if (!TOKEN) return { ok:false, error: 'No TELEGRAM_TOKEN' };
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>({ ok:false }));
  if (!j?.ok) console.error('TG API error:', j);
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
const priceN = s => { const n=Number(String(s).replace(/[^\d]/g,'')); return Number.isFinite(n)?n:null; };
const yearOf = t => { const m=String(t).match(/\b(19\d{2}|20\d{2})\b/); return m?Number(m[1]):null; };
function splitMM(title=''){
  const p=norm(title).split(' ').filter(Boolean);
  return { make:(p[0]||'Unknown'), model:(p.slice(1,3).join(' ')||'UNKNOWN') };
}

/* ===================== APIFY helpers (OLX) ===================== */
/**
 * Стартует актор Apify и возвращает массив items из dataset.
 * Надёжный пуллинг статуса + чтение датасета.
 */
async function apifyRunGetItems(actorId, input, { pollMs=2000, maxWaitMs=90_000 } = {}) {
  const startUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(APIFY_TOKEN)}`;
  const r = await fetch(startUrl, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(input||{})
  });
  if (!r.ok) {
    const text = await r.text().catch(()=>r.statusText);
    throw new Error(`Apify ${actorId} HTTP ${r.status}: ${text}`);
  }
  const started = await r.json();
  const runId = started?.data?.id;
  const datasetId = started?.data?.defaultDatasetId;
  if (!runId || !datasetId) throw new Error('Apify: runId/datasetId not received');

  const runUrl = (id)=>`https://api.apify.com/v2/actor-runs/${id}?token=${encodeURIComponent(APIFY_TOKEN)}`;
  const t0 = Date.now();
  while (true) {
    const rr = await fetch(runUrl(runId));
    const j  = await rr.json().catch(()=>({}));
    const status = j?.data?.status;
    if (status === 'SUCCEEDED') break;
    if (['FAILED','ABORTED','TIMED-OUT'].includes(status)) {
      throw new Error(`Apify run failed: ${status}`);
    }
    if (Date.now()-t0 > maxWaitMs) throw new Error('Apify run timeout');
    await new Promise(res=>setTimeout(res, pollMs));
  }

  const dsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true`;
  const ds = await fetch(dsUrl);
  if (!ds.ok) throw new Error(`Apify dataset HTTP ${ds.status}`);
  const items = await ds.json().catch(()=>[]);
  return Array.isArray(items) ? items : [];
}

/**
 * Вызывает актор OLX и мапит выдачу в общий формат {id,title,make,model,year,price,url}
 */
async function parseOlxList() {
  // Подготовим ограничение по количеству
  const perPageGuess = 24; // обычно ~24 в выдаче
  const limit = Math.max(1, Math.min(200, perPageGuess * PAGES));

  // Апифай-актор принимает либо start urls, либо поисковые параметры.
  const input = {
    startUrls: [OLX_SEARCH_URL
      .replace(/filter_float_price%3Afrom%5D=\d+/,'filter_float_price%3Afrom%5D='+PRICE_MIN)
      .replace(/filter_float_price%3Ato%5D=\d+/,'filter_float_price%3Ato%5D='+PRICE_MAX)
    ],
    maxItems: limit
  };

  const raw = await apifyRunGetItems(APIFY_OLX_ACTOR, input);

  // Пример структуры (снимки с твоего экрана): { id, url, name, price, details:[{key:'year'|'model'...}] }
  const out = [];
  for (const it of raw) {
    if (!it) continue;
    const id = String(it.id || (it.url||'').split('/').filter(Boolean).pop() || '').replace(/[^0-9a-z\-]/gi,'');
    const title = norm(it.name || it.title || '');
    const url = it.url || '';
    // цена может быть строкой или объектом
    const priceCandidate = it.price?.value ?? it.price ?? it.price_text ?? it.priceText;
    const price = priceN(priceCandidate);
    if (!id || !title || !price || !url) continue;

    // детали
    let year = null, make=null, model=null;
    if (Array.isArray(it.details)) {
      for (const d of it.details) {
        const k = String(d?.key||'').toLowerCase();
        if (!year && (k==='year'||k.includes('rok'))) year = Number(d?.value) || yearOf(title);
        if (!model && k==='model') model = String(d?.value||'').trim();
        if (!make  && k==='make')  make  = String(d?.value||'').trim();
      }
    }
    if (!make || !model) {
      const mm = splitMM(title);
      make  = make  || mm.make;
      model = model || mm.model;
    }
    if (!year) year = yearOf(title);

    out.push({ id, title, make, model, year, price, url });
  }

  // Фильтр по бюджету всё равно держим
  return out.filter(i => i.price>=PRICE_MIN && i.price<=PRICE_MAX);
}

/* ===================== Monitor loop ===================== */
let timer=null;
let lastRunInfo = { ts:null, found:0, sent:0, notes:[] };

async function monitorOnce(){
  await initDb();
  const notes=[]; let found=0, sent=0;

  const sources=[ {name:'OLX', fn:parseOlxList} ];

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
      const msg = `${s.name} error: ${e.message}`;
      notes.push(msg);
      console.error(msg);
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
app.get('/', (_req,res)=>res.send('lemexicars online 🚗 (OLX via Apify)'));
app.get('/health', (_req,res)=>res.json({ ok:true }));

// быстрая проверка Apify
app.get('/apify', async (_req,res)=>{
  try {
    const items = await apifyRunGetItems(APIFY_OLX_ACTOR, { startUrls:[OLX_SEARCH_URL], maxItems: 5 }, { maxWaitMs: 60_000 });
    res.json({ ok:true, got: items.length, sample: items.slice(0,2) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// опционально: быстрый сет вебхука (если нужно переустановить)
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
        `/top [N] [days] — топ скидок (≥${Math.round(HOT_DISCOUNT_MIN*100)}%)`,
        '',
        'Источник: OLX через Apify'
      ].join('\n'));

    } else if (/^\/watch\b/i.test(text)) {
      const m=text.match(/\/watch\s+(\d+)/i); const every=m?Number(m[1]):15;
      await reply(chatId,`⏱ Запускаю мониторинг каждые ${every} мин. (страниц/источник: ${PAGES})\nФильтры: Wrocław+100km, ${PRICE_MIN}–${PRICE_MAX} PLN.\nИсточник: OLX (Apify).`);
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
        `TOP: окно ${TOP_DAYS_DEFAULT} дн., мин. скидка ${Math.round(HOT_DISCOUNT_MIN*100)}%, страниц=${PAGES}`,
        `Источник: OLX (Apify)`
      ].filter(Boolean).join('\n'));

    } else if (/^\/scan\b/i.test(text)) {
      await reply(chatId, '🔎 Делаю разовый обход OLX через Apify…');
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
app.listen(PORT, () => console.log('lemexicars up on', PORT, 'OLX via Apify'));