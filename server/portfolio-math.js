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
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return NaN;
  const s = value.trim().replace(/\s/g, '');
  if (!s) return null;
  let norm = s;
  if (s.includes(',') && s.includes('.') && s.lastIndexOf('.') > s.lastIndexOf(',')) return NaN; // "1,234.56"
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
    accountId: holding.accountId ?? null,
    purchasedAt: holding.purchasedAt || null,
    heldDays: heldDays(holding.purchasedAt),
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
      annualizedPercent: null,
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
    // Afkast pr. år. +20 % på tre måneder og +20 % på fem år er ikke det samme,
    // og uden en købsdato kan man ikke se forskel.
    annualizedPercent: annualized(gainPercent, base.heldDays),
    dayChange,
    dayChangeBase: toBase(dayChange),
    dayChangePercent: q.changePercent,
    weight: null, // udfyldes af computePortfolio
  };
}

// Antal dage siden købsdatoen. null hvis datoen mangler eller ikke giver mening.
export function heldDays(purchasedAt, now = Date.now()) {
  if (!purchasedAt) return null;
  const t = Date.parse(`${String(purchasedAt).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(t)) return null;
  const dage = Math.floor((now - t) / 86_400_000);
  return dage < 0 ? null : dage;
}

// Omregner et samlet afkast til afkast pr. år. Under en måned giver det et
// misvisende stort tal (et par gode dage bliver til hundreder af procent),
// så dér lader vi være.
export function annualized(gainPercent, days, { minDays = 30 } = {}) {
  if (!Number.isFinite(gainPercent) || !Number.isFinite(days) || days < minDays) return null;
  const vækst = 1 + gainPercent / 100;
  if (vækst <= 0) return null;
  return round((vækst ** (365 / days) - 1) * 100, 2);
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
  let valueWithCostBase = 0; // værdi af de positioner, der har en kendt købskurs
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
      valueWithCostBase += p.valueBase;
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

  // Afkast beregnes kun over positioner med kendt købskurs – ellers ville en aktie
  // uden købskurs tælle som ren gevinst.
  const gainBase = hasCost ? valueWithCostBase - costBase : null;
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
export function computeValueHistory({ holdings, histories, fxRates, fxHistories = {} }) {
  const series = [];
  for (const h of holdings) {
    const hist = histories[h.symbol.toUpperCase()];
    if (!hist || !hist.points?.length) continue;
    const fx = fxRates[hist.currency];
    if (!fx || !fx.ok) continue;
    const qty = Number(h.quantity) || 0;
    // Historiske valutakurser når de findes; ellers dagens kurs hele vejen.
    const rateOn = dailyRates(fxHistories[hist.currency], fx.rate);
    const byDay = new Map();
    for (const p of hist.points) {
      const day = dayKey(p.t);
      byDay.set(day, { local: p.close * qty, day });
    }
    series.push({ symbol: hist.symbol || h.symbol, currency: hist.currency, byDay, rateOn, first: [...byDay.keys()].sort()[0] });
  }
  if (!series.length) return { points: [], backfilled: [] };

  // Brug alle dage fra alle serier; manglende dage udfyldes med seneste kendte
  // lukkekurs (forward fill), så en helligdag på én børs ikke giver et dyk.
  const allDays = new Set();
  for (const s of series) for (const d of s.byDay.keys()) allDays.add(d);
  const days = [...allDays].sort();
  const begin = days[0];

  // Et papir med kortere historik end resten afkortede før hele grafen. I stedet
  // regnes det med til sin første kendte kurs i tiden inden. Det er stadig et gæt,
  // så hvilke papirer det gælder, gives videre og skrives under grafen.
  const backfilled = series
    .filter((s) => s.first > begin)
    .map((s) => ({ symbol: s.symbol, from: s.first }));

  const last = series.map((s) => s.byDay.get(s.first));
  const out = [];
  for (const day of days) {
    let total = 0;
    for (let i = 0; i < series.length; i++) {
      const v = series[i].byDay.get(day);
      if (v != null) last[i] = v;
      total += last[i].local * series[i].rateOn(day);
    }
    out.push({ date: day, value: total });
  }
  return { points: out, backfilled };
}

// Opslag fra dato til valutakurs. Bruger seneste kurs til og med dagen; er dagen
// før seriens start, bruges den første kendte kurs.
export function dailyRates(history, fallback) {
  const points = history?.ok !== false && Array.isArray(history?.points) ? history.points : [];
  if (!points.length) return () => fallback;
  const byDay = new Map();
  for (const p of points) if (Number.isFinite(p.rate) && p.rate > 0) byDay.set(dayKey(p.t), p.rate);
  const days = [...byDay.keys()].sort();
  if (!days.length) return () => fallback;
  const cache = new Map();
  let i = 0;
  let current = byDay.get(days[0]);
  return (day) => {
    if (cache.has(day)) return cache.get(day);
    while (i < days.length && days[i] <= day) current = byDay.get(days[i++]);
    cache.set(day, current);
    return current;
  };
}

export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
