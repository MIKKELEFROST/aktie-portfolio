// Finder det rigtige Yahoo-symbol til et værdipapir fra en bank-eksport.
// Slår først op på ISIN, som er entydigt; ellers på navnet. Til sidst tjekkes
// valutaen mod handlens valuta, så fx Meta i Zürich ikke forveksles med Meta i New York.

// Yahoos børsnavne pr. ISIN-landekode. Bruges til at rangere kandidater.
const EXCHANGES_BY_COUNTRY = {
  US: ['NYSE', 'NASDAQ', 'NasdaqGS', 'NasdaqGM', 'NasdaqCM', 'NYSEArca', 'NYSE American', 'NYSE MKT'],
  DK: ['Copenhagen'],
  SE: ['Stockholm'],
  NO: ['Oslo'],
  FI: ['Helsinki'],
  IS: ['Iceland'],
  DE: ['XETRA', 'Frankfurt', 'Berlin', 'Munich'],
  NL: ['Amsterdam'],
  BE: ['Brussels'],
  FR: ['Paris'],
  GB: ['LSE', 'London'],
  IE: ['LSE', 'London', 'Dublin'],
  CH: ['Swiss', 'Zurich'],
  IT: ['Milan'],
  ES: ['MCE', 'Madrid'],
  AT: ['Vienna'],
  PT: ['Lisbon'],
  CA: ['Toronto', 'TSXV'],
  JP: ['Tokyo'],
  AU: ['ASX'],
  LU: ['Copenhagen', 'XETRA', 'Frankfurt', 'Luxembourg'],
};

// Handles papiret i en valuta, foretrækkes hovedmarkedet for den valuta.
// Fx findes en irsk UCITS-ETF på både XETRA og Stuttgart; XETRA er det primære.
const EXCHANGES_BY_CURRENCY = {
  EUR: ['XETRA', 'Frankfurt', 'Amsterdam', 'Paris', 'Milan', 'Vienna', 'Dublin', 'Lisbon', 'Stuttgart', 'Berlin', 'Munich', 'Hamburg', 'Dusseldorf'],
  USD: ['NYSE', 'NASDAQ', 'NasdaqGS', 'NasdaqGM', 'NasdaqCM', 'NYSEArca', 'NYSE American'],
  DKK: ['Copenhagen'],
  SEK: ['Stockholm'],
  NOK: ['Oslo'],
  GBP: ['LSE', 'London'],
  GBX: ['LSE', 'London'],
  CHF: ['Swiss', 'Zurich'],
  CAD: ['Toronto'],
  JPY: ['Tokyo'],
};

const MINOR_TO_MAJOR = { GBP: 'GBP', GBX: 'GBP', GBp: 'GBP' };

export function isinCountry(isin) {
  const m = /^([A-Z]{2})[A-Z0-9]{9}[0-9]$/.exec(String(isin || '').trim().toUpperCase());
  return m ? m[1] : null;
}

