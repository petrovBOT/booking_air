// Локальный запуск читает .env сам (на Render .env нет — переменные уже заданы платформой).
// Должно быть выполнено до require('./config') (и до всего, что читает process.env
// на старте, например proxy-bootstrap.js), иначе они прочитают пустой process.env.
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envFile = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      if (!(key in process.env)) process.env[key] = trimmed.slice(idx + 1).trim();
    });
}

module.exports = { loadEnvFile };
