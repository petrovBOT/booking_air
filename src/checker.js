const { chromium } = require('playwright');
const { SEARCH_URL, AD_DOMAINS, TARGET } = require('./config');
const { findOffers } = require('./matcher');

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

// Поставщики отвечают асинхронно и не одновременно: дешёвые (напр. myagent)
// обычно готовы позже дорогих (travelport и т.п.). Раньше ждали фиксированные
// 25с и брали минимум из того, что успело прийти — если дешёвый поставщик
// не укладывался, бот репортил цену вдвое-втрое выше реальной. Теперь ждём,
// пока поток ответов /next/api/task не затихнет (сайт сам перестаёт поллить
// задачи, включая зависшие), с потолком на случай, если затишья не наступит.
const IDLE_MS = 10000;
const MAX_WAIT_MS = 90000;
const POLL_INTERVAL_MS = 500;

// Даже когда все поставщики честно ответили, конкретно нужная пара
// туда+обратно у них иногда не складывается в единый тариф — при повторном
// поиске секунды спустя та же связка нередко находится. Поэтому при пустом
// результате повторяем поиск ещё несколько раз, прежде чем сдаться.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

async function checkPrice() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });

    await context.route('**/*', (route, req) => {
      if (AD_DOMAINS.test(req.url()) || BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
        return route.abort();
      }
      return route.continue();
    });

    let offers = [];
    const page = await context.newPage();
    let lastResponseAt = Date.now();

    page.on('response', async resp => {
      const url = resp.url();
      if (!url.includes('/next/api/task')) return;
      let data;
      try {
        const buf = await resp.body();
        data = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      lastResponseAt = Date.now();
      const tasks = data.tasks && data.tasks.avia;
      if (!tasks) return;
      for (const tid in tasks) {
        const t = tasks[tid];
        if (t.status !== 'ok' || !t.result) continue;
        offers.push(...findOffers(t, TARGET));
      }
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      offers = [];
      await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      lastResponseAt = Date.now();

      const deadline = Date.now() + MAX_WAIT_MS;
      while (Date.now() < deadline && Date.now() - lastResponseAt < IDLE_MS) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
      }

      if (offers.length > 0) break;
      if (attempt < MAX_ATTEMPTS) await page.waitForTimeout(RETRY_DELAY_MS);
    }

    if (offers.length === 0) {
      return { found: false };
    }

    offers.sort((a, b) => a.total - b.total);
    return {
      found: true,
      price: offers[0].total,
      currency: offers[0].currency,
      offersCount: offers.length,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { checkPrice };
