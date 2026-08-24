// Точка входа: сначала подхватываем .env (локальный запуск), затем (опционально)
// поднимаем прокси, и только потом требуем index.js — чтобы к моменту, когда
// config.js прочитает PROXY_SERVER из process.env, локальный SOCKS5 (если он
// нужен) уже был поднят и проверен.
const { loadEnvFile } = require('./load-env');
const { ensureProxy } = require('./proxy-bootstrap');

(async () => {
  loadEnvFile();
  await ensureProxy();
  require('./index');
})();
