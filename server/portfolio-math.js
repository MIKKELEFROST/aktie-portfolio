// Rene beregninger for porteføljen. Ingen I/O – let at teste.
//
// Regler:
// - `avgPrice` (gennemsnitlig købskurs) er i aktiens egen handelsvaluta.
// - Værdi og kostpris omregnes til basisvalutaen med DAGENS valutakurs.
//   Afkastet er dermed aktiens kursafkast; valutaeffekt siden købet indgår ikke.
// - Positioner uden kurs (fejl hos Yahoo) tæller ikke med i totalerne, men
//   markeres, og totalerne får `incomplete: true`.

// Dansk tal-input: "1.234,56" → 1234.56, "612,5" → 612.5, "0.4321" → 0.4321, "1.234" → 1234, "1234.56" → 1234.56.
// Returnerer null for tom streng og NaN for ugyldigt input. Tal gives uændret tilbage.
export function parseDanishNumber(value) {
  if (typeof value === 'number') return value;
  const s = String(value ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  let norm = s;
  if (s.includes(',')) norm = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) norm = s.replace(/\./g, '');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(norm)) return NaN;
  return Number(norm);
}

export function round(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function computePosition(holding, quoteResult, fxResult) {
  const quantity = Number(holding.quantity) || 0;
  const avgPrice = holding.avgPrice == null ? null : Number(holding.avgPrice);
  const base = {
    id: holding.id,
    symbol: holding.symbol,
    quantity,
    avgPrice,
    note: holding.note || '',
    addedAt: holding.addedAt || null,
    updatedAt: holding.updatedAt || null,
  };

  if (!quoteResult || !quoteResult.ok || !quoteResult.quote) {
    return {
      ...base,
      status: 'error',
      error: quoteResult?.error || { code: 'NO_QUOTE', message: 'Ingen kurs' },
      name: holding.name || holding.symbol,
      currency: holding.currency || null,
      price: null,
      value: null,
      valueBase: null,
      cost: null,
      costBase: null,
      gain: null,
      gainBase: null,
      gainPercent: null,
      dayChange: null,
      dayChangeBase: null,
      dayChangePercent: null,
      weight: null,
      fxRate: null,
    };
  }

  const q = quoteResult.quote;
  const fxOk = fxResult && fxResult.ok && Number.isFinite(fxResult.rate);
  const fx = fxOk ? fxResult.rate : null;
  const price = q.price;
  const value = price != null ? quantity * price : null;
  const cost = avgPrice != null ? quantity * avgPrice : null;
  const gain = value != null && cost != null ? value - cost : null;
  const gainPercent = gain != null && cost ? (gain / cost) * 100 : null;
  const dayChange = q.change != null ? quantity * q.change : null;
  const toBase = (n) => (n != null && fx != null ? n * fx : null);

  let status = 'ok';
  if (quoteResult.stale || fxResult?.stale) status = 'stale';
  if (!fxOk) status = 'fx_error';

  return {
    ...base,
    status,
    error: fxOk ? quoteResult.error || null : fxResult?.error || { code: 'NO_FX', message: 'Ingen valutakurs' },
    name: q.name,
    shortName: q.shortName,
    currency: q.currency,
    exchange: q.exchange,
    type: q.type,
    price,
    previousClose: q.previousClose,
    changePercent: q.changePercent,
    marketOpen: q.marketOpen,
    marketTime: q.marketTime,
    fetchedAt: q.fetchedAt || null,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow,
    fxRate: fx,
    value,
    valueBase: toBase(value),
    cost,
    costBase: toBase(cost),
    gain,
    gainBase: toBase(gain),
    gainPercent,
    dayChange,
    dayChangeBase: toBase(dayChange),
    dayChangePercent: q.changePercent,
    weight: null, // udfyldes af computePortfolio
  };
}

export function computePortfolio({ holdings, quotes, fxRates, baseCurrency }) {
  const positions = holdings.map((h) => {
    const quoteResult = quotes[h.symbol.toUpperCase()];
    const currency = quoteResult?.quote?.currency;
    const fxResult = currency ? fxRates[currency] : null;
    return computePosition(h, quoteResult, fxResult);
  });

  let valueBase = 0;
  let costBase = 0;
  let dayChangeBase = 0;
  let prevValueBase = 0;
  let hasCost = false;
  let hasDay = false;
  let incomplete = false;
  let hasStale = false;

  for (const p of positions) {
    if (p.valueBase == null) {
      incomplete = true;
      continue;
    }
    if (p.status === 'stale') hasStale = true;
    valueBase += p.valueBase;
    if (p.costBase != null) {
      costBase += p.costBase;
      hasCost = true;
    } else {
      incomplete = true;
    }
    if (p.dayChangeBase != null) {
      dayChangeBase += p.dayChangeBase;
      prevValueBase += p.valueBase - p.dayChangeBase;
      hasDay = true;
    }
  }

  for (const p of positions) {
    p.weight = p.valueBase != null && valueBase > 0 ? (p.valueBase / valueBase) * 100 : null;
  }

  const gainBase = hasCost ? valueBase - costBase : null;
  const gainPercent = hasCost && costBase > 0 ? (gainBase / costBase) * 100 : null;
  const dayChangePercent = hasDay && prevValueBase > 0 ? (dayChangeBase / prevValueBase) * 100 : null;

  const okCount = positions.filter((p) => p.valueBase != null).length;

  return {
    baseCurrency,
    positions,
    totals: {
      valueBase,
      costBase: hasCost ? costBase : null,
      gainBase,
      gainPercent,
      dayChangeBase: hasDay ? dayChangeBase : null,
      dayChangePercent,
      positionCount: positions.length,
      okCount,
      errorCount: positions.length - okCount,
      incomplete,
      hasStale,
      anyMarketOpen: positions.some((p) => p.marketOpen === true),
    },
  };
}

// Historisk porteføljeværdi i basisvaluta, givet nuværende beholdning
// (antager beholdningen har været uændret i perioden – tydeligt markeret i UI).
// histories: { [symbol]: { currency, points: [{t, close}] } }, fxRates: { [cur]: {ok, rate} }
export function computeValueHistory({ holdings, histories, fxRates }) {
  const series = [];
  for (const h of holdings) {
    const hist = histories[h.symbol.toUpperCase()];
    if (!hist || !hist.points?.length) continue;
    const fx = fxRates[hist.currency];
    if (!fx || !fx.ok) continue;
    const factor = (Number(h.quantity) || 0) * fx.rate;
    const byDay = new Map();
    for (const p of hist.points) byDay.set(dayKey(p.t), p.close * factor);
    series.push(byDay);
  }
  if (!series.length) return [];

  // Brug dagene fra den længste serie; manglende dage i andre serier udfyldes
  // med seneste kendte lukkekurs (forward fill), så helligdage på én børs ikke
  // giver dyk i grafen.
  const allDays = new Set();
  for (const s of series) for (const d of s.keys()) allDays.add(d);
  const days = [...allDays].sort();
  const last = new Array(series.length).fill(null);
  const out = [];
  for (const day of days) {
    let total = 0;
    let complete = true;
    for (let i = 0; i < series.length; i++) {
      const v = series[i].get(day);
      if (v != null) last[i] = v;
      if (last[i] == null) {
        complete = false;
        break;
      }
      total += last[i];
    }
    if (complete) out.push({ date: day, value: total });
  }
  return out;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
