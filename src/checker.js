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
  console.log(`[checker] прокси: ${PROXY ? PROXY.server : 'нет, соединение напрямую'}`);

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
        // Явный код ошибки — иначе Playwright/Chromium помечает abort() как
        // net::ERR_FAILED, неотличимый в логах requestfailed от настоящего
        // сетевого сбоя через прокси.
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });

    let offers = [];
    let lastResponseAt = Date.now();
    // Диагностика: сколько всего ответов /next/api/task пришло за попытку и
    // сколько из них были status:"ok" — чтобы в логах Render было видно, где
    // именно затык (прокси вообще не пускает трафик / пускает, но поставщики
    // не успевают / успевают, но нужного маршрута нет).
    let taskResponsesSeen = 0;
    let taskResponsesOk = 0;
    let requestFailures = 0;

    function attachListener(page) {
      page.on('response', async resp => {
        const url = resp.url();
        if (!url.includes('/next/api/task')) return;
        taskResponsesSeen++;
        let data;
        try {
          const buf = await resp.body();
          data = JSON.parse(buf.toString('utf8'));
        } catch (e) {
          console.log(`[checker] не удалось разобрать ответ /next/api/task: ${e.message}`);
          return;
        }
        lastResponseAt = Date.now();
        const tasks = data.tasks && data.tasks.avia;
        if (!tasks) return;
        for (const tid in tasks) {
          const t = tasks[tid];
          if (t.status !== 'ok' || !t.result) continue;
          taskResponsesOk++;
          offers.push(...findOffers(t, TARGET));
        }
      });

      // requestfailed срабатывает и на наши же намеренные route.abort() (рекламные
      // домены/картинки-стили) — их отсекаем по errorText, чтобы не шуметь в логах
      // тем, что мы сами заблокировали, а не тем, что реально не доехало через прокси.
      page.on('requestfailed', req => {
        const failure = req.failure();
        const errorText = failure ? failure.errorText : 'unknown';
        // Наши собственные route.abort('blockedbyclient') из context.route() —
        // не диагностический сигнал, отсекаем по префиксу (реальный текст —
        // "net::ERR_BLOCKED_BY_CLIENT.Inspector", не точное совпадение).
        if (errorText.startsWith('net::ERR_BLOCKED_BY_CLIENT') || errorText === 'NS_ERROR_ABORT' || errorText === 'net::ERR_ABORTED') return;
        requestFailures++;
        console.log(`[checker] сетевой запрос не удался: ${errorText} — ${req.url().slice(0, 150)}`);
      });

      page.on('pageerror', err => console.log(`[checker] JS-ошибка на странице: ${err.message}`));
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      offers = [];
      lastError = null;
      taskResponsesSeen = 0;
      taskResponsesOk = 0;
      requestFailures = 0;
      const attemptStartedAt = Date.now();
      console.log(`[checker] попытка ${attempt}/${MAX_ATTEMPTS}: открываю страницу поиска...`);
      // Новая страница на каждую попытку, а не повторный goto на старой —
      // Chromium не всегда отдаёт память рендерера обратно после навигации
      // в рамках той же страницы, а тут попытки суммарно могут висеть минутами.
      const page = await context.newPage();
      attachListener(page);
      try {
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`[checker] попытка ${attempt}: страница открылась за ${Date.now() - attemptStartedAt}мс, жду данные...`);
        lastResponseAt = Date.now();

        const deadline = Date.now() + MAX_WAIT_MS;
        let lastHeartbeatAt = Date.now();
        while (Date.now() < deadline && Date.now() - lastResponseAt < IDLE_MS) {
          await page.waitForTimeout(POLL_INTERVAL_MS);
          if (Date.now() - lastHeartbeatAt >= 10000) {
            lastHeartbeatAt = Date.now();
            console.log(
              `[checker] попытка ${attempt}: ещё жду (${Math.round((Date.now() - attemptStartedAt) / 1000)}с) — ответов: ${taskResponsesSeen} (ok: ${taskResponsesOk}), совпадений: ${offers.length}, сбоев запросов: ${requestFailures}`
            );
          }
        }
        const exitReason = Date.now() >= deadline ? 'исчерпан потолок ожидания' : 'поток ответов затих';
        console.log(
          `[checker] попытка ${attempt}: закончил ждать (${exitReason}) — ответов /next/api/task: ${taskResponsesSeen} (ok: ${taskResponsesOk}), совпадений с целевым маршрутом: ${offers.length}, сбоев запросов: ${requestFailures}, всего ${Date.now() - attemptStartedAt}мс`
        );
      } catch (e) {
        // Сайт иногда просто не открывается за 30с (сетевой сбой/подвисание) —
        // это тоже неудачная попытка, а не повод сразу сдаваться.
        lastError = e;
        console.log(`[checker] попытка ${attempt}: упала за ${Date.now() - attemptStartedAt}мс с ошибкой: ${e.message} (сбоев запросов до этого: ${requestFailures})`);
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
