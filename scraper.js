// scraper.js — утилиты фильтрации, форматирования и хеширования

export function parseStartUrls(envStr) {
  return (envStr || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

export function normalizeUrl(u = '') {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.origin + url.pathname; // без query
  } catch {
    return (u || '').split('#')[0].split('?')[0];
  }
}

export function adHash(item) {
  const u = item.url || item.link || item.detailUrl || '';
  return normalizeUrl(u);
}

export function extractPriceNumber(it) {
  const raw = it.price || it.priceText || '';
  const m = String(raw).replace(/\s/g, '').match(/(\d[\d.,]*)/);
  if (!m) return null;
  return Number(m[1].replace(/\./g, '').replace(/,/g, '.'));
}

export function getPublishedAt(it) {
  return (
    it.publishedAt || it.published_at || it.createdAt || it.created_at ||
    it.date || it.time || it.postedAt || it.posted_at || null
  );
}

export function isFreshWithinDays(it, days = 7) {
  if (!days || days <= 0) return true; // без ограничения по свежести
  const iso = getPublishedAt(it);
  if (!iso) return true;
  const t = Date.parse(iso);
  if (isNaN(t)) return true;
  const ageMs = Date.now() - t;
  const limitMs = days * 24 * 3600 * 1000;
  return ageMs <= limitMs;
}

export function filterFreshAndPrice(items, { priceMin, priceMax, freshDays }) {
  return items.filter(it => {
    if (!isFreshWithinDays(it, freshDays)) return false;
    const p = extractPriceNumber(it);
    if (p == null) return true; // без цены — пропускаем, чтобы не потерять потенциальные TOP
    return p >= priceMin && p <= priceMax;
  });
}

export function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtItem(it, badge = '') {
  const title = it.title || it.name || 'Без названия';
  const price = it.price || it.priceText || '';
  const loc = it.location || it.city || '';
  const url = it.url || it.link || it.detailUrl || '';
  const b = badge ? `${badge}\n` : '';
  return `${b}<b>${escapeHtml(title)}</b>\n${escapeHtml(price)} • ${escapeHtml(loc)}\n${url}`;
}

// Группировка для TOP: бренд + 1–2 слова модели
export function modelKeyFromTitle(title = '') {
  const t = title.toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = t.split(' ');
  if (parts.length === 0) return t;
  const brand = parts[0];
  const model = (parts[1] || '') + ' ' + (parts[2] || '');
  return (brand + ' ' + model).trim();
}
