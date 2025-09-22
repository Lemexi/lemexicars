import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { load } from 'cheerio';
import puppeteer from 'puppeteer-core';
import { Pool } from 'pg';

/* ===== ENV ===== */
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || CHAT_ALLOWED[0];

const DATABASE_URL = process.env.DATABASE_URL;

const PRICE_MIN = Number(process.env.PRICE_MIN || 1000);
const PRICE_MAX = Number(process.env.PRICE_MAX || 22000);
const HOT_THRESHOLD = Number(process.env.HOT_THRESHOLD || 0.85);

const TOP_DAYS_DEFAULT = Number(process.env.TOP_DAYS_DEFAULT || 7);
const HOT_DISCOUNT_MIN = Number(process.env.HOT_DISCOUNT_MIN || 0.20);
const PAGES = Number(process.env.PAGES || 3);

const OLX_SEARCH_URL =
  process.env.OLX_SEARCH_URL ||
  'https://www.olx.pl/d/motoryzacja/samochody/wroclaw/?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

const OTOMOTO_SEARCH_URL =
  process.env.OTOMOTO_SEARCH_URL ||
  'https://www.otomoto.pl/osobowe/wroclaw?search%5Bdist%5D=100&search%5Bfilter_float_price%3Afrom%5D=1000&search%5Bfilter_float_price%3Ato%5D=22000';

/* ===== APP ===== */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

/* ===== DB ===== */
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
  const { rows } = await pool.query('SELECT 1 FROM ads_seen WHERE site=$1 AND ad_id=$2 LIMIT 1',[site, adId]);
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
  if (!make || !model || !year || !price) return { old_avg:null, new_avg:null, new_count:null };
  const key = [make, model, year];
  const { rows } = await pool.query(
    'SELECT count, avg_price FROM model_stats WHERE make=$1 AND model=$2 AND year=$3',
    key
  );
  if (!rows.length) {
    await pool.query('INSERT INTO model_stats(make,model,year,count,avg_price) VALUES($1,$2,$3,1,$4)', [make, model, year, price]);
    return { old_avg:null, new_avg:Number(price), new_count:1 };
  } else {
    const old_count = Number(rows[0].count);
    const old_avg = Number(rows[0].avg_price);
    const new_count = old_count + 1;
    const new_avg = (old_avg * old_count + Number(price)) / new_count;
    await pool.query('UPDATE model_stats SET count=$1, avg_price=$2 WHERE make=$3 AND model=$4 AND year=$5',
      [new_count, new_avg, make, model, year]);
    return { old_avg, new_avg, new_count };
  }
}

/* ===== Telegram ===== */
async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const j = await r.json(); if (!j.ok) console.error('TG API error:', j); return j;
}
function isAllowed(chatId){ return CHAT_ALLOWED.includes(String(chatId)); }
async function reply(chatId, text){ return tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: false }); }
async function notify(text){ if (!TELEGRAM_CHAT_ID) return; return reply(TELEGRAM_CHAT_ID, text); }
function chunkMessages(s, maxLen=3500){ const out=[]; let t=String(s);
  while(t.length>maxLen){ let i=t.lastIndexOf('\n',maxLen); if(i<0) i=maxLen; out.push(t.slice(0,i)); t=t.slice(i); }
  if(t) out.push(t); return out; }

/* ===== scrape helpers ===== */
function normSpaces(s=''){ return String(s||'').replace(/\s+/g,' ').trim(); }
function parsePriceToNumber(s=''){ const n=Number(String(s).replace(/[^\d]/g,'')); return Number.isFinite(n)?n:null; }
function extractYear(title=''){ const m=String(title).match(/\b(19\d{2}|20\d{2})\b/); return m?Number(m[1]):null; }
function splitMakeModel(title=''){ const t=normSpaces(title).replace(/\,/g,' '), ym=t.match(/\b(19\d{2}|20\d{2})\b/);
  const head=ym ? t.slice(0, ym.index).trim() : t; const parts=head.split(' ').filter(Boolean);
  const make=(parts[0]||'').toLowerCase(); const model=parts.slice(1,3).join(' ').toLowerCase();
  return { make: make?make[0].toUpperCase()+make.slice(1):'Unknown', model: model?model.toUpperCase():'UNKNOWN' }; }
function withPage(url, p){ return p<=1?url: url+(url.includes('?')?`&page=${p}`:`?page=${p}`); }

