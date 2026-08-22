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

function getPassenger(chatId) {
  const d = defaultsFor(chatId);
  return { ...d.passenger, ...(store.loadUser(chatId).passenger || {}) };
}

function getContact(chatId) {
  const d = defaultsFor(chatId);
  return { ...d.contact, ...(store.loadUser(chatId).contact || {}) };
}

function setUserData(chatId, partial) {
  store.saveUser(chatId, partial);
}

// Профиль считается заполненным, когда есть всё нужное для брони,
// кроме гражданства/типа документа/кода телефона — у них есть жёсткие дефолты.
function isProfileComplete(chatId) {
  const p = getPassenger(chatId);
  const c = getContact(chatId);
  return Boolean(
    p.gender && p.birthDate && p.documentNumber && p.lastName && p.firstName && c.email && c.phoneNumber
  );
}

function isBooked(chatId) {
  return Boolean(store.loadUser(chatId).booked);
}

function markBooked(chatId, info) {
  store.saveUser(chatId, { booked: info });
}

function getPriceThreshold() {
  const saved = store.load().priceThreshold;
  return typeof saved === 'number' ? saved : config.PRICE_THRESHOLD_RUB;
}

function setPriceThreshold(value) {
  store.saveGlobal({ priceThreshold: value });
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
  allowedChatIds,
  isAllowed,
  isOwner,
};
