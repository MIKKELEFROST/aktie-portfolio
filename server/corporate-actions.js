// Splits og udbytte – det, der sker med en aktie, uden at man selv handler.
//
// SPLITS. Et split ændrer antallet af stk. uden at ændre, hvad beholdningen er
// værd: 10 stk. til 400 kr. bliver til 40 stk. til 100 kr. Yahoo regner alle
// historiske kurser om, som om splittet altid havde været der. Et køb, der er
// skrevet ind med tallene fra dengang – f.eks. hentet fra banken – passer
// derfor ikke længere med kurserne. Det ganges op her.
//
// UDBYTTE. Udbetalingerne hentes ikke enkeltvis for at lægges sammen. I stedet
// bruges Yahoos egen justerede kurs: adjclose er kursen, som den ville have
// set ud, hvis hvert udbytte var brugt til at købe flere af samme aktie samme
// dag. Forholdet close/adjclose på en dag er dermed præcis, hvor mange gange
// flere stk. man ville have i dag. Det rammer kursen på hver udbetalingsdag –
// ikke et gennemsnit – og det er splitjusteret i samme takt som close, så de
// to regnestykker ikke kan komme i utakt.
//
// Ingen af delene skriver i det, brugeren har tastet. Købene bliver stående,
// som de blev skrevet ind; det her er et lag ovenpå, der kan slås fra.

import { round } from './portfolio-math.js';

const dag = (s) => String(s || '').slice(0, 10);

// Hvor mange gange flere stk. et køb fra den dato svarer til i dag.
// Uden dato ved vi ikke, om købet lå før eller efter splittet – og så er det
// sikreste at lade være: tal uden dato er næsten altid skrevet af fra banken
// i dag og er dermed allerede efter splittet.
export function splitFactorSince(splits, date, indtil = null) {
  const fra = dag(date);
  if (!fra) return 1;
  const til = indtil ? dag(indtil) : null;
  let faktor = 1;
  for (const s of splits || []) {
    const d = dag(s.date);
    if (d > fra && (!til || d <= til) && Number.isFinite(s.ratio) && s.ratio > 0) faktor *= s.ratio;
  }
  return faktor;
}

// Serien er månedlig, og faktoren flytter sig kun et par procent om året, så
// nærmeste punkt er rigeligt.
// Serien sorteres og bygges om én gang pr. liste og genbruges derefter.
// Uden det ville hvert opslag løbe hele serien igennem, og dividendCash slår
// op én gang pr. udbetaling pr. køb – det bliver hurtigt til millioner.
const indeksCache = new WeakMap();

function indeks(punkter) {
  if (!Array.isArray(punkter) || !punkter.length) return null;
  const fundet = indeksCache.get(punkter);
  if (fundet) return fundet;
  const klar = punkter
    .map((p) => ({ t: Date.parse(`${dag(p.date)}T12:00:00Z`), f: p.adjclose > 0 ? p.close / p.adjclose : 1 }))
    // Faktoren kan aldrig være under 1: udbytte kan kun give flere stk., ikke færre.
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.f) && p.f >= 1)
    .sort((a, b) => a.t - b.t);
  const svar = klar.length ? klar : null;
  indeksCache.set(punkter, svar);
  return svar;
}

export function factorAt(punkter, date) {
  return faktorPå(punkter, date);
}

