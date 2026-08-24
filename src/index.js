const { TARGET, TELEGRAM_CHAT_ID, SEARCH_URL, SEARCH_URL_DEC24 } = require('./config');
const { checkPrice } = require('./checker');
const { attemptBooking, formatOrderCaption } = require('./booker');
const { sendMessage, sendPhoto, listenForMessages } = require('./telegram');
const profile = require('./profile');
const wizard = require('./wizard');

// На Render free web-сервисы засыпают без входящего HTTP-трафика — это заглушка
// под внешний пинг (UptimeRobot/cron-job.org), сам бот с ней никак не взаимодействует.
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(PORT, () => console.log(`Health-check сервер слушает порт ${PORT}`));

let checking = false;
// Метка даты, которая сейчас проверяется ('' — основной /check, иначе,
// напр., '24 декабря' — /check24) — нужна, чтобы не продублировать ответ
// про ЧУЖУЮ дату тому, кто ждал ответа про свою (см. respond ниже).
let inProgressLabel = null;
// Chat id тех, кто написал ту же команду, пока уже шла чужая проверка —
// им нужно продублировать итоговый ответ, а не оставлять их без ответа вовсе.
let waitingChatIds = [];

// Бронирует по очереди на каждого, у кого готов профиль и кто ещё не бронировал.
// Каждому — своя попытка и свой алерт, в его личный чат. searchUrl/label —
// см. runCheck ниже: /check24 бронирует по своей дате той же логикой.
// Владелец бота — исключение: он видит все проверки цены и может запросить
// их сам, но бронь на него никогда не создаётся, только для ALLOWED_CHAT_IDS.
async function bookForAllUsers(price, currency, searchUrl = SEARCH_URL, label = '') {
  const prefix = label ? `[${label}] ` : '';
  for (const chatId of profile.allowedChatIds()) {
    if (profile.isOwner(chatId)) {
      console.log(`[booking] ${chatId} — владелец, бронь не создаём`);
      continue;
    }
    if (!(await profile.isProfileComplete(chatId))) {
      console.log(`[booking] у ${chatId} не заполнен профиль — пропускаю`);
      continue;
    }
    if (await profile.isBooked(chatId)) {
      console.log(`[booking] у ${chatId} уже есть бронь — пропускаю`);
      continue;
    }

    await sendMessage(chatId, `${prefix}Цена подходит: ${price} ${currency}. Пробую оформить бронь...`);
    try {
      const booking = await attemptBooking(chatId, stage => console.log(`[booking:${chatId}] этап: ${stage}`), searchUrl);
      await profile.markBooked(chatId, { at: new Date().toISOString(), price });
      const caption = formatOrderCaption(booking.summary, [
        '',
        `Ссылка на оплату: ${booking.paymentLink}`,
        'Оплати вручную в течение отведённого времени.',
      ]);
      await sendPhoto(chatId, booking.screenshot, prefix + caption);
    } catch (e) {
      console.error(`[booking:${chatId}] не удалось:`, e);
      await sendMessage(chatId, `${prefix}Цена была подходящей (${price} ₽), но бронирование не завершилось: ${e.message}\nПроверь вручную, пока цена не ушла.`);
    }
  }
}

// Проверка запускается только вручную через /check(24) — никакого фонового
// расписания нет (сознательно: регулярный трафик по таймеру — заметный
// паттерн для антибот-систем сайта, разовые запросы по команде человека
// выглядят органичнее). searchUrl/label по умолчанию — основная дата
// (config.SEARCH_URL, без пометки); /check24 передаёт SEARCH_URL_DEC24 и
// метку '24 декабря' — та же самая логика поиска и бронирования, просто
// другой URL. checking — общий лок на обе даты сразу: два одновременных
// сеанса Chromium+прокси на 512MB Render гарантированно упрутся в память.
async function runCheck(requesterChatId, searchUrl = SEARCH_URL, label = '') {
  if (checking) {
    if (label === inProgressLabel) {
      if (!waitingChatIds.includes(requesterChatId)) waitingChatIds.push(requesterChatId);
      console.log(`проверка уже идёт, ставлю ${requesterChatId} в очередь на ответ`);
      await sendMessage(requesterChatId, 'Запрос уже обрабатывается — его отправил другой пользователь. Как только придёт ответ, пришлю его и тебе.');
    } else {
      // Другая дата уже в работе — дублировать её ответ этому пользователю
      // нельзя, он спрашивал про другое. Просто просим подождать и повторить.
      console.log(`идёт проверка другой даты, ${requesterChatId} просит "${label || 'основную'}" — прошу подождать`);
      await sendMessage(requesterChatId, 'Сейчас уже идёт проверка другой даты. Подожди немного и повтори запрос.');
    }
    return;
  }
  checking = true;
  inProgressLabel = label;
  const startedAt = Date.now();
  const prefix = label ? `[${label}] ` : '';
  // Итоговый ответ уходит тому, кто запросил проверку, всем, кто написал ту
  // же команду, пока она уже шла (иначе они бы остались без результата
  // вовсе), и владельцу — он получает пуш с результатом каждой проверки.
  // Set убирает дубли, если владелец сам оказался среди инициатора/ожидающих.
  const respond = async text => {
    const recipients = new Set([requesterChatId, ...waitingChatIds, TELEGRAM_CHAT_ID]);
    waitingChatIds = [];
    await Promise.all([...recipients].map(id => sendMessage(id, prefix + text)));
  };
  try {
    const threshold = await profile.getPriceThreshold();
    console.log(`${prefix}запускаю проверку цены...`);
    const result = await checkPrice(searchUrl);
    const ms = Date.now() - startedAt;

    if (!result.found) {
      console.log(`${prefix}целевой рейс/тариф не найден в выдаче (${ms}мс)`);
      await respond('Целевой рейс не найден в текущей выдаче. Возможно, сайт изменился или рейса нет в продаже.');
      return;
    }

    console.log(`${prefix}цена: ${result.price} ${result.currency}, вариантов найдено: ${result.offersCount} (${ms}мс)`);

    if (result.price > threshold) {
      await respond(`Текущая цена: ${result.price} ${result.currency} (порог ${threshold} ₽, ещё не достигнут)`);
      return;
    }

    await respond(`Цена подходящая: ${result.price} ${result.currency} (порог ${threshold} ₽) — запускаю бронирование.`);

    console.log(`${prefix}цена ${result.price} ₽ ≤ порога — бронирую на всех, у кого готов профиль...`);
    await bookForAllUsers(result.price, result.currency, searchUrl, label);
  } catch (e) {
    console.error(`${prefix}ошибка проверки:`, e);
    await respond(`Ошибка при проверке цены: ${e.message}`);
  } finally {
    checking = false;
    inProgressLabel = null;
  }
}

