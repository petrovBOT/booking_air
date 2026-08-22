// Локальный запуск читает .env сам (на Koyeb .env нет — переменные уже заданы платформой).
// Должно быть выполнено до require('./config'), иначе он прочитает пустой process.env.
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
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

const { CHECK_INTERVAL_MINUTES, TARGET } = require('./config');
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

// Бронирует по очереди на каждого, у кого готов профиль и кто ещё не бронировал.
// Каждому — своя попытка и свой алерт, в его личный чат.
async function bookForAllUsers(price, currency) {
  for (const chatId of profile.allowedChatIds()) {
    if (!profile.isProfileComplete(chatId)) {
      console.log(`[booking] у ${chatId} не заполнен профиль — пропускаю`);
      continue;
    }
    if (profile.isBooked(chatId)) {
      console.log(`[booking] у ${chatId} уже есть бронь — пропускаю`);
      continue;
    }

    await sendMessage(chatId, `Цена подходит: ${price} ${currency}. Пробую оформить бронь...`);
    try {
      const booking = await attemptBooking(chatId, stage => console.log(`[booking:${chatId}] этап: ${stage}`));
      profile.markBooked(chatId, { at: new Date().toISOString(), price });
      const caption = formatOrderCaption(booking.summary, [
        '',
        `Ссылка на оплату: ${booking.paymentLink}`,
        'Оплати вручную в течение отведённого времени.',
      ]);
      await sendPhoto(chatId, booking.screenshot, caption);
    } catch (e) {
      console.error(`[booking:${chatId}] не удалось:`, e);
      await sendMessage(chatId, `Цена была подходящей (${price} ₽), но бронирование не завершилось: ${e.message}\nПроверь вручную, пока цена не ушла.`);
    }
  }
}

async function runCheck(source, requesterChatId) {
  if (checking) {
    console.log(`[${source}] проверка уже идёт, пропускаю`);
    if (requesterChatId) await sendMessage(requesterChatId, 'Проверка уже идёт, подожди немного.');
    return;
  }
  checking = true;
  const startedAt = Date.now();
  try {
    const threshold = profile.getPriceThreshold();
    console.log(`[${source}] запускаю проверку цены...`);
    const result = await checkPrice();
    const ms = Date.now() - startedAt;

    if (!result.found) {
      console.log(`[${source}] целевой рейс/тариф не найден в выдаче (${ms}мс)`);
      if (requesterChatId) await sendMessage(requesterChatId, 'Целевой рейс не найден в текущей выдаче. Возможно, сайт изменился или рейса нет в продаже.');
      return;
    }

    console.log(`[${source}] цена: ${result.price} ${result.currency}, вариантов найдено: ${result.offersCount} (${ms}мс)`);

    if (result.price > threshold) {
      if (requesterChatId) await sendMessage(requesterChatId, `Текущая цена: ${result.price} ${result.currency} (порог ${threshold} ₽, ещё не достигнут)`);
      return;
    }

    if (requesterChatId && source === 'manual') {
      // Ручная проверка одного человека не должна тайно бронировать на всех —
      // просто сообщаем, что цена уже подходящая, автопроверка сама разберётся с бронью.
      await sendMessage(requesterChatId, `Цена уже подходящая: ${result.price} ${result.currency}. Бронирование запускается по расписанию автопроверки.`);
      return;
    }

    console.log(`[${source}] цена ${result.price} ₽ ≤ порога — бронирую на всех, у кого готов профиль...`);
    await bookForAllUsers(result.price, result.currency);
  } catch (e) {
    console.error(`[${source}] ошибка проверки:`, e);
    if (requesterChatId) await sendMessage(requesterChatId, `Ошибка при проверке цены: ${e.message}`);
  } finally {
    checking = false;
  }
}

async function showProfile(chatId) {
  const p = profile.getPassenger(chatId);
  const c = profile.getContact(chatId);
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
      `Бронь: ${profile.isBooked(chatId) ? 'уже оформлена' : 'ещё нет'}`,
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
      '/check — разовая проверка цены прямо сейчас',
      '/settings — рейс, порог цены, интервал автопроверки',
      '/profile — посмотреть свои сохранённые данные пассажира и контакты',
      '/setup — пошагово задать/изменить свои данные пассажира и контакты',
      '/cancel — прервать текущий /setup',
      '/info — это сообщение' + admin,
      '',
      'Автопроверка идёт сама по расписанию. При подходящей цене бот пробует',
      'оформить бронь на каждого, у кого заполнен профиль, и присылает лично',
      'скриншот заявки со ссылкой на оплату — платить нужно вручную.',
    ].join('\n')
  );
}

function formatTargetLeg(legs) {
  return legs.map(l => `${l.company}-${l.num} ${l.depCode}→${l.arrCode}${l.depTime ? ` (${l.depTime})` : ''}`).join(', ');
}

async function showSettings(chatId) {
  await sendMessage(
    chatId,
    [
      `Рейс туда: ${formatTargetLeg(TARGET.outbound)}`,
      `Рейс обратно: ${formatTargetLeg(TARGET.inbound)}`,
      '(маршрут зафиксирован в коде, меняется только через config.js)',
      '',
      `Порог цены: ${profile.getPriceThreshold()} ₽`,
      `Интервал автопроверки: ${CHECK_INTERVAL_MINUTES} мин`,
      profile.isOwner(chatId) ? '\nИзменить порог: /threshold <сумма>' : '',
    ].join('\n')
  );
}

setInterval(() => runCheck('cron'), CHECK_INTERVAL_MINUTES * 60 * 1000);

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
  if (text === '/check') return runCheck('manual', chatId);
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
    profile.setPriceThreshold(value);
    return sendMessage(chatId, `Порог цены обновлён: ${value} ₽`);
  }
  if (text === '/cancel') return sendMessage(chatId, 'Сейчас нечего отменять.');
});

console.log(`Бот запущен. Интервал проверки: ${CHECK_INTERVAL_MINUTES} мин. Порог цены: ${profile.getPriceThreshold()} ₽`);
console.log('Разрешённые chat_id:', profile.allowedChatIds().join(', '));
runCheck('startup');
