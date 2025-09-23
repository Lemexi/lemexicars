// server.js — Telegram + SQLite + Apify + /scrape + /top + /stop
// v1.3

import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';

import { runScrape as apifyRunWatch, runBrandUpdate } from './apify.js';
import { hasSeen, markSeen } from './db.js';
import {
  parseStartUrls, adHash, filterFreshAndPrice, fmtItem,
  extractPriceNumber, getPublishedAt, groupKeyFromItem
} from './scraper.js';
import {
  checkBelowMarket, fmtBelowMarketInfo, updateMarket
} from './top.js';

/* ───────────── ENV ───────────── */
const PORT = process.env.PORT || 8080;

// Telegram
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || 'olxhook';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Поиск/радиус
const START_URLS = parseStartUrls(process.env.START_URLS);

// Базовые фильтры
const PRICE_MIN = Number(process.env.PRICE_MIN || 1000);
const PRICE_MAX = Number(process.env.PRICE_MAX || 22000);

// Свежесть
const FRESH_DAYS_DEFAULT = Number(process.env.FRESH_DAYS || 7);
const NEW_MAX_AGE_MIN = Number(process.env.NEW_MAX_AGE_MIN || 15);
const TOP_MAX_AGE_HOURS = Number(process.env.TOP_MAX_AGE_HOURS || 48);

// Объёмы выборок
const WATCH_MAX_ITEMS = Number(process.env.WATCH_MAX_ITEMS || 40);
const MARKET_MAX_ITEMS = Number(process.env.MARKET_MAX_ITEMS || 150);

// Кэш рынка и автопоиск
const MARKET_REFRESH_MIN = Number(process.env.MARKET_REFRESH_MIN || 120);
let cronTimer = null;
let cronEnabled = (process.env.ENABLE_CRON || 'true').toLowerCase() === 'true';
const CRON_EVERY_MIN = Number(process.env.CRON_EVERY_MIN || 15);

/* ───────────── App ───────────── */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