/* ===== Smart fetch: fetch → (403/капча) → puppeteer-core ===== */
let browser = null;
async function getHtmlSmart(url){
  try {
    const r = await fetch(url, {
      headers:{
        'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language':'pl-PL,pl;q=0.9,en;q=0.8',
        'cache-control':'no-cache'
      }
    });
    if (r.status === 200) {
      const t = await r.text();
      if (!/captcha|verify you are a human/i.test(t)) return t;
    }
  } catch(_) {}

  if (!browser) {
    const exe = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: exe,
      args: ['--no-sandbox','--disable-dev-shm-usage','--single-process']
    });
  }
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' });
  await page.setViewport({ width:1366, height:900 });
  await page.setRequestInterception(true);
  page.on('request', req => ['image','media','font'].includes(req.resourceType()) ? req.abort() : req.continue());
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 });
  await page.waitForTimeout(800);
  const html = await page.content();
  await page.close();
  return html;
}

/* ===== Parsers ===== */
async function parseOlxList(){
  const items=[];
  for (let p=1;p<=PAGES;p++){
    const $ = load(await getHtmlSmart(withPage(OLX_SEARCH_URL,p)));
    $('div.css-1sw7q4x').each((_,el)=>{
      const a=$(el).find('a[href]').first(); const url=a.attr('href');
      const title=normSpaces($(el).find('h6').first().text()) || normSpaces($(el).find('h3').first().text());
      const priceText=normSpaces($(el).find('[data-testid="ad-price"]').first().text()) ||
                      normSpaces($(el).find('p.css-13afqrm').first().text()) ||
                      normSpaces($(el).find('p.css-1q7qk2x').first().text());
      const price=parsePriceToNumber(priceText); if(!url||!title||!price) return;
      const full=url.startsWith('http')?url:`https://www.olx.pl${url}`;
      const id=(full.split('/').filter(Boolean).pop()||full).replace(/[^0-9a-z\-]/gi,'');
      const year=extractYear(title); const {make,model}=splitMakeModel(title);
      items.push({ id, title, make, model, year, price, url: full });
    });
  }
  return items.filter(i=>i.price>=PRICE_MIN && i.price<=PRICE_MAX);
}
async function parseOtomotoList(){
  const items=[];
  for (let p=1;p<=PAGES;p++){
    const $ = load(await getHtmlSmart(withPage(OTOMOTO_SEARCH_URL,p)));
    $('article').each((_,el)=>{
      const a=$(el).find('a[href]').first(); let url=a.attr('href'); if(!url) return;
      if(!url.startsWith('http')) url=`https://www.otomoto.pl${url}`;
      const title=normSpaces($(el).find('h2').first().text()) || normSpaces($(el).find('a[data-testid="ad-title"]').first().text());
      const priceText=normSpaces($(el).find('[data-testid="ad-price"]').first().text()) || normSpaces($(el).find('.ooa-1bmnxg7').first().text());
      const price=parsePriceToNumber(priceText); if(!title||!price) return;
      const id=(url.split('/').filter(Boolean).pop()||url).replace(/[^0-9a-z\-]/gi,'');
      const year=extractYear(title); const {make,model}=splitMakeModel(title);
      items.push({ id, title, make, model, year, price, url });
    });
  }
  return items.filter(i=>i.price>=PRICE_MIN && i.price<=PRICE_MAX);
}

/* ===== Monitor ===== */
let timer=null;
let lastRunInfo={ ts:null, found:0, sent:0, notes:[] };

async function monitorOnce(){
  await initDb();
  const notes=[]; let found=0, sent=0;
  const sources=[ {name:'OLX', fn:parseOlxList}, {name:'OTOMOTO', fn:parseOtomotoList} ];
  for (const s of sources){
    try{
      const ads=await s.fn(); found+=ads.length;
      for (const ad of ads){
        const seen=await alreadySeen(s.name.toLowerCase(), ad.id);
        if (seen) continue;
        await markSeen(s.name.toLowerCase(), ad);
        const st=await updateStats(ad);
        let isHot=false;
        if (st.old_avg!==null && Number(st.old_avg)>0){
          if (Number(ad.price) <= Number(st.old_avg)*HOT_THRESHOLD) isHot=true;
        }
        let text=(isHot?'🔥 ГОРЯЧЕЕ ПРЕДЛОЖЕНИЕ!\n':'')+
          `${s.name}: ${ad.title}\nЦена: ${ad.price} PLN\nМарка: ${ad.make}\nМодель: ${ad.model}\nГод: ${ad.year||'—'}\n${ad.url}\n`;
        if (st.new_count){
          const avg=Number(st.old_avg ?? st.new_avg);
          if (avg && Number.isFinite(avg)){
            text+=`Средняя (${st.new_count}) для ${ad.make} ${ad.model} ${ad.year||''}: ${Math.round(avg)} PLN\n`;
            if (isHot) text+=`Порог: ${Math.round(HOT_THRESHOLD*100)}% от средней\n`;
          }
        }
        await notify(text); sent++;
      }
    }catch(e){ notes.push(`${s.name} parse error: ${e.message}`); console.error(`${s.name} error`, e); }
  }
  lastRunInfo={ ts:new Date().toISOString(), found, sent, notes };
  return lastRunInfo;
}
function startMonitor(mins=15){ if(timer) clearInterval(timer); timer=setInterval(monitorOnce, Math.max(1,mins)*60*1000); }
function stopMonitor(){ if(timer) clearInterval(timer); timer=null; }

