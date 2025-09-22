import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use(morgan('dev'));

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ==== helpers ====
async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
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
  return tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

// ==== routes ====
app.get('/health', (_req, res) => res.json({ ok: true }));

// удобный эндпоинт для установки вебхука
app.get('/set-webhook', async (req, res) => {
  const base = req.protocol + '://' + req.get('host');
  const url = `${base}/tg`;
  const j = await tg('setWebhook', { url });
  res.json({ ok: true, result: j });
});

// основной вебхук от Telegram
app.post('/tg', async (req, res) => {
  try {
    const update = req.body;
    const msg = update.message || update.edited_message || update.channel_post;
    if (!msg) return res.json({ ok: true });

    const chatId = msg.chat?.id;
    const text = (msg.text || '').trim();

    // доступ только для разрешённой группы
    if (!isAllowed(chatId)) {
      await reply(chatId, 'У вас нет прав');
      // если это чужая группа — тихо выходим
      if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') {
        await tg('leaveChat', { chat_id: chatId }).catch(()=>{});
      }
      return res.json({ ok: true });
    }

    // простые команды
    if (/^\/ping\b/i.test(text)) {
      await reply(chatId, 'pong ✅');
      return res.json({ ok: true });
    }

    if (/^\/help\b/i.test(text)) {
      await reply(chatId, 'Команды: /ping — проверить связь. (Скоро: /watch, /stop, /status)');
      return res.json({ ok: true });
    }

    // по умолчанию молчим, чтобы не спамить
    return res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.json({ ok: true });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('lemexicars up on', PORT));
