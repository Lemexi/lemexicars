// scraper.js — нормализация, группировка моделей, фильтры и форматирование
// v1.2

/* ───────────── Общие утилиты ───────────── */
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
    return url.origin + url.pathname; // без query для стабильного hash
  } catch {
    return (u || '').split('#')[0].split('?')[0];
  }
}

export function adHash(item) {
  const u = item.url || item.link || item.detailUrl || '';
  return normalizeUrl(u);
}

export function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ───────────── Данные объявления ───────────── */
export function getLocationText(it = {}) {
  const loc = it.location || it.city || it.region || it.area || {};
  if (typeof loc === 'string') return loc;
  const parts = [];
  if (loc.city) parts.push(loc.city);
  if (loc.region) parts.push(loc.region);
  if (loc.district) parts.push(loc.district);
  if (loc.name) parts.push(loc.name);
  return parts.filter(Boolean).join(', ');
}

export function extractPriceNumber(it = {}) {
  const raw = it.price || it.priceText || it.price_text || '';
  const m = String(raw).replace(/\s/g, '').match(/(\d[\d.,]*)/);
  if (!m) return null;
  return Number(m[1].replace(/\./g, '').replace(/,/g, '.'));
}

export function getPublishedAt(it = {}) {
  return (
    it.publishedAt || it.published_at ||
    it.createdAt || it.created_at ||
    it.date || it.time || it.postedAt || it.posted_at || null
  );
}

/* ───────────── Свежеcть ───────────── */
export function isFreshWithinDays(it, days = 7) {
  if (!days || days <= 0) return true; // без ограничения
  const iso = getPublishedAt(it);
  if (!iso) return false; // для watch лучше требовать явную дату
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs <= days * 24 * 3600 * 1000;
}

export function isFreshWithinMinutes(it, minutes = 15) {
  if (!minutes || minutes <= 0) return true;
  const iso = getPublishedAt(it);
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs <= minutes * 60 * 1000;
}

/**
 * Универсальный фильтр по свежести и цене.
 * freshDays: число дней или null/0 (без ограничения)
 * freshMinutes: число минут или null/0 (без ограничения)
 */
export function filterFreshAndPrice(items, { priceMin, priceMax, freshDays = null, freshMinutes = null }) {
  return (items || []).filter(it => {
    if (freshMinutes != null && freshMinutes > 0 && !isFreshWithinMinutes(it, freshMinutes)) return false;
    if (freshDays != null && freshDays > 0 && !isFreshWithinDays(it, freshDays)) return false;
    const p = extractPriceNumber(it);
    if (p == null) return false; // для нашей задачи без цены — бессмысленно
    if (priceMin != null && p < priceMin) return false;
    if (priceMax != null && p > priceMax) return false;
    return true;
  });
}

/* ───────────── Нормализация модели ───────────── */
const BRAND_ALIASES = {
  'vw': 'volkswagen',
  'merc': 'mercedes',
  'mercedes-benz': 'mercedes',
  'bмw': 'bmw', // опечатки/кириллица
};

const FUEL_WORDS = {
  diesel: ['diesel', 'dci', 'tdi', 'cdti', 'd', 'd-4d', 'hdi', 'multijet', 'dci'],
  petrol: ['benzyna', 'benzin', 'pb', 'lpg', 'mpi', 'fsi', 'tsi', 'tce', 'essence', 'gasoline'],
  hybrid: ['hybrid', 'hybryda', 'phev'],
  electric: ['ev', 'electric', 'elektryczny', 'elektryk', 'ze']
};

const YEAR_RX = /\b(19|20)\d{2}\b/;
const KM_RX = /\b(\d{1,3}(?:[ .]?\d{3})+|\d{4,6})\s*(?:km|tys\.?|tys|k)\b/i;