/* ===== /top (средняя по окну из ads_seen) ===== */
async function queryTopDeals(N=10, days=TOP_DAYS_DEFAULT){
  await initDb();
  const sql=`
    WITH recent AS (
      SELECT site, ad_id, title, make, model, year, price::numeric AS price, url, seen_at
      FROM ads_seen
      WHERE seen_at >= NOW() - INTERVAL $1
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

/* ===== Routes / Webhook ===== */
app.get('/',(_req,res)=>res.send('lemexicars online 🚗'));
app.get('/health',(_req,res)=>res.json({ ok:true }));

app.get('/set-webhook', async (_req,res)=>{
  const url = `https://lemexicars.onrender.com/tg`;
  const j = await tg('setWebhook',{ url });
  res.json({ ok:true, result:j });
});

app.post('/tg', async (req,res)=>{
  try{
    const update=req.body;
    const msg=update.message || update.edited_message || update.channel_post;
    if(!msg) return res.json({ ok:true });

    const chatId=msg.chat?.id; const text=(msg.text||'').trim();
    if(!isAllowed(chatId)){
      await reply(chatId,'У вас нет прав');
      if (msg.chat?.type==='group' || msg.chat?.type==='supergroup'){
        await tg('leaveChat',{ chat_id:chatId }).catch(()=>{});
      }
      return res.json({ ok:true });
    }

    if(/^\/ping\b/i.test(text)){ await reply(chatId,'pong ✅'); return res.json({ ok:true }); }
    if(/^\/help\b/i.test(text)){
      await reply(chatId,[
        'Команды:',
        '/ping — проверить связь',
        '/watch [мин] — запустить мониторинг (по умолчанию 15)',
        '/stop — остановить мониторинг',
        '/status — статус и метрики',
        `/top [N] [days] — топ N скидок (≥${Math.round(HOT_DISCOUNT_MIN*100)}%) за days дней (по умолчанию N=10, days=${TOP_DAYS_DEFAULT})`
      ].join('\n')); return res.json({ ok:true });
    }
    if(/^\/watch\b/i.test(text)){
      const m=text.match(/\/watch\s+(\d+)/i); const every=m?Number(m[1]):15;
      await reply(chatId,`⏱ Запускаю мониторинг каждые ${every} мин. (страниц/источник: ${PAGES})\nФильтры: Wrocław+100km, ${PRICE_MIN}–${PRICE_MAX} PLN.`);
      startMonitor(every); monitorOnce().catch(e=>console.error('first run',e));
      return res.json({ ok:true });
    }
    if(/^\/stop\b/i.test(text)){ stopMonitor(); await reply(chatId,'⏹ Мониторинг остановлен.'); return res.json({ ok:true }); }
    if(/^\/status\b/i.test(text)){
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
      ].filter(Boolean).join('\n')); return res.json({ ok:true });
    }
    if(/^\/top\b/i.test(text)){
      await initDb();
      const m=text.match(/\/top(?:\s+(\d+))?(?:\s+(\d+))?/i);
      const N=m&&m[1]?Math.max(1,Math.min(30,Number(m[1]))):10;
      const days=m&&m[2]?Math.max(1,Math.min(90,Number(m[2]))):TOP_DAYS_DEFAULT;
      const rows=await queryTopDeals(N,days);
      if(!rows.length){ await reply(chatId,`За последние ${days} дн. выгодных предложений (скидка ≥ ${Math.round(HOT_DISCOUNT_MIN*100)}%) не найдено.`); return res.json({ ok:true }); }
      let out=`🔝 Топ-${rows.length} предложений за ${days} дн. (скидка ≥ ${Math.round(HOT_DISCOUNT_MIN*100)}%):\n`;
      rows.forEach((r,i)=>{
        const avg=Number(r.avg_price); const discPct=Math.round(Number(r.discount||0)*100);
        out+=`\n${i+1}) ${String(r.site).toUpperCase()}: ${r.title}\n`;
        out+=`Цена: ${Math.round(Number(r.price))} PLN • Средняя: ${Math.round(avg)} PLN • Скидка: -${discPct}%\n`;
        out+=`${r.url}\n`;
      });
      for (const c of chunkMessages(out)) await reply(chatId,c);
      return res.json({ ok:true });
    }

    return res.json({ ok:true });
  }catch(e){ console.error('Webhook error:', e); return res.json({ ok:true }); }
});

/* ===== Start ===== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('lemexicars up on', PORT));