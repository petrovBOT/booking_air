// Временная диагностика перед решением о переносе checkPrice/attemptBooking в
// дочерний процесс (см. "Ran out of memory (512MB)" — падения через раз после
// нескольких проверок подряд наводят на мысль, что RSS одного вечно живущего
// Node-процесса растёт по храповику и не возвращается к базовой линии между
// проверками, а не что течёт конкретно Chromium — он честно перезапускается
// каждую попытку). Логируем во всех ключевых точках жизненного цикла, чтобы
// закрыть вопрос фактами с первого прогона, а не гадать по повторным деплоям.
//
// Без --expose-gc heapUsed/heapTotal показывают память ДО того, как V8 успел
// собрать мусор, и создают ложное впечатление роста там, где реально просто
// GC ещё не сработал — поэтому принудительно чистим кучу перед каждым
// замером (когда флаг передан), чтобы числа отражали "живые" данные, а не
// мусор в ожидании сборки. rss при этом всё равно может не совпадать с
// heapUsed+external — это ожидаемо: rss включает память самого Node-рантайма
// и то, что аллокатор ОС ещё не вернул системе даже после gc().
//
// ВАЖНО: process.memoryUsage() видит только сам Node-процесс. Chromium
// (browser + renderer) и Xray — отдельные процессы ОС, их память сюда не
// попадает вообще, а лимит Render в 512MB — это cgroup-лимит на ВЕСЬ
// контейнер (сумма всех процессов). Поэтому каждый замер дополнительно
// читает cgroup напрямую из /sys/fs/cgroup — это и есть то самое число,
// с которым сравнивает OOM-killer, а не косвенная оценка через один Node.
const fs = require('fs');

const startedAt = Date.now();
let prev = null;
let callCount = 0;

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function fmtDelta(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function readCgroupMemory() {
  try {
    const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    const maxRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    return { version: 'v2', current, max: maxRaw === 'max' ? null : Number(maxRaw) };
  } catch {}
  try {
    const current = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim());
    const maxRaw = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
    // "Лимита нет" в cgroup v1 отображается гигантским числом (обычно 2^63-ish), а не 'max' как в v2.
    return { version: 'v1', current, max: maxRaw > Number.MAX_SAFE_INTEGER / 2 ? null : maxRaw };
  } catch {}
  return null;
}

function fmtCgroup(cg) {
  if (!cg) return ' | cgroup: недоступен (не Linux-контейнер?)';
  const currentMb = mb(cg.current);
  if (cg.max == null) return ` | cgroup(${cg.version}): ${currentMb}MB / без лимита`;
  const pct = Math.round((cg.current / cg.max) * 1000) / 10;
  return ` | cgroup(${cg.version}): ${currentMb}MB / ${mb(cg.max)}MB (${pct}%)`;
}

function logMemory(label) {
  if (global.gc) global.gc();
  callCount++;
  const m = process.memoryUsage();
  const snapshot = {
    rss: mb(m.rss),
    heapTotal: mb(m.heapTotal),
    heapUsed: mb(m.heapUsed),
    external: mb(m.external),
    arrayBuffers: mb(m.arrayBuffers),
  };
  const uptimeMin = Math.round((Date.now() - startedAt) / 6000) / 10;
  const delta = prev
    ? ` | Δrss с прошлого замера: ${fmtDelta(snapshot.rss - prev.rss)}MB, Δrss с самого первого замера: ${fmtDelta(snapshot.rss - prev.first)}MB`
    : '';
  const gcNote = global.gc ? '' : ' [gc() недоступен — запусти с --expose-gc, иначе heap/external завышены]';
  console.log(
    `[memory #${callCount}] ${label}: node.rss=${snapshot.rss}MB heapTotal=${snapshot.heapTotal}MB heapUsed=${snapshot.heapUsed}MB external=${snapshot.external}MB arrayBuffers=${snapshot.arrayBuffers}MB${fmtCgroup(readCgroupMemory())}, аптайм=${uptimeMin}мин${delta}${gcNote}`
  );
  // first — RSS самого первого замера за весь процесс, чтобы дельту к нему
  // можно было тащить дальше без отдельной переменной в каждом месте вызова.
  snapshot.first = prev ? prev.first : snapshot.rss;
  prev = snapshot;
  return snapshot;
}

// Лёгкий "пульс" контейнера — без forced gc() и без process.memoryUsage(),
// только чтение cgroup (два синхронных чтения файла). Предназначен для вызова
// прямо ВНУТРИ цикла ожидания ответа сайта (пока браузер жив и активно
// работает, 50-60с+ по логам) — именно там, по гипотезе, находится пик
// суммарной памяти контейнера (Chromium+Xray+Node вместе), а не в точках
// "до/после браузера", которые его не захватывают.
function logCgroupPulse(label) {
  console.log(`[memory:pulse] ${label}${fmtCgroup(readCgroupMemory())}`);
}

// Замер во время простоя (без проверки цены/бронирования) — единственный
// способ отличить "течёт что-то фоновое (Xray, Telegram long-polling)" от
// "течёт конкретно вокруг запуска браузера". unref(), чтобы таймер сам по
// себе не держал процесс живым.
function startHeartbeat(intervalMs = 5 * 60 * 1000) {
  setInterval(() => logMemory('heartbeat (простой, без активной проверки)'), intervalMs).unref();
}

module.exports = { logMemory, logCgroupPulse, startHeartbeat, readCgroupMemory };
