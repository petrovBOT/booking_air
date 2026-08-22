const { chromium } = require('playwright');
const { SEARCH_URL, AD_DOMAINS, TASK_WAIT_MS, TARGET } = require('./config');
const { findOffers } = require('./matcher');

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

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

    const offers = [];
    const page = await context.newPage();

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
      const tasks = data.tasks && data.tasks.avia;
      if (!tasks) return;
      for (const tid in tasks) {
        const t = tasks[tid];
        if (t.status !== 'ok' || !t.result) continue;
        offers.push(...findOffers(t, TARGET));
      }
    });

    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(TASK_WAIT_MS);

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
