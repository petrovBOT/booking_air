const profile = require('./profile');
const { sendMessage, choiceKeyboard, removeKeyboard } = require('./telegram');

const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;

// section: куда в profile.json класть значение ('passenger' | 'contact').
// parse: как превратить ответ пользователя в сохраняемое значение.
const FIELDS = [
  // Гражданство, тип документа и код страны телефона не спрашиваем — всегда
  // "Россия" / "Заграничный паспорт РФ" / "Россия +7", заданы в config.js как дефолт.
  { key: 'gender', section: 'passenger', question: 'Пол пассажира:', choices: ['Мужской', 'Женский'], parse: v => (v === 'Женский' ? 'F' : 'M') },
  { key: 'birthDate', section: 'passenger', question: 'Дата рождения (ДД.ММ.ГГГГ):', validate: v => DATE_RE.test(v) },
  {
    key: 'documentNumber',
    section: 'passenger',
    question: 'Серия и номер документа — ровно 9 цифр для загранпаспорта РФ, без пробелов:',
    validate: v => /^\d{9}$/.test(v),
  },
  {
    key: 'documentExpireDate',
    section: 'passenger',
    question: 'Дата окончания действия документа (ДД.ММ.ГГГГ), или "-" если без срока действия:',
    validate: v => v === '-' || DATE_RE.test(v),
    parse: v => (v === '-' ? '' : v),
  },
  { key: 'lastName', section: 'passenger', question: 'Фамилия латиницей (как в загранпаспорте):' },
  { key: 'firstName', section: 'passenger', question: 'Имя латиницей (как в загранпаспорте):' },
  { key: 'middleName', section: 'passenger', question: 'Отчество (или "-" если не нужно указывать):', parse: v => (v === '-' ? '' : v) },
  { key: 'email', section: 'contact', question: 'Email для отправки билетов:', validate: v => v.includes('@') },
  { key: 'phoneNumber', section: 'contact', question: 'Номер телефона без кода страны, только цифры:' },
];

// У каждого chatId — своё состояние опроса, чтобы друзья могли проходить /setup одновременно.
const states = new Map();

async function askCurrentField(chatId) {
  const f = FIELDS[states.get(chatId).index];
  await sendMessage(chatId, f.question, f.choices ? choiceKeyboard(f.choices) : removeKeyboard);
}

async function start(chatId) {
  states.set(chatId, { index: 0, values: { passenger: {}, contact: {} } });
  await sendMessage(chatId, `Настройка данных пассажира — ${FIELDS.length} вопросов подряд. В любой момент можно прервать командой /cancel.`);
  await askCurrentField(chatId);
}

function cancel(chatId) {
  const was = isActive(chatId);
  states.delete(chatId);
  return was;
}

function isActive(chatId) {
  return states.has(chatId);
}

async function handleAnswer(chatId, text) {
  const state = states.get(chatId);
  const f = FIELDS[state.index];
  const raw = text.trim();

  if (f.validate && !f.validate(raw)) {
    await sendMessage(chatId, 'Не похоже на правильный формат, попробуй ещё раз.');
    return;
  }
  if (f.choices && !f.choices.includes(raw)) {
    await sendMessage(chatId, 'Выбери один из вариантов на клавиатуре ниже.', choiceKeyboard(f.choices));
    return;
  }

  const value = f.parse ? f.parse(raw) : raw;
  state.values[f.section][f.key] = value;
  state.index += 1;

  if (state.index >= FIELDS.length) {
    await profile.setUserData(chatId, state.values);
    states.delete(chatId);
    await sendMessage(chatId, 'Готово, данные сохранены. Проверить можно командой /profile.', removeKeyboard);
    return;
  }

  await askCurrentField(chatId);
}

module.exports = { start, cancel, isActive, handleAnswer };
