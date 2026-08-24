// Общий для checker.js и booker.js набор флагов запуска Chromium — вынесен в
// отдельный модуль, чтобы не расходились по мере правок (bb6bf19 "Снизить
// потребление памяти headless Chromium" правил только checker.js, из-за чего
// attemptBooking всё это время запускал куда более прожорливый браузер без
// этих флагов).
// Render free — 512MB на весь процесс (Node + Xray + Chromium), headless
// Chromium сам по себе прожорливый — флаги ниже гасят фоновые
// таймеры/синк/расширения/телеметрию, которые Chromium иначе держит активными
// даже в headless.
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
  // Точечные добавки поверх уже отключённого выше: убирают ещё несколько
  // фоновых процессов/подсистем, которые headless всё равно не использует,
  // но по умолчанию держит инициализированными.
  '--no-zygote', // без pre-fork'нутого zygote-процесса — на контейнер минус один процесс ОС
  '--disable-breakpad', // отключает встроенный crash-reporter Chromium
  '--disable-component-update', // не проверяет обновления встроенных компонентов (Widevine и т.п.)
  '--disable-hang-monitor', // не следит за "зависанием" вкладки — эта диагностика Chromium нам не нужна
  '--disk-cache-size=1', // не даёт разрастись HTTP-кэшу на диске/tmpfs
  '--media-cache-size=1',
  // Ни один флаг выше не ограничивает сам JS-heap рендерера — а именно он,
  // судя по pulse-логам, раздувается за 50+ секунд активного поллинга сайта
  // сильнее всего. max-old-space-size режет "старое поколение" (то, что
  // пережило несколько сборок), max-semi-space-size — "молодое" (буфер под
  // свежие аллокации между сборками) — без второго всплески параллельного
  // парсинга ответов сайтом всё равно смогут раздувать память между
  // сборками мусора. Нам от страницы нужны только сетевые JSON-ответы, не
  // её DOM/UI — если её собственный скрипт придушится агрессивным GC под
  // этим потолком, это не страшнее ещё одной причины для retry.
  '--js-flags=--max-old-space-size=256 --max-semi-space-size=32',
];

module.exports = { CHROMIUM_ARGS };