export function detectFuel(str = '') {
  const t = str.toLowerCase();
  const has = (arr) => arr.some(w => t.includes(w));
  if (has(FUEL_WORDS.electric)) return 'electric';
  if (has(FUEL_WORDS.hybrid))  return 'hybrid';
  if (has(FUEL_WORDS.diesel))  return 'diesel';
  if (has(FUEL_WORDS.petrol))  return 'petrol';
  return '';
}

export function extractYear(str = '') {
  const m = String(str).match(YEAR_RX);
  if (!m) return null;
  const y = Number(m[0]);
  if (y < 1980 || y > new Date().getFullYear() + 1) return null;
  return y;
}

export function extractMileageKm(str = '') {
  const m = String(str).replace(/\u00A0/g, ' ').match(KM_RX);
  if (!m) return null;
  const num = m[1].replace(/[ .]/g, '');
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  // если написано "150 tys" как 150000 => ловим тоже
  return n >= 1000 ? n : n * 1000;
}

export function yearBin(y) {
  if (!y) return '';
  // бины по 4–5 лет, чтобы не дробить слишком сильно
  if (y <= 2005) return '≤2005';
  if (y <= 2010) return '2006–2010';
  if (y <= 2015) return '2011–2015';
  if (y <= 2020) return '2016–2020';
  return '≥2021';
}

export function mileageBin(km) {
  if (!km) return '';
  if (km <= 80000) return '≤80k';
  if (km <= 150000) return '80–150k';
  if (km <= 220000) return '150–220k';
  if (km <= 300000) return '220–300k';
  return '≥300k';
}

function normalizeBrandModelTokens(title = '') {
  const t = title
    .toLowerCase()
    .replace(/[\/|_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let tokens = t.split(' ').filter(Boolean);

  // нормализуем бренд-алиасы
  if (tokens.length) {
    const b = tokens[0];
    tokens[0] = BRAND_ALIASES[b] || b;
  }

  return tokens;
}

export function modelFromTitle(title = '') {
  const tokens = normalizeBrandModelTokens(title);
  if (!tokens.length) return { brand: '', model: '' };

  const brand = tokens[0];
  // берём 1–2 токена модели (без мусорных «klima, super, kombi»)
  const skip = new Set(['klima','super','full','opc','line','kupie','sprzedam','bezwypadkowy','combo','idealny','nowy','lpg','diesel','benzyna','hybryda','elektryczny']);
  const modelTokens = [];
  for (let i = 1; i < tokens.length && modelTokens.length < 3; i++) {
    const tk = tokens[i];
    if (skip.has(tk)) continue;
    // игнорируем совсем короткие «x, -, /»
    if (tk.length === 1) continue;
    modelTokens.push(tk);
  }
  const model = modelTokens.join(' ').trim();
  return { brand, model };
}

/**
 * Ключ группы для рыночной цены.
 * Основан на brand+model (+fuel)+год_бин+пробег_бин.
 */
export function groupKeyFromItem(it = {}) {
  const title = it.title || it.name || '';
  const addl = [title, it.subtitle, it.description].filter(Boolean).join(' ');
  const { brand, model } = modelFromTitle(title);
  const fuel = detectFuel(addl || title);
  const y  = extractYear(addl || title);
  const km = extractMileageKm(addl || title);

  const keyParts = [
    brand,
    model,
    fuel || '',
    yearBin(y),
    mileageBin(km),
  ].filter(Boolean);

  const key = keyParts.join(' | ').trim();
  return { key, brand, model, fuel, year: y, km };
}

/* ───────────── Вывод карточки ───────────── */
export function fmtItem(it = {}, badge = '') {
  const title = it.title || it.name || 'Без названия';
  const price = it.price || it.priceText || '';
  const loc   = getLocationText(it);
  const url   = it.url || it.link || it.detailUrl || '';

  const head = badge ? `${badge}\n` : '';
  const line2 = [escapeHtml(price), escapeHtml(loc)].filter(Boolean).join(' • ');
  return `${head}<b>${escapeHtml(title)}</b>\n${line2}\n${url}`;
}