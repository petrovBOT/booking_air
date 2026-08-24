// Поднимает локальный SOCKS5 через xray-core перед стартом остального приложения —
// чтобы обходить возможную деградацию/блокировку дата-центровых IP хостинга при
// обращении к superkassa.ru. Ключ (ссылка-подписка) НИКОГДА не хранится в коде —
// только через переменную окружения PROXY_SUBSCRIPTION_URL на самом Render.
// Без неё функция ничего не делает — бот работает как раньше, напрямую.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');

const LOCAL_SOCKS_PORT = Number(process.env.PROXY_LOCAL_PORT) || 10809;
const XRAY_BIN = process.env.XRAY_BIN_PATH || path.join(__dirname, '..', 'xray', process.platform === 'win32' ? 'xray.exe' : 'xray');
const VERIFY_URL = 'https://superkassa.ru/';
const VERIFY_TIMEOUT_MS = 10000;
const STARTUP_WAIT_MS = 1500;

// Поддерживаем только vless+reality+tcp — этого формата достаточно для конкретной
// подписки, под которую это писалось; остальные варианты (xhttp и т.п.) пропускаем.
function parseVlessNodes(subscriptionText) {
  const decoded = Buffer.from(subscriptionText.trim(), 'base64').toString('utf8');
  const nodes = [];
  for (const line of decoded.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('vless://')) continue;
    try {
      const url = new URL(trimmed);
      const params = url.searchParams;
      if (params.get('security') !== 'reality' || (params.get('type') || 'tcp') !== 'tcp') continue;
      nodes.push({
        id: decodeURIComponent(url.username),
        address: url.hostname,
        port: Number(url.port) || 443,
        sni: params.get('sni') || '',
        fingerprint: params.get('fp') || 'chrome',
        publicKey: params.get('pbk') || '',
        shortId: params.get('sid') || '',
        label: decodeURIComponent(url.hash || '').replace(/^#/, ''),
      });
    } catch {
      // не наш формат строки — пропускаем
    }
  }
  return nodes;
}

async function fetchSubscriptionNodes(subscriptionUrl) {
  const res = await fetch(subscriptionUrl);
  if (!res.ok) throw new Error(`подписка ответила ${res.status}`);
  const text = await res.text();
  return parseVlessNodes(text);
}

function buildXrayConfig(node) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      { port: LOCAL_SOCKS_PORT, listen: '127.0.0.1', protocol: 'socks', settings: { auth: 'noauth', udp: true } },
    ],
    outbounds: [
      {
        protocol: 'vless',
        settings: { vnext: [{ address: node.address, port: node.port, users: [{ id: node.id, encryption: 'none' }] }] },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            serverName: node.sni,
            fingerprint: node.fingerprint,
            publicKey: node.publicKey,
            shortId: node.shortId,
          },
        },
      },
    ],
  };
}

function spawnXray(configPath) {
  const child = spawn(XRAY_BIN, ['run', '-c', configPath], { stdio: 'ignore' });
  child.unref();
  return child;
}

// Возвращает подробности, а не просто true/false — чтобы в логах было видно
// РАЗНИЦУ между "туннель вообще не работает" и "туннель работает, но конкретно
// superkassa.ru через этот узел не отвечает/блокирует" — это два разных вывода
// для диагностики (обрыв VLESS до узла vs. деградация IP именно для сайта).
function probeThroughLocalProxy(url, method = 'HEAD') {
  const agent = new SocksProxyAgent(`socks5://127.0.0.1:${LOCAL_SOCKS_PORT}`);
  const startedAt = Date.now();
  return new Promise(resolve => {
    const req = https.request(url, { agent, method, timeout: VERIFY_TIMEOUT_MS }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ ok: res.statusCode < 500, status: res.statusCode, ms: Date.now() - startedAt, body: Buffer.concat(chunks).toString('utf8').slice(0, 100) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - startedAt }); });
    req.on('error', e => resolve({ ok: false, error: e.message, ms: Date.now() - startedAt }));
    req.end();
  });
}

async function ensureProxy() {
  const subscriptionUrl = process.env.PROXY_SUBSCRIPTION_URL;
  if (!subscriptionUrl) return;

  let nodes;
  try {
    nodes = await fetchSubscriptionNodes(subscriptionUrl);
  } catch (e) {
    console.warn(`[proxy] не удалось получить подписку: ${e.message} — продолжаю без прокси`);
    return;
  }

  if (!nodes.length) {
    console.warn('[proxy] в подписке нет подходящих (vless+reality+tcp) узлов — продолжаю без прокси');
    return;
  }

  console.log(`[proxy] найдено узлов в подписке: ${nodes.length} (${nodes.map(n => n.label || n.address).join(', ')})`);

  const configPath = path.join(os.tmpdir(), 'xray-proxy-config.json');
  for (const node of nodes) {
    const label = node.label || node.address;
    fs.writeFileSync(configPath, JSON.stringify(buildXrayConfig(node)));
    const child = spawnXray(configPath);
    await new Promise(r => setTimeout(r, STARTUP_WAIT_MS));

    // Сначала общая связность (внешний нейтральный сайт) — если и она не работает,
    // проблема в самом туннеле/узле, а не конкретно в superkassa.ru.
    const generic = await probeThroughLocalProxy('https://api.ipify.org/', 'GET');
    const target = await probeThroughLocalProxy(VERIFY_URL, 'HEAD');
    console.log(
      `[proxy] узел "${label}": общая связность — ${generic.ok ? `ok, ip=${generic.body}, ${generic.ms}мс` : `FAIL (${generic.error || generic.status})`}; superkassa.ru — ${target.ok ? `ok, ${target.ms}мс` : `FAIL (${target.error || target.status})`}`
    );

    if (target.ok) {
      console.log(`[proxy] узел "${label}" рабочий, использую как прокси`);
      process.env.PROXY_SERVER = `socks5://127.0.0.1:${LOCAL_SOCKS_PORT}`;
      return;
    }

    console.warn(`[proxy] узел "${label}" не подходит, пробую следующий`);
    child.kill();
  }

  console.warn('[proxy] ни один узел подписки не сработал — продолжаю без прокси');
}

module.exports = { ensureProxy };
