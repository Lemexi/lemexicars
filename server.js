// server.js — Lemexi Cars (Render Node service, Puppeteer + Postgres + Telegram)
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import puppeteer, { executablePath } from 'puppeteer';
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
const HOT_THRESHOLD     = Number(process.env.HOT_THRESHOLD || 0.85);  // <= 85% от средней — горячее
const HOT_DISCOUNT_MIN  = Number(process.env.HOT_DISCOUNT_MIN || 0.20); // /top: скидка >= 20%
const TOP_DAYS_DEFAULT  = Number(process.env.TOP_DAYS_DEFAULT || 7);
const PAGES = Number(process.env.PAGES || 3);

// поисковые URL
const OLX_SEARCH_URL =
  process.env.OLX_SEARCH_URL ||
  'https://www.olx.pl/d/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';
const OTOMOTO_SEARCH_URL =
  process.env.OTOMOTO_SEARCH_URL ||
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
const priceN = s => { const n=Number(String(s).replace(/[^\d]/g,'')); return Number.isFinite(n)?n:null; };
const yearOf = t => { const m=String(t).match(/\b(19\d{2}|20\d{2})\b/); return m?Number(m[1]):null; };
function splitMM(title=''){
  const p=norm(title).split(' ').filter(Boolean);
  return { make:(p[0]||'Unknown'), model:(p.slice(1,3).join(' ')||'UNKNOWN') };
}
const withPage = (url,p)=> p<=1?url : url+(url.includes('?')?`&page=${p}`:`?page=${p}`);

/* ===================== Puppeteer ===================== */
let browser = null;

async function launchBrowser() {
  if (browser) return browser;

  // 1) пробуем путь из ENV (если прописан),
  // 2) иначе берём путь из встроенной функции Puppeteer (ищет в /opt/render/.cache/puppeteer)
  const execPath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    (await executablePath());

  console.log('Puppeteer execPath:', execPath);

  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: execPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
  return browser;
}

async function getHtml(url){
  const b = await launchBrowser();
  const page = await b.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language':'pl-PL,pl;q=0.9,en;q=0.8' });
  await page.setViewport({ width: 1366, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', req => ['image','media','font'].includes(req.resourceType()) ? req.abort() : req.continue());
  await page.goto(url, { waitUntil:'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(700);
  const html = await page.content();
  await page.close();
  return html;
}

/* ===================== Scrapers (regex по HTML) ===================== */
async function parseHtml(html, site){
  const re = /<a[^>]*href="([^"]+)"[^>]*>(?:.*?)<\/a>.*?(?:<h2[^>]*>|<h3[^>]*>|<h6[^>]*|data-testid="ad-title")[^>]*>(.*?)<\/(?:h2|h3|h6|a)>.*?(?:data-testid="ad-price"[^>]*>|\bclass="[^"]*(?:ooa-1bmnxg7|css-13afqrm|css-1q7qk2x)[^"]*")[^>]*>(.*?)</gis;
  const items=[]; let m;
  while ((m = re.exec(html)) !== null) {
    let url = m[1]; const title = norm(m[2].replace(/<[^>]+>/g,''));
    const price = priceN(m[3]);
    if (!url || !title || !price) continue;
    if (!/^https?:\/\//!i.test(url)) url = (site==='OLX' ? 'https://www.olx.pl' : 'https://www.otomoto.pl') + url;
    const year = yearOf(title); const { make, model } = splitMM(title);
    items.push({
      id: (url.split('/').filter(Boolean).pop()||url).replace(/[^0-9a-z\-]/gi,''),
      title, make, model, year, price, url
    });
  }
  return items.filter(i => i.price>=PRICE_MIN && i.price<=PRICE_MAX);
}
async function parseSite(baseUrl, site){
  const out=[];
  for (let p=1; p<=PAGES; p++){
    const html = await getHtml(withPage(baseUrl,p));
    out.push(...await parseHtml(html, site));
    await new Promise(r => setTimeout(r, 300 + Math.random()*500));
  }
  return out;
}
const parseOlxList     = () => parseSite(OLX_SEARCH_URL, 'OLX');
const parseOtomotoList = () => parseSite(OTOMOTO_SEARCH_URL, 'OTOMOTO');

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
app.get('/', (_req,res)=>res.send('lemexicars online 🚗'));
app.get('/health', (_req,res)=>res.json({ ok:true }));

// диагностика браузера
app.get('/chrome', async (_req, res) => {
  try {
    const b = await launchBrowser();
    const ver = await b.version();
    res.json({ ok:true, version: ver });
  } catch (e) {
    res.json({ ok:false, error: e.message });
  }
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
      await reply(chatId,`⏱ Запускаю мониторинг каждые ${every} мин. (страниц/источник: ${PAGES})\nФильтры: Wrocław+100km, ${PRICE_MIN}–${PRICE_MAX} PLN.`);
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
        `TOP: окно ${TOP_DAYS_DEFAULT} дн., мин. скидка ${Math.round(HOT_DISCOUNT_MIN*100)}%, страниц=${PAGES}`
      ].filter(Boolean).join('\n'));

    } else if (/^\/scan\b/i.test(text)) {
      await reply(chatId, '🔎 Делаю разовый обход источников…');
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

/* ===================== Start & graceful shutdown ===================== */
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => console.log('lemexicars up on', PORT));

async function shutdown() {
  try { if (browser) await browser.close(); } catch {}
  try { if (pool) await pool.end(); } catch {}
  try { server.close(()=>process.exit(0)); } catch { process.exit(0); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);