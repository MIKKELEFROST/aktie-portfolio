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
    // Er aktien købt ad flere omgange, ligger tyngden af pengene senere end
    // det første køb. weightedAt er den dato, pengene i gennemsnit blev sat
    // ind – den bruges til afkast pr. år, mens ejertid tæller fra første køb.
    weightedAt: holding.weightedAt || holding.purchasedAt || null,
    moneyDays: heldDays(holding.weightedAt || holding.purchasedAt),
    lots: Array.isArray(holding.lots) && holding.lots.length ? holding.lots : null,
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
    annualizedPercent: annualized(gainPercent, base.moneyDays),
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
// Cirka-længden på hver periode i dage, fra kort til lang. Den første, der
// dækker ejertiden, er dermed også den mindste, der dækker.
const RANGE_DAGE = [['1mo', 31], ['3mo', 93], ['6mo', 186], ['1y', 366], ['2y', 731], ['5y', 1827]];

export function rangeDays(range, now = Date.now()) {
  if (range === '5d') return 5;
  if (range === 'ytd') {
    const d = new Date(now);
    return Math.floor((now - Date.UTC(d.getUTCFullYear(), 0, 1)) / MS_PER_DAG) + 1;
  }
  const fundet = RANGE_DAGE.find(([k]) => k === range);
  return fundet ? fundet[1] : Infinity; // "max"
}

// Første køb på tværs af beholdningerne. Mangler datoen på bare én, ved vi ikke,
// hvornår porteføljen begyndte – og så svares der null i stedet for at gætte.
export function firstPurchaseDate(holdings = []) {
  const datoer = holdings.map((h) => h?.purchasedAt || null);
  return datoer.length && datoer.every(Boolean) ? [...datoer].sort()[0] : null;
}

// Yahoo leverer 5y og max i ugebarer. Henter vi "Alt" for noget købt for en
// måned siden, bliver kurven til en håndfuld punkter, når tiden inden købet er
// klippet fra. Derfor snævres perioden ind til den mindste, der stadig dækker
// ejertiden – så bliver det dagsbarer og en rigtig kurve.
export function narrowRange(range, ownedFrom, now = Date.now()) {
  if (!ownedFrom || range === '5d') return range;
  const dage = heldDays(ownedFrom, now);
  if (!Number.isFinite(dage)) return range;
  const mindste = RANGE_DAGE.find(([, d]) => d >= dage);
  if (!mindste) return range; // ejet længere end fem år: hent som bedt om
  return mindste[1] < rangeDays(range, now) ? mindste[0] : range;
}

