const { chromium } = require('playwright');
const { SEARCH_URL, AD_DOMAINS, TARGET, PAYMENT_METHOD_LABEL, HEADLESS } = require('./config');
const { getPassenger, getContact } = require('./profile');

const URLISH_KEY = /url|link|redirect|href|formurl|paymenturl/i;

function findLinkInJson(obj) {
  if (obj == null) return null;
  if (typeof obj === 'object') {
    for (const k in obj) {
      if (typeof obj[k] === 'string' && URLISH_KEY.test(k) && /^https?:\/\//.test(obj[k])) return obj[k];
      const nested = findLinkInJson(obj[k]);
      if (nested) return nested;
    }
  }
  return null;
}

// Сегмент "Санкт-Петербург — Пхукет" рендерится как плоский текст вида:
// "21:05\nПулково\n LED\n25 декабря, пт\n...\n22:00\nПхукет\n HKT\n26 декабря, сб".
// Берём первый блок время+город+код+дата как вылет, последний — как прилёт.
function parseSegmentText(text) {
  if (!text) return null;
  const re = /(\d{2}:\d{2})\n([^\n]+)\n\s*([A-ZА-Я]{2,4})\n(\d{1,2}\s+[^\n,]+,\s*[^\n]+)/g;
  const matches = [...text.matchAll(re)];
  if (!matches.length) return null;
  const first = matches[0];
  const last = matches[matches.length - 1];
  return {
    depTime: first[1], depCity: first[2].trim(), depCode: first[3], depDate: first[4].trim(),
    arrTime: last[1], arrCity: last[2].trim(), arrCode: last[3], arrDate: last[4].trim(),
  };
}

// Данные берём с той же самой страницы в момент скриншота — а не из конфига,
// чтобы подпись к алерту всегда совпадала с тем, что реально видно на фото.
async function extractOrderSummary(page, fallbackPassenger) {
  const data = await page.evaluate(() => {
    const val = id => document.getElementById(id)?.value || null;
    const priceEl = document.querySelector('[data-testid="total-cost"]') || document.querySelector('[data-testid="orderInfo-totalPrice"]');
    const maleBtn = document.querySelector('[data-testid^="gender-selector-male-button"]');
    const femaleBtn = document.querySelector('[data-testid^="gender-selector-female-button"]');
    const isSelected = el => !!el && (el.getAttribute('aria-pressed') === 'true' || /selected|active|checked/i.test(el.className));
    let gender = null;
    if (isSelected(maleBtn)) gender = 'Мужской';
    else if (isSelected(femaleBtn)) gender = 'Женский';
    return {
      seg0Text: document.getElementById('stuffing-segment0')?.innerText || '',
      seg1Text: document.getElementById('stuffing-segment1')?.innerText || '',
      priceText: priceEl ? priceEl.innerText.trim() : null,
      gender,
      birthDate: val('Birthday-adult-0'),
      citizenship: val('Nationality-adult-0'),
      documentType: val('DocumentType-adult-0'),
      documentNumber: val('DocumentNumber-adult-0'),
      documentExpireDate: val('DocumentExpireDate-adult-0'),
      lastName: val('LastName-adult-0'),
      firstName: val('FirstName-adult-0'),
      middleName: val('MiddleName-adult-0'),
      email: val('booking-form-user-email-input'),
      phoneCode: val('booking-form-user-phone-code'),
      phoneNumber: val('booking-form-user-phone-number-input'),
    };
  });

  return {
    outbound: parseSegmentText(data.seg0Text),
    inbound: parseSegmentText(data.seg1Text),
    price: data.priceText ? data.priceText.replace(/^Итого к оплате\s*/i, '').replace(/\s+/g, ' ').trim() : null,
    passenger: {
      gender: data.gender || (fallbackPassenger.gender === 'F' ? 'Женский' : 'Мужской'),
      birthDate: data.birthDate,
      citizenship: data.citizenship,
      documentType: data.documentType,
      documentNumber: data.documentNumber,
      documentExpireDate: data.documentExpireDate,
      lastName: data.lastName,
      firstName: data.firstName,
      middleName: data.middleName,
    },
    contact: {
      email: data.email,
      phone: `${data.phoneCode || ''} ${data.phoneNumber || ''}`.trim(),
    },
  };
}

function formatLeg(leg) {
  if (!leg) return 'не удалось прочитать со страницы';
  return `${leg.depDate}, ${leg.depTime} ${leg.depCity} (${leg.depCode}) → ${leg.arrDate}, ${leg.arrTime} ${leg.arrCity} (${leg.arrCode})`;
}

function formatOrderCaption(summary, extraLines = []) {
  const p = summary.passenger;
  const fio = [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ');
  const lines = [
    `Туда: ${formatLeg(summary.outbound)}`,
    `Обратно: ${formatLeg(summary.inbound)}`,
    '',
    `Пассажир: ${fio}`,
    `Пол: ${p.gender || '—'}`,
    `Дата рождения: ${p.birthDate || '—'}`,
    `Гражданство: ${p.citizenship || '—'}`,
    `Документ: ${p.documentType || '—'}, ${p.documentNumber || '—'}${p.documentExpireDate ? `, действителен до ${p.documentExpireDate}` : ''}`,
    `Контакты: ${summary.contact.email || '—'}, ${summary.contact.phone || '—'}`,
    '',
    `ИТОГ: ${summary.price || '—'}`,
    ...extraLines,
  ];
  return lines.join('\n');
}

// Кастомные поля (дата, автокомплит) слушают реальные keydown-события, .fill() их не всегда триггерит.
// force:true — плавающий лейбл/липкая шапка иногда перекрывают инпут при скролле в него.
async function typeSlow(page, selector, text) {
  const loc = page.locator(selector);
  await loc.scrollIntoViewIfNeeded();
  await loc.click({ force: true });
  await loc.pressSequentially(text, { delay: 60 });
}

// ArrowDown+Enter вслепую иногда попадает не в тот вариант списка (наблюдали Узбекистан
// вместо России) — список не использует ARIA role="option", это обычные div/li без разметки.
// Ищем самый маленький видимый элемент, чей текст начинается с нужного, и расположенный
// прямо под полем ввода (а не одноимённый текст в другом месте страницы, напр. "Россия" в поле "Откуда").
async function typeAndPickOption(page, selector, text, expectedSubstring, verifySubstring = expectedSubstring) {
  await typeSlow(page, selector, text);
  await page.waitForTimeout(1000);

  const marked = await page.evaluate(({ needle, sel }) => {
    const anchor = document.querySelector(sel);
    if (!anchor) return false;
    const rect = anchor.getBoundingClientRect();
    const all = Array.from(document.querySelectorAll('body *'));
    const candidates = all.filter(el => {
      if (el.children.length > 2) return false;
      const t = el.textContent.trim();
      if (!t || !t.toLowerCase().startsWith(needle.toLowerCase())) return false;
      const r = el.getBoundingClientRect();
      if (r.height === 0) return false;
      return r.top >= rect.top - 5 && r.top <= rect.bottom + 500 && Math.abs(r.left - rect.left) < 500;
    });
    if (!candidates.length) return false;
    candidates.sort((a, b) => a.textContent.length - b.textContent.length);
    candidates[0].setAttribute('data-pw-pick', '1');
    return true;
  }, { needle: expectedSubstring, sel: selector });

  if (!marked) {
    if (process.env.DEBUG_SHOT) {
      await page.screenshot({ path: process.env.DEBUG_SHOT.replace('.png', `-${selector.replace('#', '')}.png`), fullPage: true }).catch(() => {});
    }
    throw new Error(`в списке "${selector}" не нашлось варианта, начинающегося с "${expectedSubstring}"`);
  }

  await page.locator('[data-pw-pick="1"]').click({ force: true });
  await page.evaluate(() => document.querySelector('[data-pw-pick="1"]')?.removeAttribute('data-pw-pick'));
  await page.waitForTimeout(300);

  const value = await page.locator(selector).inputValue().catch(() => '');
  if (!value.toLowerCase().includes(verifySubstring.toLowerCase())) {
    throw new Error(`поле "${selector}": ожидали "${verifySubstring}", получили "${value}"`);
  }
}

async function forceFill(loc, value) {
  await loc.scrollIntoViewIfNeeded();
  await loc.fill(value, { force: true });
}

async function forceClick(loc) {
  await loc.scrollIntoViewIfNeeded();
  await loc.click({ force: true });
}

// Обязательные чекбоксы — сверяем, что реально встали, иначе форма может уйти
// в оплату без принятых условий (наблюдали именно это).
async function forceCheckVerified(page, selector, label) {
  const loc = page.locator(selector);
  const forAttr = selector.replace('#', '');
  const lbl = page.locator(`label[for="${forAttr}"]`);

  let checked = false;
  for (let attempt = 0; attempt < 5 && !checked; attempt++) {
    const target = attempt % 2 === 0 ? loc : (await lbl.count()) ? lbl : loc;
    await target.scrollIntoViewIfNeeded();
    await target.click({ force: true });
    await page.waitForTimeout(500 + attempt * 300);
    checked = await loc.isChecked().catch(() => false);
  }
  if (!checked) {
    throw new Error(`чекбокс "${label}" (${selector}) не отметился после нескольких попыток`);
  }
}

const PAYMENT_TESTIDS = {
  'СБП': 'qr-payment-logo-select-button',
  'SberPay': 'sberpay-payment-logo-select-button',
  'AlfaPay': 'alfapay-payment-logo-select-button',
  'T-Pay': 'tpay-payment-logo-select-button',
  'Оплата картой': 'bankCard-payment-logo-select-button',
  'Бронирование': 'booking-payment-logo-select-button',
};

async function step(name, fn) {
  try {
    await fn();
    return { name, ok: true };
  } catch (e) {
    throw new Error(`шаг "${name}" упал: ${e.message}`);
  }
}

async function attemptBooking(chatId, onProgress = () => {}) {
  // Свежее чтение на каждый запуск — так изменения через /setup в Telegram
  // подхватываются без перезапуска процесса. chatId — чей именно профиль бронируем.
  const PASSENGER = getPassenger(chatId);
  const CONTACT = getContact(chatId);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      viewport: { width: 1400, height: 1400 },
    });

    // Блокируем только рекламные домены — картинки/стили нужны, форма интерактивная.
    // new URL(req.url()) на каждый запрос давал 10-кратное замедление навигации — просто строка.
    await context.route('**/*', (route, req) => {
      if (AD_DOMAINS.test(req.url())) return route.abort();
      return route.continue();
    });

    let paymentLink = null;
    const page = await context.newPage();

    page.on('response', async resp => {
      if (paymentLink) return;
      const status = resp.status();
      const url = resp.url();
      if ([301, 302, 303, 307, 308].includes(status) && /payment/i.test(url)) {
        const loc = resp.headers()['location'];
        if (loc) paymentLink = loc;
        return;
      }
      if (/\/(api|next\/api)\//.test(url) && /payment/i.test(url)) {
        try {
          const buf = await resp.body();
          const json = JSON.parse(buf.toString('utf8'));
          const link = findLinkInJson(json);
          if (link) paymentLink = link;
        } catch {}
      }
    });

    onProgress('navigate');
    await step('переход на страницу поиска', async () => {
      await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(30000);
    });

    onProgress('select-flight');
    await step('выбор рейса из выдачи', async () => {
      // "1 пересадка" резко сокращает список и почти всегда поднимает нужную
      // авиакомпанию наверх — но всё равно не полагаемся на "первую карточку",
      // а явно ищем ту, где совпадает время вылета/прилёта нужного направления.
      const oneStopFilter = page.getByText('1 пересадка', { exact: true });
      if (await oneStopFilter.count()) {
        await oneStopFilter.first().click();
        await page.waitForTimeout(4000);
      }

      // Карточка результата может по умолчанию показывать другой стыковочный рейс —
      // переключаем на нужное время ДО открытия тарифов кнопками select-time-button.
      // Сверяем и вылет, и прилёт: бывают варианты с одинаковым вылетом, но разным прилётом.
      async function timeMatches(cardIndex, segmentIndex, expectedDepTime, expectedArrTime) {
        for (let i = 0; i < 5; i++) {
          const btn = page.locator(`#search-recommendation${cardIndex}-segment${segmentIndex}-select-time-button-${i}`);
          if ((await btn.count()) === 0) break;
          const text = await btn.innerText().catch(() => '');
          if (text.includes(expectedDepTime) && text.includes(expectedArrTime)) return true;
        }
        return false;
      }

      async function selectTimeVariant(cardIndex, segmentIndex, expectedDepTime, expectedArrTime) {
        if (!expectedDepTime || !expectedArrTime) return;
        for (let i = 0; i < 5; i++) {
          const btn = page.locator(`#search-recommendation${cardIndex}-segment${segmentIndex}-select-time-button-${i}`);
          if ((await btn.count()) === 0) break;
          const text = await btn.innerText().catch(() => '');
          if (text.includes(expectedDepTime) && text.includes(expectedArrTime)) {
            await btn.click();
            await page.waitForTimeout(1000);
            return;
          }
        }
      }

      // Ищем карточку, где совпадает время рейса ТУДА (обратный подбирается уже
      // внутри выбранной карточки — там точно такой же перевозчик на обоих плечах).
      let cardIndex = null;
      for (let n = 0; n < 30; n++) {
        const priceEl = page.getByTestId(`search-recommendation${n}-price`);
        if ((await priceEl.count()) === 0) break;
        if (await timeMatches(n, 0, TARGET.outbound[0].depTime, TARGET.outbound[0].arrTime)) {
          cardIndex = n;
          break;
        }
      }
      if (cardIndex === null) {
        if (process.env.DEBUG_SHOT) await page.screenshot({ path: process.env.DEBUG_SHOT, fullPage: true }).catch(() => {});
        throw new Error('не нашлась карточка с нужным временем вылета/прилёта туда среди выдачи');
      }

      await selectTimeVariant(cardIndex, 0, TARGET.outbound[0].depTime, TARGET.outbound[0].arrTime);
      await selectTimeVariant(cardIndex, 1, TARGET.inbound[0].depTime, TARGET.inbound[0].arrTime);

      await forceClick(page.getByTestId(`search-recommendation${cardIndex}-select-tariff-button`));
      await page.waitForTimeout(8000);
      await page.waitForSelector('#stuffing-segment0', { timeout: 20000 });

      // Первый показанный вариант стыковочного рейса на сегменте может не совпасть
      // с целевым — сайт даёт пролистать альтернативы стрелкой tariff-scroll-next-button-N.
      // Для strict:false рейсов (стыковка через Шанхай) сверяем только маршрут —
      // номер там гуляет между источниками (MU-8647/FM-857 и т.п.).
      function legTextMatches(text, leg) {
        if (leg.strict === false) return text.includes(leg.depCode) && text.includes(leg.arrCode);
        return text.includes(`${leg.company}-${leg.num}`);
      }

      async function ensureSegmentMatches(segmentIndex, legs) {
        const segment = page.locator(`#stuffing-segment${segmentIndex}`);
        for (let attempt = 0; attempt < 12; attempt++) {
          const text = await segment.innerText().catch(() => '');
          if (process.env.DEBUG) {
            const flightNumMatch = text.match(/Рейс\s*\n?\s*([A-Z]{2}-\d+)/);
            console.log(`  [сегмент ${segmentIndex}] попытка ${attempt}: рейс=${flightNumMatch ? flightNumMatch[1] : '?'}`);
          }
          if (legs.every(leg => legTextMatches(text, leg))) return true;
          const nextBtn = page.locator(`#tariff-scroll-next-button-${segmentIndex}`);
          const btnCount = await nextBtn.count();
          const btnEnabled = btnCount ? await nextBtn.isEnabled().catch(() => false) : false;
          if (process.env.DEBUG) console.log(`  [сегмент ${segmentIndex}] кнопка next: count=${btnCount} enabled=${btnEnabled}`);
          if (btnCount === 0 || !btnEnabled) return false;
          await nextBtn.click();
          await page.waitForTimeout(1200);
        }
        return false;
      }

      const outboundOk = await ensureSegmentMatches(0, TARGET.outbound);
      const inboundOk = await ensureSegmentMatches(1, TARGET.inbound);

      if (!outboundOk || !inboundOk) {
        if (process.env.DEBUG_SHOT) await page.screenshot({ path: process.env.DEBUG_SHOT, fullPage: true }).catch(() => {});
        if (process.env.DEBUG_TEXT) {
          const bodyText = await page.evaluate(() => document.body.innerText);
          require('fs').writeFileSync(process.env.DEBUG_TEXT, bodyText);
        }
        const bad = [!outboundOk && 'туда', !inboundOk && 'обратно'].filter(Boolean).join(' и ');
        throw new Error(`не удалось подобрать целевой рейс среди вариантов сегмента (${bad}) — возможно рейса нет в этой выдаче`);
      }

      // Не полагаемся на дефолтный выбор сайта — явно берём самый дешёвый тариф
      // среди карточек этого сегмента (иначе иногда остаётся выбранным не тот).
      async function selectCheapestTariff(segmentIndex) {
        const marked = await page.evaluate(segIdx => {
          const container = document.getElementById(`stuffing-segment${segIdx}`);
          if (!container) return false;
          const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
          let best = null;
          for (const radio of radios) {
            const label = radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : radio.closest('label');
            const text = label ? label.textContent : '';
            const m = text.match(/([\d\s]{3,})\s*₽/);
            if (!m) continue;
            const price = parseInt(m[1].replace(/\s/g, ''), 10);
            if (!best || price < best.price) best = { price, radio };
          }
          if (!best) return false;
          best.radio.setAttribute('data-pw-pick-cheapest', '1');
          return true;
        }, segmentIndex);

        if (!marked) return;
        await page.locator('[data-pw-pick-cheapest="1"]').click({ force: true });
        await page.evaluate(() => document.querySelector('[data-pw-pick-cheapest="1"]')?.removeAttribute('data-pw-pick-cheapest'));
        await page.waitForTimeout(800);
      }

      await selectCheapestTariff(0);
      await selectCheapestTariff(1);
    });

    onProgress('wait-passenger-form');
    await step('ожидание формы пассажира', async () => {
      await page.waitForSelector('#LastName-adult-0', { timeout: 40000 });
    });

    onProgress('fill-passenger');
    await step('заполнение данных пассажира', async () => {
      const genderTestId = PASSENGER.gender === 'F'
        ? 'gender-selector-female-button-Gender-adult-0'
        : 'gender-selector-male-button-Gender-adult-0';
      await forceClick(page.getByTestId(genderTestId));
      await typeSlow(page, '#Birthday-adult-0', PASSENGER.birthDate);
      await typeAndPickOption(page, '#Nationality-adult-0', PASSENGER.citizenship, PASSENGER.citizenship);
      await typeAndPickOption(page, '#DocumentType-adult-0', PASSENGER.documentType, PASSENGER.documentType);
      await typeSlow(page, '#DocumentNumber-adult-0', PASSENGER.documentNumber);
      if (PASSENGER.documentExpireDate) {
        await typeSlow(page, '#DocumentExpireDate-adult-0', PASSENGER.documentExpireDate);
      } else {
        await forceClick(page.locator('#DocumentNoExpireDate-adult-0'));
      }
      await forceFill(page.locator('#LastName-adult-0'), PASSENGER.lastName);
      await forceFill(page.locator('#FirstName-adult-0'), PASSENGER.firstName);
      if (PASSENGER.middleName) {
        await forceFill(page.locator('#MiddleName-adult-0'), PASSENGER.middleName);
      }
    });

    onProgress('fill-contact');
    await step('заполнение контактов', async () => {
      await forceFill(page.locator('#booking-form-user-email-input'), CONTACT.email);
      await typeAndPickOption(page, '#booking-form-user-phone-code', CONTACT.phoneCountry, 'Росс', '+7');
      await forceFill(page.locator('#booking-form-user-phone-number-input'), CONTACT.phoneNumber);
    });

    onProgress('consents');
    await step('согласия и способ оплаты', async () => {
      // Способ оплаты — первым: его выбор перерисовывает блок и сбрасывает чекбоксы,
      // если отмечать их до этого клика (так и терялись отметки на предыдущих прогонах).
      const payTestId = PAYMENT_TESTIDS[PAYMENT_METHOD_LABEL];
      if (payTestId) {
        await forceClick(page.getByTestId(payTestId));
      } else {
        await page.getByText(PAYMENT_METHOD_LABEL, { exact: false }).first().click({ force: true });
      }
      await page.waitForTimeout(2000);
      await forceCheckVerified(page, '#accept-tariffs-conditions-input', 'согласие с тарифами');
      await forceCheckVerified(page, '#accept-processing-of-personal-data-input', 'согласие на обработку данных');
    });

    // Скриншот и сводку по заказу снимаем ДО клика на оплату — после него страница может
    // уйти на домен платёжного шлюза, и order summary с ценой/датами будет уже не прочитать.
    const screenshot = await page.screenshot({ fullPage: true });
    const summary = await extractOrderSummary(page, PASSENGER);
    if (process.env.SCREENSHOT_PATH) {
      require('fs').writeFileSync(process.env.SCREENSHOT_PATH, screenshot);
      console.log('Скриншот сохранён:', process.env.SCREENSHOT_PATH);
    }

    if (process.env.DRY_RUN === 'true' || process.env.DRY_RUN_AUTO === 'true') {
      onProgress('dry-run-stop');
      console.log('DRY_RUN: форма заполнена, "ПЕРЕЙТИ К ОПЛАТЕ" не нажимаю.');
      console.log(formatOrderCaption(summary));
      if (process.env.DRY_RUN === 'true') {
        console.log('Браузер открыт — закрой окно вручную, когда посмотришь.');
        while (context.pages().length > 0) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      return { success: true, dryRun: true, screenshot, summary };
    }

    onProgress('submit');
    await step('переход к оплате', async () => {
      await forceClick(page.getByTestId('pay-button-PAY(live)'));
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline && !paymentLink) {
        await page.waitForTimeout(500);
      }
      if (!paymentLink) {
        throw new Error('ссылка на оплату не появилась за 25с после отправки формы');
      }
    });

    return { success: true, paymentLink, screenshot, summary };
  } finally {
    if (process.env.DRY_RUN !== 'true') {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { attemptBooking, formatOrderCaption };
