// Открывает видимое окно браузера, заполняет форму бронирования полностью,
// но НЕ нажимает "Оплатить" и не закрывает окно — для визуальной проверки перед деплоем.
// Использование: npm run dry-run [chatId]  (по умолчанию — владелец бота)

const path = require('path');
const { loadEnvFile } = require('../src/load-env');

loadEnvFile();
process.env.HEADLESS = 'false';
process.env.DRY_RUN = 'true';

const screenshotPath = path.join(__dirname, 'dry-run-result.png');
process.env.SCREENSHOT_PATH = screenshotPath;
process.env.DEBUG_SHOT = screenshotPath;

const { TELEGRAM_CHAT_ID } = require('../src/config');
const { attemptBooking, formatOrderCaption } = require('../src/booker');

const chatId = process.argv[2] || TELEGRAM_CHAT_ID;

(async () => {
  console.log(`Заполняю форму для chat_id=${chatId}. Окно останется открытым — закрой вручную, когда посмотришь.`);
  try {
    const result = await attemptBooking(chatId, stage => console.log('>>> этап:', stage));
    console.log('Скриншот сохранён:', screenshotPath);
    if (result.summary) console.log(formatOrderCaption(result.summary));
  } catch (e) {
    console.error('НЕ УДАЛОСЬ:', e.message);
    console.log('Скриншот момента ошибки (если сохранился):', screenshotPath);
    process.exitCode = 1;
  }
})();