// Hvornår hver portion kom ind i beholdningen. Er aktien ført køb for køb,
// er det ét trin pr. køb; ellers ét trin med hele antallet fra købsdatoen.
// Uden dato regnes portionen med hele vejen – vi ved ikke bedre.
function ownedSteps(holding) {
  const lots = (Array.isArray(holding.lots) ? holding.lots : []).filter((l) => l && Number(l.quantity) > 0);
  const trin = lots.length
    ? lots.map((l) => ({
      date: l.date ? String(l.date).slice(0, 10) : null,
      quantity: Number(l.quantity),
      cost: harKurs(l) ? Number(l.quantity) * Number(l.price) : 0,
    }))
    : [{
      date: holding.purchasedAt ? String(holding.purchasedAt).slice(0, 10) : null,
      quantity: Number(holding.quantity) || 0,
      cost: holding.avgPrice == null ? 0 : (Number(holding.quantity) || 0) * Number(holding.avgPrice),
    }];
  // Tomme datoer sorterer først og tælles derfor med fra første dag.
  return trin.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

export function computeValueHistory({ holdings, histories, fxRates, fxHistories = {}, windowStart = null }) {
  const series = [];
  const med = [];
  for (const h of holdings) {
    const hist = histories[h.symbol.toUpperCase()];
    if (!hist || !hist.points?.length) continue;
    const fx = fxRates[hist.currency];
    if (!fx || !fx.ok) continue;
    // Historiske valutakurser når de findes; ellers dagens kurs hele vejen.
    const rateOn = dailyRates(fxHistories[hist.currency], fx.rate);
    const byDay = new Map();
    for (const p of hist.points) {
      const day = dayKey(p.t);
      byDay.set(day, { close: p.close, day });
    }
    series.push({
      symbol: hist.symbol || h.symbol,
      name: h.name || hist.symbol || h.symbol,
      currency: hist.currency,
      byDay,
      rateOn,
      first: [...byDay.keys()].sort()[0],
      steps: ownedSteps(h),
      // Det investerede omregnes med dagens valutakurs – samme regnestykke som
      // tallet "Investeret" over grafen, så de to ikke siger hver sit.
      rateNow: fx.rate,
    });
    med.push(h);
  }
  if (!series.length) return { points: [], backfilled: [], ownedFrom: null };

  // Kurven skal ikke starte, før man ejede noget: tiden inden første køb klippes
  // væk, uanset hvilken periode der er valgt. Kun de beholdninger, der faktisk
  // er med i kurven, tæller – en der mangler kurser, skal ikke flytte starten.
  const ownedFrom = firstPurchaseDate(med);

  // Brug alle dage fra alle serier; manglende dage udfyldes med seneste kendte
  // lukkekurs (forward fill), så en helligdag på én børs ikke giver et dyk.
  const allDays = new Set();
  for (const s of series) for (const d of s.byDay.keys()) allDays.add(d);
  const days = [...allDays].sort();

  // Antal og kostpris vokser hen ad vejen: et køb midt i perioden skal give et
  // hop i kurven, ikke tælle med fra første dag. Trinene er sorteret, så der
  // kun skal læses fremad én gang.
  const last = series.map((s) => s.byDay.get(s.first));
  const ejet = series.map(() => ({ i: 0, quantity: 0, cost: 0 }));
  const out = [];
  for (const day of days) {
    let total = 0;
    let invested = 0;
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const e = ejet[i];
      while (e.i < s.steps.length && (!s.steps[e.i].date || s.steps[e.i].date <= day)) {
        e.quantity += s.steps[e.i].quantity;
        e.cost += s.steps[e.i].cost;
        e.i++;
      }
      const v = s.byDay.get(day);
      if (v != null) last[i] = v;
      total += last[i].close * e.quantity * s.rateOn(day);
      invested += e.cost * s.rateNow;
    }
    out.push({ date: day, value: round(total), invested: round(invested) });
  }

  // Begivenheder på kurven: hvad blev der købt hvornår. Køb samme dag samles i
  // ét punkt, så en måned med fire fondskøb bliver til én markør og ikke fire
  // oven i hinanden. Salg kan ikke vises – dem gemmer vi ikke, købene skrumper
  // bare forholdsmæssigt.
  const påDag = new Map();
  for (const s of series) {
    for (const step of s.steps) {
      if (!step.date || !(step.quantity > 0)) continue;
      if (!påDag.has(step.date)) påDag.set(step.date, []);
      påDag.get(step.date).push({
        symbol: s.symbol,
        name: s.name,
        quantity: round(step.quantity, 6),
        price: step.cost > 0 ? round(step.cost / step.quantity, 6) : null,
        currency: s.currency,
        amount: round(step.cost, 2),
        amountBase: round(step.cost * s.rateNow),
      });
    }
  }

  // Dagene før det første køb er nuller – der var ikke noget at være værd.
  let første = 0;
  while (første < out.length - 1 && out[første].value <= 0) første++;
  let points = out.slice(første);
  // Er alt købt i dag, er der ikke en kurve endnu; så beholdes de sidste par
  // dage, så grafen ikke står helt tom.
  if (points.length < 2) points = out.slice(-2);

  // Et papir med kortere historik end resten afkortede før hele grafen. I stedet
  // regnes det med til sin første kendte kurs i tiden inden. Det er stadig et gæt,
  // så hvilke papirer det gælder, gives videre og skrives under grafen. Måles mod
  // den viste periode: ligger gættet før kurvens start, ses det ikke.
  const begin = points.length ? points[0].date : days[0];
  const backfilled = series
    .filter((s) => s.first > begin)
    .map((s) => ({ symbol: s.symbol, from: s.first }));

  // Hvilke køb hører til den viste periode? Kurven kan begynde senere end
  // købet – køber man en lørdag, er første børsdag mandag, og Yahoo leverer
  // ikke altid så mange dage, som perioden lover. Derfor måles der mod den
  // periode, der blev bedt om (windowStart), og ellers mod den sidste dag,
  // der blev klippet væk. Kurvens første dag alene ville smide markøren for
  // det allerførste køb på gulvet.
  const trimGrænse = første > 0 ? out[første - 1].date : null;
  const start = points.length ? points[0].date : '';
  const iVinduet = (dato) => {
    if (windowStart && dato >= windowStart) return true;
    if (trimGrænse) return dato > trimGrænse;
    return dato >= start;
  };
  const events = [...påDag.entries()]
    .filter(([dato]) => iVinduet(dato))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, items]) => ({ date, items, amountBase: round(items.reduce((sum, i) => sum + i.amountBase, 0)) }));

  return { points, backfilled, ownedFrom, events: events.length <= 80 ? events : [] };
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