function allowChat(chatId) {
  if (!ALLOWED_CHAT_IDS.length) return true;
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

async function tgSend(chatId, text, opts = {}) {
  if (!BOT_TOKEN) {
    console.error('tgSend: BOT_TOKEN not set');
    return { ok: false, error: 'BOT_TOKEN not set' };
  }
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

/* ───────────── Helpers ───────────── */
function ageHours(it) {
  const iso = getPublishedAt(it);
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 3_600_000;
}

function splitNewAndEligible(items) {
  // Возвращает:
  //  - newOnes: новые по минутам
  //  - eligible: подходящие по базовым фильтрам (дальше проверяем "ниже рынка")
  const base = filterFreshAndPrice(items, {
    priceMin: PRICE_MIN,
    priceMax: PRICE_MAX,
    freshDays: FRESH_DAYS_DEFAULT,     // защитный максимум по возрасту
    freshMinutes: null
  });
  const newOnes = base.filter(it => ageHours(it) * 60 <= NEW_MAX_AGE_MIN);
  return { newOnes, eligible: base };
}

function uniqueNotSeen(items) {
  const fresh = [];
  for (const it of items) {
    const h = adHash(it);
    if (!hasSeen(h)) fresh.push(it);
  }
  return fresh;
}

function groupPricesFrom(items, groupKey) {
  // Собираем цены только у объявлений нужной группы
  const arr = [];
  for (const it of items) {
    const g = groupKeyFromItem(it).key;
    if (g !== groupKey) continue;
    const p = extractPriceNumber(it);
    if (Number.isFinite(p)) arr.push(p);
  }
  return arr;
}

/* ───────────── CORE: /scrape ───────────── */
async function runScrape(chatId) {
  if (!START_URLS.length) {
    await tgSend(chatId, '❌ START_URLS пуст. Добавь ссылку Wrocław +100 км.');
    return;
  }

  await tgSend(chatId,
    `🔎 Проверяю свежие объявления…\n` +
    `Верх ленты: ~${WATCH_MAX_ITEMS} позиций/URL, новые: ≤${NEW_MAX_AGE_MIN} мин.\n` +
    `Диапазон: ${PRICE_MIN}–${PRICE_MAX} zł.`
  );

  const raw = await apifyRunWatch(START_URLS, WATCH_MAX_ITEMS);
  const { newOnes, eligible } = splitNewAndEligible(raw);

  // Блок 1: 🆕 Новые (только не виденные)
  const newFresh = uniqueNotSeen(newOnes);
  if (newFresh.length) {
    await tgSend(chatId, `🆕 Новые (≤${NEW_MAX_AGE_MIN} мин): ${newFresh.length} шт.`);
    for (const it of newFresh) {
      const url = it.url || it.link || it.detailUrl || '';
      const price = extractPriceNumber(it);
      markSeen(adHash(it), {
        url,
        title: it.title || it.name || '',
        price,
        publishedAt: getPublishedAt(it),
        reason: 'scrape'
      });
      await tgSend(chatId, fmtItem(it));
    }
  } else {
    await tgSend(chatId, `🆕 Новых нет.`);
  }

  // Блок 2: 🔥 Выгодные (ниже рынка + ниже hard_cap)
  const stillUnseen = uniqueNotSeen(eligible); // проверяем только то, чего ещё не слали
  const hotOut = [];
  for (const it of stillUnseen) {
    // 1) пробуем по кэшу
    let verdict = checkBelowMarket(it);

    // 2) если нет рынка — делаем точечный добор (разово)
    if (!verdict) {
      const { key, brand, model, fuel, year, km } = groupKeyFromItem(it);
      if (key) {
        const extra = await runBrandUpdate(START_URLS, MARKET_MAX_ITEMS);
        const numbers = groupPricesFrom(extra, key);
        if (numbers.length >= 5) {
          updateMarket(key, {
            brand, model, fuel,
            year_bin: '', km_bin: ''
          }, numbers);
          verdict = checkBelowMarket(it); // пробуем снова
        }
      }
    }

    if (verdict) {
      hotOut.push({ it, verdict });
    }
  }

  if (hotOut.length) {
    await tgSend(chatId, `🔥 Выгодные сейчас: ${hotOut.length} шт.`);
    for (const { it, verdict } of hotOut) {
      const url = it.url || it.link || it.detailUrl || '';
      const price = extractPriceNumber(it);
      markSeen(adHash(it), {
        url,
        title: it.title || it.name || '',
        price,
        publishedAt: getPublishedAt(it),
        reason: 'top'
      });
      const badge = fmtBelowMarketInfo(it, verdict);
      await tgSend(chatId, fmtItem(it, `🔥 <b>ТОП</b>\n${badge}`));
    }
  } else {
    await tgSend(chatId, '🔥 Выгодных не нашёл на этот раз.');
  }
}

/* ───────────── CORE: /top ───────────── */
async function runTop(chatId) {
  if (!START_URLS.length) {
    await tgSend(chatId, '❌ START_URLS пуст. Добавь ссылку Wrocław +100 км.');
    return;
  }

  await tgSend(chatId, `🔥 Ищу ТОП за последние ${TOP_MAX_AGE_HOURS} часов…`);

  // Берём побольше, чтобы охватить 48 часов
  const raw = await runBrandUpdate(START_URLS, MARKET_MAX_ITEMS);
  // Базовые фильтры + строго возраст ≤ 48ч
  const eligible = filterFreshAndPrice(raw, {
    priceMin: PRICE_MIN,
    priceMax: PRICE_MAX,
    freshDays: null, // возраст контролируем в часа́х
    freshMinutes: null
  }).filter(it => ageHours(it) <= TOP_MAX_AGE_HOURS);

  const hot = [];
  for (const it of eligible) {
    let verdict = checkBelowMarket(it);
    if (!verdict) {
      // если нет рынка — добираем прямо сейчас (но тут extra уже = raw; можно реюз)
      const { key, brand, model, fuel, year, km } = groupKeyFromItem(it);
      if (key) {
        const numbers = groupPricesFrom(raw, key);
        if (numbers.length >= 5) {
          updateMarket(key, {
            brand, model, fuel,
            year_bin: '', km_bin: ''
          }, numbers);
          verdict = checkBelowMarket(it);
        }
      }
    }
    if (verdict) hot.push({ it, verdict });
  }

  if (!hot.length) {
    await tgSend(chatId, 'За 48 часов выгодных (ниже рынка) не нашлось.');
    return;
  }

  // сортируем по величине скидки
  hot.sort((a, b) => {
    const pa = extractPriceNumber(a.it), pb = extractPriceNumber(b.it);
    const da = pa / a.verdict.market_price;
    const db = pb / b.verdict.market_price;
    return da - db;
  });

  await tgSend(chatId, `🔥 ТОП за ${TOP_MAX_AGE_HOURS}ч: ${hot.length} шт.`);
  for (const { it, verdict } of hot) {
    // не шлём повторы
    if (hasSeen(adHash(it))) continue;
    const url = it.url || it.link || it.detailUrl || '';
    const price = extractPriceNumber(it);
    markSeen(adHash(it), {
      url,
      title: it.title || it.name || '',
      price,
      publishedAt: getPublishedAt(it),
      reason: 'top'
    });
    const badge = fmtBelowMarketInfo(it, verdict);
    await tgSend(chatId, fmtItem(it, `🔥 <b>ТОП</b>\n${badge}`));
  }
}

/* ───────────── CRON control ───────────── */
function startCron(chatIdForLog = TELEGRAM_CHAT_ID) {
  stopCron();
  const ms = CRON_EVERY_MIN * 60 * 1000;
  cronTimer = setInterval(() => runScrape(TELEGRAM_CHAT_ID), ms);
  cronEnabled = true;
  console.log(`CRON started: every ${CRON_EVERY_MIN} min`);
  if (chatIdForLog) tgSend(chatIdForLog, `⏱ Автопоиск включён: каждые ${CRON_EVERY_MIN} мин.`);
}
function stopCron(chatIdForLog) {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = null;
  if (cronEnabled) {
    cronEnabled = false;
    console.log('CRON stopped');
    if (chatIdForLog) tgSend(chatIdForLog, '⏹ Автопоиск остановлен.');
  }
}

/* ───────────── Telegram webhook ───────────── */
app.post('/tg/webhook', async (req, res) => {
  const { secret } = req.query;
  if (secret !== TG_WEBHOOK_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });

  try {
    const update = req.body;
    if (!update?.message) return res.json({ ok: true });

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (!allowChat(chatId)) {
      await tgSend(chatId, '⛔️ Доступ ограничен.');
      return res.json({ ok: true });
    }

    if (/^\/start\b/i.test(text)) {
      await tgSend(chatId,
        `Привет! Я ловлю свежие и выгодные авто по радиусу Wrocław +100км.\n` +
        `Команды:\n` +
        `• /scrape — разовый поиск и включение автопоиска (каждые ${CRON_EVERY_MIN} мин)\n` +
        `• /top — ТОП за последние ${TOP_MAX_AGE_HOURS} часов\n` +
        `• /stop — остановить автопоиск\n` +
        `• /help — помощь`
      );
    } else if (/^\/help\b/i.test(text)) {
      await tgSend(chatId,
        `Настройки:\n` +
        `• Ссылок: ${START_URLS.length}\n` +
        `• Диапазон: ${PRICE_MIN}–${PRICE_MAX} zł\n` +
        `• Новые: ≤ ${NEW_MAX_AGE_MIN} мин\n` +
        `• ТОП возраст: ≤ ${TOP_MAX_AGE_HOURS} ч\n` +
        `• Автопоиск: каждые ${CRON_EVERY_MIN} мин (${cronEnabled ? 'включен' : 'выключен'})`
      );
    } else if (/^\/stop\b/i.test(text)) {
      stopCron(chatId);
    } else if (/^\/top\b/i.test(text)) {
      await runTop(chatId);
    } else if (/^\/scrape\b/i.test(text)) {
      await runScrape(chatId);
      if (!cronEnabled) startCron(chatId);
    } else {
      await tgSend(chatId, 'Не понял. Используй /scrape, /top, /stop или /help.');
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ───────────── Utils routes ───────────── */
app.get('/', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/tg/test', async (req, res) => {
  const { secret, text, chatId } = req.query;
  if (secret !== TG_WEBHOOK_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
  const id = chatId || TELEGRAM_CHAT_ID;
  if (!id) return res.status(400).json({ ok: false, error: 'no chatId' });
  const r = await tgSend(id, text || 'pong');
  res.json(r);
});

/* ───────────── Start ───────────── */
app.listen(PORT, () => {
  console.log('Listening on', PORT);
  if (cronEnabled) startCron();
});