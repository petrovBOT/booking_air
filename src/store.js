// Render free web service не имеет persistent disk — контейнер эфемерный,
// любой рестарт (redeploy, сон/пробуждение, краш) стирает локальный диск.
// Поэтому состояние (профили, статус брони, порог цены) живёт в Upstash Redis.
const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'booking-air:profile';

async function command(args) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Upstash: ${data.error}`);
  return data.result;
}

// Форма данных: { priceThreshold?: number, users: { "<chatId>": { passenger, contact, booked } } }
async function load() {
  const raw = await command(['GET', KEY]);
  if (!raw) return { users: {} };
  try {
    const data = JSON.parse(raw);
    if (!data.users) data.users = {};
    return data;
  } catch {
    return { users: {} };
  }
}

async function saveAll(data) {
  await command(['SET', KEY, JSON.stringify(data)]);
  return data;
}

async function saveGlobal(partial) {
  return saveAll({ ...(await load()), ...partial });
}

async function saveUser(chatId, partial) {
  const data = await load();
  const current = data.users[String(chatId)] || {};
  data.users[String(chatId)] = { ...current, ...partial };
  return saveAll(data);
}

async function loadUser(chatId) {
  return (await load()).users[String(chatId)] || {};
}

module.exports = { load, saveGlobal, saveUser, loadUser };