// ---------------------------------------------------------------------------
// Analyse: tal om porteføljen som helhed, som ikke kan aflæses af listen.
// Alt bygger på købsdatoerne – uden dem kan man ikke sige noget om tid.
// ---------------------------------------------------------------------------

const MS_PER_DAG = 86_400_000;
const DAGE_PR_MÅNED = 365.25 / 12;

// Hvor mange procent om året porteføljen har givet. Vægtet efter hvor længe
// hver krone har været investeret: 100.000 kr. i tre år vejer tungere end
// 10.000 kr. i en måned.
function vægtetEjertid(poster) {
  let vægt = 0;
  let sum = 0;
  for (const p of poster) {
    const dage = Number.isFinite(p.moneyDays) ? p.moneyDays : p.heldDays;
    if (!Number.isFinite(p.costBase) || !Number.isFinite(dage)) continue;
    vægt += p.costBase;
    sum += p.costBase * dage;
  }
  return vægt > 0 ? sum / vægt : null;
}

export function computeAnalytics({ positions = [], totals = {}, baseCurrency = 'DKK', now = Date.now() } = {}) {
  const medKurs = positions.filter((p) => Number.isFinite(p.valueBase));
  const medDato = medKurs.filter((p) => p.purchasedAt && Number.isFinite(p.heldDays));
  const medKøbskurs = medKurs.filter((p) => Number.isFinite(p.costBase) && p.costBase > 0);

  const invested = medKøbskurs.reduce((s, p) => s + p.costBase, 0) || null;
  const value = Number.isFinite(totals.valueBase) ? totals.valueBase : medKurs.reduce((s, p) => s + p.valueBase, 0);
  const gain = invested == null ? null : value - invested;
  const gainPercent = invested ? (gain / invested) * 100 : null;

  const førsteDato = medDato.map((p) => p.purchasedAt).sort()[0] || null;
  const dageSiden = førsteDato ? heldDays(førsteDato, now) : null;
  const måneder = dageSiden == null ? null : dageSiden / DAGE_PR_MÅNED;

  // Gennemsnitligt indskud pr. måned. Første købsmåned tæller med, så en
  // portefølje købt i denne måned ikke bliver til "uendeligt pr. måned".
  const perMonth = invested != null && måneder != null ? invested / Math.max(1, måneder) : null;
  const perDay = gain != null && dageSiden != null && dageSiden > 0 ? gain / dageSiden : null;

  const snitEjertid = vægtetEjertid(medDato);
  const annualizedPercent = annualized(gainPercent, snitEjertid, { minDays: 60 });

  // Hvor længe der går, før pengene er fordoblet, hvis det fortsætter sådan.
  const doublingYears = Number.isFinite(annualizedPercent) && annualizedPercent > 0
    ? round(Math.log(2) / Math.log(1 + annualizedPercent / 100), 1)
    : null;

  const sorteretEfterAfkast = medKøbskurs.filter((p) => Number.isFinite(p.gainPercent)).sort((a, b) => b.gainPercent - a.gainPercent);
  const efterVærdi = [...medKurs].sort((a, b) => b.valueBase - a.valueBase);
  const længstEjet = [...medDato].sort((a, b) => b.heldDays - a.heldDays)[0] || null;
  const top3 = efterVærdi.slice(0, 3).reduce((s, p) => s + p.valueBase, 0);

  const kort = (p, ekstra = {}) => (p ? { symbol: p.symbol, name: p.name || p.symbol, ...ekstra } : null);

  return {
    baseCurrency,
    since: førsteDato,
    days: dageSiden,
    months: måneder == null ? null : round(måneder, 1),
    invested: invested == null ? null : round(invested),
    value: round(value),
    gain: gain == null ? null : round(gain),
    gainPercent: gainPercent == null ? null : round(gainPercent, 2),
    annualizedPercent,
    // Hvor sikkert det årlige tal er: under et år er det for kort til at sige noget.
    annualizedReliable: Number.isFinite(snitEjertid) && snitEjertid >= 365,
    avgHeldDays: snitEjertid == null ? null : Math.round(snitEjertid),
    perMonth: perMonth == null ? null : round(perMonth),
    perDay: perDay == null ? null : round(perDay),
    doublingYears,
    positionsTotal: positions.length,
    withDates: medDato.length,
    withoutDates: positions.length - medDato.length,
    // Andelen af det, porteføljen er værd, som ikke er dine egne indbetalinger.
    gainShare: value > 0 && gain != null ? round((gain / value) * 100, 1) : null,
    concentration: value > 0 ? round((top3 / value) * 100, 1) : null,
    currencies: [...new Set(medKurs.map((p) => p.currency).filter(Boolean))].length,
    accounts: [...new Set(positions.map((p) => p.accountId).filter(Boolean))].length,
    biggest: kort(efterVærdi[0], { valueBase: round(efterVærdi[0]?.valueBase), weight: efterVærdi[0]?.weight ?? null }),
    best: kort(sorteretEfterAfkast[0], { gainPercent: round(sorteretEfterAfkast[0]?.gainPercent, 2), gainBase: round(sorteretEfterAfkast[0]?.gainBase) }),
    worst: sorteretEfterAfkast.length > 1 ? kort(sorteretEfterAfkast[sorteretEfterAfkast.length - 1], {
      gainPercent: round(sorteretEfterAfkast[sorteretEfterAfkast.length - 1].gainPercent, 2),
      gainBase: round(sorteretEfterAfkast[sorteretEfterAfkast.length - 1].gainBase),
    }) : null,
    longestHeld: kort(længstEjet, { heldDays: længstEjet?.heldDays ?? null, purchasedAt: længstEjet?.purchasedAt ?? null }),
    ...computePurchaseFacts(positions, now),
  };
}

