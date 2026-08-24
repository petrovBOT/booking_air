// Точка входа: сначала подхватываем .env (локальный запуск), затем (опционально)
// поднимаем прокси, и только потом требуем index.js — чтобы к моменту, когда
// config.js прочитает PROXY_SERVER из process.env, локальный SOCKS5 (если он
// нужен) уже был поднят и проверен.
const { loadEnvFile } = require('./load-env');
const { ensureProxy } = require('./proxy-bootstrap');
const { logMemory } = require('./memlog');

(async () => {
  logMemory('процесс стартовал (до .env и proxy bootstrap)');
  loadEnvFile();
  await ensureProxy();
  // Отдельная точка ДО require('./index') — если Xray (см. proxy-bootstrap.js)
  // ощутимо ест память, это будет видно как скачок именно между этим замером
  // и предыдущим, ещё до того, как в дело вступит что-либо из checker/booker.
  logMemory('после ensureProxy (Xray, если поднят, уже запущен)');
  require('./index');
})();
