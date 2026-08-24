// Диагностика памяти на Render free (512MB на весь контейнер: Node + Xray +
// 4 процесса Chromium).
//
// Без --expose-gc heapUsed/heapTotal показывают память ДО того, как V8 успел
// собрать мусор, и создают ложное впечатление роста там, где реально просто
// GC ещё не сработал — поэтому принудительно чистим кучу перед каждым
// замером (когда флаг передан), чтобы числа отражали "живые" данные, а не
// мусор в ожидании сборки.
//
// process.memoryUsage() видит только сам Node-процесс. Chromium (browser,
// gpu-process, network service, renderer — по логам /proc их четыре) и Xray
// живут отдельными процессами ОС, их память сюда не попадает вообще, а лимит
// Render — cgroup-лимит на ВЕСЬ контейнер. Поэтому дополнительно читаем cgroup.
//
// КЛЮЧЕВОЕ: memory.current — НЕ показатель риска OOM. Он включает page cache
// (mmap'нутый бинарник Chromium ~200MB, файлы профиля в /tmp и т.п.), который
// ядро под давлением просто вытесняет. Контейнер с hard-лимитом штатно
// заполняет его кэшем под самый потолок и живёт дальше. Наблюдали ровно это:
// memory.current=100% при НУЛЕ обработанных ответов и 0.0MB распарсенного
// JSON — занимать столько анонимной памяти там было просто нечем.
// К OOM-kill приводит невытесняемая память: anon (кучи процессов), shmem
// (tmpfs — без свопа не вытесняется), неперемещаемый slab, стеки ядра, сокеты.
// Её и считаем отдельно — это единственное честное основание для решений.
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

function parseKeyValue(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined) out[key] = Number(value);
  }
  return out;
}

function sumDefined(...values) {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
}

function readCgroupMemory() {
  try {
    const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    const maxRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const stat = parseKeyValue(fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8'));
    const events = parseKeyValue(fs.readFileSync('/sys/fs/cgroup/memory.events', 'utf8'));
    return {
      version: 'v2',
      current,
      max: maxRaw === 'max' ? null : Number(maxRaw),
      // Всё, что ядро НЕ может просто отбросить, освобождая место.
      unreclaimable: sumDefined(stat.anon, stat.shmem, stat.slab_unreclaimable, stat.kernel_stack, stat.sock),
      anon: stat.anon,
      // Вытесняемый файловый кэш — тот самый, что и раздувал memory.current.
      file: stat.file,
      // Ground truth от самого ядра, а не наши догадки по процентам:
      // max растёт каждый раз, когда аллокация упёрлась в лимит и ядру
      // пришлось принудительно освобождать; oom_kill — сколько процессов
      // ядро реально убило за жизнь контейнера.
      pressureEvents: events.max,
      oomKills: events.oom_kill,
    };
  } catch {}
  try {
    const stat = parseKeyValue(fs.readFileSync('/sys/fs/cgroup/memory/memory.stat', 'utf8'));
    const current = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim());
    const maxRaw = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
    return {
      version: 'v1',
      current,
      // "Лимита нет" в cgroup v1 отображается гигантским числом, а не 'max' как в v2.
      max: maxRaw > Number.MAX_SAFE_INTEGER / 2 ? null : maxRaw,
      unreclaimable: sumDefined(stat.total_rss, stat.total_shmem),
      anon: stat.total_rss,
      file: stat.total_cache,
      pressureEvents: Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.failcnt', 'utf8').trim()),
      oomKills: null,
    };
  } catch {}
  return null;
}

function fmtCgroup(cg) {
  if (!cg) return ' | cgroup: недоступен (не Linux-контейнер?)';
  const pct = value => (cg.max ? ` (${((value / cg.max) * 100).toFixed(1)}%)` : '');
  const parts = [
    // Первым — то, по чему реально принимаются решения.
    `невытесняемая ${mb(cg.unreclaimable)}MB${pct(cg.unreclaimable)}`,
    `кэш ${mb(cg.file)}MB (ядро вытеснит)`,
    `всего ${mb(cg.current)}MB${cg.max ? `/${mb(cg.max)}MB${pct(cg.current)}` : ''}`,
    `упирались в лимит: ${cg.pressureEvents}`,
  ];
  if (cg.oomKills != null) parts.push(`oom-kill: ${cg.oomKills}`);
  return ` | cgroup(${cg.version}): ${parts.join(', ')}`;
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
// только чтение cgroup. Предназначен для вызова прямо ВНУТРИ цикла ожидания
// ответа сайта (пока браузер жив и активно работает, 50-60с+ по логам).
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
