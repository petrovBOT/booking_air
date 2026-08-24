const { chromium } = require('playwright');
const { SEARCH_URL, AD_DOMAINS, TARGET, PROXY } = require('./config');
const { findOffers } = require('./matcher');

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

// Поставщики отвечают асинхронно и не одновременно: дешёвые (напр. myagent)
// обычно готовы позже дорогих (travelport и т.п.). Раньше ждали фиксированные
// 25с и брали минимум из того, что успело прийти — если дешёвый поставщик
// не укладывался, бот репортил цену вдвое-втрое выше реальной. Теперь ждём,
// пока поток ответов /next/api/task не затихнет (сайт сам перестаёт поллить
// задачи, включая зависшие), с потолком на случай, если затишья не наступит.
const IDLE_MS = 10000;
const MAX_WAIT_MS = 120000;
const POLL_INTERVAL_MS = 500;

// Даже когда все поставщики честно ответили, конкретно нужная пара
// туда+обратно у них иногда не складывается в единый тариф — при повторном
// поиске секунды спустя та же связка нередко находится. Поэтому при пустом
// результате повторяем поиск ещё несколько раз, прежде чем сдаться.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 15000;

// Render free — 512MB на весь процесс, headless Chromium сам по себе прожорливый.
// Эти флаги гасят фоновые таймеры/синк/расширения, которые Chromium иначе
// держит активными даже в headless — без них память на длинных проверках
// (потолок ожидания в несколько минут) быстрее упирается в лимит.
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
  '--safebrowsing-disable-auto-update',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

async function checkPrice() {
  const browser = await chromium.launch({
    headless: true,
    args: CHROMIUM_ARGS,
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      ...(PROXY ? { proxy: PROXY } : {}),
    });

    await context.route('**/*', (route, req) => {
      if (AD_DOMAINS.test(req.url()) || BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
        return route.abort();
      }
      return route.continue();
    });

    let offers = [];
    let lastResponseAt = Date.now();

    function attachListener(page) {
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
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      offers = [];
      lastError = null;
      // Новая страница на каждую попытку, а не повторный goto на старой —
      // Chromium не всегда отдаёт память рендерера обратно после навигации
      // в рамках той же страницы, а тут попытки суммарно могут висеть минутами.
      const page = await context.newPage();
      attachListener(page);
      try {
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        lastResponseAt = Date.now();

        const deadline = Date.now() + MAX_WAIT_MS;
        while (Date.now() < deadline && Date.now() - lastResponseAt < IDLE_MS) {
          await page.waitForTimeout(POLL_INTERVAL_MS);
        }
      } catch (e) {
        // Сайт иногда просто не открывается за 30с (сетевой сбой/подвисание) —
        // это тоже неудачная попытка, а не повод сразу сдаваться.
        lastError = e;
      } finally {
        await page.close().catch(() => {});
      }

      if (offers.length > 0) break;
      if (attempt < MAX_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    if (offers.length === 0) {
      if (lastError) throw lastError;
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