// close/adjclose aflæst på den dato, der ligger nærmest.
function faktorPå(punkter, date) {
  const d = dag(date);
  const liste = indeks(punkter);
  if (!d || !liste) return 1;
  const t = Date.parse(`${d}T12:00:00Z`);
  if (!Number.isFinite(t)) return 1;
  if (t <= liste[0].t) return liste[0].f;
  if (t >= liste[liste.length - 1].t) return liste[liste.length - 1].f;
  let lo = 0;
  let hi = liste.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (liste[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return t - liste[lo].t <= liste[hi].t - t ? liste[lo].f : liste[hi].f;
}

// Hvor mange gange flere stk. udbyttet siden den dato har købt, hvis hver
// udbetaling gik til flere af samme aktie.
export function dividendFactorSince(punkter, date, indtil = null) {
  const fra = faktorPå(punkter, date);
  if (!indtil) return fra;
  const til = faktorPå(punkter, indtil);
  const f = til > 0 ? fra / til : 1;
  return Number.isFinite(f) && f >= 1 ? f : 1;
}

// Et køb set med dagens øjne. Antallet ganges op for splits og for det udbytte,
// der er geninvesteret; kursen deles med split-forholdet, så det investerede
// beløb er præcis det samme som før.
export function adjustLot(lot, events, { splits: brugSplits = true, dividends: brugUdbytte = true } = {}) {
  const antal = Number(lot?.quantity);
  if (!Number.isFinite(antal) || antal <= 0) return null;
  const splitF = brugSplits ? splitFactorSince(events?.splits, lot.date) : 1;
  const udbytteF = brugUdbytte ? dividendFactorSince(events?.factors, lot.date) : 1;
  return {
    ...lot,
    quantity: round(antal * splitF, 6),
    price: lot.price == null || !Number.isFinite(Number(lot.price)) ? lot.price : round(Number(lot.price) / splitF, 6),
    // Stk. købt for udbytte står for sig: de er ikke noget, man har betalt for,
    // så de skal tælle med i værdien, men ikke i det investerede.
    dividendShares: round(antal * splitF * (udbytteF - 1), 6),
    splitFactor: splitF,
    dividendFactor: udbytteF,
  };
}

// Hvad der er udbetalt i udbytte på beholdningen, i papirets egen valuta.
// Antallet af stk. vokser undervejs, i takt med at udbyttet køber flere.
export function dividendCash(lots, events) {
  const udbetalinger = (events?.dividends || []).slice().sort((a, b) => dag(a.date).localeCompare(dag(b.date)));
  if (!udbetalinger.length) return { total: 0, count: 0, lastDate: null, lastAmount: null };
  let total = 0;
  let antalMed = 0;
  let sidsteDato = null;
  let sidsteBeløb = null;
  for (const u of udbetalinger) {
    const d = dag(u.date);
    const beløb = Number(u.amount);
    if (!d || !Number.isFinite(beløb) || beløb <= 0) continue;
    // Stk. på udbetalingsdagen: købets antal ganget op for de splits og det
    // udbytte, der lå mellem købsdatoen og den dag.
    let stk = 0;
    for (const l of lots || []) {
      const antal = Number(l?.quantity);
      if (!Number.isFinite(antal) || antal <= 0) continue;
      if (!l.date || dag(l.date) > d) continue; // købt efter udbetalingen
      stk += antal * splitFactorSince(events?.splits, l.date, d) * dividendFactorSince(events?.factors, l.date, d);
    }
    if (stk <= 0) continue;
    total += stk * beløb;
    antalMed += 1;
    sidsteDato = d;
    sidsteBeløb = beløb;
  }
  return { total: round(total, 2), count: antalMed, lastDate: sidsteDato, lastAmount: sidsteBeløb };
}

// Et split fra før man købte er uden betydning – kurserne var allerede regnet
// om, da man trådte ind. Kun dem efter det ældste køb siger noget.
function relevanteSplits(splits, lots) {
  const datoer = (lots || []).map((l) => dag(l?.date)).filter(Boolean).sort();
  const ældste = datoer[0] || null;
  return (splits || [])
    .filter((s) => !ældste || dag(s.date) > ældste)
    .map((s) => ({ date: dag(s.date), ratio: s.ratio, label: s.label || `${s.ratio}:1` }));
}

// Hele beholdningen set med dagens øjne. Returnerer null, når der ikke er
// noget at rette – så kan resten af appen regne videre præcis som før.
export function adjustHolding(holding, events, { splits: brugSplits = true, dividends: brugUdbytte = true } = {}) {
  if (!events || events.ok === false) return null;
  const harSplits = brugSplits && Boolean(events.splits?.length);
  const harUdbytte = Boolean(events.dividends?.length);
  // Det er faktor-serien, der bærer udbytte-regnestykket – ikke listen af
  // udbetalinger. Nogle papirer har den ene uden den anden, og så skal vi
  // stadig regne på det, vi har.
  const harFaktor = brugUdbytte && (events.factors || []).some((p) => p.adjclose > 0 && p.close / p.adjclose > 1.0001);
  if (!harSplits && !harUdbytte && !harFaktor) return null;

  // Uden en liste af køb er der kun ét "køb": hele beholdningen fra købsdatoen.
  const lots = Array.isArray(holding.lots) && holding.lots.length
    ? holding.lots
    : [{ date: holding.purchasedAt || null, quantity: Number(holding.quantity) || 0, price: holding.avgPrice ?? null }];

  const justerede = lots.map((l) => adjustLot(l, events, { splits: brugSplits, dividends: brugUdbytte })).filter(Boolean);
  if (!justerede.length) return null;

  const splitStk = round(justerede.reduce((s, l) => s + l.quantity, 0), 6);
  const oprindeligt = round(lots.reduce((s, l) => s + (Number(l.quantity) || 0), 0), 6);
  const udbytteStk = brugUdbytte ? round(justerede.reduce((s, l) => s + l.dividendShares, 0), 6) : 0;
  const splitRettet = brugSplits && justerede.some((l) => l.splitFactor !== 1);

  return {
    // Stk. man ejer, når splits er regnet med – det tal banken viser i dag.
    quantity: splitStk,
    // Stk. udbyttet har købt oveni. Dem har man ikke betalt for.
    dividendShares: udbytteStk,
    // Alt i alt, det kurven og værdien regnes på.
    effectiveQuantity: round(splitStk + udbytteStk, 6),
    lots: justerede,
    splitAdjusted: splitRettet,
    addedBySplits: splitRettet ? round(splitStk - oprindeligt, 6) : 0,
    // Kun de splits, der ligger efter ens ældste køb. Apple har splittet fem
    // gange siden 1987; har man købt i 2019, rager de fire af dem ikke en.
    splits: relevanteSplits(events.splits, lots),
    // De oprindelige køb sendes ind: dividendCash ganger selv op for splits,
    // så de justerede tal ville tælle splittet med to gange.
    dividend: brugUdbytte && harUdbytte ? dividendCash(lots, events) : null,
    // Bruges af kurven: stk. på en vilkårlig dag er antallet her divideret med
    // faktoren den dag, så udbyttet vokser ind i kurven, efterhånden som det
    // bliver udbetalt – i stedet for at ligge der fra første dag.
    factors: brugUdbytte ? (events.factors || []) : [],
    currency: events.currency || null,
  };
}