// ---------------------------------------------------------------------------
// Tal om købene selv: hvor tit, hvor meget, hvornår. Bygger på de enkelte køb,
// hvor de findes, og ellers på beholdningens ene købsdato.
// ---------------------------------------------------------------------------

export function computePurchaseFacts(positions = [], now = Date.now()) {
  const køb = [];
  let units = 0;
  for (const p of positions) {
    units += Number(p.quantity) || 0;
    const fx = Number.isFinite(p.fxRate) ? p.fxRate : null;
    const lots = Array.isArray(p.lots) ? p.lots.filter((l) => l && l.date && Number(l.quantity) > 0) : [];
    if (lots.length) {
      for (const l of lots) {
        køb.push({
          date: String(l.date).slice(0, 10),
          name: p.name || p.symbol,
          symbol: p.symbol,
          quantity: Number(l.quantity),
          amountBase: harKurs(l) && fx != null ? round(Number(l.quantity) * Number(l.price) * fx) : null,
        });
      }
    } else if (p.purchasedAt) {
      køb.push({
        date: String(p.purchasedAt).slice(0, 10),
        name: p.name || p.symbol,
        symbol: p.symbol,
        quantity: Number(p.quantity) || 0,
        amountBase: Number.isFinite(p.costBase) ? round(p.costBase) : null,
      });
    }
  }

  const tom = { purchases: 0, units: round(units, 4), firstBuy: null, lastBuy: null, daysSinceLastBuy: null, daysBetweenBuys: null, biggestBuy: null, avgBuy: null, busiestMonth: null };
  if (!køb.length) return tom;

  køb.sort((a, b) => a.date.localeCompare(b.date));
  const firstBuy = køb[0].date;
  const lastBuy = køb[køb.length - 1].date;
  const spænd = heldDays(firstBuy, now) - heldDays(lastBuy, now);

  const medBeløb = køb.filter((k) => Number.isFinite(k.amountBase) && k.amountBase > 0);
  const biggest = medBeløb.reduce((bedst, k) => (!bedst || k.amountBase > bedst.amountBase ? k : bedst), null);

  // Hvilken måned der blev lagt mest ind.
  const måneder = new Map();
  for (const k of medBeløb) {
    const m = k.date.slice(0, 7);
    const r = måneder.get(m) || { month: m, amountBase: 0, count: 0 };
    r.amountBase += k.amountBase;
    r.count++;
    måneder.set(m, r);
  }
  const travlest = [...måneder.values()].reduce((bedst, m) => (!bedst || m.amountBase > bedst.amountBase ? m : bedst), null);

  return {
    purchases: køb.length,
    units: round(units, 4),
    firstBuy,
    lastBuy,
    daysSinceLastBuy: heldDays(lastBuy, now),
    // Hvor tit der købes. Giver først mening fra to køb og op.
    daysBetweenBuys: køb.length > 1 && Number.isFinite(spænd) ? round(spænd / (køb.length - 1), 1) : null,
    biggestBuy: biggest ? { name: biggest.name, symbol: biggest.symbol, date: biggest.date, amountBase: biggest.amountBase } : null,
    avgBuy: medBeløb.length ? round(medBeløb.reduce((sum, k) => sum + k.amountBase, 0) / medBeløb.length) : null,
    busiestMonth: travlest ? { month: travlest.month, amountBase: round(travlest.amountBase), count: travlest.count } : null,
  };
}

