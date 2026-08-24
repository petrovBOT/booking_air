const { chromium } = require('playwright');
const { SEARCH_URL, AD_DOMAINS, TARGET, PROXY } = require('./config');
const { findOffers } = require('./matcher');

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

// Чистая телеметрия сайта (debug-log шлётся десятками в секунду, heartbeat и
// client-reach — просто пинги) — для самой цены не нужны, а на медленном
// прокси-соединении на Render каждый лишний запрос — это лишнее время и
// память. Проверено локально: с блокировкой поиск так же находит рейсы.
const BLOCKED_API_PATTERNS = [/\/next\/api\/debug-log/, /\/next\/api\/heartbeat/, /\/next\/api\/client-reach/];

// Поставщики отвечают асинхронно и не одновременно: дешёвые (напр. myagent)
// обычно готовы позже дорогих (travelport и т.п.). Раньше ждали фиксированные
// 25с и брали минимум из того, что успело прийти — если дешёвый поставщик
// не укладывался, бот репортил цену вдвое-втрое выше реальной. Теперь ждём,
// пока поток ответов /next/api/task не затихнет (сайт сам перестаёт поллить
// задачи, включая зависшие), с потолком на случай, если затишья не наступит.
// IDLE_MS=10000 хватало локально (первый запрос поиска улетает почти сразу
// после открытия страницы), но на Render через прокси между открытием
// страницы и первым запросом /next/api/task наблюдался разрыв БЕЗ единого
// запроса к /api/ вообще — 10с там истекали до того, как поиск успевал
// стартовать. Подняли с запасом.
const IDLE_MS = 30000;
const MAX_WAIT_MS = 120000;
const POLL_INTERVAL_MS = 500;

// IDLE_MS выше страхует от "поиск ещё толком не начался", но не спасает от
// обратной ситуации: сайт непрерывно опрашивает поставщиков, которые всё
// никак не завершатся (или не завершатся вообще), и поток запросов не
// затихает часами. А как только наш целевой рейс уже нашёлся у ХОТЯ БЫ
// одного поставщика — продолжать ждать остальных смысла нет: нам нужен один
// подходящий по маршруту+рейсу тариф, а не биржа цен по всем авиакомпаниям
// сразу. Короткое окно ниже — не "остановиться мгновенно", а поймать
// почти одновременные ответы от других продавцов той же самой брони
// (нередко приходят кластером в те же секунды), прежде чем сдаться на
// первом, если рядом есть дешевле тот же рейс.
const FIRST_MATCH_GRACE_MS = 5000;

// Даже когда все поставщики честно ответили, конкретно нужная пара
// туда+обратно у них иногда не складывается в единый тариф — при повторном
// поиске секунды спустя та же связка нередко находится. Поэтому при пустом
// результате повторяем поиск ещё несколько раз, прежде чем сдаться.
// Было 3 — но с IDLE_MS=30000 (см. выше) каждая попытка стала заметно дольше
// и тяжелее по памяти, а на Render уже ловили "Ran out of memory (512MB)"
// на 3 попытках подряд в одном процессе. Меньше попыток — меньше суммарная
// нагрузка на память за один вызов.
const MAX_ATTEMPTS = 2;
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
  // Site Isolation держит отдельный процесс на каждый ориджин — для одной
  // управляемой страницы это чистый расход памяти без пользы.
  '--disable-features=site-per-process',
];

