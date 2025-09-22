// apify.js — запуск актора Apify (urls + max_items_per_url)
import { ApifyClient } from 'apify-client';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR = process.env.APIFY_ACTOR || 'ecomscrape/olx-product-search-scraper';
const APIFY_USE_PROXY = (process.env.APIFY_USE_PROXY || 'false').toLowerCase() === 'true';

if (!APIFY_TOKEN) {
  console.error('[apify] APIFY_TOKEN not set');
}

const client = new ApifyClient({ token: APIFY_TOKEN });

export async function runApify(urls, maxItems = 100) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');
  if (!urls?.length) throw new Error('No URLs provided to Apify');

  const input = {
    urls,
    max_items_per_url: maxItems,
    max_retries_per_url: 2,
    proxy: { useApifyProxy: APIFY_USE_PROXY }
  };

  console.log('[apify] INPUT:', JSON.stringify(input));
  const run = await client.actor(APIFY_ACTOR).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 2000 });

  const count = Array.isArray(items) ? items.length : 0;
  console.log('[apify] items:', count);
  return Array.isArray(items) ? items : [];
}