async function showProfile(chatId) {
  const p = await profile.getPassenger(chatId);
  const c = await profile.getContact(chatId);
  const booked = await profile.isBooked(chatId);
  await sendMessage(
    chatId,
    [
      `Пол: ${p.gender === 'F' ? 'Женский' : 'Мужской'}`,
      `Дата рождения: ${p.birthDate || '—'}`,
      `Гражданство: ${p.citizenship || '—'}`,
      `Документ: ${p.documentType || '—'}, ${p.documentNumber || '—'}${p.documentExpireDate ? `, до ${p.documentExpireDate}` : ' (без срока действия)'}`,
      `ФИО: ${[p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ') || '—'}`,
      `Email: ${c.email || '—'}`,
      `Телефон: ${c.phoneCountry || '—'} ${c.phoneNumber || '—'}`,
      `Бронь: ${booked ? 'уже оформлена' : 'ещё нет'}`,
      '',
      'Изменить: /setup',
    ].join('\n')
  );
}

async function showInfo(chatId) {
  const admin = profile.isOwner(chatId)
    ? '\n/threshold <сумма> — изменить порог цены (только владелец)'
    : '';
  await sendMessage(
    chatId,
    [
      'Доступные команды:',
      '',
      '/check — проверка цены прямо сейчас (вылет 25 декабря)',
      '/check24 — та же проверка, но на вылет 24 декабря',
      '/settings — рейс и порог цены',
      '/profile — посмотреть свои сохранённые данные пассажира и контакты',
      '/setup — пошагово задать/изменить свои данные пассажира и контакты',
      '/cancel — прервать текущий /setup',
      '/info — это сообщение' + admin,
      '',
      'Автопроверки по расписанию нет — только по команде /check. Если цена',
      'подходящая, бот пробует оформить бронь на каждого, у кого заполнен',
      'профиль, и присылает лично скриншот заявки со ссылкой на оплату —',
      'платить нужно вручную.',
    ].join('\n')
  );
}

function formatTargetLeg(legs) {
  return legs.map(l => `${l.company}-${l.num} ${l.depCode}→${l.arrCode}${l.depTime ? ` (${l.depTime})` : ''}`).join(', ');
}

async function showSettings(chatId) {
  const threshold = await profile.getPriceThreshold();
  await sendMessage(
    chatId,
    [
      `Рейс туда: ${formatTargetLeg(TARGET.outbound)}`,
      `Рейс обратно: ${formatTargetLeg(TARGET.inbound)}`,
      '(маршрут зафиксирован в коде, меняется только через config.js)',
      '/check — вылет 25 декабря, /check24 — тот же рейс на 24 декабря',
      '',
      `Порог цены: ${threshold} ₽`,
      profile.isOwner(chatId) ? '\nИзменить порог: /threshold <сумма>' : '',
    ].join('\n')
  );
}

listenForMessages(async (chatId, text) => {
  if (!profile.isAllowed(chatId)) {
    await sendMessage(chatId, `Доступ закрыт. Твой chat_id: ${chatId} — попроси владельца бота добавить его в ALLOWED_CHAT_IDS.`);
    return;
  }

  if (wizard.isActive(chatId)) {
    if (text === '/cancel') {
      wizard.cancel(chatId);
      await sendMessage(chatId, 'Настройка прервана. Прежние сохранённые данные не изменились.');
      return;
    }
    await wizard.handleAnswer(chatId, text);
    return;
  }

  if (text === '/info' || text === '/start') return showInfo(chatId);
  if (text === '/check') return runCheck(chatId);
  if (text === '/check24') return runCheck(chatId, SEARCH_URL_DEC24, '24 декабря');
  if (text === '/setup') return wizard.start(chatId);
  if (text === '/profile') return showProfile(chatId);
  if (text === '/settings') return showSettings(chatId);
  if (text.startsWith('/threshold')) {
    if (!profile.isOwner(chatId)) {
      return sendMessage(chatId, 'Порог цены может менять только владелец бота.');
    }
    const arg = text.replace('/threshold', '').trim().replace(/[^\d]/g, '');
    const value = Number(arg);
    if (!arg || !Number.isFinite(value) || value <= 0) {
      return sendMessage(chatId, 'Формат: /threshold 120000 (сумма в рублях, только цифры).');
    }
    await profile.setPriceThreshold(value);
    return sendMessage(chatId, `Порог цены обновлён: ${value} ₽`);
  }
  if (text === '/cancel') return sendMessage(chatId, 'Сейчас нечего отменять.');
});

(async () => {
  const threshold = await profile.getPriceThreshold();
  console.log(`Бот запущен. Порог цены: ${threshold} ₽. Проверка только по команде /check.`);
  console.log('Разрешённые chat_id:', profile.allowedChatIds().join(', '));
})();
