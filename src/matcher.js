function legMatches(flight, target) {
  if (!flight) return false;
  const routeOk =
    String(flight.depCode).toUpperCase() === target.depCode.toUpperCase() &&
    String(flight.arrCode).toUpperCase() === target.arrCode.toUpperCase();
  if (!routeOk) return false;
  // Стыковочный рейс через Шанхай у разных источников называется по-разному
  // (MU-8647/FM-857, MU-8648/MU-8618) — для него сверяем только маршрут.
  if (target.strict === false) return true;
  return (
    String(flight.company).toUpperCase() === target.company.toUpperCase() &&
    String(flight.num) === String(target.num)
  );
}

function segmentMatchesLegs(segment, targetLegs) {
  const flights = segment.flights || [];
  if (flights.length !== targetLegs.length) return false;
  return targetLegs.every((leg, i) => legMatches(flights[i], leg));
}

function findMatchingSegmentKeys(segments, targetLegs) {
  return Object.entries(segments)
    .filter(([, seg]) => segmentMatchesLegs(seg, targetLegs))
    .map(([key]) => key);
}

// task — один элемент tasks.avia[id] с сайта (status "ok", содержит result[]).
// Возвращает список найденных предложений { total, currency, searchGroup } для целевого маршрута.
function findOffers(task, target) {
  const offers = [];
  for (const r of task.result || []) {
    if (!r.segments || Array.isArray(r.segments)) continue; // segments:[] значит пусто у этого поставщика

    const outboundKeys = new Set(findMatchingSegmentKeys(r.segments, target.outbound));
    const inboundKeys = new Set(findMatchingSegmentKeys(r.segments, target.inbound));
    if (outboundKeys.size === 0 || inboundKeys.size === 0) continue;

    for (const rec of r.recommendations || []) {
      if (typeof rec.total !== 'number') continue;

      const usedKeys = new Set();
      for (const fragName in rec.fragments || {}) {
        for (const group of rec.fragments[fragName].segments || []) {
          for (const obj of group) {
            Object.keys(obj).forEach(k => usedKeys.add(k));
          }
        }
      }

      const hasOutbound = [...outboundKeys].some(k => usedKeys.has(k));
      const hasInbound = [...inboundKeys].some(k => usedKeys.has(k));
      if (hasOutbound && hasInbound) {
        offers.push({ total: rec.total, currency: rec.currency || 'RUB', searchGroup: task.search_group });
      }
    }
  }
  return offers;
}

module.exports = { findOffers, legMatches, segmentMatchesLegs };