async function checkPrice() {
  console.log(`[checker] прокси: ${PROXY ? PROXY.server : 'нет, соединение напрямую'}`);

  let offers = [];
  // Раньше сбрасывалось только ответами /next/api/task — из-за этого на
  // медленном окружении (прокси + ограниченный CPU на Render) таймер тишины
  // истекал ДО того, как страница вообще успевала отправить первый запрос
  // поиска (на это у неё уходило больше времени, чем IDLE_MS). Теперь считаем
  // живой любую активность к /api/ — сайт всё это время реально работает,
  // просто медленно, а не "завис".
  let lastActivityAt = Date.now();
  // Момент, когда нашёлся ПЕРВЫЙ подходящий тариф — см. FIRST_MATCH_GRACE_MS.
  // null, пока ничего не нашли.
  let firstMatchAt = null;
  // Диагностика: сколько всего ответов /next/api/task пришло за попытку и
  // сколько из них были status:"ok" — чтобы в логах Render было видно, где
  // именно затык (прокси вообще не пускает трафик / пускает, но поставщики
  // не успевают / успевают, но нужного маршрута нет).
  let taskResponsesSeen = 0;
  let taskResponsesOk = 0;
  let requestFailures = 0;
  let totalRequests = 0;
  let apiRequests = 0;
  let taskRequestsSent = 0;
  let firstTaskRequestLogged = false;
  // status:"ok" — терминальное состояние конкретной задачи поставщика: сайт
  // продолжает опрашивать тот же __tasks=ID и после этого, но данные там уже
  // не изменятся. Запоминаем такие id, чтобы не читать и не парсить заново
  // тело повторного ответа (среди них попадались на несколько мегабайт).
  let completedTaskIds = new Set();
  let skippedRedundantResponses = 0;

  function attachListener(page) {
    // Считаем вообще все запросы (не только /next/api/task) — если их за 18с+
    // открытия страницы единицы, значит зависает что-то на самом раннем этапе
    // (DNS/TLS через туннель), а не сама логика поиска на странице.
    page.on('request', req => {
      totalRequests++;
      const url = req.url();
      if (!url.includes('/api/')) return;
      apiRequests++;
      if (!url.includes('/next/api/task')) return;
      // Таймер простоя сбрасываем только реально значимой активностью
      // (запрос/ответ поиска). Телеметрию (debug-log/heartbeat) блокируем
      // маршрутизацией, но событие 'request' на неё всё равно срабатывает
      // ДО блокировки — если бы мы сбрасывали таймер и по ней, он бы никогда
      // не истекал (сайт долбит эти пинги бесконечно), и ожидание всегда
      // тянулось бы до жёсткого потолка, даже когда поиск давно закончен.
      lastActivityAt = Date.now();
      taskRequestsSent++;
      // Их сотни за один поиск (сайт опрашивает статус задач) — логируем
      // только первый факт, чтобы подтвердить, что поиск вообще стартовал,
      // а не заваливать лог сотнями одинаковых строк.
      if (!firstTaskRequestLogged) {
        firstTaskRequestLogged = true;
        console.log(`[checker] первый запрос к API поиска: ${url.slice(0, 150)}`);
      }
    });

    page.on('console', msg => {
      if (msg.type() !== 'error' || msg.text().includes('ERR_BLOCKED_BY_CLIENT')) return;
      console.log(`[checker] консоль страницы (error): ${msg.text().slice(0, 200)}`);
    });
    page.on('response', async resp => {
      const url = resp.url();
      if (!url.includes('/next/api/task')) return;

      // __tasks=ID(,ID...) в самом URL — если все перечисленные задачи уже
      // видели с status:"ok" в этой же попытке, тело ответа точно не несёт
      // ничего нового: не читаем и не парсим его вовсе (экономим и память, и CPU
      // на JSON.parse — среди этих ответов попадались по несколько мегабайт).
      const requestedIds = (new URL(url).searchParams.get('__tasks') || '').split(',').filter(Boolean);
      if (requestedIds.length && requestedIds.every(id => completedTaskIds.has(id))) {
        skippedRedundantResponses++;
        return;
      }

      taskResponsesSeen++;
      let data;
      try {
        const buf = await resp.body();
        data = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        console.log(`[checker] не удалось разобрать ответ /next/api/task: ${e.message}`);
        return;
      }
      lastActivityAt = Date.now();
      const tasks = data.tasks && data.tasks.avia;
      if (!tasks) return;
      for (const tid in tasks) {
        const t = tasks[tid];
        if (t.status !== 'ok' || completedTaskIds.has(tid)) continue;
        completedTaskIds.add(tid);
        if (!t.result) continue;
        taskResponsesOk++;
        offers.push(...findOffers(t, TARGET));
        if (firstMatchAt === null && offers.length > 0) firstMatchAt = Date.now();
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
    totalRequests = 0;
    apiRequests = 0;
    taskRequestsSent = 0;
    firstTaskRequestLogged = false;
    firstMatchAt = null;
    completedTaskIds = new Set();
    skippedRedundantResponses = 0;
    const attemptStartedAt = Date.now();
    console.log(`[checker] попытка ${attempt}/${MAX_ATTEMPTS}: открываю страницу поиска...`);

    // Свежий браузер целиком на каждую попытку, а не одна долгоживущая
    // инстанция на все попытки — Chromium не всегда отдаёт память рендерера
    // между навигациями внутри одного процесса, а на Render (512MB на весь
    // процесс) это уже приводило к "Ran out of memory". Перезапуск браузера
    // между попытками — самый надёжный способ реально освободить память
    // на уровне ОС, а не полагаться на внутренний GC Chromium.
    const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
    try {
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        // mincifri.superkassa.ru (и, возможно, другие поддомены сайта) подписаны
        // российским Minsvyaz/Mintsifry CA ("Russian Trusted Sub CA") — его нет в
        // доверенном списке Chromium вне России, из-за чего запрос к нему падает
        // с ERR_CERT_AUTHORITY_INVALID и, похоже, тормозит инициализацию страницы
        // до состояния, когда поиск вообще не запускается. Сертификат настоящий
        // и ожидаемый для этого сайта — просто не в дефолтном доверенном списке.
        ignoreHTTPSErrors: true,
        ...(PROXY ? { proxy: PROXY } : {}),
      });

      await context.route('**/*', (route, req) => {
        const url = req.url();
        if (AD_DOMAINS.test(url) || BLOCKED_RESOURCE_TYPES.has(req.resourceType()) || BLOCKED_API_PATTERNS.some(p => p.test(url))) {
          // Явный код ошибки — иначе Playwright/Chromium помечает abort() как
          // net::ERR_FAILED, неотличимый в логах requestfailed от настоящего
          // сетевого сбоя через прокси.
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });

      const page = await context.newPage();
      attachListener(page);
      try {
        // 60с вместо 30 — на Render через прокси открытие страницы стабильно
        // занимает 18-20с (против 1-2с локально), 30с не давали запаса на случай
        // просадки.
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log(
          `[checker] попытка ${attempt}: страница открылась за ${Date.now() - attemptStartedAt}мс (запросов сделано к этому моменту: ${totalRequests}), жду данные...`
        );
        lastActivityAt = Date.now();

        const deadline = Date.now() + MAX_WAIT_MS;
        let lastHeartbeatAt = Date.now();
        while (Date.now() < deadline && Date.now() - lastActivityAt < IDLE_MS) {
          await page.waitForTimeout(POLL_INTERVAL_MS);
          // Целевой рейс уже нашёлся — короткое окно поймать почти
          // одновременные ответы от других продавцов той же брони, и хватит:
          // нам нужен один подходящий тариф, а не полная биржа цен по всем
          // авиакомпаниям сразу.
          if (firstMatchAt !== null && Date.now() - firstMatchAt >= FIRST_MATCH_GRACE_MS) break;
          if (Date.now() - lastHeartbeatAt >= 10000) {
            lastHeartbeatAt = Date.now();
            console.log(
              `[checker] попытка ${attempt}: ещё жду (${Math.round((Date.now() - attemptStartedAt) / 1000)}с) — запросов всего: ${totalRequests} (к /api/: ${apiRequests}), запросов /next/api/task отправлено: ${taskRequestsSent}, ответов: ${taskResponsesSeen} (ok: ${taskResponsesOk}, пропущено повторных: ${skippedRedundantResponses}), совпадений: ${offers.length}, сбоев запросов: ${requestFailures}`
            );
          }
        }
        const exitReason =
          Date.now() >= deadline
            ? 'исчерпан потолок ожидания'
            : firstMatchAt !== null && Date.now() - firstMatchAt >= FIRST_MATCH_GRACE_MS
              ? 'целевой рейс найден, дальше не жду'
              : 'поток ответов затих';
        console.log(
          `[checker] попытка ${attempt}: закончил ждать (${exitReason}) — запросов всего: ${totalRequests} (к /api/: ${apiRequests}), запросов /next/api/task отправлено: ${taskRequestsSent}, ответов: ${taskResponsesSeen} (ok: ${taskResponsesOk}, пропущено повторных: ${skippedRedundantResponses}), совпадений с целевым маршрутом: ${offers.length}, сбоев запросов: ${requestFailures}, всего ${Date.now() - attemptStartedAt}мс`
        );
      } catch (e) {
        // Сайт иногда просто не открывается за 30с (сетевой сбой/подвисание) —
        // это тоже неудачная попытка, а не повод сразу сдаваться.
        lastError = e;
        console.log(`[checker] попытка ${attempt}: упала за ${Date.now() - attemptStartedAt}мс с ошибкой: ${e.message} (сбоев запросов до этого: ${requestFailures})`);
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await browser.close().catch(() => {});
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
}

module.exports = { checkPrice };
