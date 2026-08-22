// Цена в рублях, при которой бот шлёт алерт в Telegram.
// Можно менять прямо тут (redeploy) или переопределить переменной окружения
// PRICE_THRESHOLD_RUB в настройках Koyeb — без пересборки образа.
const PRICE_THRESHOLD_RUB = Number(process.env.PRICE_THRESHOLD_RUB) || 110000;

module.exports = {
  PRICE_THRESHOLD_RUB,

  // На Koyeb всегда headless. HEADLESS=false — только для локальной проверки глазами.
  HEADLESS: process.env.HEADLESS !== 'false',

  // Как часто гонять автоматическую проверку (минуты).
  CHECK_INTERVAL_MINUTES: Number(process.env.CHECK_INTERVAL_MINUTES) || 20,

  // Сколько ждать после захода на страницу, пока поставщики отдадут результаты поиска.
  TASK_WAIT_MS: Number(process.env.TASK_WAIT_MS) || 25000,

  // ?search=...&refSearch=true запускает свежий поиск сразу при заходе,
  // без этого сайт просто предзаполняет форму и ждёт клика.
  SEARCH_URL: 'https://superkassa.ru/?search=LED2512HKT1601100&refSearch=true',

  // Рекламные попандеры/трекеры — блокируем на уровне сети, иначе редиректит с сайта.
  AD_DOMAINS: /ostrovok\.ru|fastrovok\.net|dengage\.com/,

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  // Владелец бота — единственный, кто может менять порог цены и видит админ-команды.
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  // Остальные, кому разрешено пользоваться ботом (свой /setup, свои бронирования) —
  // список chat_id через запятую. Владелец в списке не нужен, добавляется всегда сам.
  ALLOWED_CHAT_IDS: (process.env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Данные пассажира и покупателя — только через переменные окружения Koyeb,
  // никогда не хранить в коде/git.
  PASSENGER: {
    gender: process.env.PASSENGER_GENDER, // 'M' | 'F'
    birthDate: process.env.PASSENGER_BIRTH_DATE, // ДД.ММ.ГГГГ
    citizenship: process.env.PASSENGER_CITIZENSHIP, // напр. "Россия"
    documentType: process.env.PASSENGER_DOCUMENT_TYPE, // напр. "Загранпаспорт"
    documentNumber: process.env.PASSENGER_DOCUMENT_NUMBER,
    documentExpireDate: process.env.PASSENGER_DOCUMENT_EXPIRE_DATE || '', // ДД.ММ.ГГГГ, пусто = "Без даты"
    lastName: process.env.PASSENGER_LAST_NAME,
    firstName: process.env.PASSENGER_FIRST_NAME,
    middleName: process.env.PASSENGER_MIDDLE_NAME || '',
  },
  CONTACT: {
    email: process.env.CONTACT_EMAIL,
    phoneCountry: process.env.CONTACT_PHONE_COUNTRY || 'Россия +7',
    phoneNumber: process.env.CONTACT_PHONE_NUMBER,
  },
  PAYMENT_METHOD_LABEL: process.env.PAYMENT_METHOD_LABEL || 'T-Pay',

  // Точная идентификация нужного рейса+маршрута — сверяется по каждому перелёту,
  // а не по "первому попавшемуся" результату поиска.
  TARGET: {
    // depTime/arrTime у первого перелёта каждого направления — это НЕ время именно
    // этого рейса, а сводное время всего сегмента (вылет из LED / прилёт в HKT и т.д.),
    // как оно показано в самой карточке выдачи до открытия тарифов. Нужны оба, а не
    // только вылет — у карточки бывают варианты с одинаковым вылетом, но разным прилётом.
    // По ним кликаем нужный вариант через select-time-button, т.к. карточка может
    // по умолчанию показывать другой стыковочный рейс той же авиакомпании.
    // strict:false — стыковочный рейс через Шанхай называется по-разному в разных
    // источниках данных сайта (видели и MU-8647/MU-8648, и FM-857/MU-8618 для тех же
    // времени и маршрута) — матчим его по depCode/arrCode, без сверки номера рейса.
    // Прямой рейс (strict не указан = true) остаётся строгим.
    outbound: [
      { company: 'MU', num: '260', depCode: 'LED', arrCode: 'PVG', depTime: '21:05', arrTime: '22:00' },
      { company: 'MU', num: '8647', depCode: 'PVG', arrCode: 'HKT', strict: false },
    ],
    inbound: [
      { company: 'MU', num: '8648', depCode: 'HKT', arrCode: 'PVG', depTime: '23:05', arrTime: '19:05', strict: false },
      { company: 'MU', num: '259', depCode: 'PVG', arrCode: 'LED' },
    ],
  },
};
