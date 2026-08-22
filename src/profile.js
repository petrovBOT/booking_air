const config = require('./config');
const store = require('./store');

// Дефолты из .env — только для владельца (TELEGRAM_CHAT_ID). У остальных
// дефолтов нет, они обязаны пройти /setup, иначе поля будут пустыми.
function defaultsFor(chatId) {
  const isOwner = String(chatId) === String(config.TELEGRAM_CHAT_ID);
  return {
    passenger: isOwner ? config.PASSENGER : {},
    contact: isOwner ? config.CONTACT : {},
  };
}

async function getPassenger(chatId) {
  const d = defaultsFor(chatId);
  const user = await store.loadUser(chatId);
  return { ...d.passenger, ...(user.passenger || {}) };
}

async function getContact(chatId) {
  const d = defaultsFor(chatId);
  const user = await store.loadUser(chatId);
  return { ...d.contact, ...(user.contact || {}) };
}

async function setUserData(chatId, partial) {
  await store.saveUser(chatId, partial);
}

// Профиль считается заполненным, когда есть всё нужное для брони,
// кроме гражданства/типа документа/кода телефона — у них есть жёсткие дефолты.
async function isProfileComplete(chatId) {
  const p = await getPassenger(chatId);
  const c = await getContact(chatId);
  return Boolean(
    p.gender && p.birthDate && p.documentNumber && p.lastName && p.firstName && c.email && c.phoneNumber
  );
}

async function isBooked(chatId) {
  const user = await store.loadUser(chatId);
  return Boolean(user.booked);
}

async function markBooked(chatId, info) {
  await store.saveUser(chatId, { booked: info });
}

async function getPriceThreshold() {
  const data = await store.load();
  return typeof data.priceThreshold === 'number' ? data.priceThreshold : config.PRICE_THRESHOLD_RUB;
}

async function setPriceThreshold(value) {
  await store.saveGlobal({ priceThreshold: value });
}

async function getCheckIntervalMinutes() {
  const data = await store.load();
  return typeof data.checkIntervalMinutes === 'number' ? data.checkIntervalMinutes : config.CHECK_INTERVAL_MINUTES;
}

async function setCheckIntervalMinutes(value) {
  await store.saveGlobal({ checkIntervalMinutes: value });
}

// Все, кому разрешено пользоваться ботом: владелец + ALLOWED_CHAT_IDS из .env.
function allowedChatIds() {
  return [String(config.TELEGRAM_CHAT_ID), ...config.ALLOWED_CHAT_IDS].filter(Boolean);
}

function isAllowed(chatId) {
  return allowedChatIds().includes(String(chatId));
}

function isOwner(chatId) {
  return String(chatId) === String(config.TELEGRAM_CHAT_ID);
}

module.exports = {
  getPassenger,
  getContact,
  setUserData,
  isProfileComplete,
  isBooked,
  markBooked,
  getPriceThreshold,
  setPriceThreshold,
  getCheckIntervalMinutes,
  setCheckIntervalMinutes,
  allowedChatIds,
  isAllowed,
  isOwner,
};
