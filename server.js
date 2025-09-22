// server.js — Telegram + SQLite + Apify + /scrape + /top
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';

import { runApify } from './apify.js';
import { hasSeen, markSeen } from './db.js';
import {
  parseStartUrls, adHash, filterFreshAndPrice,
  fmtItem, extractPriceNumber, getPublishedAt
} from './scraper.js';
import { findHotDeals } from './top.js';

/* ── ENV ─────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 8080;

// Telegram
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || 'olxhook';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Поиск
const START_URLS = parseStartUrls(process.env.START_URLS);
const PRICE_MIN = Number(process.env.PRICE_MIN || 1000);
const PRICE_MAX = Number(process.env.PRICE_MAX || 22000);
const ITEMS_LIMIT = Number(process.env.ITEMS_LIMIT || 100);
const FRESH_DAYS = Number(process.env.FRESH_DAYS || 7);

// Крон
const ENABLE_CRON = (process.env.ENABLE_CRON || 'true').toLowerCase() === 'true';
const CRON_EVERY_MIN = Number(process.env.CRON_EVERY_MIN || 15);

/* ── APP ─────────────────────────────────────────────────────── */
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

/* ── CORE: /scrape ───────────────────────────────────────────── */
async function runScrape(chatId) {
  await tgSend(chatId, `🔎 Запускаю скрапинг OLX…\nЛимит: ${ITEMS_LIMIT}, цена: ${PRICE_MIN}–${PRICE_MAX}, свежесть: ≤${FRESH_DAYS} дней`);
  const raw = await runApify(START_URLS, ITEMS_LIMIT);
  await tgSend(chatId, `ℹ️ Apify вернул: ${raw.length} элементов (до фильтров).`);

  const filtered = filterFreshAndPrice(raw, {
    priceMin: PRICE_MIN,
    priceMax: PRICE_MAX,
    freshDays: FRESH_DAYS
  });

  let sent = 0, skipped = 0;
  for (const it of filtered) {
    const hash = adHash(it);
    if (hasSeen(hash)) { skipped++; continue; }
    const price = extractPriceNumber(it);
    const pub = getPublishedAt(it);
    markSeen(hash, {
      url: it.url || it.link || it.detailUrl || '',
      title: it.title || it.name || '',
      price,
      publishedAt: pub,
      reason: 'scrape'
    });
    await tgSend(chatId, fmtItem(it));
    sent++;
  }
  await tgSend(chatId, `✅ Готово. Новых: ${sent}, пропущено (повторы/старая дата/цена): ${filtered.length - sent}.`);
}

/* ── CORE: /top ──────────────────────────────────────────────── */
const HOT_DISCOUNT = Number(process.env.HOT_DISCOUNT || 0.15); // 15%
const HOT_MIN_GROUP = Number(process.env.HOT_MIN_GROUP || 5);

async function runTop(chatId) {
  await tgSend(chatId, `🔥 Ищу топ-предложения…\nУсловие: цена ниже средней на ≥${Math.round(HOT_DISCOUNT*100)}%, группа ≥${HOT_MIN_GROUP}.`);
  const raw = await runApify(START_URLS, ITEMS_LIMIT);
  await tgSend(chatId, `ℹ️ Apify вернул: ${raw.length} элементов (до фильтров).`);

  const filtered = filterFreshAndPrice(raw, {
    priceMin: PRICE_MIN,
    priceMax: PRICE_MAX,
    freshDays: FRESH_DAYS
  });

  const hot = findHotDeals(filtered, {
    minGroupSize: HOT_MIN_GROUP,
    discount: HOT_DISCOUNT,
    maxRefsPerGroup: 10
  });

  let sent = 0, skipped = 0;
  for (const h of hot) {
    const it = h.item;
    const hash = adHash(it);
    if (hasSeen(hash)) { skipped++; continue; }

    const price = extractPriceNumber(it);
    const pub = getPublishedAt(it);

    markSeen(hash, {
      url: it.url || it.link || it.detailUrl || '',
      title: it.title || it.name || '',
      price,
      publishedAt: pub,
      reason: 'top'
    });

    const badge = `🔥 <b>ТОП:</b> цена ≤ ${h.threshold.toFixed(0)} (ср. ${h.avg.toFixed(0)})`;
    await tgSend(chatId, fmtItem(it, badge));
    sent++;
  }

  await tgSend(chatId, `🏁 Топ-скан завершён. Новых ТОПов: ${sent}, пропущено (повторы): ${skipped}.`);
}

/* ── TELEGRAM WEBHOOK ───────────────────────────────────────── */
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
        `Привет! Я слежу за OLX.\n` +
        `Команды:\n` +
        `/scrape — свежие объявления (без повторов)\n` +
        `/top — лучшие предложения (ниже средней на ≥${Math.round(HOT_DISCOUNT*100)}%)\n` +
        `/help — помощь`
      );
    } else if (/^\/help\b/i.test(text)) {
      await tgSend(chatId,
        `Настройки:\n` +
        `• Ссылки: ${START_URLS.length}\n` +
        `• Цена: ${PRICE_MIN}–${PRICE_MAX}\n` +
        `• Свежесть: ≤${FRESH_DAYS} дней\n` +
        `• Крон: каждые ${CRON_EVERY_MIN} мин (${ENABLE_CRON ? 'вкл' : 'выкл'})`
      );
    } else if (/^\/top\b/i.test(text)) {
      await runTop(chatId);
    } else if (/^\/scrape\b/i.test(text)) {
      await runScrape(chatId);
    } else {
      await tgSend(chatId, 'Не понял. Используй /scrape, /top или /help.');
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ── UTILS/ROUTES ───────────────────────────────────────────── */
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

/* ── CRON ───────────────────────────────────────────────────── */
function startCron() {
  if (!ENABLE_CRON) return;
  if (!TELEGRAM_CHAT_ID) {
    console.warn('CRON disabled: TELEGRAM_CHAT_ID not set');
    return;
  }
  const ms = CRON_EVERY_MIN * 60 * 1000;
  setInterval(() => runScrape(TELEGRAM_CHAT_ID), ms);
  console.log(`CRON started: every ${CRON_EVERY_MIN} min`);
}

/* ── START ──────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('Listening on', PORT);
  startCron();
});
