const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'profile.json');

// Форма файла: { priceThreshold?: number, users: { "<chatId>": { passenger, contact, booked } } }
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!data.users) data.users = {};
    return data;
  } catch {
    return { users: {} };
  }
}

function saveAll(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  return data;
}

function saveGlobal(partial) {
  return saveAll({ ...load(), ...partial });
}

function saveUser(chatId, partial) {
  const data = load();
  const current = data.users[String(chatId)] || {};
  data.users[String(chatId)] = { ...current, ...partial };
  return saveAll(data);
}

function loadUser(chatId) {
  return load().users[String(chatId)] || {};
}

module.exports = { load, saveGlobal, saveUser, loadUser };