// Fjerner tilføjelser banken skriver, men som Yahoo ikke kender.
export function cleanSecurityName(name) {
  return String(name || '')
    .replace(/\b(ADR|GDR|REIT|NPV|SDB|DEP RCPT)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Navnevarianter der prøves i rækkefølge, fx "Meta Platforms A" og "Meta Platforms".
export function nameVariants(name) {
  const base = cleanSecurityName(name);
  if (!base) return [];
  const variants = [base];
  const withoutClass = base.replace(/\s+(?:ser\.?\s*)?[A-D]$/i, '').trim();
  if (withoutClass && withoutClass !== base && withoutClass.split(' ').length > 1) variants.push(withoutClass);
  return variants;
}

// Nogle børser har ingen rigtig ticker hos Yahoo, kun ISIN'en som symbol.
// De noteringer har ofte forkert navn og sløve kurser, så de kommer sidst.
export const isPlaceholderSymbol = (symbol) => /^[A-Z]{2}[A-Z0-9]{9}[0-9](\.|$)/.test(String(symbol || ''));

function rank(candidates, country, currency) {
  const byCountry = EXCHANGES_BY_COUNTRY[country] || [];
  const byCurrency = EXCHANGES_BY_CURRENCY[currency] || [];
  const score = (list, exchange) => {
    const i = list.indexOf(exchange);
    return i === -1 ? 99 : i;
  };
  return candidates
    .map((c, i) => ({ c, i, placeholder: isPlaceholderSymbol(c.symbol) ? 1 : 0, country: score(byCountry, c.exchange), currency: score(byCurrency, c.exchange) }))
    .sort((a, b) => {
      if (a.placeholder !== b.placeholder) return a.placeholder - b.placeholder;
      // Landet fra ISIN vejer tungest, dernæst hovedmarkedet for handlens valuta.
      if (a.country !== b.country) return a.country - b.country;
      if (a.currency !== b.currency) return a.currency - b.currency;
      return a.i - b.i;
    })
    .map((x) => x.c);
}

const sameCurrency = (a, b) => (MINOR_TO_MAJOR[a] || a) === (MINOR_TO_MAJOR[b] || b);

// Yahoo har af og til forkerte navne på små børsnoteringer. Deler navnene intet
// betydningsbærende ord, markeres det, så brugeren kan kontrollere symbolet.
export function namesDisagree(bankName, yahooName) {
  const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-zæøå0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
  const a = words(bankName);
  const b = words(yahooName);
  if (!a.size || !b.size) return false;
  for (const w of a) if (b.has(w)) return false;
  return true;
}

const STOPWORDS = new Set(['inc', 'the', 'ltd', 'plc', 'corp', 'corporation', 'company', 'ucits', 'etf', 'acc', 'dis', 'usd', 'eur', 'dkk', 'class', 'aktie', 'fund', 'index']);

// Slår ét værdipapir op. Kaster ikke: kan ingen kandidat findes, returneres symbol: null.
export async function resolveSecurity(yahoo, security, { maxQuotes = 5 } = {}) {
  const isin = String(security?.isin || '').trim().toUpperCase();
  const name = String(security?.name || '').trim();
  const currency = String(security?.currency || '').trim().toUpperCase();
  const country = isinCountry(isin);
  const out = { isin, name, symbol: null, symbolName: null, exchange: null, currency: null, matchedBy: null, currencyMismatch: false, nameMismatch: false };

  const search = async (q) => {
    try {
      return await yahoo.search(q);
    } catch {
      return [];
    }
  };

  // Både ISIN og navn slås op: ISIN er entydigt, men rammer ikke altid den notering,
  // der handles i papirets valuta. Navnet finder de øvrige børser.
  const candidates = [];
  const seen = new Set();
  const fromIsin = new Set();
  const add = (list, isIsinHit) => {
    for (const c of list) {
      if (!c?.symbol || seen.has(c.symbol)) continue;
      seen.add(c.symbol);
      if (isIsinHit) fromIsin.add(c.symbol);
      candidates.push(c);
    }
  };
  if (isin) add(await search(isin), true);
  // Navnet slås også op: en ISIN-søgning rammer tit kun én børs, og den handler
  // ikke nødvendigvis i samme valuta som købet.
  for (const variant of nameVariants(name)) add(await search(variant), false);
  if (!candidates.length) return out;

  const matchedFor = (symbol) => (fromIsin.has(symbol) ? 'isin' : 'navn');
  const ranked = rank(candidates, country, currency);
  let placeholderHit = null;
  let mismatchHit = null;
  for (const candidate of ranked.slice(0, maxQuotes)) {
    let quote = null;
    try {
      quote = await yahoo.getQuote(candidate.symbol);
    } catch {
      continue;
    }
    const hit = { ...out, symbol: quote.symbol, symbolName: quote.name, exchange: quote.exchange || candidate.exchange, currency: quote.currency, matchedBy: matchedFor(candidate.symbol), nameMismatch: namesDisagree(name, quote.name) };
    const currencyOk = !currency || sameCurrency(quote.currency, currency);
    // Rigtig ticker i handlens valuta er det bedste; en ISIN-pladsholder bruges kun,
    // hvis ingen rigtig notering handler i samme valuta.
    if (currencyOk && !isPlaceholderSymbol(quote.symbol)) return hit;
    if (currencyOk && !placeholderHit) placeholderHit = hit;
    if (!currencyOk && !mismatchHit) mismatchHit = { ...hit, currencyMismatch: true };
  }
  if (placeholderHit) return placeholderHit;
  if (mismatchHit) return mismatchHit;

  // Ingen kurs kunne hentes: giv den bedst rangerede kandidat videre, så brugeren kan vælge.
  const top = ranked[0];
  return { ...out, symbol: top.symbol, symbolName: top.name, exchange: top.exchange, matchedBy: matchedFor(top.symbol) };
}

export async function resolveSecurities(yahoo, list, options = {}) {
  const results = [];
  // Sekventielt: Yahoo afviser mange samtidige kald, og en import er sjælden.
  for (const security of list) results.push(await resolveSecurity(yahoo, security, options));
  return results;
}