// ---------------------------------------------------------------------------
// Rekorder fra kurven: toppen, bedste og værste dag, og hvor længe man har
// været i plus. Dagens udsving måles på afkastet – værdi minus indsat – så en
// indbetaling ikke ligner en kanondag.
// ---------------------------------------------------------------------------

export function computeHistoryFacts(points = []) {
  const p = points.filter((x) => x && Number.isFinite(x.value));
  if (p.length < 2) return null;

  const top = p.reduce((bedst, x) => (x.value > bedst.value ? x : bedst), p[0]);
  const nu = p[p.length - 1];

  const medIndsat = p.every((x) => Number.isFinite(x.invested));
  let bedstDag = null;
  let værstDag = null;
  let iPlus = 0;
  let stime = 0;
  let længsteStime = 0;
  for (let i = 0; i < p.length; i++) {
    if (medIndsat && p[i].invested > 0 && p[i].value >= p[i].invested) iPlus++;
    if (i === 0) continue;
    const før = p[i - 1];
    const dag = p[i];
    const ændring = medIndsat
      ? (dag.value - dag.invested) - (før.value - før.invested)
      : dag.value - før.value;
    const post = {
      date: dag.date,
      change: round(ændring),
      changePercent: før.value > 0 ? round((ændring / før.value) * 100, 2) : null,
    };
    if (!bedstDag || ændring > bedstDag.change) bedstDag = post;
    if (!værstDag || ændring < værstDag.change) værstDag = post;
    if (ændring > 0) {
      stime++;
      if (stime > længsteStime) længsteStime = stime;
    } else if (ændring < 0) {
      stime = 0;
    }
  }

  return {
    tradingDays: p.length,
    peak: { date: top.date, value: round(top.value) },
    fromPeakPercent: top.value > 0 ? round(((nu.value - top.value) / top.value) * 100, 2) : null,
    bestDay: bedstDag,
    worstDay: værstDag,
    daysInProfit: medIndsat ? iPlus : null,
    longestStreak: længsteStime,
  };
}

// Fremskrivning: hvad bliver det til, hvis man bliver ved med at lægge det
// samme til hver måned, og væksten fortsætter. Renter tilskrives månedligt.
export function projectValue({ start = 0, perMonth = 0, annualPercent = 0, years = 10 } = {}) {
  const måneder = Math.max(0, Math.round(years * 12));
  const r = (1 + annualPercent / 100) ** (1 / 12) - 1;
  const vokset = start * (1 + r) ** måneder;
  // Ved 0 % vækst er formlen en division med nul; så er det bare indskuddene.
  const bidrag = Math.abs(r) < 1e-9 ? perMonth * måneder : perMonth * (((1 + r) ** måneder - 1) / r);
  const indbetalt = start + perMonth * måneder;
  const slut = vokset + bidrag;
  return {
    years,
    months: måneder,
    value: round(slut),
    contributed: round(indbetalt),
    growth: round(slut - indbetalt),
  };
}

