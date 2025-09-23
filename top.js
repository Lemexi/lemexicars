// top.js — проверка "ниже рынка" и hard_cap по моделям
// v1.2

import { getMarket, buildMarketRow, upsertMarket, isMarketFresh } from './db.js';
import { groupKeyFromItem, extractPriceNumber } from './scraper.js';

/* ───────────── Конфиг из ENV ───────────── */
let PRICE_RULES = {};
try {
  if (process.env.PRICE_RULES_JSON) {
    PRICE_RULES = JSON.parse(process.env.PRICE_RULES_JSON);
  }
} catch (e) {
  console.error('PRICE_RULES_JSON parse error:', e);
}

const DISCOUNT_DEFAULT = Number(process.env.MARKET_DISCOUNT_STRONG || 0.15);
const DISCOUNT_WHEN_LOW = Number(process.env.MARKET_DISCOUNT_WEAK || 0.22);
const MIN_SAMPLES = Number(process.env.MARKET_MIN_SAMPLES || 10);
const MARKET_MAX_AGE_MIN = Number(process.env.MARKET_REFRESH_MIN || 120);

/* ───────────── Helpers ───────────── */
function hardCapForGroup(key, brand, model) {
  const k1 = `${brand} ${model}`.toLowerCase();
  const k2 = brand.toLowerCase();
  if (PRICE_RULES[k1]?.hard_cap) return PRICE_RULES[k1].hard_cap;
  if (PRICE_RULES[k2]?.hard_cap) return PRICE_RULES[k2].hard_cap;
  if (PRICE_RULES['default']?.hard_cap) return PRICE_RULES['default'].hard_cap;
  return null;
}

function discountForGroup(sampleCount) {
  if (!sampleCount || sampleCount < MIN_SAMPLES) return DISCOUNT_WHEN_LOW;
  return DISCOUNT_DEFAULT;
}

/* ───────────── Основная логика ───────────── */
/**
 * Проверка: является ли объявление "ниже рынка"
 * @param {object} item — объект объявления
 * @returns {null|{reason,market_price,threshold,hard_cap,discount}}
 */
export function checkBelowMarket(item) {
  const price = extractPriceNumber(item);
  if (!price) return null;

  const { key, brand, model, fuel, year, km } = groupKeyFromItem(item);
  if (!key) return null;

  const { fresh, row } = isMarketFresh(key, MARKET_MAX_AGE_MIN);
  if (!row) {
    // рынка нет — решение принять нельзя
    return null;
  }

  const disc = discountForGroup(row.sample_count);
  const threshold = row.price_median * (1 - disc);
  const hardCap = hardCapForGroup(key, brand, model);

  if (hardCap && price > hardCap) return null;
  if (price <= threshold) {
    return {
      reason: 'below_market',
      market_price: row.price_median,
      threshold,
      hard_cap: hardCap,
      discount: disc,
    };
  }
  return null;
}

/**
 * Обновить рынок для группы из новых цен
 * @param {string} key
 * @param {object} meta { brand, model, fuel, year_bin, km_bin }
 * @param {number[]} numbers
 */
export function updateMarket(key, meta, numbers) {
  const row = buildMarketRow(numbers, { group_key: key, ...meta });
  if (!row) return null;
  upsertMarket(row);
  return row;
}

/**
 * Текстовое пояснение для телеграма
 */
export function fmtBelowMarketInfo(item, check) {
  if (!check) return '';
  const price = extractPriceNumber(item);
  const discPct = Math.round((1 - price / check.market_price) * 100);
  const hard = check.hard_cap ? `, cap ≤ ${check.hard_cap}` : '';
  return `💰 Рынок ≈ ${Math.round(check.market_price)} zł, порог (−${Math.round(check.discount*100)}%) = ${Math.round(check.threshold)} zł${hard}; факт ${price} zł (−${discPct}%)`;
}