const { TELEGRAM_BOT_TOKEN } = require('./config');

const api = path => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${path}`;

async function sendMessage(chatId, text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.log('[telegram отключен]', chatId, text);
    return;
  }
  try {
    await fetch(api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
  } catch (e) {
    console.error('Не удалось отправить в Telegram:', e.message);
  }
}

// Клавиатура с кнопками-вариантами — чтобы в /setup нельзя было опечататься
// в поле с фиксированным набором значений (пол, тип документа).
function choiceKeyboard(choices) {
  return { keyboard: choices.map(c => [c]), one_time_keyboard: true, resize_keyboard: true };
}

const removeKeyboard = { remove_keyboard: true };

async function sendPhoto(chatId, buffer, caption) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.log('[telegram отключен] фото:', chatId, caption);
    return;
  }
  if (!buffer) {
    await sendMessage(chatId, caption);
    return;
  }
  try {
    // Определяем формат по сигнатуре, а не по фиксированному image/png: скриншот
    // заказа теперь снимается в JPEG (booker.js), а отладочные — бывают PNG.
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append(
      'photo',
      new Blob([buffer], { type: isJpeg ? 'image/jpeg' : 'image/png' }),
      isJpeg ? 'screenshot.jpg' : 'screenshot.png'
    );
    await fetch(api('sendPhoto'), { method: 'POST', body: form });
  } catch (e) {
    console.error('Не удалось отправить фото в Telegram:', e.message);
    await sendMessage(chatId, caption);
  }
}

// Long polling — без публичного URL и вебхука, подходит для Koyeb Worker без порта.
// Авторизация (кому отвечать) — забота вызывающего кода, тут просто раздаём все сообщения.
async function listenForMessages(onMessage) {
  if (!TELEGRAM_BOT_TOKEN) return;
  let offset = 0;
  for (;;) {
    try {
      const resp = await fetch(api(`getUpdates?timeout=30&offset=${offset}`));
      const data = await resp.json();
      for (const update of data.result || []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        onMessage(String(msg.chat.id), msg.text.trim());
      }
    } catch (e) {
      console.error('Ошибка long polling Telegram:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

module.exports = { sendMessage, sendPhoto, listenForMessages, choiceKeyboard, removeKeyboard };