// ---------------------------------------------------------------------------
// Køb (lots): har man købt den samme aktie ad flere omgange, kan hvert køb
// skrives ind for sig. Så er antal og gennemsnitskurs ikke noget, man selv
// skal regne ud – og man kan se forskel på, hvornår papiret blev købt, og
// hvornår pengene faktisk gik ind.
// ---------------------------------------------------------------------------

// Et køb uden kurs tæller med i antallet, men ikke i gennemsnitskursen.
// Bemærk at Number(null) er 0 og består Number.isFinite – derfor null-tjekket.
const harKurs = (l) => l.price !== null && l.price !== undefined && l.price !== '' && Number.isFinite(Number(l.price));

export function summarizeLots(lots) {
  const gyldige = (Array.isArray(lots) ? lots : []).filter((l) => l && Number.isFinite(Number(l.quantity)) && Number(l.quantity) > 0);
  if (!gyldige.length) return null;

  let quantity = 0;
  let cost = 0;
  let medKurs = 0;
  for (const l of gyldige) {
    const antal = Number(l.quantity);
    quantity += antal;
    if (harKurs(l)) {
      cost += antal * Number(l.price);
      medKurs += antal;
    }
  }

  const datoer = gyldige.map((l) => String(l.date || '').slice(0, 10)).filter(Boolean).sort();
  // Mangler der dato på bare ét køb, kan vi ikke sige, hvornår beholdningen
  // blev startet – og så skal der ikke regnes ejertid eller afkast pr. år på
  // den. Bedre ingen dato end en, der ser for ny ud.
  const udenDato = gyldige.length - datoer.length;
  const purchasedAt = udenDato > 0 ? null : (datoer[0] || null);

  // Pengevægtet dato: hvert køb vejer efter hvor mange penge der gik ind.
  // Uden kurser vejes der efter antal i stedet, så datoen stadig siger noget.
  const medDato = gyldige.filter((l) => l.date);
  const vægt = (l) => (harKurs(l) && medKurs > 0 ? Number(l.quantity) * Number(l.price) : Number(l.quantity));
  const samletVægt = medDato.reduce((s, l) => s + vægt(l), 0);
  let weightedAt = purchasedAt;
  if (samletVægt > 0 && purchasedAt) {
    const ms = medDato.reduce((s, l) => s + Date.parse(`${String(l.date).slice(0, 10)}T12:00:00Z`) * (vægt(l) / samletVægt), 0);
    if (Number.isFinite(ms)) weightedAt = new Date(ms).toISOString().slice(0, 10);
  }

  return {
    count: gyldige.length,
    missingDates: udenDato,
    quantity: round(quantity, 6),
    // Kun de køb, hvor der står en kurs, tæller med i gennemsnittet.
    avgPrice: medKurs > 0 ? round(cost / medKurs, 6) : null,
    purchasedAt,
    weightedAt,
  };
}

// Sælger man en del af sin beholdning, skrumper alle køb forholdsmæssigt.
// Det er gennemsnitsmetoden, som danske aktieavancer gøres op efter – og det
// betyder, at et salg hverken flytter gennemsnitskursen eller den vægtede
// købsdato. Havde vi solgt de ældste køb først (FIFO), ville begge dele
// hoppe efter hvert salg.
export function reduceLots(lots, antalSolgt) {
  const liste = (Array.isArray(lots) ? lots : []).filter((l) => l && Number(l.quantity) > 0);
  const ialt = liste.reduce((s, l) => s + Number(l.quantity), 0);
  const solgt = Number(antalSolgt) || 0;
  if (solgt <= 0) return liste;
  if (solgt >= ialt - 1e-9) return [];
  const andel = (ialt - solgt) / ialt;
  return liste
    .map((l) => ({ ...l, quantity: round(Number(l.quantity) * andel, 6) }))
    .filter((l) => l.quantity > 0);
}
