// top.js — поиск горячих предложений
import { extractPriceNumber, modelKeyFromTitle } from './scraper.js';

export function findHotDeals(items, {
  minGroupSize = 5,
  discount = 0.15, // 15%
  maxRefsPerGroup = 10
} = {}) {
  // 1) подготовим цены
  const withPrice = items.map(it => ({
    it,
    price: extractPriceNumber(it),
    key: modelKeyFromTitle(it.title || it.name || '')
  })).filter(x => x.price != null);

  // 2) сгруппируем
  const groups = new Map();
  for (const x of withPrice) {
    if (!groups.has(x.key)) groups.set(x.key, []);
    groups.get(x.key).push(x);
  }

  // 3) посчитаем средние и выберем дешёвые
  const hot = [];
  for (const [key, arr] of groups) {
    if (arr.length < minGroupSize) continue;
    const refs = arr.slice(0, maxRefsPerGroup);
    const avg = refs.reduce((s, x) => s + x.price, 0) / refs.length;
    const threshold = avg * (1 - discount);
    for (const x of arr) {
      if (x.price <= threshold) {
        hot.push({ item: x.it, price: x.price, key, avg, threshold });
      }
    }
  }
  return hot;
}
