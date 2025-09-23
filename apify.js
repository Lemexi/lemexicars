// apify.js — обёртка над ApifyClient для OLX
// v1.2

import { ApifyClient } from 'apify-client';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = process.env.APIFY_ACTOR_ID || 'ecomscrape~olx-product-search-scraper';

if (!APIFY_TOKEN) {
  console.error('APIFY_TOKEN not set!');
}

const client = new ApifyClient({ token: APIFY_TOKEN });

/* ─────────────────────── Helpers ─────────────────────── */
function normalizeResults(items = []) {
  return items.map(it => {
    return {
      ...it,
      url: it.url || it.link || it.detailUrl || '',
      title: it.title || it.name || '',
      price: it.price || it.priceText || '',
    };
  });
}

/* ─────────────────────── Основной ран ─────────────────────── */
/**
 * Запустить актор на набор ссылок (watch run).
 * Обычно раз в 15 минут: верх ленты для свежих объявлений.
 *
 * @param {string[]} urls — ссылки OLX
 * @param {number} maxItems — ограничение (обычно 20–40)
 * @returns {Promise<object[]>} — массив объявлений
 */
export async function runScrape(urls, maxItems = 40) {
  if (!urls?.length) return [];

  const input = {
    urls,
    max_items_per_url: maxItems,
    max_retries_per_url: 2,
    proxy: { useApifyProxy: false },
  };

  const run = await client.actor(ACTOR_ID).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return normalizeResults(items);
}

/* ─────────────────────── Точечный бренд-ран ─────────────────────── */
/**
 * Для конкретной марки/модели делаем доп. запрос для обновления рынка.
 *
 * @param {string[]} urls — ссылки OLX только под этот бренд
 * @param {number} maxItems — 30–50, чтобы собрать статистику
 * @returns {Promise<object[]>}
 */
export async function runBrandUpdate(urls, maxItems = 50) {
  if (!urls?.length) return [];

  const input = {
    urls,
    max_items_per_url: maxItems,
    max_retries_per_url: 2,
    proxy: { useApifyProxy: false },
  };

  const run = await client.actor(ACTOR_ID).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return normalizeResults(items);
}