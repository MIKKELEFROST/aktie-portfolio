// Min Portefølje – dashboard-klient. Vanilla JS, ingen afhængigheder.
(() => {
  'use strict';

  // ======================================================================
  // Hjælpere
  // ======================================================================

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

  const CURRENCY_SYMBOLS = { DKK: 'kr.', EUR: '€', USD: '$', GBP: '£', SEK: 'kr', NOK: 'kr', CHF: 'CHF' };
  const BASE_CURRENCIES = ['DKK', 'EUR', 'USD', 'SEK', 'NOK', 'GBP', 'CHF'];
  const PALETTE = ['#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1'];
  const REFRESH_MS = 60_000;
  const RANGES = [
    { key: '1mo', label: '1M' },
    { key: '3mo', label: '3M' },
    { key: '6mo', label: '6M' },
    { key: 'ytd', label: 'ÅTD' },
    { key: '1y', label: '1Å' },
    { key: '5y', label: '5Å' },
    { key: 'max', label: 'Alt' },
  ];

  const nf = (opts) => new Intl.NumberFormat('da-DK', opts);
  const fmtNum = (n, min = 2, max = 2) => (isNum(n) ? nf({ minimumFractionDigits: min, maximumFractionDigits: max }).format(n) : '–');

  // Beløb i basisvaluta: "1.234.567 kr." – decimaler kan slås til i indstillinger.
  function fmtAmount(n, currency = state.baseCurrency, { decimals = null, sign = false } = {}) {
    if (!isNum(n)) return '–';
    const d = decimals ?? (state.settings.showDecimals ? 2 : 0);
    const abs = nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(n));
    const sym = CURRENCY_SYMBOLS[currency] || currency;
    const prefix = n < 0 ? '−' : sign && n > 0 ? '+' : '';
    return `${prefix}${abs} ${sym}`;
  }

  // Kurs i aktiens egen valuta: 2 decimaler, flere for små kurser.
  function fmtPrice(n) {
    if (!isNum(n)) return '–';
    const d = Math.abs(n) < 1 ? 4 : 2;
    return fmtNum(n, d, d);
  }

  function fmtPct(n, { sign = true } = {}) {
    if (!isNum(n)) return '–';
    const abs = fmtNum(Math.abs(n), 1, 2);
    const prefix = n < 0 ? '−' : sign && n > 0 ? '+' : '';
    return `${prefix}${abs} %`;
  }

  // Til input-felter: fuld præcision, uden tusindtalspunkter (parseInput læser komma som decimal)
  function fmtRaw(n) {
    return isNum(n) ? nf({ minimumFractionDigits: 0, maximumFractionDigits: 6, useGrouping: false }).format(n) : '';
  }

  function fmtQty(n) {
    if (!isNum(n)) return '–';
    return nf({ minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(n);
  }

  function fmtTime(iso) {
    if (!iso) return '–';
    return new Intl.DateTimeFormat('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' }).format(new Date(iso));
  }

  function fmtDateTime(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    const date = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'short', timeZone: 'Europe/Copenhagen' }).format(d);
    return `${date} kl. ${fmtTime(iso)}`;
  }

  function fmtDate(iso, { year = false } = {}) {
    if (!iso) return '–';
    return new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'short', year: year ? 'numeric' : undefined, timeZone: 'Europe/Copenhagen' }).format(new Date(iso));
  }

  // Kompakt aksemærkat: 1,28 mio. / 128.000
  function fmtCompact(n) {
    if (!isNum(n)) return '';
    if (Math.abs(n) >= 1e9) return `${fmtNum(n / 1e9, 1, 2)} mia.`;
    if (Math.abs(n) >= 1e6) return `${fmtNum(n / 1e6, 1, 2)} mio.`;
    return fmtNum(n, 0, 0);
  }

  // Dansk tal-input: "1.234,56" → 1234.56, "612,5" → 612.5, "0.4321" → 0.4321, "1.234" → 1234
  function parseInput(str) {
    const s = String(str ?? '').trim().replace(/\s/g, '');
    if (!s) return null;
    let norm = s;
    if (s.includes(',') && s.includes('.') && s.lastIndexOf('.') > s.lastIndexOf(',')) return NaN; // "1,234.56"
    if (s.includes(',')) norm = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) norm = s.replace(/\./g, '');
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(norm)) return NaN;
    const n = Number(norm);
    return Number.isFinite(n) ? n : NaN;
  }

  const signClass = (n) => (!isNum(n) || Math.abs(n) < 1e-9 ? 'flat' : n > 0 ? 'pos' : 'neg');
  const arrow = (n) => (!isNum(n) || Math.abs(n) < 1e-9 ? '' : n > 0 ? '▲ ' : '▼ ');
  const initials = (symbol) => symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase();
  const yahooUrl = (symbol) => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;

  function storageGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  // ======================================================================
  // Tilstand
  // ======================================================================

  const state = {
    portfolio: null, // svar fra /api/portfolio
    settings: {},
    baseCurrency: 'DKK',
    loading: false,
    loadError: null,
    lastFetch: 0,
    sort: JSON.parse(storageGet('sort', 'null')) || { key: 'valueBase', dir: 'desc' },
    filter: '',
    privacy: storageGet('privacy', '0') === '1',
    theme: storageGet('theme', 'system'),
    autoRefresh: storageGet('autoRefresh', '1') === '1',
    range: storageGet('range', '1y'),
    history: {}, // range -> { points, ... } | { error }
    historyLoading: null,
    panelSymbol: null,
    menu: null,
    pending: null, // beholdninger vist før kurserne er hentet
    failures: 0,
    lastAttempt: 0,
    lastManual: 0,
    usesEnvPassword: false,
    storage: 'server', // 'server' (database eller fil) eller 'browser' (localStorage)
    access: 'login', // 'login' = adgangskode kræves | 'open' = åben adgang for alle med adressen | 'browser'
    canSetPassword: false, // åben adgang uden adgangskode: siden kan lukkes herfra
    me: null, // min profil på platformen: { id, name, email, isOwner }
    viewing: null, // ser jeg en andens portefølje? { id, name }
    people: { q: '', results: [], loading: false, loaded: false },
    analytics: { data: null, loaded: false, loading: false },
    // Fremskrivningens felter. null = "brug det, analysen fandt".
    plan: { years: 10, perMonth: null, growth: null },
    inviteCode: null,
    account: storageGet('account', 'all'), // 'all' | 'none' | depot-id
    localImport: null, // data fundet i browserens lager, som kan overføres til kontoen
    allHoldings: [], // alle beholdninger uanset depot-filter (til tilføj/køb til og "Uden depot"-chip)
  };

  const accounts = () => (Array.isArray(state.settings.accounts) ? state.settings.accounts : []);
  const accountName = (id) => (id ? accounts().find((a) => a.id === id)?.name || null : null);
  const accountQuery = () => (state.account !== 'all' ? `?account=${encodeURIComponent(state.account)}` : '');
  const sameSlot = (h, symbol, accountId) => h.symbol === symbol && (h.accountId ?? null) === (accountId ?? null);

  // ======================================================================
  // API
  // ======================================================================

  function api(method, path, body) {
    return state.storage === 'browser' ? localApi(method, path, body) : serverApi(method, path, body);
  }

  async function serverApi(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw new Error('Ingen forbindelse til serveren');
    }
    if (res.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
      throw new Error('Du er logget ud');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error(data?.error || `Serveren svarede ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ======================================================================
  // Browser-tilstand: lokalt "API" i localStorage, når serveren ingen database har.
  // Efterligner serverens endpoints, så resten af appen er uændret. Kurser og
  // beregninger hentes stadig fra serveren (/api/compute, /api/search, /api/quote).
  // ======================================================================

  const LOCAL_KEY = 'portfolio-local-v1';
  const LOCAL_KEY_ARCHIVE = 'portfolio-local-overfoert';
  const HOLDABLE = ['EQUITY', 'ETF', 'MUTUALFUND'];

  function localLoad() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.holdings)) {
          const settings = { baseCurrency: 'DKK', accounts: [], ...(d.settings || {}) };
          if (!Array.isArray(settings.accounts)) settings.accounts = [];
          for (const h of d.holdings) if (h.accountId === undefined) h.accountId = null;
          return { version: 1, settings, holdings: d.holdings };
        }
      }
    } catch {}
    return { version: 1, settings: { baseCurrency: 'DKK', accounts: [] }, holdings: [] };
  }

  function localAccountId(value, list) {
    if (value === null || value === undefined || value === '') return null;
    if (!list.some((a) => a.id === String(value))) throw localErr(400, 'Ukendt depot – opret det først under Indstillinger');
    return String(value);
  }

  function localAccounts(list) {
    if (!Array.isArray(list)) throw localErr(400, 'Depoter skal være en liste');
    if (list.length > 20) throw localErr(400, 'Højst 20 depoter');
    const names = new Set();
    return list.map((raw, i) => {
      const name = String(raw?.name ?? '').trim().slice(0, 40);
      if (!name) throw localErr(400, `Depot nr. ${i + 1} mangler et navn`);
      if (names.has(name.toLowerCase())) throw localErr(400, `Depotet "${name}" findes flere gange`);
      names.add(name.toLowerCase());
      return { id: typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : newLocalId(), name };
    });
  }

  function localHasData() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const d = raw ? JSON.parse(raw) : null;
      return Boolean(d && Array.isArray(d.holdings) && d.holdings.length);
    } catch {
      return false;
    }
  }

  function localSave(data) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
    } catch {
      throw localErr(500, 'Kunne ikke gemme i browseren – er lagring af websteds-data slået fra?');
    }
  }

  const localErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, data: extra });
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const pubHolding = (h) => ({ id: h.id, symbol: h.symbol, name: h.name || h.symbol, currency: h.currency || null, quantity: h.quantity, avgPrice: h.avgPrice ?? null, note: h.note || '', accountId: h.accountId ?? null, purchasedAt: h.purchasedAt ?? null, weightedAt: h.weightedAt ?? null, lots: Array.isArray(h.lots) ? h.lots : null, addedAt: h.addedAt || null, updatedAt: h.updatedAt || null });
  const newLocalId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  function localDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = String(value).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`))) throw localErr(400, 'Købsdatoen skal skrives som åååå-mm-dd');
    if (Date.parse(`${d}T12:00:00Z`) > Date.now() + 86400000) throw localErr(400, 'Købsdatoen kan ikke ligge i fremtiden');
    return d;
  }

  function localLots(value) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) throw localErr(400, 'Købene skal være en liste');
    if (value.length > 100) throw localErr(400, 'Der kan højst registreres 100 køb pr. aktie');
    return value
      .map((raw) => ({
        id: typeof raw?.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : newLocalId(),
        date: localDate(raw?.date),
        quantity: localQty(raw?.quantity),
        price: localPrice(raw?.price),
      }))
      .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
  }

  // Samme regnestykke som på serveren: antal, gennemsnitskurs, første køb og
  // den dato, pengene i gennemsnit blev sat ind.
  const harKurs = (l) => l.price !== null && l.price !== undefined && l.price !== '' && isNum(Number(l.price));

  function localApplyLots(h) {
    const lots = (Array.isArray(h.lots) ? h.lots : []).filter((l) => Number(l.quantity) > 0);
    if (!lots.length) {
      delete h.lots;
      delete h.weightedAt;
      return h;
    }
    let quantity = 0;
    let cost = 0;
    let medKurs = 0;
    for (const l of lots) {
      quantity += Number(l.quantity);
      if (harKurs(l)) { cost += Number(l.quantity) * Number(l.price); medKurs += Number(l.quantity); }
    }
    const medDato = lots.filter((l) => l.date);
    const vægt = (l) => (medKurs > 0 && harKurs(l) ? Number(l.quantity) * Number(l.price) : Number(l.quantity));
    const samlet = medDato.reduce((sum, l) => sum + vægt(l), 0);
    h.quantity = round6(quantity);
    h.avgPrice = medKurs > 0 ? round6(cost / medKurs) : null;
    h.purchasedAt = medDato.length === lots.length ? (medDato.map((l) => l.date).sort()[0] || null) : null;
    h.weightedAt = h.purchasedAt;
    if (samlet > 0 && h.purchasedAt) {
      const ms = medDato.reduce((sum, l) => sum + Date.parse(`${l.date}T12:00:00Z`) * (vægt(l) / samlet), 0);
      if (isNum(ms)) h.weightedAt = new Date(ms).toISOString().slice(0, 10);
    }
    return h;
  }

  // Ved salg skrumper alle køb forholdsmæssigt – gennemsnitsmetoden, som på serveren.
  function localReduceLots(lots, solgt) {
    const liste = (lots || []).filter((l) => Number(l.quantity) > 0);
    const ialt = liste.reduce((sum, l) => sum + Number(l.quantity), 0);
    if (solgt <= 0) return liste;
    if (solgt >= ialt - 1e-9) return [];
    const andel = (ialt - solgt) / ialt;
    return liste.map((l) => ({ ...l, quantity: round6(Number(l.quantity) * andel) })).filter((l) => l.quantity > 0);
  }

  function localQty(value) {
    const n = typeof value === 'number' ? value : parseInput(value);
    if (!isNum(n) || n <= 0) throw localErr(400, 'Antal skal være større end 0');
    return round6(n);
  }

  function localPrice(value, { allowNull = true } = {}) {
    if (value === null || value === undefined || value === '') {
      if (allowNull) return null;
      throw localErr(400, 'Kurs mangler');
    }
    const n = typeof value === 'number' ? value : parseInput(value);
    if (!isNum(n) || n < 0) throw localErr(400, 'Kursen skal være et tal');
    return round6(n);
  }

  async function localApi(method, path, body = {}) {
    const url = new URL(path, location.origin);
    const p = url.pathname;
    const data = localLoad();
    const now = new Date().toISOString();

    if (p === '/api/auth/status') return { authenticated: true, setupRequired: false, setupTokenRequired: false, usesEnvPassword: false, access: 'browser', storage: 'browser' };
    if (p.startsWith('/api/auth/')) return { ok: true };
    const account = url.searchParams.get('account') || '';
    if (p === '/api/portfolio' && method === 'GET') return serverApi('POST', '/api/compute', { holdings: data.holdings, settings: data.settings, account });
    if (p === '/api/portfolio/history') return serverApi('POST', '/api/compute/history', { holdings: data.holdings, settings: data.settings, range: url.searchParams.get('range') || '1y', account });
    if (p === '/api/holdings' && method === 'GET') return { holdings: data.holdings.map(pubHolding), settings: data.settings };

    if (p === '/api/holdings' && method === 'POST') {
      const symbol = String(body.symbol || '').trim().toUpperCase();
      if (!/^[A-Z0-9^][A-Z0-9.\-=^]{0,24}$/.test(symbol)) throw localErr(400, 'Ugyldigt symbol');
      const quantity = localQty(body.quantity);
      const avgPrice = localPrice(body.avgPrice);
      const accountId = localAccountId(body.accountId, data.settings.accounts);
      const existing = data.holdings.find((h) => sameSlot(h, symbol, accountId));
      if (existing) throw localErr(409, `${existing.name || symbol} er allerede i ${accountId ? 'depotet' : 'porteføljen'} – brug "Køb til"`, { id: existing.id });
      if (data.holdings.length >= 100) throw localErr(409, 'Porteføljen kan højst indeholde 100 aktier i browser-tilstand');
      let quote = null;
      let warning = null;
      try {
        quote = (await serverApi('GET', `/api/quote/${encodeURIComponent(symbol)}`)).quote;
      } catch (err) {
        if (err.status === 404) throw localErr(400, `Ukendt symbol "${symbol}" – husk fx .CO for danske aktier`);
        warning = `Kunne ikke hente kurs lige nu (${err.message}). Aktien er tilføjet alligevel.`;
      }
      if (quote?.type && !HOLDABLE.includes(quote.type)) throw localErr(400, "Kun aktier, ETF'er og fonde kan tilføjes");
      const lots = localLots(body.lots);
      const holding = localApplyLots({ id: newLocalId(), symbol, name: quote ? quote.name : String(body.name || symbol).slice(0, 120), currency: quote ? quote.currency : null, quantity, avgPrice, note: String(body.note || '').trim().slice(0, 200), accountId, purchasedAt: localDate(body.purchasedAt), ...(lots ? { lots } : {}), addedAt: now, updatedAt: now });
      data.holdings.push(holding);
      localSave(data);
      return { holding: pubHolding(holding), warning };
    }

    const m = p.match(/^\/api\/holdings\/([^/]+)(\/trade)?$/);
    if (m) {
      const h = data.holdings.find((x) => x.id === decodeURIComponent(m[1]));
      if (!h) throw localErr(404, 'Aktien findes ikke i porteføljen');
      if (m[2] && method === 'POST') {
        const type = body.type === 'sell' ? 'sell' : 'buy';
        const q = localQty(body.quantity);
        const date = localDate(body.date);
        if (type === 'buy') {
          const price = localPrice(body.price, { allowNull: false });
          const oldQty = Number(h.quantity) || 0;
          const førerKøb = Array.isArray(h.lots) && h.lots.length > 0;
          if (førerKøb || date) {
            const lots = førerKøb ? [...h.lots] : (oldQty > 0 ? [{ id: newLocalId(), date: h.purchasedAt ?? null, quantity: oldQty, price: h.avgPrice ?? null }] : []);
            if (lots.length >= 100) throw localErr(409, 'Der kan højst registreres 100 køb pr. aktie');
            lots.push({ id: newLocalId(), date, quantity: q, price });
            h.lots = localLots(lots);
            localApplyLots(h);
          } else {
            const newQty = oldQty + q;
            if (h.avgPrice != null && oldQty > 0) h.avgPrice = round6((oldQty * h.avgPrice + q * price) / newQty);
            else if (oldQty === 0) h.avgPrice = price;
            h.quantity = round6(newQty);
          }
        } else {
          if (q > h.quantity + 1e-9) throw localErr(400, `Du ejer kun ${fmtQty(h.quantity)} stk.`);
          const newQty = round6(h.quantity - q);
          if (newQty <= 0) {
            data.holdings = data.holdings.filter((x) => x !== h);
            localSave(data);
            return { removed: true, holding: pubHolding({ ...h, quantity: 0 }) };
          }
          if (Array.isArray(h.lots) && h.lots.length) {
            h.lots = localReduceLots(h.lots, q);
            localApplyLots(h);
          }
          h.quantity = newQty;
        }
        h.updatedAt = now;
        localSave(data);
        return { removed: false, holding: pubHolding(h) };
      }
      if (method === 'PUT') {
        if (body.quantity !== undefined) h.quantity = localQty(body.quantity);
        if (body.avgPrice !== undefined) h.avgPrice = localPrice(body.avgPrice);
        if (body.note !== undefined) h.note = String(body.note ?? '').trim().slice(0, 200);
        if (body.purchasedAt !== undefined) h.purchasedAt = localDate(body.purchasedAt);
        if (body.lots !== undefined) h.lots = localLots(body.lots) || [];
        if (body.accountId !== undefined) {
          const accountId = localAccountId(body.accountId, data.settings.accounts);
          if (data.holdings.some((x) => x !== h && sameSlot(x, h.symbol, accountId))) throw localErr(409, `${h.name || h.symbol} findes allerede i det depot – brug "Køb til" dér i stedet`);
          h.accountId = accountId;
        }
        localApplyLots(h);
        h.updatedAt = now;
        localSave(data);
        return { holding: pubHolding(h) };
      }
      if (method === 'DELETE') {
        data.holdings = data.holdings.filter((x) => x !== h);
        localSave(data);
        return { ok: true, holding: pubHolding(h) };
      }
    }

    if (p === '/api/settings' && method === 'GET') return { settings: data.settings };
    if (p === '/api/settings' && method === 'PUT') {
      if (body.baseCurrency !== undefined) {
        const c = String(body.baseCurrency).trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(c)) throw localErr(400, 'Ugyldig valuta (brug f.eks. DKK, EUR eller USD)');
        data.settings.baseCurrency = c;
      }
      if (body.displayName !== undefined) data.settings.displayName = String(body.displayName ?? '').trim().slice(0, 40);
      if (body.showDecimals !== undefined) data.settings.showDecimals = Boolean(body.showDecimals);
      if (body.cash !== undefined) data.settings.cash = body.cash == null ? 0 : localPrice(body.cash) ?? 0;
      if (body.accounts !== undefined) {
        data.settings.accounts = localAccounts(body.accounts);
        const ids = new Set(data.settings.accounts.map((a) => a.id));
        for (const h of data.holdings) if (h.accountId && !ids.has(h.accountId)) h.accountId = null;
      }
      localSave(data);
      return { settings: data.settings };
    }
    if (p === '/api/backup') return { ...data, exportedAt: now };
    if (p === '/api/restore' && method === 'POST') {
      if (!Array.isArray(body.holdings)) throw localErr(400, 'Filen indeholder ingen "holdings"-liste');
      if (body.holdings.length > 100) throw localErr(400, 'Højst 100 aktier kan gendannes i browser-tilstand');
      const seen = new Set();
      const restoredAccounts = body.settings && Array.isArray(body.settings.accounts) ? localAccounts(body.settings.accounts) : [];
      const holdings = body.holdings.map((raw, i) => {
        if (!raw || typeof raw !== 'object') throw localErr(400, `Ugyldig post (linje ${i + 1})`);
        const symbol = String(raw.symbol || '').trim().toUpperCase();
        if (!/^[A-Z0-9^][A-Z0-9.\-=^]{0,24}$/.test(symbol)) throw localErr(400, `Ugyldigt symbol (linje ${i + 1})`);
        const accountId = localAccountId(raw.accountId, restoredAccounts);
        const slot = `${symbol}@${accountId ?? ''}`;
        if (seen.has(slot)) throw localErr(400, `Symbolet ${symbol} optræder flere gange i samme depot (linje ${i + 1})`);
        seen.add(slot);
        const lots = localLots(raw.lots);
        return localApplyLots({ id: typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : newLocalId(), symbol, accountId, name: String(raw.name || symbol).slice(0, 120), currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 3) : null, quantity: localQty(raw.quantity), avgPrice: localPrice(raw.avgPrice), note: String(raw.note || '').trim().slice(0, 200), purchasedAt: localDate(raw.purchasedAt), ...(lots ? { lots } : {}), addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : now, updatedAt: now });
      });
      data.holdings = holdings;
      data.settings.accounts = restoredAccounts;
      if (body.settings && typeof body.settings === 'object') {
        const s = body.settings;
        if (s.baseCurrency && /^[A-Za-z]{3}$/.test(String(s.baseCurrency))) data.settings.baseCurrency = String(s.baseCurrency).toUpperCase();
        if (s.cash !== undefined) data.settings.cash = localPrice(s.cash) ?? 0;
        if (s.displayName !== undefined) data.settings.displayName = String(s.displayName ?? '').trim().slice(0, 40);
        if (s.showDecimals !== undefined) data.settings.showDecimals = Boolean(s.showDecimals);
      }
      localSave(data);
      return { ok: true, count: holdings.length, settings: data.settings };
    }
    return serverApi(method, path, body); // søgning, kurs, health
  }

  // ======================================================================
  // Indlæsning
  // ======================================================================

  let refreshTimer = null;
  let inflight = null;
  // Tæller, så et langsomt svar fra en tidligere hentning ikke overskriver et nyere.
  let portfolioSeq = 0;

  // Samtidige kald deles; `fresh: true` venter på det igangværende og henter derefter igen
  // (bruges efter en ændring, så svaret garanteret indeholder ændringen).
  function loadPortfolio(opts = {}) {
    if (inflight) {
      if (!opts.fresh) return inflight;
      return inflight.catch(() => {}).then(() => loadPortfolio({ ...opts, fresh: false }));
    }
    inflight = doLoadPortfolio(opts).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function doLoadPortfolio({ silent = false } = {}) {
    const seq = ++portfolioSeq;
    state.loading = true;
    state.lastAttempt = Date.now();
    if (!silent) setRefreshing(true);
    try {
      // Ser man en andens portefølje, hentes deres – uden ens eget depot-filter.
      const v = state.viewing;
      const data = await api('GET', v ? `/api/users/${encodeURIComponent(v.id)}/portfolio` : `/api/portfolio${accountQuery()}`);
      if (seq !== portfolioSeq) return; // overhalet af en nyere hentning
      if (v && data.person) state.viewing = { id: v.id, name: data.person.name };
      state.portfolio = data;
      state.pending = null;
      state.settings = data.settings || {};
      // Et valgt depot, der ikke findes længere (slettet fra en anden enhed) → tilbage til "Alle".
      if (!state.viewing && state.account !== 'all' && state.account !== 'none' && !accounts().some((a) => a.id === state.account)) {
        setAccount('all', { reload: true });
        return;
      }
      state.baseCurrency = data.baseCurrency;
      state.loadError = null;
      state.failures = 0;
      state.lastFetch = Date.now();
    } catch (err) {
      if (seq !== portfolioSeq) return;
      state.loadError = err.message;
      state.failures += 1;
      if (state.viewing) state.viewingDenied = true; // stop med at prøve igen
      else if (!silent || !state.portfolio) toast(err.message, 'error');
    } finally {
      if (seq === portfolioSeq) {
        state.loading = false;
        setRefreshing(false);
        render({ silent });
        if (state.panelSymbol) renderPanel();
      }
    }
  }

  async function afterMutation() {
    await Promise.all([loadPortfolio({ silent: true, fresh: true }), loadAllHoldings()]);
    invalidateHistory();
  }

  // Har brugeren tidligere brugt browser-tilstand, tilbydes dataene overført til kontoen.
  function checkLocalImport() {
    if (state.storage !== 'server') return;
    if (storageGet('importDismissed', '') === '1') return;
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return;
      const local = JSON.parse(raw);
      if (local && Array.isArray(local.holdings) && local.holdings.length) state.localImport = local;
    } catch {}
  }

  function checkLocalImportForce() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const local = raw ? JSON.parse(raw) : null;
      if (local && Array.isArray(local.holdings) && local.holdings.length) state.localImport = local;
    } catch {}
  }

  async function importLocal() {
    const local = state.localImport;
    if (!local) return;
    const btn = $('[data-action="import-local"]');
    if (btn) btn.disabled = true;
    try {
      // 1) Depoter matches på navn; dem der mangler, oprettes.
      const localAccounts = Array.isArray(local.settings?.accounts) ? local.settings.accounts : [];
      const missing = localAccounts.filter((a) => a?.name && !accounts().some((s) => s.name.toLowerCase() === String(a.name).toLowerCase()));
      if (missing.length) {
        const data = await api('PUT', '/api/settings', { accounts: [...accounts(), ...missing.map((a) => ({ name: String(a.name) }))] });
        state.settings = data.settings;
      }
      const idByName = new Map(accounts().map((a) => [a.name.toLowerCase(), a.id]));
      const mapAccount = (localId) => {
        const name = localAccounts.find((a) => a.id === localId)?.name;
        return name ? idByName.get(String(name).toLowerCase()) || null : null;
      };

      // 2) Kun beholdninger der ikke allerede findes i samme depot – så en gentagelse ikke dublerer.
      const existing = (await api('GET', '/api/holdings')).holdings;
      let added = 0;
      let skipped = 0;
      for (const h of local.holdings) {
        const accountId = mapAccount(h.accountId);
        if (existing.some((x) => sameSlot(x, h.symbol, accountId))) {
          skipped++;
          continue;
        }
        await api('POST', '/api/holdings', { symbol: h.symbol, quantity: h.quantity, avgPrice: h.avgPrice ?? null, note: h.note || '', purchasedAt: h.purchasedAt || null, name: h.name, accountId });
        added++;
      }

      // 3) Kontanter og navn overføres kun, hvis kontoen ikke har dem i forvejen.
      const patch = {};
      if (!state.settings.cash && local.settings?.cash) patch.cash = local.settings.cash;
      if (!state.settings.displayName && local.settings?.displayName) patch.displayName = local.settings.displayName;
      if (Object.keys(patch).length) state.settings = (await api('PUT', '/api/settings', patch)).settings;

      // 4) Behold en kopi i browseren som sikkerhedsnet, men stop med at bruge den.
      try {
        localStorage.setItem(LOCAL_KEY_ARCHIVE, JSON.stringify(local));
        localStorage.removeItem(LOCAL_KEY);
      } catch {}
      state.localImport = null;
      toast(added ? `${added} ${added === 1 ? 'aktie' : 'aktier'} overført til din konto${skipped ? `, ${skipped} fandtes allerede` : ''}` : 'Alt lå allerede i din konto', 'success');
      await afterMutation();
    } catch (err) {
      toast(err.message, 'error');
      if (btn) btn.disabled = false;
    }
  }

  // Depot-linjen afhænger af, om der findes aktier uden depot. Gentegn kun når det ændrer sig,
  // så en baggrundshentning ikke river grafen ned midt i en interaktion.
  const accountBarSignature = () => `${accounts().map((a) => a.id + a.name).join('|')}#${state.allHoldings.some((h) => !h.accountId)}`;

  async function loadAllHoldings() {
    const before = accountBarSignature();
    try {
      const data = await api('GET', '/api/holdings');
      state.allHoldings = data.holdings || [];
    } catch {
      return;
    }
    if (accountBarSignature() !== before) render();
  }

  function setAccount(id, { reload = true } = {}) {
    state.account = id;
    storageSet('account', id);
    state.history = {};
    render();
    if (reload) loadPortfolio({ fresh: true });
  }

  const historyReq = {};

  // Ændrer beholdningen sig (også fra en anden enhed), skal grafen beregnes igen.
  function historyKey() {
    return `${state.baseCurrency}|${state.account}|${positions().map((p) => `${p.symbol}:${p.quantity}`).sort().join(',')}`;
  }

  async function loadHistory(range, { force = false } = {}) {
    const cached = state.history[range];
    if (!force && cached && !cached.error && cached.key === historyKey()) return;
    const seq = (historyReq[range] = (historyReq[range] || 0) + 1);
    state.historyLoading = range;
    if (!cached || cached.error) renderChartCard();
    let result;
    try {
      const key = historyKey();
      result = await api('GET', `/api/portfolio/history?range=${encodeURIComponent(range)}${state.account !== 'all' ? `&account=${encodeURIComponent(state.account)}` : ''}`);
      result.fetchedAt = Date.now();
      result.key = key;
    } catch (err) {
      result = { error: err.message };
    }
    if (historyReq[range] !== seq) return; // overhalet af et nyere kald
    state.history[range] = result;
    if (state.historyLoading === range) state.historyLoading = null;
    renderChartCard();
  }

  function setRefreshing(on) {
    $$('[data-action="refresh"]').forEach((b) => b.classList.toggle('is-loading', on));
  }

  // 60 s mens en børs er åben, 5 min når alle er lukket; fordobles ved fejl (maks 10 min).
  function refreshInterval() {
    if (!state.portfolio) return 30_000; // intet vist endnu: prøv igen hurtigt
    const open = state.portfolio?.totals?.anyMarketOpen;
    let ms = open ? REFRESH_MS : 5 * 60_000;
    if (state.failures) ms = Math.min(10 * 60_000, ms * 2 ** state.failures);
    return ms;
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!state.autoRefresh || document.hidden || state.importing) return;
      if (state.viewingDenied) return; // en profil man ikke må se, prøves ikke igen
      if (Date.now() - state.lastAttempt >= refreshInterval()) {
        loadPortfolio({ silent: true });
        const h = state.history[state.range];
        if (h && !h.error && Date.now() - (h.fetchedAt || 0) > 15 * 60_000) loadHistory(state.range, { force: true });
      } else if (state.portfolio && Date.now() - state.lastFetch > 5 * 60_000) {
        renderSidebarStatus();
      }
    }, 5000);
  }

  function manualRefresh() {
    if (Date.now() - state.lastManual < 10_000) {
      toast('Vent lidt – kurserne blev lige hentet. Yahoo blokerer ved for mange kald.');
      return;
    }
    state.lastManual = Date.now();
    loadPortfolio();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.autoRefresh && Date.now() - state.lastFetch > 20_000) loadPortfolio({ silent: true });
  });

  // ======================================================================
  // Routing
  // ======================================================================

  const ROUTES = { '/': 'overview', '/beholdninger': 'holdings', '/indstillinger': 'settings', '/folk': 'people', '/analyse': 'analytics' };
  const TITLES = { overview: 'Overblik', holdings: 'Beholdninger', settings: 'Indstillinger', people: 'Folk', person: 'Profil', analytics: 'Analyse' };
  const PERSON_PATH = /^\/profil\/([^/]+)$/;

  const personIdFromPath = () => PERSON_PATH.exec(location.pathname)?.[1] || null;

  function currentRoute() {
    if (personIdFromPath()) return 'person';
    return ROUTES[location.pathname] || 'overview';
  }

  function navigate(path) {
    if (!(path in ROUTES) && !PERSON_PATH.test(path)) path = '/';
    if (location.pathname !== path) history.pushState({}, '', path);
    closeMenu();
    closePanel();
    render();
    window.scrollTo({ top: 0 });
  }

  window.addEventListener('popstate', () => {
    closePanel();
    render();
  });

  // Sørger for, at siden har de data, den viser. Kaldes ved hver tegning, men
  // henter kun når noget rent faktisk mangler.
  function routeData(route) {
    if (route === 'person') {
      const id = personIdFromPath();
      if (id) viewPerson(id);
      return;
    }
    if (state.viewing) stopViewing();
    if (route === 'people' && state.access === 'platform' && !state.people.loaded && !state.people.loading) loadPeople('');
    if (route === 'analytics' && !state.analytics.loaded && !state.analytics.loading) loadAnalytics();
  }

  // ======================================================================
  // Rendering
  // ======================================================================

  function render({ silent = false } = {}) {
    const route = currentRoute();
    routeData(route);
    document.title = `${TITLES[route]} – Min Portefølje`;
    $$('[data-nav]').forEach((a) => {
      const active = ROUTES[a.dataset.nav] === route;
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    // Afbryd ikke brugeren midt i et felt ved en stille baggrundsopdatering.
    const active = document.activeElement;
    if (silent && active && active !== document.body && $('#page')?.contains(active)) {
      renderSidebarStatus();
      return;
    }
    const page = $('#page');
    if (route === 'overview') page.innerHTML = renderOverview();
    else if (route === 'holdings') page.innerHTML = renderHoldings();
    else if (route === 'people') page.innerHTML = renderPeople();
    else if (route === 'analytics') page.innerHTML = renderAnalytics();
    else if (route === 'person') page.innerHTML = renderPerson();
    else page.innerHTML = renderSettings();
    if (route === 'overview') afterRenderOverview();
    renderSidebarStatus();
    document.body.classList.toggle('private', state.privacy);
    // "Tilføj aktie" ville lægge i ens egen portefølje – forvirrende mens man ser en andens.
    document.body.classList.toggle('viewing-person', Boolean(state.viewing));
    $$('[data-action="privacy"]').forEach((b) => {
      const label = state.privacy ? 'Vis beløb' : 'Skjul beløb';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', String(state.privacy));
      b.querySelector('use')?.setAttribute('href', state.privacy ? '#i-eye-off' : '#i-eye');
    });
  }

  function renderSidebarStatus() {
    const el = $('#sidebar-status');
    if (!el) return;
    const p = state.portfolio;
    if (!p) {
      el.textContent = state.loadError ? 'Kunne ikke hente kurser' : 'Henter kurser…';
      return;
    }
    const chip = freshness();
    el.innerHTML = `<span class="market-dot ${chip.cls}"></span> ${esc(chip.text)}<br>${p.totals.positionCount} ${p.totals.positionCount === 1 ? 'aktie' : 'aktier'} · ${esc(state.baseCurrency)}`;
  }

  function positions() {
    if (state.portfolio) return state.portfolio.positions;
    if (state.pending) return state.pending;
    return [];
  }

  // Yahoo's børsnavne → danske
  const EXCHANGE_NAMES = {
    Copenhagen: 'København', CPH: 'København', NasdaqGS: 'New York', NasdaqGM: 'New York', NasdaqCM: 'New York', NYSE: 'New York',
    'NYSE Arca': 'New York', 'NYSE American': 'New York', NYQ: 'New York', NMS: 'New York', Stockholm: 'Stockholm', STO: 'Stockholm',
    Oslo: 'Oslo', OSL: 'Oslo', Helsinki: 'Helsinki', HEL: 'Helsinki', XETRA: 'Frankfurt', Frankfurt: 'Frankfurt', GER: 'Frankfurt',
    Amsterdam: 'Amsterdam', AMS: 'Amsterdam', LSE: 'London', London: 'London', Paris: 'Paris', PAR: 'Paris', Zurich: 'Zürich',
    Toronto: 'Toronto', 'Swiss Exchange': 'Zürich', Milan: 'Milano', Madrid: 'Madrid', Tokyo: 'Tokyo', 'Hong Kong': 'Hongkong',
  };
  const exchangeName = (ex) => EXCHANGE_NAMES[ex] || ex || 'Ukendt børs';

  // Én samlet friskheds-status: { cls: 'open'|'closed'|'warn'|'error', text }
  function freshness() {
    const p = state.portfolio;
    if (!p) return state.loadError ? { cls: 'error', text: 'Kunne ikke hente kurser' } : { cls: 'closed', text: 'Henter kurser…' };
    const pos = p.positions;
    const t = p.totals;
    if (pos.length && t.errorCount === pos.length) return { cls: 'error', text: 'Ingen forbindelse til Yahoo Finance' };
    if (state.loadError) return { cls: 'warn', text: `Kunne ikke opdatere · viser tal fra kl. ${fmtTime(p.updatedAt)}` };
    if (t.hasStale) {
      const s = pos.find((x) => x.status === 'stale');
      return { cls: 'warn', text: `Forældede kurser${s?.fetchedAt ? ` · fra ${fmtDateTime(s.fetchedAt)}` : ''}` };
    }
    const ageMin = Math.floor((Date.now() - state.lastFetch) / 60_000);
    if (ageMin >= 5) return { cls: 'warn', text: `Opdateret for ${ageMin} min siden` };
    const known = pos.filter((x) => x.marketOpen === true || x.marketOpen === false);
    if (!known.length) return { cls: 'closed', text: `Opdateret kl. ${fmtTime(p.updatedAt)}` };
    const byEx = new Map();
    for (const x of known) {
      const name = exchangeName(x.exchange);
      const e = byEx.get(name) || { open: 0, closed: 0 };
      if (x.marketOpen) e.open++;
      else e.closed++;
      byEx.set(name, e);
    }
    const list = [...byEx.entries()].map(([name, e]) => ({ name, open: e.open >= e.closed }));
    const openCount = list.filter((e) => e.open).length;
    if (openCount === 0) {
      const last = known.map((x) => x.marketTime).filter(Boolean).sort().at(-1);
      return { cls: 'closed', text: `Markederne er lukket${last ? ` · kurser fra ${fmtDateTime(last)}` : ''}` };
    }
    const text = list.length <= 3 ? list.map((e) => `${e.name} ${e.open ? 'åben' : 'lukket'}`).join(' · ') : `${openCount} af ${list.length} børser åbne`;
    return { cls: 'open', text };
  }

  function greeting() {
    const hour = Number(new Intl.DateTimeFormat('da-DK', { hour: 'numeric', hour12: false, timeZone: 'Europe/Copenhagen' }).format(new Date()));
    const word = hour < 5 ? 'Godnat' : hour < 10 ? 'Godmorgen' : hour < 18 ? 'Goddag' : 'Godaften';
    const name = (state.me?.name || state.settings.displayName || '').trim();
    return name ? `${word}, ${name}` : 'Overblik';
  }

  function marketPill() {
    if (!state.portfolio || !state.portfolio.positions.length) return '';
    const f = freshness();
    return `<span class="status-pill ${f.cls}" role="status"><span class="dot"></span>${esc(f.text)}</span>`;
  }

  function allMarketsClosed() {
    const pos = positions();
    return pos.length > 0 && pos.some((x) => x.marketOpen === false) && !pos.some((x) => x.marketOpen === true);
  }

  function pageHeader(title, sub, actions = '') {
    return `<div class="page-header">
      <div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div>
      <div class="page-actions">${actions}</div>
    </div>`;
  }

  // Chips til at vælge depot (vises kun når der findes depoter).
  function accountBar() {
    const list = accounts();
    if (!list.length) return '';
    const hasUnassigned = state.allHoldings.some((h) => !h.accountId);
    const chip = (id, label) => `<button type="button" class="chip-btn${state.account === id ? ' active' : ''}" data-account="${esc(id)}" aria-pressed="${state.account === id}">${esc(label)}</button>`;
    return `<div class="account-bar" role="group" aria-label="Depot">${chip('all', 'Alle depoter')}${list.map((a) => chip(a.id, a.name)).join('')}${hasUnassigned || state.account === 'none' ? chip('none', 'Uden depot') : ''}</div>`;
  }

  function currentAccountLabel() {
    if (state.account === 'none') return 'Uden depot';
    return accountName(state.account) || '';
  }

  function headerActions({ add = true } = {}) {
    return `
      <button class="btn btn-ghost btn-icon" data-action="privacy" title="${state.privacy ? 'Vis beløb' : 'Skjul beløb'}" aria-label="${state.privacy ? 'Vis beløb' : 'Skjul beløb'}" aria-pressed="${state.privacy}">${icon(state.privacy ? 'eye-off' : 'eye')}</button>
      <button class="btn btn-ghost btn-icon${state.loading ? ' is-loading' : ''}" data-action="refresh" title="Opdatér kurser" aria-label="Opdatér kurser">${icon('refresh')}</button>
      ${add ? `<button class="btn btn-primary" data-action="add">${icon('plus')}<span>Tilføj aktie</span></button>` : ''}`;
  }

  function browserModePill() {
    if (state.storage === 'browser') return '<span class="status-pill" title="Serveren har ingen database, så dine aktier gemmes kun i denne browser. Se Indstillinger.">💾 Gemt i denne browser</span>';
    if (state.access === 'open') return '<span class="status-pill" title="Porteføljen ligger i databasen, så du ser den samme uanset enhed og browser.">☁️ Synkroniseret</span>';
    return '';
  }

  function updatedSub() {
    const p = state.portfolio;
    if (!p) return state.loadError ? '<span class="status-pill error" role="status"><span class="dot"></span>Kunne ikke hente kurser</span>' : '<span>Henter kurser…</span>';
    return `<span>Opdateret kl. ${esc(fmtTime(p.updatedAt))}</span>${marketPill()}${browserModePill()}`;
  }

  function banners() {
    const p = state.portfolio;
    const out = [];
    if (state.localImport) {
      const n = state.localImport.holdings.length;
      out.push(`<div class="banner info">${icon('upload')}<div><b>${n} ${n === 1 ? 'aktie' : 'aktier'} ligger gemt i denne browser.</b> Overfør dem til din konto, så de følger med på alle dine enheder. <span class="banner-actions"><button class="btn btn-sm btn-primary" data-action="import-local">Overfør</button> <button class="btn btn-sm" data-action="import-dismiss">Ikke nu</button></span></div></div>`);
    }
    if (state.canSetPassword && !storageGet('open-dismissed', '')) {
      out.push(`<div class="banner info">${icon('lock')}<div><b>Siden er åben for alle, der kender adressen.</b> Opret en adgangskode, hvis kun du skal kunne se og ændre din portefølje. <span class="banner-actions"><button class="btn btn-sm btn-primary" data-action="setup-password">Opret adgangskode</button> <button class="btn btn-sm" data-action="open-dismiss">Ikke nu</button></span></div></div>`);
    }
    if (state.loadError && !p) {
      out.push(`<div class="banner error">${icon('warn')}<div><b>Kunne ikke hente kurser.</b> ${esc(state.loadError)}. <a href="#" data-action="refresh">Prøv igen</a></div></div>`);
    }
    if (state.loadError && p) {
      out.push(`<div class="banner error">${icon('warn')}<div><b>Kunne ikke opdatere kurserne.</b> ${esc(state.loadError)}. Viser tal fra kl. ${esc(fmtTime(p.updatedAt))}. <a href="#" data-action="refresh">Prøv igen</a></div></div>`);
    }
    if (!p) return out.join('');
    const errors = p.positions.filter((x) => x.status === 'error' || x.status === 'fx_error');
    if (errors.length) {
      const list = errors.map((x) => `${esc(x.symbol)} (${esc(x.error?.message || 'ingen kurs')})`).join(', ');
      out.push(`<div class="banner">${icon('warn')}<div><b>${errors.length === 1 ? '1 aktie mangler kurs' : `${errors.length} aktier mangler kurs`}</b> – totalerne er ufuldstændige. ${list}</div></div>`);
    }
    const stale = p.positions.filter((x) => x.status === 'stale');
    if (stale.length) {
      out.push(`<div class="banner">${icon('info')}<div><b>Kunne ikke hente nye kurser for ${stale.map((x) => esc(x.symbol)).join(', ')}.</b> Viser seneste kendte kurs${stale[0].fetchedAt ? ` fra ${esc(fmtDateTime(stale[0].fetchedAt))}` : ''}.</div></div>`);
    }
    return out.join('');
  }

  // ---------- Overblik ----------

  // "3 år og 2 md." læses lettere end "1157 dage".
  function ejertid(dage) {
    if (!isNum(dage)) return '';
    if (dage < 1) return 'i dag';
    if (dage === 1) return '1 dag';
    if (dage < 45) return `${dage} dage`;
    const måneder = Math.round(dage / 30.44);
    if (måneder < 24) return `${måneder} md.`;
    const år = Math.floor(måneder / 12);
    const rest = måneder % 12;
    return rest ? `${år} år og ${rest} md.` : `${år} år`;
  }

  // Sætter punktum, medmindre teksten allerede ender på et.
  const punktum = (t) => (/[.!?]$/.test(String(t).trim()) ? t : `${t}.`);

  const AFKAST_TOOLTIP = 'Kursafkast i forhold til din gns. købskurs, omregnet til basisvalutaen med dagens valutakurs. Valutaudsving siden købet indgår ikke.';

  function renderOverview() {
    const p = state.portfolio;
    const t = p?.totals;
    const todayLabel = allMarketsClosed() ? 'Seneste handelsdag' : 'I dag';
    const kpi = (label, value, sub = '', cls = '', title = '') => `<div class="card kpi ${cls}"><div class="kpi-label" ${title ? `title="${esc(title)}"` : ''}>${label}</div><div class="kpi-value ${p ? '' : 'skeleton'}">${value}</div><div class="kpi-sub">${sub}</div></div>`;

    let kpis;
    if (!p) {
      kpis = [kpi('Porteføljeværdi', '000.000 kr.', '', 'kpi-hero'), kpi('I dag', '0.000 kr.'), kpi('Samlet afkast', '0.000 kr.'), kpi('Investeret', '000.000 kr.')].join('');
    } else {
      const pill = (n) => (isNum(n) ? `<span class="pill ${signClass(n)}">${fmtPct(n)}</span>` : '');
      const noQuote = t.errorCount;
      const noCost = p.positions.filter((x) => x.valueBase != null && x.costBase == null).length;
      const excl = (n, what) => (n ? `<span class="muted">· ekskl. ${n} ${n === 1 ? 'aktie' : 'aktier'} ${what}</span>` : '');
      const lastTrade = p.positions.map((x) => x.marketTime).filter(Boolean).sort().at(-1);
      kpis = [
        kpi(state.account === 'all' ? 'Porteføljeværdi' : `Værdi · ${esc(currentAccountLabel())}`, `<span class="amount">${fmtAmount(t.totalValueBase ?? t.valueBase)}</span>`,
          `<span>${t.positionCount} ${t.positionCount === 1 ? 'aktie' : 'aktier'}${t.cashBase ? ` · heraf kontanter <span class="amount">${fmtAmount(t.cashBase)}</span>` : ''}</span>${excl(noQuote, 'uden kurs')}`,
          'kpi-hero', 'Antal × kurs for alle aktier, omregnet til basisvalutaen med dagens valutakurs' + (t.cashBase ? ', plus kontanter' : '')),
        kpi(todayLabel, `<span class="amount ${signClass(t.dayChangeBase)}">${fmtAmount(t.dayChangeBase, state.baseCurrency, { sign: true })}</span>`,
          `${pill(t.dayChangePercent)}<span>${todayLabel === 'I dag' ? 'siden forrige lukkekurs' : lastTrade ? `handlet ${fmtDateTime(lastTrade)}` : 'siden forrige lukkekurs'}</span>`,
          '', 'Ændring i forhold til forrige lukkekurs på aktiens egen børs'),
        kpi('Samlet afkast', `<span class="amount ${signClass(t.gainBase)}">${fmtAmount(t.gainBase, state.baseCurrency, { sign: true })}</span>`,
          `${pill(t.gainPercent)}<span>urealiseret, siden køb</span>${excl(noCost, 'uden købskurs')}`, '', AFKAST_TOOLTIP),
        kpi('Investeret', `<span class="amount">${fmtAmount(t.costBase)}</span>`, `<span>købskurs × antal, til dagens valutakurs</span>${excl(noCost, 'uden købskurs')}`, '', 'Gns. købskurs × antal for alle aktier med kendt købskurs, omregnet med dagens valutakurs'),
      ].join('');
    }

    const empty = p ? p.positions.length === 0 : state.pending ? state.pending.length === 0 : false;
    return `
      ${pageHeader(greeting(), updatedSub(), headerActions())}
      ${accountBar()}
      ${banners()}
      <div class="grid grid-kpi">${kpis}</div>
      ${empty ? emptyState() : `
      <div class="grid grid-2">
        <div class="card" id="chart-card">${chartCardInner()}</div>
        <div class="stack">
          <div class="card">${allocationCardInner()}</div>
          <div class="card">${moversCardInner()}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h2>${icon('briefcase')}Beholdning</h2><a href="/beholdninger" data-link class="small">Administrér →</a></div>
        ${holdingsTable({ compact: true })}
      </div>`}
      <p class="footer-note">Kurser fra Yahoo Finance – kan være op til 15 min. forsinkede. Beløb i ${esc(state.baseCurrency)}. Ikke investeringsrådgivning.</p>`;
  }

  function afterRenderOverview() {
    if (state.portfolio && state.portfolio.positions.length) {
      loadHistory(state.range);
      renderChartCard();
    }
  }

  function emptyState() {
    const chips = ['Novo Nordisk', 'Mærsk', 'Apple', 'MSCI World'].map((q) => `<button class="chip-btn" data-action="add" data-query="${esc(q)}">${esc(q)}</button>`).join('');
    return `<div class="card"><div class="empty">${icon('briefcase')}<h3>Din portefølje er tom</h3><p>Tilføj din første aktie for at se værdi, dagens bevægelse og afkast.</p><button class="btn btn-primary" data-action="add">${icon('plus')}Tilføj din første aktie</button><div class="chip-row"><span class="muted small">Prøv f.eks.</span>${chips}</div></div></div>`;
  }

  // ---------- Graf ----------

  function chartCardInner() {
    const pills = RANGES.map((r) => `<button type="button" data-range="${r.key}" class="${r.key === state.range ? 'active' : ''}">${r.label}</button>`).join('');
    return `<div class="card-header"><h2>${icon('chart')}Udvikling <span class="hint">ca.</span></h2><div class="range-pills">${pills}</div></div>
      <div id="chart-summary" class="chart-summary"></div>
      <div class="chart-box" id="chart-box"></div>
      <div class="chart-legend"><span><i></i>Porteføljeværdi</span><span class="chart-invested-key"><i class="dashed"></i>Investeret</span><span class="chart-events-key hidden"><i class="dot"></i>Køb</span></div>
      <div class="chart-notes" id="chart-notes"></div>`;
  }

  function renderChartCard() {
    const box = $('#chart-box');
    const summary = $('#chart-summary');
    if (!box) return;
    $$('#chart-card [data-range]').forEach((b) => b.classList.toggle('active', b.dataset.range === state.range));
    const h = state.history[state.range];
    if (!h) {
      box.innerHTML = `<div class="chart-msg">Henter historik…</div>`;
      summary.innerHTML = '';
      return;
    }
    if (h.error) {
      box.innerHTML = `<div class="chart-msg">Kunne ikke hente historik: ${esc(h.error)}</div>`;
      summary.innerHTML = '';
      return;
    }
    if (!h.points || h.points.length < 2) {
      box.innerHTML = `<div class="chart-msg">Ikke nok historik til at tegne en graf${h.missing?.length ? ` (${h.missing.map((m) => esc(m.symbol)).join(', ')} mangler data)` : ''}.</div>`;
      summary.innerHTML = '';
      return;
    }
    const first = h.points[0];
    const last = h.points[h.points.length - 1];
    // Kurven stiger også, når man køber til, og det er ikke afkast. Kender vi
    // det indsatte, trækkes det fra i begge ender, så tallet kun er det,
    // markedet gav i perioden. Ellers vises den rå bevægelse som før.
    const medIndskud = isNum(last.invested) && last.invested > 0 && isNum(first.invested);
    const diff = medIndskud
      ? (last.value - last.invested) - (first.value - first.invested)
      : last.value - first.value;
    const pct = medIndskud
      ? (diff / last.invested) * 100
      : (first.value ? (diff / first.value) * 100 : null);
    summary.innerHTML = `<span class="big amount">${fmtAmount(last.value)}</span>`
      + `<span class="${signClass(diff)}"><span class="amount">${fmtAmount(diff, state.baseCurrency, { sign: true })}</span> (${fmtPct(pct)})</span>`
      + `<span class="muted small">i ${medIndskud ? 'afkast' : 'kursbevægelse'} siden ${esc(fmtDate(first.date, { year: longRange() }))}`
      + `${state.historyLoading === state.range ? ' · opdaterer…' : ''}</span>`;
    drawChart(box, h.points, h.events || []);
    renderChartNotes(h);
  }

  const longRange = () => ['1y', '2y', '5y', 'max'].includes(state.range);

  // Alt det, grafen ikke selv kan vise: hvad kurven egentlig er, hvorfor perioden
  // kan være kortere end knappen, og hvad der eventuelt mangler.
  function renderChartNotes(h) {
    const el = $('#chart-notes');
    if (!el) return;
    const noter = [];
    // Kurven bygger på købsdatoerne, når de er der. Mangler de, kan vi kun vise
    // dagens antal hele vejen – og det skal siges, for så er den ikke historisk.
    const udenDato = state.portfolio?.positions?.filter((p) => !p.purchasedAt).length || 0;
    if (udenDato) {
      noter.push(`For ${udenDato === 1 ? 'én beholdning' : `${udenDato} beholdninger`} mangler købsdatoen, så ${udenDato === 1 ? 'den regnes' : 'de regnes'} med i hele perioden – også før du ejede ${udenDato === 1 ? 'den' : 'dem'}. Skriv datoen ind under Redigér, så bliver kurven rigtig.`);
    } else {
      noter.push('Kurven viser, hvad du <b>faktisk ejede hver dag</b>. Køber du til, stiger den – den del er ikke afkast. Den stiplede linje er det, du har lagt ind, så afstanden mellem de to er dit afkast.');
      if (h.events?.length) {
        noter.push(`Prikkerne er dine køb – ${h.events.length === 1 ? 'der er ét' : `der er ${h.events.length}`} i perioden. Kør hen over kurven (eller tryk på den) for at se hvad og for hvor meget. Salg kan ikke vises: dem gemmer appen ikke, de skrumper bare købene.`);
      }
    }
    // Er perioden klippet til første køb, skal det stå – ellers ser det ud som
    // om knappen ikke virkede, når 6M og 1Å viser det samme.
    if (h.ownedFrom) {
      noter.push(`Kurven starter ved dit <b>første køb ${esc(fmtDate(h.ownedFrom, { year: true }))}</b> – før det ejede du ikke noget. Vælger du en længere periode, ændrer det derfor ikke kurven.`);
    }
    if (h.backfilled?.length) {
      const liste = h.backfilled.map((b) => `<b>${esc(b.symbol)}</b> (før ${esc(fmtDate(b.from, { year: true }))})`).join(', ');
      noter.push(`Yahoo har ikke kurser så langt tilbage for ${liste}. Der regnes med den første kurs, som findes – så kurven dækker hele perioden, men bevæger sig lidt mindre i den ældste del.`);
    }
    if (h.fxToday?.length) {
      noter.push(`Historiske valutakurser kunne ikke hentes for ${esc(h.fxToday.join(', '))} – de dage er omregnet med dagens kurs.`);
    }
    if (h.missing?.length) {
      noter.push(`Ikke med i kurven: ${h.missing.map((m) => `<b>${esc(m.symbol)}</b> (${esc(m.error)})`).join(', ')}.`);
    }
    if (state.investedOffChart) {
      noter.push('Investeret ligger uden for grafens skala og er ikke tegnet.');
    }
    el.innerHTML = noter.map((n) => `<p>${n}</p>`).join('');
  }

  function drawChart(box, points, events = []) {
    const W = Math.max(280, box.clientWidth || 600);
    const H = box.clientHeight || 240;
    const padL = 8, padR = 8, padT = 14, padB = 26;
    const values = points.map((p) => p.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    // Investeret er en trappe: den stiger den dag, der blev lagt penge ind.
    const inv = points.map((p) => p.invested);
    const harInv = inv.every(isNum) && Math.max(...inv) > 0;
    // Linjen må gerne udvide skalaen lidt, men ikke mase kurven flad. Ligger
    // den længere væk end halvdelen af kurvens eget udsving, udelades den.
    const spread = Math.max(max - min, Math.abs(max) * 0.005);
    const invMin = harInv ? Math.min(...inv.filter((v) => v > 0)) : null;
    const invMax = harInv ? Math.max(...inv) : null;
    const showInvested = harInv && invMax > min - spread * 0.5 && invMin < max + spread * 0.5;
    state.investedOffChart = harInv && !showInvested;
    if (showInvested) {
      min = Math.min(min, invMin);
      max = Math.max(max, invMax);
    }
    if (max === min) { max += 1; min -= 1; }
    const span = max - min;
    min -= span * 0.08;
    max += span * 0.08;
    const t0 = Date.parse(points[0].date);
    const t1 = Date.parse(points[points.length - 1].date);
    const x = (date) => padL + ((Date.parse(date) - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);

    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const area = `${path} L${x(points[points.length - 1].date).toFixed(1)},${(H - padB).toFixed(1)} L${x(points[0].date).toFixed(1)},${(H - padB).toFixed(1)} Z`;

    const gridLines = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = min + ((max - min) * i) / steps;
      const yy = y(v).toFixed(1);
      gridLines.push(`<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="var(--chart-grid)" stroke-width="1"/>`);
      // Tallet får en kant i baggrundsfarven, så det kan læses oven på kurven.
      if (i > 0 && i < steps) gridLines.push(`<text x="${W - padR}" y="${yy - 3}" text-anchor="end" font-size="10" fill="var(--muted)" stroke="var(--surface)" stroke-width="3" paint-order="stroke" class="amount">${esc(fmtCompact(v))}</text>`);
    }
    const labelCount = W < 480 ? 3 : 5;
    const xLabels = [];
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.round(((points.length - 1) * i) / (labelCount - 1));
      const p = points[idx];
      const anchor = i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle';
      xLabels.push(`<text x="${x(p.date).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" font-size="10" fill="var(--muted)">${esc(fmtDate(p.date, { year: longRange() }))}</text>`);
    }
    // Trappen tegnes vandret frem til købsdagen og så lodret op – ikke skråt,
    // for pengene kom ind på én dag.
    const investedLine = showInvested
      ? `<path d="${points.map((p, i) => (i ? `H${x(p.date).toFixed(1)} V${y(p.invested).toFixed(1)}` : `M${x(p.date).toFixed(1)},${y(p.invested).toFixed(1)}`)).join(' ')}" fill="none" stroke="var(--chart-invested)" stroke-width="1.5" stroke-dasharray="5 4"/>`
      : '';
    $$('.chart-invested-key').forEach((el) => el.classList.toggle('hidden', !showInvested));

    // Et køb kan falde i en weekend; markøren sættes på første børsdag derefter,
    // altså samme dag som hoppet i kurven.
    const påIndex = new Map();
    for (const ev of events) {
      let i = points.findIndex((p) => p.date >= ev.date);
      if (i < 0) i = points.length - 1;
      if (!påIndex.has(i)) påIndex.set(i, []);
      påIndex.get(i).push(ev);
    }
    $$('.chart-events-key').forEach((el) => el.classList.toggle('hidden', påIndex.size === 0));
    const markører = [...påIndex.keys()].map((i) => {
      const p = points[i];
      return `<circle class="chart-event" cx="${x(p.date).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4" fill="var(--surface)" stroke="var(--chart-line)" stroke-width="2"/>`;
    }).join('');

    const last = points[points.length - 1];
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="chart-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--chart-line)" stop-opacity="0.22"/><stop offset="1" stop-color="var(--chart-line)" stop-opacity="0"/></linearGradient></defs>
      ${gridLines.join('')}
      <path d="${area}" fill="url(#chart-grad)"/>
      ${investedLine}
      <path d="${path}" fill="none" stroke="var(--chart-line)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${markører}
      <circle cx="${x(last.date).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="3.5" fill="var(--chart-line)" stroke="var(--surface)" stroke-width="2"/>
      <line id="chart-cursor" x1="0" x2="0" y1="${padT}" y2="${H - padB}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>
      <circle id="chart-dot" r="4" fill="var(--chart-line)" stroke="var(--surface)" stroke-width="2" style="display:none"/>
      ${xLabels.join('')}
    </svg><div class="chart-tip" id="chart-tip" style="display:none"></div>`;

    const svg = $('svg', box);
    const tip = $('#chart-tip', box);
    const cursor = $('#chart-cursor', box);
    const dot = $('#chart-dot', box);
    const xs = points.map((p) => x(p.date));
    const move = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * W;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < xs.length; i++) {
        const d = Math.abs(xs[i] - px);
        if (d < bestD) { bestD = d; best = i; }
      }
      const p = points[best];
      const cx = xs[best];
      const cy = y(p.value);
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.style.display = '';
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.style.display = '';
      // Afkast den dag: værdien mod det, der faktisk var lagt ind indtil da.
      const afkast = isNum(p.invested) && p.invested > 0 ? p.value - p.invested : null;
      // Blev der købt den dag, står hvad og for hvor meget – det forklarer hoppet.
      const køb = (påIndex.get(best) || []).flatMap((ev) => ev.items).map((i) => {
        const beløb = i.amount > 0
          ? `for <b>${fmtPrice(i.amount)} ${esc(i.currency || '')}</b>${i.currency && i.currency !== state.baseCurrency ? ` (${fmtAmount(i.amountBase)})` : ''}`
          : '';
        return `<span class="tip-event">Købt ${fmtQty(i.quantity)} stk. ${esc(i.name)} ${beløb}</span>`;
      }).join('');
      tip.innerHTML = `${esc(fmtDate(p.date, { year: true }))}<b class="amount">${fmtAmount(p.value)}</b>`
        + (afkast == null
          ? `<span class="amount">${fmtAmount(p.value - points[0].value, state.baseCurrency, { sign: true })}</span> siden start`
          : `<span class="amount ${signClass(afkast)}">${fmtAmount(afkast, state.baseCurrency, { sign: true })}</span> af ${fmtAmount(p.invested)} indsat`)
        + køb;
      tip.style.display = '';
      const halv = Math.min(tip.offsetWidth / 2 + 4, rect.width / 2);
      const leftPx = clamp((cx / W) * rect.width, halv, rect.width - halv);
      tip.style.left = `${leftPx}px`;
      tip.style.top = `${(cy / H) * rect.height - 10}px`;
    };
    const hide = () => { tip.style.display = 'none'; cursor.style.display = 'none'; dot.style.display = 'none'; };
    svg.addEventListener('mousemove', (e) => move(e.clientX));
    svg.addEventListener('touchmove', (e) => { move(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchend', hide);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if ($('#chart-box')) renderChartCard(); }, 150);
  });

  // ---------- Fordeling ----------

  // Samme aktie i flere depoter lægges sammen i fordeling og dagens bevægelser.
  function groupedBySymbol() {
    const groups = new Map();
    for (const p of positions()) {
      const g = groups.get(p.symbol) || { symbol: p.symbol, name: p.name || p.symbol, currency: p.currency, weight: null, valueBase: null, dayChangeBase: null, dayChangePercent: p.dayChangePercent };
      if (isNum(p.weight)) g.weight = (g.weight || 0) + p.weight;
      if (isNum(p.valueBase)) g.valueBase = (g.valueBase || 0) + p.valueBase;
      if (isNum(p.dayChangeBase)) g.dayChangeBase = (g.dayChangeBase || 0) + p.dayChangeBase;
      groups.set(p.symbol, g);
    }
    return [...groups.values()];
  }

  function allocationCardInner() {
    const pos = groupedBySymbol().filter((p) => isNum(p.weight)).sort((a, b) => b.weight - a.weight);
    if (!pos.length) return `<div class="card-header"><h2>Fordeling</h2></div><p class="muted">Ingen kurser endnu.</p>`;
    const top = pos.slice(0, 6);
    const rest = pos.slice(6);
    const segs = top.map((p, i) => ({ name: p.name || p.symbol, symbol: p.symbol, pct: p.weight, color: PALETTE[i % PALETTE.length] }));
    if (rest.length) segs.push({ name: `Andre (${rest.length})`, pct: rest.reduce((s, p) => s + p.weight, 0), color: '#9ca3af' });

    const byCur = {};
    for (const p of pos) byCur[p.currency] = (byCur[p.currency] || 0) + p.weight;
    const curs = Object.entries(byCur).sort((a, b) => b[1] - a[1]).map(([cur, pct], i) => ({ name: cur, pct, color: PALETTE[(i + 3) % PALETTE.length] }));

    const bar = (items) => `<div class="alloc-bar">${items.map((s) => `<span style="width:${s.pct.toFixed(2)}%;background:${s.color}" title="${esc(s.name)}: ${fmtPct(s.pct, { sign: false })}"></span>`).join('')}</div>`;
    const legend = (items) => `<ul class="alloc-legend">${items.map((s) => `<li${s.symbol ? ` data-action="open" data-symbol="${esc(s.symbol)}" style="cursor:pointer"` : ''}><span class="swatch" style="background:${s.color}"></span><span class="name">${esc(s.name)}</span><span class="pct">${fmtPct(s.pct, { sign: false })}</span></li>`).join('')}</ul>`;
    return `<div class="card-header"><h2>Fordeling</h2><span class="hint">Andel af værdi</span></div>
      ${bar(segs)}${legend(segs)}
      ${curs.length > 1 ? `<div class="alloc-title">Efter valuta</div>${bar(curs)}${legend(curs)}` : ''}`;
  }

  // ---------- Dagens bevægelser ----------

  function moversCardInner() {
    const pos = groupedBySymbol().filter((p) => isNum(p.dayChangePercent));
    if (pos.length < 2) return `<div class="card-header"><h2>Dagens bevægelser</h2></div><p class="muted">Tilføj flere aktier for at se dagens største bevægelser.</p>`;
    const sorted = [...pos].sort((a, b) => b.dayChangePercent - a.dayChangePercent);
    const up = sorted.filter((p) => p.dayChangePercent > 0).slice(0, 3);
    const down = sorted.filter((p) => p.dayChangePercent < 0).reverse().slice(0, 3);
    const li = (p) => `<li data-action="open" data-symbol="${esc(p.symbol)}" title="${esc(p.name || p.symbol)}"><span class="mover-l"><span class="sym">${esc(p.name || p.symbol)}</span><span class="nm">${esc(p.symbol)}</span></span><span class="cell-2"><span class="${signClass(p.dayChangePercent)}">${fmtPct(p.dayChangePercent)}</span><span class="sub amount">${fmtAmount(p.dayChangeBase, state.baseCurrency, { sign: true })}</span></span></li>`;
    return `<div class="card-header"><h2>Dagens bevægelser</h2></div>
      <div class="movers">
        <div><h3>Stiger mest</h3>${up.length ? `<ul>${up.map(li).join('')}</ul>` : '<p class="muted small">Ingen stigninger i dag.</p>'}</div>
        <div><h3>Falder mest</h3>${down.length ? `<ul>${down.map(li).join('')}</ul>` : '<p class="muted small">Ingen fald i dag.</p>'}</div>
      </div>`;
  }

  // ---------- Beholdningstabel ----------

  const SORTERS = {
    name: (p) => (p.name || p.symbol).toLowerCase(),
    quantity: (p) => p.quantity,
    price: (p) => p.price,
    dayChangePercent: (p) => p.dayChangePercent,
    avgPrice: (p) => p.avgPrice,
    valueBase: (p) => p.valueBase,
    gainBase: (p) => p.gainBase,
    weight: (p) => p.weight,
  };

  function sortedPositions({ applyFilter = true } = {}) {
    const key = SORTERS[state.sort.key] ? state.sort.key : 'valueBase';
    const get = SORTERS[key];
    const dir = state.sort.dir === 'asc' ? 1 : -1;
    const filter = applyFilter ? state.filter.trim().toLowerCase() : '';
    return positions()
      .filter((p) => !filter || (p.name || '').toLowerCase().includes(filter) || p.symbol.toLowerCase().includes(filter))
      .sort((a, b) => {
        const va = get(a);
        const vb = get(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'string') return va.localeCompare(vb, 'da') * dir;
        return (va - vb) * dir;
      });
  }

  function staleTitle(p) {
    return `Seneste kendte kurs${p.fetchedAt ? ` fra ${fmtDateTime(p.fetchedAt)}` : ''} – kunne ikke opdateres`;
  }

  function stockCell(p) {
    const dot = p.marketOpen === true ? '<span class="market-dot open" title="Børsen er åben"></span>' : p.marketOpen === false ? '<span class="market-dot" title="Børsen er lukket"></span>' : '';
    const errMsg = p.error?.code === 'NOT_FOUND' ? 'Symbolet findes ikke længere hos Yahoo Finance' : p.error?.message || 'Ingen kurs';
    const warn = p.status === 'error' || p.status === 'fx_error' ? `<span class="warn-dot" title="${esc(errMsg)}"></span>` : p.status === 'stale' ? `<span class="warn-dot" title="${esc(staleTitle(p))}"></span>` : '';
    return `<div class="stock-cell">
      <span class="stock-avatar">${esc(initials(p.symbol))}</span>
      <div><div class="stock-name">${warn}${esc(p.name || p.symbol)}</div>
      <div class="stock-meta">${esc(p.symbol)}${p.currency ? ` <span class="chip">${esc(p.currency)}</span>` : ''}${dot}${p.exchange ? ` <span>${esc(p.exchange)}</span>` : ''}${p.accountName && state.account === 'all' ? ` <span class="chip chip-account">${esc(p.accountName)}</span>` : ''}</div></div>
    </div>`;
  }

  function holdingsTable({ compact = false } = {}) {
    // Ser man en andens portefølje, er der intet at redigere: ingen handlingskolonne
    // og ingen klikbare rækker.
    if (state.viewing) compact = compact || false;
    const readonly = Boolean(state.viewing);
    const rows = sortedPositions({ applyFilter: !compact });
    const t = state.portfolio?.totals;
    const pendingOnly = !state.portfolio; // beholdninger kendt, kurser på vej
    if (pendingOnly && !state.pending) return `<div class="table-wrap"><table class="holdings"><tbody>${[1, 2, 3].map(() => `<tr><td colspan="8"><span class="skeleton">Henter beholdning…</span></td></tr>`).join('')}</tbody></table></div>`;
    if (!rows.length) {
      return !compact && state.filter ? `<p class="muted" style="padding:16px 0">Ingen aktier matcher "${esc(state.filter)}".</p>` : '';
    }
    const todayLabel = allMarketsClosed() ? 'Seneste handelsdag' : 'I dag';
    const anyOpen = rows.some((p) => p.marketOpen === true);
    const cols = [
      { key: 'name', label: 'Aktie', n: false },
      { key: 'quantity', label: 'Antal', n: true, hide: compact },
      { key: 'price', label: 'Kurs', n: true, title: 'Seneste kurs i aktiens egen valuta' },
      { key: 'dayChangePercent', label: todayLabel, n: true, title: 'Ændring i forhold til forrige lukkekurs på aktiens egen børs' },
      { key: 'avgPrice', label: 'Gns. købskurs', n: true, hide: compact },
      { key: 'valueBase', label: `Værdi (${esc(state.baseCurrency)})`, n: true },
      { key: 'gainBase', label: 'Afkast', n: true, title: AFKAST_TOOLTIP },
      { key: 'weight', label: 'Andel', n: true, title: 'Andel af porteføljens samlede aktieværdi' },
    ].filter((c) => !c.hide);
    const th = cols.map((c) => {
      const sorted = state.sort.key === c.key;
      const ariaSort = sorted ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<th class="${c.n ? 'n' : ''}${sorted ? ' sorted' : ''}" data-sort="${c.key}" aria-sort="${ariaSort}" tabindex="0" role="columnheader button" ${c.title ? `title="${esc(c.title)}"` : ''}>${c.label}<span class="sort-ind">${sorted ? (state.sort.dir === 'asc' ? '▲' : '▼') : ''}</span></th>`;
    }).join('') + (compact || readonly ? '' : '<th class="n"><span class="sr-only">Handlinger</span></th>');

    const sk = '<span class="skeleton">00.000</span>';
    const tr = rows.map((p) => {
      if (pendingOnly) {
        const cells = [`<td>${stockCell(p)}</td>`];
        if (!compact) cells.push(`<td class="n">${fmtQty(p.quantity)}</td>`);
        cells.push(`<td class="n">${sk}</td><td class="n">${sk}</td>`);
        if (!compact) cells.push(`<td class="n">${isNum(p.avgPrice) ? fmtPrice(p.avgPrice) : '<span class="muted">–</span>'}</td>`);
        cells.push(`<td class="n">${sk}</td><td class="n">${sk}</td><td class="n">${sk}</td>`);
        if (!compact) cells.push('<td></td>');
        return `<tr>${cells.join('')}</tr>`;
      }
      const hasPrice = isNum(p.price);
      const stale = p.status === 'stale';
      const closedWhileOthersOpen = anyOpen && p.marketOpen === false;
      const dayMuted = stale || closedWhileOthersOpen;
      const dayTitle = stale ? staleTitle(p) : closedWhileOthersOpen ? `Lukket${p.marketTime ? ` · sidste handel ${fmtDateTime(p.marketTime)}` : ''}` : '';
      const cells = [];
      cells.push(`<td>${stockCell(p)}</td>`);
      if (!compact) cells.push(`<td class="n">${fmtQty(p.quantity)}</td>`);
      cells.push(`<td class="n${stale ? ' stale' : ''}" ${stale ? `title="${esc(staleTitle(p))}"` : ''}>${hasPrice ? `${stale ? '⏱ ' : ''}${fmtPrice(p.price)} <span class="muted small">${esc(p.currency || '')}</span>` : '–'}</td>`);
      cells.push(`<td class="n${dayMuted ? ' stale' : ''}" ${dayTitle ? `title="${esc(dayTitle)}"` : ''}><div class="cell-2"><span class="${dayMuted ? '' : signClass(p.dayChangePercent)}">${arrow(p.dayChangePercent)}${fmtPct(p.dayChangePercent)}</span><span class="sub amount">${fmtAmount(p.dayChangeBase, state.baseCurrency, { sign: true })}</span></div></td>`);
      if (!compact) cells.push(`<td class="n">${isNum(p.avgPrice) ? fmtPrice(p.avgPrice) : '<span class="muted">–</span>'}</td>`);
      cells.push(`<td class="n"><b class="amount">${fmtAmount(p.valueBase)}</b></td>`);
      cells.push(`<td class="n"><div class="cell-2"><span class="amount ${signClass(p.gainBase)}">${fmtAmount(p.gainBase, state.baseCurrency, { sign: true })}</span><span class="sub ${signClass(p.gainPercent)}">${fmtPct(p.gainPercent)}</span></div></td>`);
      cells.push(`<td class="n">${isNum(p.weight) ? `${fmtPct(p.weight, { sign: false })}<span class="weight-bar"><i style="width:${clamp(p.weight, 0, 100).toFixed(1)}%"></i></span>` : '–'}</td>`);
      if (!compact && !readonly) cells.push(`<td class="n"><div class="row-actions"><button class="btn btn-ghost btn-icon" data-action="menu" data-id="${esc(p.id)}" title="Handlinger" aria-label="Handlinger for ${esc(p.name)}">${icon('more')}</button></div></td>`);
      if (readonly) return `<tr data-symbol="${esc(p.symbol)}" class="${hasPrice ? '' : 'error-row'}">${cells.join('')}</tr>`;
      return `<tr data-action="open" data-symbol="${esc(p.symbol)}" class="${hasPrice ? '' : 'error-row'}" tabindex="0" aria-label="Vis detaljer for ${esc(p.name || p.symbol)}">${cells.join('')}</tr>`;
    }).join('');

    const foot = t && !pendingOnly ? `<tfoot><tr>
      <td>I alt</td>${compact || readonly ? '' : '<td></td>'}<td></td>
      <td class="n"><div class="cell-2"><span class="${signClass(t.dayChangePercent)}">${fmtPct(t.dayChangePercent)}</span><span class="sub amount ${signClass(t.dayChangeBase)}">${fmtAmount(t.dayChangeBase, state.baseCurrency, { sign: true })}</span></div></td>
      ${compact || readonly ? '' : '<td></td>'}
      <td class="n"><span class="amount">${fmtAmount(t.valueBase)}</span></td>
      <td class="n"><div class="cell-2"><span class="amount ${signClass(t.gainBase)}">${fmtAmount(t.gainBase, state.baseCurrency, { sign: true })}</span><span class="sub ${signClass(t.gainPercent)}">${fmtPct(t.gainPercent)}</span></div></td>
      <td class="n">100 %</td>${compact || readonly ? '' : '<td></td>'}
    </tr></tfoot>` : '';

    const cards = rows.map((p) => pendingOnly
      ? `<div class="hcard"><div class="l1">${esc(p.name || p.symbol)}</div><div class="r1">${sk}</div><div class="l2">${esc(p.symbol)} · ${fmtQty(p.quantity)} stk.</div><div class="r2">${sk}</div></div>`
      // Tre linjer i stedet for to: så er der plads til både valuta og depot,
      // uden at noget klippes af på en smal skærm.
      : `<div class="hcard"${readonly ? '' : ` data-action="open" data-symbol="${esc(p.symbol)}" tabindex="0" role="button"`}>
      <div class="l1">${p.status !== 'ok' ? '<span class="warn-dot"></span>' : ''}${esc(p.name || p.symbol)}</div>
      <div class="r1 amount">${fmtAmount(p.valueBase)}</div>
      <div class="l2">${esc(p.symbol)} · ${fmtQty(p.quantity)} stk.${p.accountName && state.account === 'all' ? ` · ${esc(p.accountName)}` : ''}</div>
      <div class="r2"><span class="${p.status === 'stale' ? 'stale' : signClass(p.dayChangePercent)}">${arrow(p.dayChangePercent)}${fmtPct(p.dayChangePercent)}</span></div>
      <div class="l3">${isNum(p.price) ? `${fmtPrice(p.price)} ${esc(p.currency || '')}` : 'ingen kurs'}</div>
      <div class="r3"><span class="muted">afkast</span> <span class="${signClass(p.gainPercent)}">${fmtPct(p.gainPercent)}</span></div>
    </div>`).join('');
    const cardTotal = t && !pendingOnly ? `<div class="hcard-total"><span>I alt</span><span class="amount">${fmtAmount(t.valueBase)}</span></div>` : '';

    return `<div class="table-wrap"><table class="holdings"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody>${foot}</table><div class="holding-cards">${cards}${cardTotal}</div></div>`;
  }

  // ---------- Beholdninger (side) ----------

  function renderHoldings() {
    const p = state.portfolio;
    const empty = p ? p.positions.length === 0 : state.pending ? state.pending.length === 0 : false;
    return `
      ${pageHeader('Beholdninger', updatedSub(), headerActions())}
      ${accountBar()}
      ${banners()}
      ${empty ? emptyState() : `
      <div class="card">
        <div class="card-header">
          <h2>${icon('list')}Alle aktier ${p ? `<span class="hint">${p.totals.positionCount}</span>` : ''}</h2>
          <div class="input-group" style="max-width:260px"><input class="input" id="filter" type="search" placeholder="Filtrér…" value="${esc(state.filter)}" aria-label="Filtrér aktier"></div>
        </div>
        ${holdingsTable({ compact: false })}
      </div>
      <p class="footer-note">Tryk på en aktie for detaljer – her kan du købe til, sælge, redigere eller slette.</p>`}`;
  }

  // ---------- Analyse ----------

  async function loadAnalytics() {
    state.analytics.loading = true;
    try {
      const data = await api('GET', '/api/analytics');
      state.analytics = { data, loaded: true, loading: false };
    } catch (err) {
      state.analytics = { data: null, loaded: true, loading: false };
      toast(err.message, 'error');
    }
    render();
  }

  // Samme regnestykke som på serveren: renter tilskrives månedligt.
  function projectValue({ start = 0, perMonth = 0, annualPercent = 0, years = 10 }) {
    const måneder = Math.max(0, Math.round(years * 12));
    const r = (1 + annualPercent / 100) ** (1 / 12) - 1;
    const vokset = start * (1 + r) ** måneder;
    const bidrag = Math.abs(r) < 1e-9 ? perMonth * måneder : perMonth * (((1 + r) ** måneder - 1) / r);
    const indbetalt = start + perMonth * måneder;
    const slut = vokset + bidrag;
    return { value: slut, contributed: indbetalt, growth: slut - indbetalt };
  }

  // Hvad fremskrivningen regner med, hvis brugeren ikke selv har rettet noget.
  const DEFAULT_VÆKST = 7;
  function faktaKort(ikon, titel, liste, note = '') {
    if (!liste.length) return '';
    return `<div class="card">
        <div class="card-header"><h2>${icon(ikon)}${esc(titel)}</h2></div>
        <div class="card-body">
          <ul class="fact-list">${liste.map(([i, tekst]) => `<li>${i}<span>${tekst}</span></li>`).join('')}</ul>
          ${note ? `<p class="muted small" style="margin:12px 0 0">${esc(note)}</p>` : ''}
        </div>
      </div>`;
  }

  // "2025-10" → "oktober 2025"
  function månedNavn(m) {
    const d = new Date(`${m}-01T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return m;
    return d.toLocaleDateString('da-DK', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function planInput(a) {
    const perMonth = state.plan.perMonth ?? (isNum(a.perMonth) ? Math.round(a.perMonth) : 0);
    // Eget afkast bruges kun, når der er over et års historik bag det.
    const eget = a.annualizedReliable && isNum(a.annualizedPercent) ? a.annualizedPercent : null;
    const growth = state.plan.growth ?? (eget === null ? DEFAULT_VÆKST : Math.round(eget * 10) / 10);
    return { perMonth, growth, eget, years: state.plan.years };
  }

  function renderAnalytics() {
    const { data: a, loaded } = state.analytics;
    if (!loaded) return `${pageHeader('Analyse', '<span>Henter…</span>', headerActions({ add: false }))}`;
    if (!a || !a.positionsTotal) {
      return `${pageHeader('Analyse', '<span>Tal om din portefølje</span>', headerActions({ add: false }))}
        <div class="card"><div class="empty">${icon('chart')}<h3>Ikke noget at regne på endnu</h3><p>Tilføj dine aktier – og skriv gerne købsdatoen på. Så kan der regnes på, hvor meget du lægger til side om måneden, og hvad det kan blive til.</p></div></div>`;
    }

    const { perMonth, growth, eget, years } = planInput(a);
    const f = projectValue({ start: a.value, perMonth, annualPercent: growth, years });
    const årValg = [5, 10, 15, 20, 30].map((å) => `<button type="button" class="chip-btn${å === years ? ' active' : ''}" data-action="plan-years" data-years="${å}">${å} år</button>`).join('');

    // ---------- sjove tal ----------
    const fakta = [];
    if (isNum(a.months)) fakta.push([icon('chart'), `Du har investeret i <b>${esc(ejertid(a.days))}</b> – siden ${esc(fmtDate(a.since, { year: true }))}.`]);
    if (isNum(a.perDay)) fakta.push([icon(a.perDay >= 0 ? 'trend' : 'warn'), `Porteføljen har i gennemsnit ${a.perDay >= 0 ? 'tjent' : 'tabt'} <b class="amount ${signClass(a.perDay)}">${fmtAmount(Math.abs(a.perDay))}</b> om dagen.`]);
    if (isNum(a.gainShare)) fakta.push([icon('briefcase'), `<b>${fmtPct(a.gainShare, { sign: false })}</b> af det, porteføljen er værd, er afkast. Resten er dine egne penge.`]);
    if (a.biggest) fakta.push([icon('list'), `Størst: <b>${esc(a.biggest.name)}</b>${isNum(a.biggest.weight) ? ` – ${fmtPct(a.biggest.weight, { sign: false })} af porteføljen` : ''}.`]);
    if (isNum(a.concentration) && a.positionsTotal > 3) fakta.push([icon('list'), `Dine tre største fylder <b>${fmtPct(a.concentration, { sign: false })}</b> tilsammen.`]);
    if (a.best) fakta.push([icon('trend'), `Højest afkast: <b>${esc(a.best.name)}</b> med <span class="${signClass(a.best.gainPercent)}">${fmtPct(a.best.gainPercent)}</span>.`]);
    if (a.worst) fakta.push([icon(a.worst.gainPercent < 0 ? 'warn' : 'list'), `Lavest afkast: <b>${esc(a.worst.name)}</b> med <span class="${signClass(a.worst.gainPercent)}">${fmtPct(a.worst.gainPercent)}</span>${a.worst.gainPercent >= 0 ? ' – stadig i plus' : ''}.`]);
    if (a.longestHeld) fakta.push([icon('chart'), `Længst ejet: <b>${esc(a.longestHeld.name)}</b> i ${esc(punktum(ejertid(a.longestHeld.heldDays)))}`]);
    if (isNum(a.doublingYears)) fakta.push([icon('trend'), `Fortsætter væksten, er pengene fordoblet om <b>${fmtNum(a.doublingYears, 0, 1)} år</b>.`]);
    if (a.currencies > 1) fakta.push([icon('eye'), `Du har papirer i <b>${a.currencies} valutaer</b>${a.accounts ? ` fordelt på ${a.accounts} ${a.accounts === 1 ? 'depot' : 'depoter'}` : ''}.`]);
    if (isNum(a.units) && a.units > 0) fakta.push([icon('briefcase'), `Du ejer <b>${fmtQty(a.units)} andele</b> i alt, fordelt på ${a.positionsTotal} ${a.positionsTotal === 1 ? 'papir' : 'papirer'}.`]);

    // ---------- dine køb ----------
    const købFakta = [];
    if (a.purchases > 1) {
      købFakta.push([icon('cart'), `Du har købt <b>${a.purchases} gange</b> siden ${esc(fmtDate(a.firstBuy, { year: true }))}${isNum(a.daysBetweenBuys) ? ` – ét køb hver <b>${fmtNum(a.daysBetweenBuys, 0, 0)}. dag</b> i gennemsnit` : ''}.`]);
    } else if (a.purchases === 1) {
      købFakta.push([icon('cart'), `Ét køb registreret – den ${esc(fmtDate(a.firstBuy, { year: true }))}.`]);
    }
    if (isNum(a.daysSinceLastBuy)) {
      købFakta.push([icon('chart'), a.daysSinceLastBuy === 0
        ? 'Dit seneste køb var <b>i dag</b>.'
        : `Der er gået <b>${esc(ejertid(a.daysSinceLastBuy))}</b> siden dit seneste køb den ${esc(fmtDate(a.lastBuy, { year: true }))}.`]);
    }
    if (a.biggestBuy) købFakta.push([icon('trend'), `Største enkeltkøb: <b>${esc(a.biggestBuy.name)}</b> for <b class="amount">${fmtAmount(a.biggestBuy.amountBase)}</b> den ${esc(fmtDate(a.biggestBuy.date, { year: true }))}.`]);
    if (isNum(a.avgBuy)) købFakta.push([icon('list'), `Et typisk køb hos dig er på <b class="amount">${fmtAmount(a.avgBuy)}</b>`]);
    if (a.busiestMonth) købFakta.push([icon('chart'), `Travleste måned: <b>${esc(månedNavn(a.busiestMonth.month))}</b> med <b class="amount">${fmtAmount(a.busiestMonth.amountBase)}</b> fordelt på ${a.busiestMonth.count} ${a.busiestMonth.count === 1 ? 'køb' : 'køb'}.`]);

    // ---------- rekorder ----------
    const r = a.records;
    const rekorder = [];
    if (r) {
      const påToppen = isNum(r.fromPeakPercent) && r.fromPeakPercent > -0.05;
      // "Nogensinde" holder kun, når alle papirer har en købsdato – ellers
      // dækker kurven også tid, hvor man ikke ejede dem.
      const nogensinde = a.withoutDates ? 'højeste i den viste periode' : 'højeste nogensinde';
      rekorder.push([icon('trend'), påToppen
        ? `Porteføljen står på sit <b>${nogensinde}</b>: <b class="amount">${fmtAmount(r.peak.value)}</b>`
        : `Toppen var <b class="amount">${fmtAmount(r.peak.value)}</b> den ${esc(fmtDate(r.peak.date, { year: true }))} – du er <b class="neg">${fmtPct(r.fromPeakPercent)}</b> under.`]);
      if (r.bestDay && isNum(r.bestDay.change)) rekorder.push([icon('trend'), `Bedste dag: <b class="amount pos">${fmtAmount(r.bestDay.change, state.baseCurrency, { sign: true })}</b> den ${esc(fmtDate(r.bestDay.date, { year: true }))}.`]);
      if (r.worstDay && isNum(r.worstDay.change)) rekorder.push([icon('warn'), `Værste dag: <b class="amount neg">${fmtAmount(r.worstDay.change, state.baseCurrency, { sign: true })}</b> den ${esc(fmtDate(r.worstDay.date, { year: true }))}.`]);
      if (isNum(r.daysInProfit) && r.tradingDays) {
        const andel = (r.daysInProfit / r.tradingDays) * 100;
        rekorder.push([icon('chart'), `Du har været i plus <b>${r.daysInProfit} af ${r.tradingDays} børsdage</b> – ${fmtPct(andel, { sign: false })} af tiden.`]);
      }
      if (r.longestStreak > 1) rekorder.push([icon('list'), `Længste stime: <b>${r.longestStreak} dage i træk</b> med fremgang.`]);
    }

    return `
      ${pageHeader('Analyse', `<span>Tal om din portefølje</span>`, headerActions({ add: false }))}

      ${a.withoutDates ? `<div class="banner">${icon('warn')}<div><b>${a.withoutDates} ${a.withoutDates === 1 ? 'papir mangler' : 'papirer mangler'} en købsdato.</b> Uden den kan der ikke regnes på tid – hverken månedligt gennemsnit eller afkast pr. år. Datoen sættes under Redigér.</div></div>` : ''}

      <div class="grid grid-kpi">
        <div class="card kpi kpi-hero">
          <div class="kpi-label">Investeret pr. måned</div>
          <div class="kpi-value amount">${isNum(a.perMonth) ? fmtAmount(a.perMonth) : '–'}</div>
          <div class="kpi-sub">${isNum(a.months) ? `i gennemsnit over ${fmtNum(a.months, 0, 0)} måneder` : 'kræver købsdatoer'}</div>
        </div>
        <div class="card kpi">
          <div class="kpi-label">Investeret i alt</div>
          <div class="kpi-value amount">${fmtAmount(a.invested)}</div>
          <div class="kpi-sub">dine egne indbetalinger</div>
        </div>
        <div class="card kpi">
          <div class="kpi-label">Afkast pr. år</div>
          <div class="kpi-value amount ${signClass(a.annualizedPercent)}">${isNum(a.annualizedPercent) ? fmtPct(a.annualizedPercent) : '–'}</div>
          <div class="kpi-sub">${isNum(a.annualizedPercent) ? (a.annualizedReliable ? 'over hele ejertiden' : 'kort historik – tallet svinger meget') : 'kræver købsdatoer'}</div>
        </div>
        <div class="card kpi">
          <div class="kpi-label">Værdi nu</div>
          <div class="kpi-value amount">${fmtAmount(a.value)}</div>
          <div class="kpi-sub ${signClass(a.gain)}">${fmtAmount(a.gain, state.baseCurrency, { sign: true })} i afkast</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>${icon('trend')}Hvis det fortsætter sådan her</h2></div>
        <div class="card-body">
          <div class="chip-row" style="margin-bottom:14px">${årValg}</div>
          <div class="plan-grid">
            <div class="field">
              <label for="plan-month">Jeg lægger til side hver måned</label>
              <div class="input-group"><input class="input n" id="plan-month" inputmode="decimal" value="${esc(fmtRaw(perMonth))}"><span class="addon">${esc(a.baseCurrency)}</span></div>
            </div>
            <div class="field">
              <label for="plan-growth">Vækst om året</label>
              <div class="input-group"><input class="input n" id="plan-growth" inputmode="decimal" value="${esc(fmtRaw(growth))}"><span class="addon">%</span></div>
              <span class="help">${eget === null ? `Der er ikke historik nok til dit eget tal endnu, så der regnes med ${DEFAULT_VÆKST} %.` : `Dit eget afkast hidtil er ${fmtPct(eget)}.`}</span>
            </div>
          </div>

          <div class="plan-result">
            <div class="plan-total">
              <div class="kpi-label">Om ${years} år har du</div>
              <div class="plan-value amount">${fmtAmount(f.value)}</div>
            </div>
            <dl class="kv">
              <dt>Heraf lagt til side selv</dt><dd class="amount">${fmtAmount(f.contributed)}</dd>
              <dt>Heraf vækst</dt><dd class="amount ${signClass(f.growth)}">${fmtAmount(f.growth, state.baseCurrency, { sign: true })}</dd>
            </dl>
          </div>
          <p class="muted small" style="margin:12px 0 0">Det er et regnestykke, ikke en forudsigelse. Markedet giver ikke det samme hvert år, og et enkelt dårligt år ændrer tallet markant. Skatten er ikke regnet med.</p>
        </div>
      </div>

      ${faktaKort('list', 'Om din portefølje', fakta)}
      ${faktaKort('cart', 'Dine køb', købFakta)}
      ${faktaKort('trend', 'Rekorder', rekorder, 'Målt på kursbevægelser – dine egne indbetalinger er trukket fra, så en indbetaling ikke tæller som en god dag.')}`;
  }

  // ---------- Platform: profil, følgere, søgning ----------

  async function loadMe() {
    try {
      const data = await api('GET', '/api/me');
      state.me = data.user;
      state.inviteCode = data.inviteCode || null;
    } catch {
      /* ikke logget ind eller ikke en platform – siden virker uden */
    }
  }

  let peopleTimer = null;

  async function loadPeople(q = '') {
    state.people.loading = true;
    try {
      const data = await api('GET', q.trim() ? `/api/people?q=${encodeURIComponent(q.trim())}` : '/api/people');
      if (state.people.q !== q) return;
      state.people = { q, results: data.people, loading: false, loaded: true };
    } catch (err) {
      state.people = { q, results: [], loading: false, loaded: true };
      toast(err.message, 'error');
    }
    render();
  }

  // Filtreringen sker på serveren, men først når man holder pause i tastningen.
  function searchPeopleSoon(q) {
    state.people.q = q;
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(() => loadPeople(q), 250);
  }

  // Skifter til en andens portefølje (eller tilbage til ens egen).
  function viewPerson(id) {
    if (state.viewing?.id === id) return;
    state.viewingDenied = false;
    state.viewing = { id, name: 'Profil' };
    state.portfolio = null;
    state.pending = null;
    state.loadError = null;
    render();
    loadPortfolio();
  }

  function stopViewing() {
    if (!state.viewing) return;
    state.viewing = null;
    state.portfolio = null;
    state.pending = null;
    state.loadError = null;
    loadPortfolio();
  }

  // ---------- Folk: find, følg, godkend ----------

  const personInitials = (name) => String(name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  function renderPeople() {
    const { results, loading, loaded, q } = state.people;
    const liste = results.map((person) => `
      <a class="person-row person-link" href="/profil/${esc(person.id)}" data-link>
        <span class="avatar" aria-hidden="true">${esc(personInitials(person.name))}</span>
        <span class="person-name">${esc(person.name)}${person.isOwner ? ' <span class="hint">ejer</span>' : ''}</span>
        <span class="person-go" aria-hidden="true">Se portefølje →</span>
      </a>`).join('');

    return `
      ${pageHeader('Folk', '<span>Se hvad de andre har i deres portefølje</span>', headerActions({ add: false }))}
      <div class="card">
        <div class="card-header"><h2>${icon('users')}Profiler${loaded ? ` <span class="hint">${results.length}</span>` : ''}</h2></div>
        <div class="card-body">
          <div class="input-group" style="max-width:360px;margin-bottom:8px"><input class="input" id="people-search" type="search" placeholder="Søg efter navn…" value="${esc(q)}" aria-label="Søg efter profil"></div>
          ${loading && !loaded ? '<p class="muted">Henter…</p>'
            : results.length ? liste
            : q ? `<p class="muted">Ingen profiler matcher "${esc(q)}".</p>`
            : '<p class="muted">Der er ingen andre profiler endnu. Del din invitationskode fra Indstillinger, så kan de andre komme med.</p>'}
        </div>
      </div>`;
  }

  // En andens portefølje. Samme tal som ens egen, men intet kan ændres.
  function renderPerson() {
    const v = state.viewing;
    if (state.loadError && !state.portfolio) {
      return `${pageHeader('Profil', '<span>Kunne ikke hentes</span>')}
        <div class="banner error">${icon('warn')}<div><b>${esc(state.loadError)}</b> <a href="/folk" data-link>Tilbage til Folk</a></div></div>`;
    }
    if (!v) return `${pageHeader('Profil', '<span>Henter…</span>')}`;
    const p = state.portfolio;
    return `
      ${pageHeader(esc(v.name), `<span>Portefølje · kun visning</span>${updatedSub()}`, `<a class="btn" href="/folk" data-link>${icon('list')}<span>Tilbage</span></a><button class="btn btn-ghost btn-icon${state.loading ? ' is-loading' : ''}" data-action="refresh" title="Opdatér kurser" aria-label="Opdatér kurser">${icon('refresh')}</button>`)}
      <div class="banner info">${icon('eye')}<div>Du ser <b>${esc(v.name)}s</b> portefølje. Du kan ikke ændre noget her.</div></div>
      ${p ? `
      <div class="grid grid-kpi">
        <div class="card kpi kpi-hero"><div class="kpi-label">Porteføljeværdi</div><div class="kpi-value amount">${fmtAmount(p.totals.totalValueBase ?? p.totals.valueBase)}</div><div class="kpi-sub">${p.totals.positionCount} ${p.totals.positionCount === 1 ? 'aktie' : 'aktier'}</div></div>
        <div class="card kpi"><div class="kpi-label">${allMarketsClosed() ? 'Seneste handelsdag' : 'I dag'}</div><div class="kpi-value amount ${signClass(p.totals.dayChangeBase)}">${fmtAmount(p.totals.dayChangeBase, state.baseCurrency, { sign: true })}</div><div class="kpi-sub ${signClass(p.totals.dayChangePercent)}">${fmtPct(p.totals.dayChangePercent)}</div></div>
        <div class="card kpi"><div class="kpi-label">Samlet afkast</div><div class="kpi-value amount ${signClass(p.totals.gainBase)}">${fmtAmount(p.totals.gainBase, state.baseCurrency, { sign: true })}</div><div class="kpi-sub ${signClass(p.totals.gainPercent)}">${fmtPct(p.totals.gainPercent)}</div></div>
      </div>
      <div class="card">
        <div class="card-header"><h2>${icon('list')}Aktier</h2></div>
        ${holdingsTable({ compact: false })}
      </div>` : '<p class="muted">Henter portefølje…</p>'}`;
  }

  // ---------- Indstillinger ----------

  function renderSettings() {
    const s = state.settings;
    const opt = (v, label, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    const usesEnvPassword = Boolean(state.usesEnvPassword);
    return `
      ${pageHeader('Indstillinger', '<span>Dine præferencer og data</span>', headerActions({ add: false }))}
      <div class="settings-grid">
        <div class="card">
          <div class="card-header"><h2>${icon('lock')}Konto</h2></div>
          <div class="setting-row"><div><div class="lbl">Dit navn</div><div class="desc">${state.access === 'platform' ? 'Vises i hilsenen – og er sådan, andre finder dig.' : 'Bruges i hilsenen på forsiden.'}</div></div><input class="input" id="set-name" style="max-width:200px" value="${esc(state.access === 'platform' ? state.me?.name || '' : s.displayName || '')}" placeholder="F.eks. Mikkel Frost" maxlength="40" aria-label="Dit navn"></div>
          ${state.access === 'platform' ? `
          <div class="setting-row"><div><div class="lbl">E-mail</div><div class="desc">Bruges til at logge ind. Andre kan finde dig med den, men de får den aldrig at se.</div></div><span class="muted">${esc(state.me?.email || '')}</span></div>
          <div class="setting-row"><div><div class="lbl">Adgangskode</div><div class="desc">Skifter du den, logges dine andre enheder ud.</div></div><button class="btn btn-sm" data-action="change-password">Skift adgangskode</button></div>
          ${state.inviteCode ? `<div class="setting-row"><div><div class="lbl">Invitationskode</div><div class="desc">Del den med dem, du vil have med. Uden en kode kan ingen oprette en profil.</div></div><div class="invite-box"><code class="invite-code">${esc(state.inviteCode)}</code><button class="btn btn-sm" data-action="copy-invite">Kopiér</button><button class="btn btn-sm" data-action="rotate-invite">Ny kode</button></div></div>` : ''}
          ` : ''}
          ${state.access === 'platform' ? '' : state.storage === 'browser' ? `<div class="setting-row"><div><div class="lbl">Browser-tilstand – intet login</div><div class="desc">Serveren har ingen database, så dine aktier og indstillinger gemmes kun i denne browser (de sendes til serveren for at få kurser, men gemmes ikke der). Tag jævnligt en sikkerhedskopi under Data. Vil du have, at porteføljen følger med til alle dine enheder, så tilslut en database – se README.</div></div></div>` : state.access === 'open' ? `<div class="setting-row"><div><div class="lbl">Åben adgang – intet login</div><div class="desc">Porteføljen ligger i databasen og vises, så snart siden åbnes – på alle dine enheder og i alle browsere. Det betyder også, at alle der kender adressen, kan se og ændre den.</div></div><button class="btn btn-sm btn-primary" data-action="setup-password">Opret adgangskode</button></div>` : `
          <div class="setting-row"><div><div class="lbl">Adgangskode</div><div class="desc">${usesEnvPassword ? 'Styres af DASHBOARD_PASSWORD på serveren.' : 'Skift adgangskoden til dashboardet.'}</div></div><button class="btn btn-sm" data-action="change-password" ${usesEnvPassword ? 'disabled' : ''}>Skift adgangskode</button></div>
          <div class="setting-row"><div><div class="lbl">Log ud på alle enheder</div><div class="desc">Ugyldiggør alle aktive logins, også dette.</div></div><button class="btn btn-sm" data-action="logout-all">Log ud overalt</button></div>`}
        </div>

        <div class="card">
          <div class="card-header"><h2>${icon('eye')}Visning</h2></div>
          <div class="setting-row"><div><div class="lbl">Tema</div><div class="desc">Lys, mørk eller følg systemet.</div></div><select class="select-inline" id="set-theme" aria-label="Tema">${opt('system', 'Følg systemet', state.theme)}${opt('light', 'Lys', state.theme)}${opt('dark', 'Mørk', state.theme)}</select></div>
          <div class="setting-row"><div><div class="lbl">Basisvaluta</div><div class="desc">Alle totaler omregnes til denne valuta.</div></div><select class="select-inline" id="set-currency" aria-label="Basisvaluta">${BASE_CURRENCIES.map((c) => opt(c, c, state.baseCurrency)).join('')}</select></div>
          <div class="setting-row"><div><div class="lbl">Kontanter</div><div class="desc">Uinvesterede penge i depotet. Lægges til porteføljeværdien.</div></div><div class="input-group" style="max-width:180px"><input class="input n" id="set-cash" inputmode="decimal" value="${s.cash ? fmtRaw(s.cash) : ''}" placeholder="0" aria-label="Kontanter"><span class="addon">${esc(state.baseCurrency)}</span></div></div>
          <div class="setting-row"><div><div class="lbl">Vis ører på beløb</div><div class="desc">Vis to decimaler på alle beløb i basisvalutaen.</div></div><label class="switch"><input type="checkbox" id="set-decimals" ${s.showDecimals ? 'checked' : ''} aria-label="Vis ører på beløb"><span class="track"></span></label></div>
          <div class="setting-row"><div><div class="lbl">Skjul beløb</div><div class="desc">Slører beløb, når andre kigger med. Procenter vises stadig.</div></div><label class="switch"><input type="checkbox" id="set-privacy" ${state.privacy ? 'checked' : ''} aria-label="Skjul beløb"><span class="track"></span></label></div>
        </div>

        <div class="card">
          <div class="card-header"><h2>${icon('briefcase')}Depoter</h2><span class="hint">Fx Månedsopsparing, Pension</span></div>
          <p class="muted small" style="margin-bottom:10px">Knyt dine køb til et depot og se dem samlet eller hver for sig. Samme aktie kan ligge i flere depoter.</p>
          ${accounts().length ? accounts().map((a) => `<div class="setting-row account-row" data-id="${esc(a.id)}"><input class="input account-name" value="${esc(a.name)}" maxlength="40" aria-label="Depotnavn" data-id="${esc(a.id)}"><span class="muted small">${state.allHoldings.filter((h) => h.accountId === a.id).length} aktier</span><button class="btn btn-sm btn-ghost" data-action="account-delete" data-id="${esc(a.id)}" aria-label="Slet ${esc(a.name)}">${icon('trash', 'icon icon-sm')}</button></div>`).join('') : '<p class="muted small">Ingen depoter endnu.</p>'}
          <div class="setting-row"><div class="input-group" style="flex:1"><input class="input" id="account-new" placeholder="Nyt depot, fx Pension" maxlength="40" aria-label="Nyt depot"><button class="addon addon-btn" data-action="account-add" type="button">Tilføj</button></div></div>
        </div>

        <div class="card">
          <div class="card-header"><h2>${icon('refresh')}Kurser</h2></div>
          <div class="setting-row"><div><div class="lbl">Opdatér automatisk</div><div class="desc">Henter nye kurser hvert minut, mens siden er åben.</div></div><label class="switch"><input type="checkbox" id="set-autorefresh" ${state.autoRefresh ? 'checked' : ''} aria-label="Opdatér automatisk"><span class="track"></span></label></div>
          <div class="setting-row"><div><div class="lbl">Seneste hentning</div><div class="desc">${state.portfolio ? `${esc(fmtDateTime(state.portfolio.updatedAt))} · ${state.portfolio.totals.okCount} af ${state.portfolio.totals.positionCount} kurser hentet · ${Object.keys(state.portfolio.fxRates || {}).filter((c) => c !== state.baseCurrency).length} valutakurser` : '–'}</div></div><button class="btn btn-sm" data-action="refresh">Hent nu</button></div>
          <div class="setting-row"><div><div class="lbl">Hvor tit?</div><div class="desc">Hvert minut mens en børs er åben, hvert 5. minut når alle er lukket, og aldrig mens fanen er skjult.</div></div></div>
          <div class="setting-row"><div><div class="lbl">Kilde</div><div class="desc">Yahoo Finance. Kurser kan være op til 15 min. forsinkede og er ikke rådgivning.</div></div></div>
        </div>

        <div class="card">
          <div class="card-header"><h2>${icon('download')}Data</h2></div>
          <div class="setting-row"><div><div class="lbl">Sikkerhedskopi</div><div class="desc">Download alle beholdninger som en JSON-fil.</div></div><button class="btn btn-sm" data-action="backup">${icon('download', 'icon icon-sm')}Download</button></div>
          <div class="setting-row"><div><div class="lbl">Gendan</div><div class="desc">Erstat beholdningerne med indholdet af en sikkerhedskopi.</div></div><button class="btn btn-sm" data-action="restore">${icon('upload', 'icon icon-sm')}Vælg fil…</button></div>
          <div class="setting-row"><div><div class="lbl">Importér fra banken</div><div class="desc">Hent din transaktionsoversigt som CSV hos banken, fx Nordnet. Appen regner antal og gennemsnitskurs ud pr. depot og foreslår symboler. Du ser det hele, før noget gemmes.</div></div><button class="btn btn-sm" data-action="import-broker">${icon('upload', 'icon icon-sm')}Vælg fil…</button></div>
          ${state.storage === 'server' && localHasData() ? `<div class="setting-row"><div><div class="lbl">Data fra denne browser</div><div class="desc">Der ligger stadig aktier gemt lokalt i denne browser fra før. Overfør dem til din konto, så de følger med på alle enheder.</div></div><button class="btn btn-sm btn-primary" data-action="import-local">Overfør</button></div>` : ''}
          <div class="setting-row"><div><div class="lbl">Hvor ligger mine data?</div><div class="desc">${state.storage === 'browser' ? 'I denne browsers lokale lager (localStorage). Rydder du browserdata, forsvinder de – så download en sikkerhedskopi.' : 'I serverens database/datamappe.'} Ingen data sendes til andre end Yahoo Finance (kun symboler).</div></div></div>
        </div>
      </div>`;
  }

  // ======================================================================
  // Detaljepanel
  // ======================================================================

  function openPanel(symbol) {
    state.panelSymbol = symbol;
    renderPanel();
    const panel = $('#panel');
    panel.inert = false;
    panel.classList.add('show');
    $('#panel-backdrop').classList.add('show');
    setTimeout(() => $('#panel [data-action="close-panel"]')?.focus(), 50);
  }

  function closePanel() {
    if (!state.panelSymbol) return;
    state.panelSymbol = null;
    const panel = $('#panel');
    panel.classList.remove('show');
    panel.inert = true;
    $('#panel-backdrop').classList.remove('show');
  }

  function renderPanel() {
    const p = positions().find((x) => x.symbol === state.panelSymbol);
    const panel = $('#panel');
    if (!p) {
      closePanel();
      return;
    }
    const cur = p.currency || '';
    const hasPrice = isNum(p.price);
    const fx = p.fxRate && cur !== state.baseCurrency ? `<div class="muted small">Omregnet med ${esc(cur)}/${esc(state.baseCurrency)} ${fmtNum(p.fxRate, 2, 4)}</div>` : '';
    let range52 = '';
    if (isNum(p.fiftyTwoWeekLow) && isNum(p.fiftyTwoWeekHigh) && hasPrice && p.fiftyTwoWeekHigh > p.fiftyTwoWeekLow) {
      const pct = clamp(((p.price - p.fiftyTwoWeekLow) / (p.fiftyTwoWeekHigh - p.fiftyTwoWeekLow)) * 100, 0, 100);
      range52 = `<div><h3>52 ugers interval</h3><div class="range52"><i style="left:${pct.toFixed(1)}%"></i></div><div class="range52-labels"><span>${fmtPrice(p.fiftyTwoWeekLow)}</span><span>${fmtPrice(p.fiftyTwoWeekHigh)}</span></div></div>`;
    }
    const dayRange = isNum(p.dayLow) && isNum(p.dayHigh) ? `<dt>Dagens interval</dt><dd>${fmtPrice(p.dayLow)} – ${fmtPrice(p.dayHigh)}</dd>` : '';
    const status = p.status === 'error' || p.status === 'fx_error' ? `<div class="banner error">${icon('warn')}<div>${esc(p.error?.message || 'Ingen kurs')}</div></div>` : p.status === 'stale' ? `<div class="banner">${icon('info')}<div>Kunne ikke opdatere kursen – viser seneste kendte kurs${p.fetchedAt ? ` fra ${esc(fmtDateTime(p.fetchedAt))}` : ''}.</div></div>` : '';

    panel.innerHTML = `
      <div class="panel-head">
        <div>
          <h2>${esc(p.name || p.symbol)}</h2>
          <div class="stock-meta">${esc(p.symbol)}${p.exchange ? ` · ${esc(p.exchange)}` : ''}${cur ? ` <span class="chip">${esc(cur)}</span>` : ''}${p.marketOpen === true ? ' <span class="market-dot open"></span> Åben' : p.marketOpen === false ? ' <span class="market-dot"></span> Lukket' : ''}${accounts().length ? ` <span class="chip chip-account">${esc(p.accountName || 'Uden depot')}</span>` : ''}</div>
        </div>
        <button class="btn btn-ghost btn-icon" data-action="close-panel" aria-label="Luk">${icon('x')}</button>
      </div>
      <div class="panel-body">
        ${status}
        <div>
          <div class="panel-price"><span class="big${p.status === 'stale' ? ' stale' : ''}">${hasPrice ? fmtPrice(p.price) : '–'}</span><span class="muted">${esc(cur)}</span><span class="${p.status === 'stale' ? 'stale' : signClass(p.changePercent)}">${arrow(p.changePercent)}${fmtPct(p.changePercent)}${isNum(p.previousClose) && hasPrice ? ` (${fmtPrice(p.price - p.previousClose)})` : ''}</span></div>
          <div class="muted small">${p.marketTime ? `Seneste handel: ${esc(fmtDateTime(p.marketTime))}` : ''}${p.fetchedAt ? ` · kurs hentet kl. ${esc(fmtTime(p.fetchedAt))}` : ''}</div>
          <dl class="kv" style="margin-top:10px">${dayRange}${isNum(p.previousClose) ? `<dt>Forrige lukkekurs</dt><dd>${fmtPrice(p.previousClose)}</dd>` : ''}</dl>
        </div>
        ${range52}
        <div>
          <h3>Din position</h3>
          <dl class="kv">
            <dt>Antal</dt><dd>${fmtQty(p.quantity)} stk.</dd>
            <dt>Gns. købskurs</dt><dd>${isNum(p.avgPrice) ? `${fmtPrice(p.avgPrice)} ${esc(cur)}` : '<span class="muted">ikke angivet</span>'}</dd>
            <dt>Investeret</dt><dd class="amount">${fmtAmount(p.costBase)}</dd>
            <dt>Værdi</dt><dd class="amount">${fmtAmount(p.valueBase)}</dd>
            <dt>Afkast</dt><dd class="${signClass(p.gainBase)}">${isNum(p.gainBase) ? `<span class="amount">${fmtAmount(p.gainBase, state.baseCurrency, { sign: true })}</span> (${fmtPct(p.gainPercent)})` : '<span class="muted">– tilføj købskurs under Redigér</span>'}</dd>
            ${isNum(p.annualizedPercent) ? `<dt title="Afkastet omregnet til, hvad det svarer til pr. år">Afkast pr. år</dt><dd class="${signClass(p.annualizedPercent)}">${fmtPct(p.annualizedPercent)}</dd>` : ''}
            <dt>I dag</dt><dd class="${signClass(p.dayChangeBase)}"><span class="amount">${fmtAmount(p.dayChangeBase, state.baseCurrency, { sign: true })}</span></dd>
            <dt>Andel af portefølje</dt><dd>${fmtPct(p.weight, { sign: false })}</dd>
            <dt>Købt den</dt><dd>${p.purchasedAt ? `${esc(fmtDate(p.purchasedAt, { year: true }))}${isNum(p.heldDays) ? ` <span class="muted">· ${esc(ejertid(p.heldDays))}</span>` : ''}` : '<span class="muted">ikke angivet</span>'}</dd>
            ${p.weightedAt && p.weightedAt !== p.purchasedAt ? `<dt title="Den dato pengene i gennemsnit blev sat ind. Afkast pr. år regnes herfra.">Pengene i snit</dt><dd>${esc(fmtDate(p.weightedAt, { year: true }))}${isNum(p.moneyDays) ? ` <span class="muted">· ${esc(ejertid(p.moneyDays))}</span>` : ''}</dd>` : ''}
          </dl>
          ${lotList(p)}
          ${fx}
          ${isNum(p.gainBase) ? `<div class="muted small" style="margin-top:6px">${esc(AFKAST_TOOLTIP)}</div>` : ''}
          ${p.note ? `<div class="muted small" style="margin-top:8px">Note: ${esc(p.note)}</div>` : ''}
        </div>
        <div class="panel-actions">
          <button class="btn btn-primary" data-action="trade" data-type="buy" data-id="${esc(p.id)}">${icon('cart')}Køb til</button>
          <button class="btn" data-action="trade" data-type="sell" data-id="${esc(p.id)}">${icon('sell')}Sælg</button>
          <button class="btn" data-action="edit" data-id="${esc(p.id)}">${icon('edit')}Redigér</button>
          <button class="btn btn-danger" data-action="delete" data-id="${esc(p.id)}">${icon('trash')}Slet</button>
          <a class="btn btn-ghost span2" href="${yahooUrl(p.symbol)}" target="_blank" rel="noopener">${icon('external')}Åbn på Yahoo Finance</a>
        </div>
      </div>`;
  }

  // ======================================================================
  // Dialoger
  // ======================================================================

  function openDialog(id) {
    const dlg = $(id);
    if (!dlg.open) dlg.showModal();
    return dlg;
  }

  function setError(id, msg) {
    $(id).textContent = msg || '';
  }

  function confirmDialog({ title, text, okLabel = 'Slet', danger = true }) {
    return new Promise((resolve) => {
      const dlg = $('#dlg-confirm');
      $('#confirm-title').textContent = title;
      $('#confirm-text').textContent = text;
      const ok = $('#confirm-ok');
      ok.textContent = okLabel;
      ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        dlg.removeEventListener('close', onClose);
        resolve(value);
      };
      const onClose = () => finish(dlg.returnValue === 'ok');
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      ok.onclick = (e) => {
        e.preventDefault();
        dlg.close('ok');
      };
      dlg.showModal();
    });
  }

  // ---------- Tilføj ----------

  const add = { selected: null, results: [], active: -1, timer: null, seq: 0, quote: null, lastQuery: '', existing: null };

  // Udfylder et depot-<select> med de kendte depoter + "Uden depot".
  function fillAccountSelect(sel, value) {
    const list = accounts();
    sel.innerHTML = `<option value="">Uden depot</option>${list.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}`;
    sel.value = value && list.some((a) => a.id === value) ? value : '';
    sel.closest('.field')?.classList.toggle('hidden', list.length === 0);
  }

  function defaultAccountForAdd() {
    if (state.account !== 'all' && state.account !== 'none') return state.account;
    if (state.account === 'none') return '';
    return storageGet('lastAccount', '');
  }

  function openAdd(query = '') {
    add.selected = null;
    add.results = [];
    add.active = -1;
    add.quote = null;
    add.existing = null;
    $('#add-search').value = query;
    add.lastQuery = query;
    $('#add-results').innerHTML = '';
    $('#add-price').placeholder = '0,00';
    $('#add-notice').innerHTML = '';
    $('#add-deviation').innerHTML = '';
    fillAccountSelect($('#add-account'), defaultAccountForAdd());
    loadAllHoldings();
    if (query) runSearch(query);
    $('#add-qty').value = '';
    $('#add-price').value = '';
    $('#add-note').value = '';
    $('#add-date').value = '';
    setError('#add-error', '');
    showAddStep('search');
    openDialog('#dlg-add');
    setTimeout(() => {
      const f = $('#add-search');
      f.focus();
      if (query) f.select();
    }, 50);
  }

  function showAddStep(step) {
    const search = step === 'search';
    $('#add-step-search').classList.toggle('hidden', !search);
    $('#add-step-form').classList.toggle('hidden', search);
    $('#add-submit').classList.toggle('hidden', search);
    $('#add-back').classList.toggle('hidden', search);
    $('#dlg-add-title').textContent = search ? 'Tilføj aktie' : `Tilføj ${add.selected?.name || ''}`;
  }

  const SYMBOL_LIKE = /^[A-Z0-9^][A-Z0-9.\-=^]{0,24}$/i;

  function renderAddResults(items, msg, { symbolHint = null } = {}) {
    const ul = $('#add-results');
    if (msg) {
      ul.innerHTML = `<li class="msg">${esc(msg)}</li>${symbolHint ? `<li role="option" data-use-symbol="${esc(symbolHint)}"><span class="stock-avatar">?</span><span class="name">Brug symbolet "${esc(symbolHint)}"<br><span class="meta">Vi tjekker hos Yahoo Finance, om det findes</span></span></li>` : ''}`;
      return;
    }
    const owned = new Set(positions().map((p) => p.symbol));
    ul.innerHTML = items.map((r, i) => `<li role="option" data-index="${i}" class="${i === add.active ? 'active' : ''}"><span class="stock-avatar">${esc(initials(r.symbol))}</span><span class="name">${esc(r.name)}<br><span class="meta">${esc(r.symbol)}${r.exchange ? ` · ${esc(r.exchange)}` : ''}${r.type && r.type !== 'EQUITY' ? ` · ${esc(typeLabel(r.type))}` : ''}</span></span>${owned.has(r.symbol) ? '<span class="chip">I porteføljen</span>' : ''}</li>`).join('');
  }

  function typeLabel(t) {
    return { ETF: 'ETF', MUTUALFUND: 'Fond', INDEX: 'Indeks', CRYPTOCURRENCY: 'Krypto' }[t] || t;
  }

  async function runSearch(q) {
    const seq = ++add.seq;
    if (q.length < 1) {
      add.results = [];
      renderAddResults([]);
      return;
    }
    renderAddResults([], 'Søger…');
    try {
      const data = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      if (seq !== add.seq) return;
      add.results = data.results;
      add.active = data.results.length ? 0 : -1;
      const hint = SYMBOL_LIKE.test(q) && !data.results.some((r) => r.symbol === q.toUpperCase()) ? q.toUpperCase() : null;
      if (!data.results.length) renderAddResults([], `Ingen resultater for "${q}". Prøv navnet på engelsk eller et Yahoo-symbol (husk .CO for danske aktier).`, { symbolHint: hint });
      else renderAddResults(data.results);
    } catch (err) {
      if (seq !== add.seq) return;
      renderAddResults([], `Søgning fejlede: ${err.message}`, { symbolHint: SYMBOL_LIKE.test(q) ? q.toUpperCase() : null });
    }
  }

  // Ejer du allerede aktien i det valgte depot, bliver dialogen til "Køb til": det du skriver lægges oveni.
  // Sætter fokus i et felt kort efter en dialog åbner – men kun hvis brugeren ikke
  // allerede selv er i gang et andet sted. Ellers kan tastning nå at lande i det
  // forkerte felt, når fokus rykkes bagefter.
  function focusSoon(selector, ms = 30) {
    setTimeout(() => {
      const el = $(selector);
      if (!el) return;
      const aktiv = document.activeElement;
      const iGang = aktiv && aktiv !== document.body && aktiv !== el
        && (aktiv.tagName === 'INPUT' || aktiv.tagName === 'SELECT' || aktiv.tagName === 'TEXTAREA');
      if (iGang) return;
      el.focus();
    }, ms);
  }

  function applyAddMode() {
    if (!add.selected) return;
    const accountId = $('#add-account').value || null;
    add.existing = state.allHoldings.find((h) => sameSlot(h, add.selected.symbol, accountId)) || null;
    const buy = Boolean(add.existing);
    $('#add-mode-notice').innerHTML = buy
      ? `<div class="notice info">Du ejer allerede <b>${fmtQty(add.existing.quantity)} stk.</b>${accountId ? ` i ${esc(accountName(accountId) || 'depotet')}` : ''}${isNum(add.existing.avgPrice) ? ` til gns. <b>${fmtPrice(add.existing.avgPrice)} ${esc(add.existing.currency || '')}</b>` : ''}. Det du skriver her lægges oveni, og gennemsnitskursen regnes ud for dig.</div>`
      : '';
    $('#add-qty-label').textContent = buy ? 'Antal købt' : 'Antal';
    $('#add-price-label').textContent = buy ? 'Købskurs for dette køb' : 'Gns. købskurs';
    $('#add-price-help').textContent = buy ? 'Kursen du købte til denne gang.' : 'Valgfri. Uden købskurs vises værdi, men ikke afkast.';
    $('#add-note').closest('.field').classList.toggle('hidden', buy);
    $('#add-date').closest('.field').classList.toggle('hidden', buy);
    $('#add-submit').textContent = buy ? 'Læg til beholdning' : 'Tilføj';
    updateAddSummary();
  }

  async function selectStock(result) {
    add.selected = result;
    add.quote = null;
    add.existing = null;
    $('#add-selected').innerHTML = `<span class="stock-avatar">${esc(initials(result.symbol))}</span><span><span class="name">${esc(result.name)}</span><br><span class="meta">${esc(result.symbol)}${result.exchange ? ` · ${esc(result.exchange)}` : ''}</span></span><span class="meta" id="add-quote-info">Henter kurs…</span>`;
    $('#add-price-addon').textContent = result.currency || '';
    $('#add-notice').innerHTML = '';
    $('#add-submit').disabled = false;
    showAddStep('form');
    applyAddMode();
    focusSoon('#add-qty', 30);
    try {
      const data = await api('GET', `/api/quote/${encodeURIComponent(result.symbol)}`);
      if (add.selected !== result) return;
      const q = data.quote;
      add.quote = q;
      result.name = q.name;
      result.currency = q.currency;
      $('#dlg-add-title').textContent = `Tilføj ${q.name}`;
      $('#add-price-addon').textContent = q.currency;
      const notices = [];
      if (q.rawCurrency === 'GBp' || q.rawCurrency === 'GBX') notices.push('Yahoo noterer denne aktie i pence – vi viser og gemmer kurser i GBP (÷100). Skriv din købskurs i GBP.');
      if (q.type === 'MUTUALFUND') notices.push('Investeringsforening: kursen opdateres typisk kun én gang dagligt.');
      $('#add-selected').innerHTML = `<span class="stock-avatar">${esc(initials(q.symbol))}</span><span><span class="name">${esc(q.name)}</span><br><span class="meta">${esc(q.symbol)}${q.exchange ? ` · ${esc(q.exchange)}` : ''} · <span class="chip">${esc(q.currency)}</span>${q.marketOpen === true ? ' · åben' : q.marketOpen === false ? ' · lukket' : ''}</span></span><span class="meta" id="add-quote-info">Kurs nu: <b>${fmtPrice(q.price)} ${esc(q.currency)}</b><br><span class="${signClass(q.changePercent)}">${arrow(q.changePercent)}${fmtPct(q.changePercent)}</span></span>`;
      $('#add-notice').innerHTML = notices.map((n) => `<div class="notice">${esc(n)}</div>`).join('');
      if (!$('#add-price').value) $('#add-price').placeholder = fmtPrice(q.price);
      updateAddSummary();
    } catch (err) {
      const info = $('#add-quote-info');
      if (err.status === 404) {
        if (info) info.textContent = 'Ukendt symbol';
        setError('#add-error', `Yahoo Finance kender ikke symbolet ${result.symbol} – husk .CO for danske aktier.`);
        $('#add-submit').disabled = true;
      } else {
        if (info) info.textContent = 'Kurs ikke tilgængelig';
        $('#add-notice').innerHTML = `<div class="notice">Kunne ikke hente kursen lige nu – du kan stadig tilføje aktien; kurs og valuta hentes automatisk senere.</div>`;
      }
    }
  }

  function updateAddSummary() {
    const qty = parseInput($('#add-qty').value);
    const price = parseInput($('#add-price').value);
    const cur = add.quote?.currency || add.selected?.currency || '';
    const el = $('#add-summary');
    const parts = [];
    if (add.existing && isNum(qty) && qty > 0) {
      const oldQty = add.existing.quantity;
      const newQty = oldQty + qty;
      const newAvg = isNum(add.existing.avgPrice) && isNum(price) ? (oldQty * add.existing.avgPrice + qty * price) / newQty : null;
      el.innerHTML = `<span>Ny beholdning: <b>${fmtQty(newQty)} stk.</b></span><span>${isNum(newAvg) ? `Ny gns. købskurs: <b>${fmtPrice(newAvg)} ${esc(cur)}</b>` : !isNum(add.existing.avgPrice) ? '<span class="muted">Gns. købskurs er ukendt for det du ejer – ret den under Redigér</span>' : 'Skriv købskursen for at se ny gns. købskurs'}</span>`;
      $('#add-deviation').innerHTML = '';
      return;
    }
    if (isNum(qty) && qty > 0) parts.push(`<span>${fmtQty(qty)} stk.</span>`);
    if (isNum(price) && price >= 0 && isNum(qty) && qty > 0) parts.push(`<span>Investeret: <b>${fmtPrice(qty * price)} ${esc(cur)}</b></span>`);
    if (isNum(qty) && qty > 0 && add.quote && isNum(add.quote.price)) parts.push(`<span>Værdi nu: <b>${fmtPrice(qty * add.quote.price)} ${esc(cur)}</b></span>`);
    el.innerHTML = parts.join('') || '<span class="muted">Skriv antal – og gerne din gennemsnitlige købskurs.</span>';
    const warn = $('#add-deviation');
    if (add.quote && isNum(add.quote.price) && add.quote.price > 0 && isNum(price) && price > 0 && Math.abs(price / add.quote.price - 1) > 0.5) {
      warn.innerHTML = `<div class="notice">Købskursen afviger ${fmtPct(Math.abs(price / add.quote.price - 1) * 100, { sign: false })} fra dagens kurs (${fmtPrice(add.quote.price)} ${esc(cur)}). Har du skrevet den i den rigtige valuta?</div>`;
    } else warn.innerHTML = '';
  }

  async function submitAdd() {
    setError('#add-error', '');
    if (!add.selected) return;
    const qty = parseInput($('#add-qty').value);
    const price = parseInput($('#add-price').value);
    if (!isNum(qty) || qty <= 0) return setError('#add-error', 'Antal skal være større end 0.');
    if ($('#add-price').value.trim() && (!isNum(price) || price < 0)) return setError('#add-error', 'Købskursen skal være et tal.');
    const accountId = $('#add-account').value || null;
    const btn = $('#add-submit');
    btn.disabled = true;
    try {
      if (accountId) storageSet('lastAccount', accountId);
      if (add.existing) {
        if (!isNum(price) || price < 0) return setError('#add-error', 'Skriv kursen, du købte til – så regnes den nye gennemsnitskurs ud.');
        const data = await api('POST', `/api/holdings/${encodeURIComponent(add.existing.id)}/trade`, { type: 'buy', quantity: qty, price });
        $('#dlg-add').close();
        toast(`Købte ${fmtQty(qty)} stk. ${data.holding.name} – du har nu ${fmtQty(data.holding.quantity)} stk.`, 'success');
        await afterMutation();
        return;
      }
      const data = await api('POST', '/api/holdings', { symbol: add.selected.symbol, quantity: qty, avgPrice: price ?? null, note: $('#add-note').value, purchasedAt: $('#add-date').value || null, name: add.selected.name, accountId });
      $('#dlg-add').close();
      toast(`${data.holding.name} er tilføjet${accountId ? ` i ${accountName(accountId)}` : ''}`, 'success');
      if (data.warning) toast(data.warning);
      await afterMutation();
    } catch (err) {
      setError('#add-error', err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // De enkelte køb vist i detaljepanelet – kun når aktien føres køb for køb.
  function lotList(p) {
    if (!Array.isArray(p.lots) || p.lots.length < 2) return '';
    const cur = p.currency || '';
    const rækker = [...p.lots]
      .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')))
      .map((l) => `<li><span>${l.date ? esc(fmtDate(l.date, { year: true })) : '<span class="muted">uden dato</span>'}</span><span class="amount">${fmtQty(l.quantity)} stk.</span><span class="amount">${isNum(l.price) ? `${fmtPrice(l.price)} ${esc(cur)}` : '<span class="muted">–</span>'}</span></li>`)
      .join('');
    return `<div class="lot-list"><h3>Dine ${p.lots.length} køb</h3><ul>${rækker}</ul></div>`;
  }

  // ---------- Redigér ----------

  // edit.lots er null, når aktien føres med ét samlet antal, og en liste,
  // når hvert køb skrives ind for sig. Rækkerne lever i DOM'en mellem
  // tegninger – vi læser dem ind igen, før listen ændres, så det man er ved
  // at taste, ikke forsvinder.
  const edit = { id: null, lots: null };
  const MAX_LOTS = 100;

  function openEdit(id) {
    const p = positions().find((x) => x.id === id);
    if (!p) return;
    edit.id = id;
    edit.lots = Array.isArray(p.lots) && p.lots.length
      ? p.lots.map((l) => ({ date: l.date || '', quantity: fmtRaw(l.quantity), price: fmtRaw(l.price) }))
      : null;
    $('#dlg-edit-title').textContent = `Redigér ${p.name || p.symbol}`;
    $('#edit-qty').value = fmtRaw(p.quantity);
    $('#edit-price').value = fmtRaw(p.avgPrice);
    $('#edit-price-addon').textContent = p.currency || '';
    $('#edit-note').value = p.note || '';
    $('#edit-date').value = p.purchasedAt || '';
    fillAccountSelect($('#edit-account'), p.accountId || '');
    setError('#edit-error', '');
    renderLots();
    openDialog('#dlg-edit');
    if (!edit.lots) setTimeout(() => $('#edit-qty').select(), 30);
  }

  // Læser rækkerne tilbage fra DOM'en, så tastede værdier overlever en ny tegning.
  function readLotRows() {
    return $$('#edit-lot-rows .lot-row').map((row) => ({
      date: row.querySelector('[data-lot="date"]').value,
      quantity: row.querySelector('[data-lot="qty"]').value,
      price: row.querySelector('[data-lot="price"]').value,
    }));
  }

  // Antal og gennemsnitskurs regnet ud af købene – samme regnestykke som på serveren.
  function sumLots(rows) {
    let quantity = 0;
    let cost = 0;
    let medKurs = 0;
    let mangler = 0;
    for (const r of rows) {
      const q = parseInput(r.quantity);
      if (!isNum(q) || q <= 0) { if (String(r.quantity).trim() || String(r.price).trim() || r.date) mangler++; continue; }
      quantity += q;
      const pr = parseInput(r.price);
      if (isNum(pr)) { cost += q * pr; medKurs += q; }
    }
    return { quantity, avgPrice: medKurs > 0 ? cost / medKurs : null, mangler };
  }

  function lotRowHtml(l) {
    return `<div class="lot-row">
      <input class="input lot-date" type="date" data-lot="date" value="${esc(l.date || '')}" aria-label="Købsdato">
      <input class="input n" inputmode="decimal" data-lot="qty" value="${esc(l.quantity ?? '')}" placeholder="Antal" aria-label="Antal" autocomplete="off">
      <input class="input n" inputmode="decimal" data-lot="price" value="${esc(l.price ?? '')}" placeholder="Kurs" aria-label="Kurs" autocomplete="off">
      <button type="button" class="btn btn-ghost btn-icon" data-lot-del aria-label="Fjern købet"><svg class="icon"><use href="#i-x"/></svg></button>
    </div>`;
  }

  function renderLots() {
    const on = Array.isArray(edit.lots);
    $('#edit-lots').classList.toggle('hidden', !on);
    $('#edit-date-field').classList.toggle('hidden', on);
    for (const id of ['#edit-qty', '#edit-price']) {
      const el = $(id);
      el.readOnly = on;
      el.classList.toggle('derived', on);
    }
    if (on) {
      $('#edit-lot-rows').innerHTML = edit.lots.map(lotRowHtml).join('');
      $('#edit-lot-add').disabled = edit.lots.length >= MAX_LOTS;
    }
    updateEditSummary();
  }

  function updateEditSummary() {
    const p = positions().find((x) => x.id === edit.id);
    const el = $('#edit-summary');
    const sumEl = $('#edit-lots-sum');
    let qty;
    let price;
    if (Array.isArray(edit.lots)) {
      const rows = readLotRows();
      const sum = sumLots(rows);
      qty = sum.quantity || null;
      price = sum.avgPrice;
      // Felterne ovenfor følger købene, så man kan se tallet vokse, mens man taster.
      $('#edit-qty').value = sum.quantity > 0 ? fmtRaw(round6(sum.quantity)) : '';
      $('#edit-price').value = isNum(sum.avgPrice) ? fmtRaw(round6(sum.avgPrice)) : '';
      const datoer = rows.map((r) => r.date).filter(Boolean).sort();
      const udenDato = rows.length - datoer.length;
      const dele = [`${rows.length} køb`];
      if (udenDato === 0 && datoer.length) dele.push(`første ${esc(fmtDate(datoer[0], { year: true }))}`);
      // Uden dato på hvert køb kan ejertid og afkast pr. år ikke regnes ud.
      if (udenDato) dele.push(`<span class="neg">${udenDato} mangler dato</span>`);
      if (sum.mangler) dele.push(`<span class="neg">${sum.mangler} mangler antal</span>`);
      sumEl.innerHTML = rows.length === 0 ? '<span class="muted">Tilføj dit første køb.</span>' : dele.join(' · ');
    } else {
      qty = parseInput($('#edit-qty').value);
      price = parseInput($('#edit-price').value);
    }
    if (!p || !isNum(qty)) return (el.innerHTML = '');
    const parts = [`<span>${fmtQty(qty)} stk.</span>`];
    if (isNum(price)) parts.push(`<span>Investeret: <b>${fmtPrice(qty * price)} ${esc(p.currency || '')}</b></span>`);
    if (isNum(p.price)) parts.push(`<span>Værdi nu: <b>${fmtPrice(qty * p.price)} ${esc(p.currency || '')}</b></span>`);
    el.innerHTML = parts.join('');
  }

  // Slå enkeltkøb til: det, der allerede står, bliver til det første køb,
  // så man skriver videre i stedet for at starte forfra.
  function lotsOn() {
    const qty = parseInput($('#edit-qty').value);
    const price = parseInput($('#edit-price').value);
    edit.lots = isNum(qty) && qty > 0
      ? [{ date: $('#edit-date').value || '', quantity: fmtRaw(qty), price: isNum(price) ? fmtRaw(price) : '' }]
      : [{ date: '', quantity: '', price: '' }];
    renderLots();
    focusSoon('#edit-lot-rows .lot-row:last-child [data-lot="qty"]', 30);
  }

  function lotsOff() {
    const sum = sumLots(readLotRows());
    const datoer = readLotRows().map((r) => r.date).filter(Boolean).sort();
    edit.lots = null;
    renderLots();
    if (sum.quantity > 0) $('#edit-qty').value = fmtRaw(round6(sum.quantity));
    if (isNum(sum.avgPrice)) $('#edit-price').value = fmtRaw(round6(sum.avgPrice));
    if (datoer.length) $('#edit-date').value = datoer[0];
  }

  async function submitEdit() {
    setError('#edit-error', '');
    const body = { note: $('#edit-note').value };
    if (Array.isArray(edit.lots)) {
      const rows = readLotRows().filter((r) => String(r.quantity).trim() || String(r.price).trim() || r.date);
      if (!rows.length) return setError('#edit-error', 'Skriv mindst ét køb – eller vælg "Brug samlet antal".');
      const lots = [];
      for (const [i, r] of rows.entries()) {
        const q = parseInput(r.quantity);
        if (!isNum(q) || q <= 0) return setError('#edit-error', `Køb nr. ${i + 1}: antal skal være større end 0.`);
        const pr = String(r.price).trim() ? parseInput(r.price) : null;
        if (String(r.price).trim() && (!isNum(pr) || pr < 0)) return setError('#edit-error', `Køb nr. ${i + 1}: kursen skal være et tal.`);
        lots.push({ date: r.date || null, quantity: q, price: pr });
      }
      body.lots = lots;
    } else {
      const qty = parseInput($('#edit-qty').value);
      const priceRaw = $('#edit-price').value.trim();
      const price = parseInput(priceRaw);
      if (!isNum(qty) || qty <= 0) return setError('#edit-error', 'Antal skal være større end 0.');
      if (priceRaw && (!isNum(price) || price < 0)) return setError('#edit-error', 'Købskursen skal være et tal.');
      Object.assign(body, { quantity: qty, avgPrice: priceRaw ? price : null, purchasedAt: $('#edit-date').value || null, lots: [] });
    }
    if (accounts().length) body.accountId = $('#edit-account').value || null;
    try {
      await api('PUT', `/api/holdings/${encodeURIComponent(edit.id)}`, body);
      $('#dlg-edit').close();
      toast('Gemt', 'success');
      await afterMutation();
    } catch (err) {
      setError('#edit-error', err.message);
    }
  }

  // ---------- Køb til / sælg ----------

  const trade = { id: null, type: 'buy' };

  function openTrade(id, type) {
    const p = positions().find((x) => x.id === id);
    if (!p) return;
    trade.id = id;
    trade.type = type;
    $('#trade-qty').value = '';
    $('#trade-price').value = fmtRaw(p.price);
    $('#trade-price-addon').textContent = p.currency || '';
    $('#trade-date').value = '';
    setError('#trade-error', '');
    applyTradeType();
    openDialog('#dlg-trade');
    focusSoon('#trade-qty', 30);
  }

  function applyTradeType() {
    const p = positions().find((x) => x.id === trade.id);
    const buy = trade.type === 'buy';
    $$('#dlg-trade [data-trade-type]').forEach((b) => b.classList.toggle('active', b.dataset.tradeType === trade.type));
    $('#trade-sell-all').classList.toggle('hidden', buy);
    // Datoen hører til købet – ved salg skrumper de eksisterende køb bare.
    $('#trade-date-field').classList.toggle('hidden', !buy);
    $('#dlg-trade-title').textContent = `${buy ? 'Køb til' : 'Sælg'} – ${p?.name || ''}`;
    $('#trade-qty-label').textContent = buy ? 'Antal købt' : 'Antal solgt';
    $('#trade-submit').textContent = buy ? 'Læg til' : 'Registrér salg';
    updateTradeSummary();
  }

  function updateTradeSummary() {
    const p = positions().find((x) => x.id === trade.id);
    const el = $('#trade-summary');
    if (!p) return (el.innerHTML = '');
    const qty = parseInput($('#trade-qty').value);
    const price = parseInput($('#trade-price').value);
    if (!isNum(qty) || qty <= 0) {
      el.innerHTML = `<span class="muted">Du ejer ${fmtQty(p.quantity)} stk.${isNum(p.avgPrice) ? ` til gns. ${fmtPrice(p.avgPrice)} ${esc(p.currency || '')}` : ''}</span>`;
      return;
    }
    if (trade.type === 'buy') {
      const newQty = p.quantity + qty;
      const newAvg = isNum(p.avgPrice) && isNum(price) ? (p.quantity * p.avgPrice + qty * price) / newQty : null;
      el.innerHTML = `<span>Ny beholdning: <b>${fmtQty(newQty)} stk.</b></span><span>${isNum(newAvg) ? `Ny gns. købskurs: <b>${fmtPrice(newAvg)} ${esc(p.currency || '')}</b>` : !isNum(p.avgPrice) ? '<span class="muted">Gns. købskurs forbliver ukendt – ret den under Redigér</span>' : ''}</span>`;
    } else {
      const newQty = p.quantity - qty;
      el.innerHTML = newQty < -1e-9
        ? `<span class="neg">Du ejer kun ${fmtQty(p.quantity)} stk.</span>`
        : `<span>Tilbage: <b>${fmtQty(Math.max(0, newQty))} stk.</b>${newQty <= 1e-9 ? ' – aktien fjernes fra porteføljen' : ''}</span>${isNum(price) ? `<span>Salgssum: <b>${fmtPrice(qty * price)} ${esc(p.currency || '')}</b></span>` : ''}`;
    }
  }

  async function submitTrade() {
    setError('#trade-error', '');
    const qty = parseInput($('#trade-qty').value);
    const priceRaw = $('#trade-price').value.trim();
    const price = parseInput(priceRaw);
    if (!isNum(qty) || qty <= 0) return setError('#trade-error', 'Antal skal være større end 0.');
    if (trade.type === 'buy' && (!isNum(price) || price < 0)) return setError('#trade-error', 'Skriv kursen, du købte til.');
    try {
      const body = { type: trade.type, quantity: qty, price: priceRaw ? price : null };
      if (trade.type === 'buy' && $('#trade-date').value) body.date = $('#trade-date').value;
      const data = await api('POST', `/api/holdings/${encodeURIComponent(trade.id)}/trade`, body);
      $('#dlg-trade').close();
      if (data.removed) {
        toast(`${data.holding.name} er solgt helt og fjernet fra porteføljen`, 'success');
        closePanel();
      } else {
        toast(trade.type === 'buy' ? `Købte ${fmtQty(qty)} stk. ${data.holding.name}` : `Solgte ${fmtQty(qty)} stk. ${data.holding.name}`, 'success');
      }
      await afterMutation();
    } catch (err) {
      setError('#trade-error', err.message);
    }
  }

  // ---------- Slet ----------

  async function deleteHolding(id) {
    const p = positions().find((x) => x.id === id);
    if (!p) return;
    const ok = await confirmDialog({ title: `Slet ${p.name || p.symbol}?`, text: `${fmtQty(p.quantity)} stk. fjernes fra porteføljen. Det kan ikke fortrydes.` });
    if (!ok) return;
    try {
      await api('DELETE', `/api/holdings/${encodeURIComponent(id)}`);
      closePanel();
      toast(`${p.name || p.symbol} er slettet`, 'success');
      await afterMutation();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function invalidateHistory() {
    const keep = state.history[state.range];
    state.history = keep && !keep.error ? { [state.range]: keep } : {};
    if (currentRoute() === 'overview' && positions().length) loadHistory(state.range, { force: true });
  }

  // ---------- Import fra banken ----------

  const imp = { rows: [], depots: [], cash: null, info: null };

  async function handleImportFile(file) {
    let parsed;
    try {
      parsed = window.parseBrokerCsv(window.parseBrokerCsv.decode(await file.arrayBuffer()));
    } catch (err) {
      return toast(`Kunne ikke læse filen: ${err.message}`, 'error');
    }
    if (!parsed.ok) return toast(parsed.error, 'error');
    if (!parsed.positions.length) return toast('Fandt ingen åbne beholdninger i filen. Er alt solgt, er der intet at importere.', 'error');

    toast(`Fandt ${parsed.positions.length} beholdninger. Slår symboler op…`);
    let results = [];
    try {
      const res = await serverApi('POST', '/api/resolve', {
        securities: parsed.positions.map((p) => ({ isin: p.isin, name: p.name, currency: p.currency })),
      });
      results = res.results || [];
    } catch (err) {
      return toast(`Kunne ikke slå symboler op: ${err.message}`, 'error');
    }

    await loadAllHoldings();
    imp.cash = parsed.cash;
    imp.info = parsed;
    imp.depots = (parsed.depots.length ? parsed.depots : ['']).map((code) => {
      const used = state.allHoldings.filter((h) => h.accountId).length;
      const existing = accounts().find((a) => a.name === `Depot ${code}`);
      return { code, name: existing ? existing.name : code ? `Depot ${code}` : 'Uden depot', used };
    });
    imp.rows = parsed.positions.map((p, i) => {
      const r = results[i] || {};
      return { ...p, resolved: r, symbol: r.symbol || '', include: Boolean(r.symbol) };
    });
    renderImportDialog();
    setError('#import-error', '');
    openDialog('#dlg-import');
  }

  function renderImportDialog() {
    const p = imp.info;
    $('#import-summary').innerHTML = `<span>${p.positions.length} ${p.positions.length === 1 ? 'beholdning' : 'beholdninger'} fra ${p.trades} ${p.trades === 1 ? 'handel' : 'handler'}</span>${p.closed ? `<span class="muted">${p.closed} udsolgt${p.closed === 1 ? '' : 'e'} udeladt</span>` : ''}<span class="muted">${imp.depots.length} ${imp.depots.length === 1 ? 'depot' : 'depoter'}</span>`;

    $('#import-depots').innerHTML = imp.depots.map((d) => `<div class="import-depot-row"><span class="code">${esc(d.code || 'uden depotnummer')}</span><span>→</span><input class="input" data-depot-name="${esc(d.code)}" value="${esc(d.name)}" maxlength="40" aria-label="Navn på depot ${esc(d.code)}"><span class="muted small">navnet depotet får her i appen</span></div>`).join('');

    $('#import-rows').innerHTML = imp.rows.map((row, i) => {
      const r = row.resolved || {};
      const notes = [];
      if (!row.symbol) notes.push('Fandt ikke et symbol – skriv det selv, ellers springes den over.');
      else if (r.currencyMismatch) notes.push(`Noteres i ${esc(r.currency)}, men du købte i ${esc(row.currency)}. Så bliver afkastet forkert.`);
      else if (r.nameMismatch) notes.push(`Yahoo kalder ${esc(r.symbol)} for "${esc(r.symbolName || '')}". Kontrollér symbolet.`);
      return `<tr class="${row.include ? '' : 'off'}" data-row="${i}">
        <td><input type="checkbox" data-import-include="${i}" ${row.include ? 'checked' : ''} aria-label="Tag ${esc(row.name)} med"></td>
        <td><div class="stock-name">${esc(row.name)}</div><div class="stock-meta">${esc(row.isin || '')}${r.matchedBy ? ` · fundet via ${esc(r.matchedBy)}` : ''}</div>${notes.map((n) => `<span class="import-note">${n}</span>`).join('')}</td>
        <td><input class="input import-sym" data-import-symbol="${i}" value="${esc(row.symbol)}" placeholder="fx MU" spellcheck="false"></td>
        <td class="n">${fmtQty(row.quantity)}</td>
        <td class="n">${fmtPrice(row.avgPrice)} <span class="muted small">${esc(row.currency)}</span></td>
        <td class="muted small">${row.purchasedAt ? esc(fmtDate(row.purchasedAt, { year: true })) : '–'}${row.lots ? `<div class="muted small">${row.lots.length} køb</div>` : ''}</td>
        <td class="muted small">${esc(imp.depots.find((d) => d.code === row.depot)?.name || '')}</td>
      </tr>`;
    }).join('');

    const cashRow = $('#import-cash-row');
    if (isNum(imp.cash) && imp.cash > 0) {
      cashRow.classList.remove('hidden');
      $('#import-cash-label').textContent = `Sæt kontanter til ${fmtAmount(imp.cash, state.baseCurrency, { decimals: 2 })} fra filens seneste saldo`;
    } else cashRow.classList.add('hidden');

    $('#import-warnings').innerHTML = p.warnings.length ? `<div class="notice">${p.warnings.map(esc).join('<br>')}</div>` : '';
    updateImportCount();
  }

  function updateImportCount() {
    const n = imp.rows.filter((r) => r.include && r.symbol).length;
    $('#import-count').textContent = `${n} af ${imp.rows.length} importeres`;
    $('#import-submit').disabled = n === 0;
  }

  async function submitImport() {
    setError('#import-error', '');
    const btn = $('#import-submit');
    btn.disabled = true;
    state.importing = true; // sæt baggrundsopdateringen på pause imens
    try {
      // 1) Depoter: brug et eksisterende med samme navn, ellers opret det.
      for (const d of imp.depots) {
        const input = document.querySelector(`[data-depot-name="${CSS.escape(d.code)}"]`);
        if (input) d.name = input.value.trim();
      }
      const missing = imp.depots.filter((d) => d.name && !accounts().some((a) => a.name.toLowerCase() === d.name.toLowerCase()));
      if (missing.length) {
        const data = await api('PUT', '/api/settings', { accounts: [...accounts(), ...missing.map((d) => ({ name: d.name }))] });
        state.settings = data.settings;
      }
      for (const d of imp.depots) d.accountId = accounts().find((a) => a.name.toLowerCase() === (d.name || '').toLowerCase())?.id || null;

      // 2) Beholdninger: findes symbolet i samme depot, opdateres antal og kurs.
      const existing = (await api('GET', '/api/holdings')).holdings;
      let added = 0;
      let updated = 0;
      const failed = [];
      for (const row of imp.rows) {
        const symbol = String(row.symbol || '').trim().toUpperCase();
        if (!row.include || !symbol) continue;
        const accountId = imp.depots.find((d) => d.code === row.depot)?.accountId || null;
        const match = existing.find((h) => sameSlot(h, symbol, accountId));
        try {
          if (match) {
            await api('PUT', `/api/holdings/${encodeURIComponent(match.id)}`, { quantity: row.quantity, avgPrice: row.avgPrice, ...(row.purchasedAt ? { purchasedAt: row.purchasedAt } : {}), lots: row.lots || [] });
            updated++;
          } else {
            await api('POST', '/api/holdings', { symbol, quantity: row.quantity, avgPrice: row.avgPrice, purchasedAt: row.purchasedAt || null, ...(row.lots ? { lots: row.lots } : {}), name: row.name, accountId });
            added++;
          }
        } catch (err) {
          failed.push(`${row.name}: ${err.message}`);
        }
      }

      // 3) Kontanter fra filens seneste saldo, hvis brugeren vil.
      if ($('#import-cash')?.checked && isNum(imp.cash)) {
        const data = await api('PUT', '/api/settings', { cash: imp.cash });
        state.settings = data.settings;
      }

      state.importing = false;
      $('#dlg-import').close();
      const parts = [];
      if (added) parts.push(`${added} tilføjet`);
      if (updated) parts.push(`${updated} opdateret`);
      toast(parts.length ? `Import færdig: ${parts.join(', ')}` : 'Intet blev ændret', failed.length ? '' : 'success');
      for (const f of failed.slice(0, 3)) toast(f, 'error');
      await afterMutation();
    } catch (err) {
      setError('#import-error', err.message);
    } finally {
      state.importing = false;
      updateImportCount();
    }
  }

  // ---------- Depoter ----------

  async function saveAccounts(list, successMessage) {
    const data = await api('PUT', '/api/settings', { accounts: list });
    state.settings = data.settings;
    if (successMessage) toast(successMessage, 'success');
    await Promise.all([loadPortfolio({ silent: true, fresh: true }), loadAllHoldings()]);
    render();
  }

  async function addAccount() {
    const input = $('#account-new');
    const name = input.value.trim();
    if (!name) return input.focus();
    try {
      await saveAccounts([...accounts(), { name }], `Depotet "${name}" er oprettet`);
      $('#account-new')?.focus();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function renameAccount(id, name) {
    const trimmed = name.trim();
    const current = accounts().find((a) => a.id === id);
    if (!current || !trimmed || trimmed === current.name) return render();
    try {
      await saveAccounts(accounts().map((a) => (a.id === id ? { ...a, name: trimmed } : a)), 'Depotet er omdøbt');
    } catch (err) {
      toast(err.message, 'error');
      render();
    }
  }

  async function deleteAccount(id) {
    const a = accounts().find((x) => x.id === id);
    if (!a) return;
    const count = state.allHoldings.filter((h) => h.accountId === id).length;
    const ok = await confirmDialog({ title: `Slet depotet ${a.name}?`, text: count ? `${count} ${count === 1 ? 'aktie' : 'aktier'} i depotet slettes ikke – de kommer til at stå "uden depot".` : 'Depotet er tomt.', okLabel: 'Slet depot' });
    if (!ok) return;
    try {
      if (state.account === id) setAccount('all', { reload: false });
      await saveAccounts(accounts().filter((x) => x.id !== id), `Depotet "${a.name}" er slettet`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------- Adgangskode ----------

  // Første adgangskode på en åben side. Bagefter kræver alt login – også denne browser,
  // men opsætningen logger én ind med det samme, så der skal ikke tastes igen.
  async function submitSetup() {
    setError('#setup-error', '');
    const next = $('#setup-new').value;
    const repeat = $('#setup-repeat').value;
    if (next.length < 8) return setError('#setup-error', 'Adgangskoden skal være mindst 8 tegn.');
    if (next !== repeat) return setError('#setup-error', 'De to adgangskoder er ikke ens.');
    try {
      await api('POST', '/api/auth/setup', { password: next, confirm: repeat });
      $('#dlg-setup').close();
      toast('Adgangskoden er oprettet – siden kræver nu login', 'success');
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      setError('#setup-error', err.message);
    }
  }

  async function submitPassword() {
    setError('#pw-error', '');
    const current = $('#pw-current').value;
    const next = $('#pw-new').value;
    const confirm = $('#pw-confirm').value;
    if (next.length < 8) return setError('#pw-error', 'Den nye adgangskode skal være mindst 8 tegn.');
    if (next !== confirm) return setError('#pw-error', 'De to nye adgangskoder er ikke ens.');
    try {
      await api('POST', '/api/auth/change-password', { currentPassword: current, newPassword: next });
      $('#dlg-password').close();
      $('#form-password').reset();
      toast('Adgangskoden er ændret', 'success');
    } catch (err) {
      setError('#pw-error', err.message);
    }
  }

  // ---------- Backup / gendan ----------

  async function downloadBackup() {
    try {
      let blob;
      let name;
      if (state.storage === 'browser') {
        const data = await api('GET', '/api/backup');
        blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        name = `aktie-portfolio-${new Date().toISOString().slice(0, 10)}.json`;
      } else {
        const res = await fetch('/api/backup', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Kunne ikke hente sikkerhedskopi');
        blob = await res.blob();
        name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'aktie-portfolio.json';
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Sikkerhedskopi downloadet', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function restoreFromFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast('Filen er ikke gyldig JSON', 'error');
    }
    if (!Array.isArray(data.holdings)) return toast('Filen indeholder ingen beholdninger', 'error');
    const ok = await confirmDialog({
      title: 'Gendan fra sikkerhedskopi?',
      text: `Dine nuværende ${positions().length} aktier erstattes med de ${data.holdings.length} aktier fra filen "${file.name}".`,
      okLabel: 'Gendan',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api('POST', '/api/restore', { holdings: data.holdings, settings: data.settings });
      toast(`${res.count} aktier gendannet`, 'success');
      await afterMutation();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ======================================================================
  // Toast & menu
  // ======================================================================

  function toast(message, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 7000 : 4000);
  }

  function openMenu(anchor, id) {
    closeMenu();
    const p = positions().find((x) => x.id === id);
    if (!p) return;
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.dataset.id = id;
    menu.innerHTML = `
      <button data-action="open" data-symbol="${esc(p.symbol)}">${icon('info', 'icon icon-sm')}Vis detaljer</button>
      <button data-action="trade" data-type="buy" data-id="${esc(id)}">${icon('cart', 'icon icon-sm')}Køb til</button>
      <button data-action="trade" data-type="sell" data-id="${esc(id)}">${icon('sell', 'icon icon-sm')}Sælg</button>
      <button data-action="edit" data-id="${esc(id)}">${icon('edit', 'icon icon-sm')}Redigér</button>
      <hr>
      <button class="danger" data-action="delete" data-id="${esc(id)}">${icon('trash', 'icon icon-sm')}Slet</button>`;
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = 180;
    menu.style.left = `${clamp(r.right - mw, 8, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 240)}px`;
    state.menu = menu;
  }

  function closeMenu() {
    if (state.menu) {
      state.menu.remove();
      state.menu = null;
    }
  }

  // ======================================================================
  // Hændelser
  // ======================================================================

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-link]');
    if (link) {
      e.preventDefault();
      navigate(new URL(link.href).pathname);
      return;
    }
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      closeBtn.closest('dialog')?.close();
      return;
    }
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
      storageSet('sort', JSON.stringify(state.sort));
      render();
      return;
    }
    const rangeBtn = e.target.closest('[data-range]');
    if (rangeBtn) {
      state.range = rangeBtn.dataset.range;
      storageSet('range', state.range);
      renderChartCard();
      loadHistory(state.range);
      return;
    }
    const accountChip = e.target.closest('[data-account]');
    if (accountChip) {
      setAccount(accountChip.dataset.account);
      return;
    }
    const tradeType = e.target.closest('[data-trade-type]');
    if (tradeType) {
      trade.type = tradeType.dataset.tradeType;
      applyTradeType();
      return;
    }
    const result = e.target.closest('#add-results li[data-index]');
    if (result) {
      selectStock(add.results[Number(result.dataset.index)]);
      return;
    }
    const useSymbol = e.target.closest('#add-results li[data-use-symbol]');
    if (useSymbol) {
      const sym = useSymbol.dataset.useSymbol;
      selectStock({ symbol: sym, name: sym, exchange: null, type: 'EQUITY' });
      return;
    }
    if (e.target.closest('#edit-lots-on')) { lotsOn(); return; }
    if (e.target.closest('#edit-lots-off')) { lotsOff(); return; }
    if (e.target.closest('#edit-lot-add')) {
      edit.lots = [...readLotRows(), { date: '', quantity: '', price: '' }];
      renderLots();
      focusSoon('#edit-lot-rows .lot-row:last-child [data-lot="qty"]', 30);
      return;
    }
    const lotDel = e.target.closest('[data-lot-del]');
    if (lotDel) {
      const rows = readLotRows();
      const i = $$('#edit-lot-rows .lot-row').indexOf(lotDel.closest('.lot-row'));
      rows.splice(i, 1);
      edit.lots = rows;
      renderLots();
      return;
    }
    if (e.target.closest('#trade-sell-all')) {
      e.preventDefault();
      const p = positions().find((x) => x.id === trade.id);
      if (p) {
        $('#trade-qty').value = fmtRaw(p.quantity);
        updateTradeSummary();
      }
      return;
    }
    const el = e.target.closest('[data-action]');
    const inMenu = state.menu && state.menu.contains(e.target);
    if (!inMenu && state.menu && !e.target.closest('[data-action="menu"]')) closeMenu();
    if (!el) return;
    const action = el.dataset.action;
    if (el.tagName === 'A') e.preventDefault();
    if (inMenu) closeMenu();

    switch (action) {
      case 'add': return openAdd(el.dataset.query || '');
      case 'refresh': return manualRefresh();
      case 'privacy':
        state.privacy = !state.privacy;
        storageSet('privacy', state.privacy ? '1' : '0');
        return render();
      case 'logout':
        api('POST', '/api/auth/logout').finally(() => location.replace('/login'));
        return;
      case 'open':
        e.stopPropagation();
        return openPanel(el.dataset.symbol);
      case 'close-panel': return closePanel();
      case 'menu':
        e.stopPropagation();
        return state.menu && state.menu.dataset.id === el.dataset.id ? closeMenu() : openMenu(el, el.dataset.id);
      case 'edit':
        e.stopPropagation();
        return openEdit(el.dataset.id);
      case 'trade':
        e.stopPropagation();
        return openTrade(el.dataset.id, el.dataset.type);
      case 'delete':
        e.stopPropagation();
        return deleteHolding(el.dataset.id);
      case 'plan-years':
        state.plan.years = Number(el.dataset.years) || 10;
        render();
        break;
      case 'copy-invite':
        navigator.clipboard?.writeText(state.inviteCode || '').then(
          () => toast('Invitationskoden er kopieret', 'success'),
          () => toast('Kunne ikke kopiere – markér koden og kopiér selv', 'error'),
        );
        break;
      case 'rotate-invite':
        confirmDialog({ title: 'Ny invitationskode?', text: 'Den nuværende kode holder op med at virke med det samme. Dem, der allerede er tilmeldt, bliver ikke berørt.', okLabel: 'Lav en ny kode' }).then(async (ok) => {
          if (!ok) return;
          try {
            state.inviteCode = (await api('POST', '/api/invite/rotate')).inviteCode;
            render();
            toast('Ny invitationskode lavet', 'success');
          } catch (err) {
            toast(err.message, 'error');
          }
        });
        break;
      case 'setup-password':
        setError('#setup-error', '');
        $('#form-setup-pw').reset();
        $('#dlg-setup').showModal();
        focusSoon('#setup-new', 50);
        break;
      case 'open-dismiss':
        storageSet('open-dismissed', '1');
        render();
        break;
      case 'change-password':
        $('#form-password').reset();
        setError('#pw-error', '');
        openDialog('#dlg-password');
        focusSoon('#pw-current', 30);
        return;
      case 'logout-all':
        confirmDialog({ title: 'Log ud på alle enheder?', text: 'Alle aktive logins ugyldiggøres – også dette. Du skal logge ind igen.', okLabel: 'Log ud overalt' }).then(async (ok) => {
          if (!ok) return;
          try {
            await api('POST', '/api/auth/logout-all');
          } catch (err) {
            return toast(err.message, 'error');
          }
          location.replace('/login');
        });
        return;
      case 'backup': return downloadBackup();
      case 'restore': return $('#restore-file').click();
      case 'import-local':
        if (!state.localImport) checkLocalImportForce();
        return importLocal();
      case 'import-dismiss':
        state.localImport = null;
        storageSet('importDismissed', '1');
        return render();
      case 'import-broker': return $('#import-file').click();
      case 'account-add': return addAccount();
      case 'account-delete': return deleteAccount(el.dataset.id);
      default: return;
    }
  });

  // Klik på tabel-rækker må ikke åbne panelet når man trykker på en knap i rækken
  $('#panel-backdrop').addEventListener('click', closePanel);

  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('th[data-sort], tr[data-action="open"], .hcard[data-action="open"], .movers li[data-action="open"]')) {
      e.preventDefault();
      e.target.click();
      return;
    }
    if (e.key === 'Escape') {
      if (state.menu) return closeMenu();
      if (state.panelSymbol && !document.querySelector('dialog[open]')) return closePanel();
    }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (typing || document.querySelector('dialog[open]')) return;
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      openAdd();
    }
    if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      manualRefresh();
    }
  });

  document.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'add-search') {
      clearTimeout(add.timer);
      const q = e.target.value.trim();
      if (q !== add.lastQuery) {
        add.results = [];
        add.active = -1;
        add.lastQuery = q;
        $('#add-results').innerHTML = ''; // gamle resultater må ikke kunne vælges ved en fejl
      }
      add.timer = setTimeout(() => runSearch(q), 250);
    } else if (id === 'add-qty' || id === 'add-price') updateAddSummary();
    else if (e.target.dataset.lot !== undefined) updateEditSummary();
    else if (id === 'edit-qty' || id === 'edit-price') updateEditSummary();
    else if (id === 'trade-qty' || id === 'trade-price') updateTradeSummary();
    else if (e.target.dataset.importSymbol !== undefined) {
      imp.rows[Number(e.target.dataset.importSymbol)].symbol = e.target.value.trim().toUpperCase();
      updateImportCount();
    }
    else if (id === 'plan-month' || id === 'plan-growth') {
      const n = parseInput(e.target.value);
      const felt = id === 'plan-month' ? 'perMonth' : 'growth';
      state.plan[felt] = isNum(n) ? n : (e.target.value.trim() ? state.plan[felt] : 0);
      // Kun resultatet tegnes om, så markøren ikke hopper ud af feltet.
      const a = state.analytics.data;
      if (a) {
        const { perMonth, growth, years } = planInput(a);
        const f = projectValue({ start: a.value, perMonth, annualPercent: growth, years });
        const boks = $('.plan-result');
        if (boks) {
          $('.plan-value', boks).innerHTML = fmtAmount(f.value);
          const dd = $$('.plan-result .kv dd');
          if (dd[0]) dd[0].innerHTML = fmtAmount(f.contributed);
          if (dd[1]) { dd[1].innerHTML = fmtAmount(f.growth, state.baseCurrency, { sign: true }); dd[1].className = `amount ${signClass(f.growth)}`; }
        }
      }
    }
    else if (id === 'people-search') {
      const felt = e.target;
      const pos = felt.selectionStart;
      searchPeopleSoon(felt.value);
      // Tegningen erstatter feltet; sæt markøren tilbage hvor den var.
      const igen = $('#people-search');
      if (igen && igen !== felt) {
        igen.focus();
        igen.setSelectionRange(pos, pos);
      }
    }
    else if (id === 'filter') {
      state.filter = e.target.value;
      const card = $('#filter')?.closest('.card');
      if (card) {
        const wrap = $('.table-wrap', card) || $('p.muted', card);
        const html = holdingsTable({ compact: false });
        if (wrap) wrap.outerHTML = html || '<p class="muted" style="padding:16px 0"></p>';
      }
    }
  });

  document.addEventListener('change', async (e) => {
    const id = e.target.id;
    if (e.target.dataset.importInclude !== undefined) {
      const i = Number(e.target.dataset.importInclude);
      imp.rows[i].include = e.target.checked;
      e.target.closest('tr')?.classList.toggle('off', !e.target.checked);
      updateImportCount();
      return;
    }
    try {
      if (id === 'set-theme') {
        state.theme = e.target.value;
        storageSet('theme', state.theme);
        applyTheme();
      } else if (id === 'set-currency') {
        const data = await api('PUT', '/api/settings', { baseCurrency: e.target.value });
        state.settings = data.settings;
        state.baseCurrency = data.settings.baseCurrency;
        toast(`Basisvaluta ændret til ${data.settings.baseCurrency}`, 'success');
        state.history = {};
        await loadPortfolio({ fresh: true });
      } else if (id === 'set-decimals') {
        const data = await api('PUT', '/api/settings', { showDecimals: e.target.checked });
        state.settings = data.settings;
        render();
      } else if (id === 'set-privacy') {
        state.privacy = e.target.checked;
        storageSet('privacy', state.privacy ? '1' : '0');
        render();
      } else if (id === 'set-autorefresh') {
        state.autoRefresh = e.target.checked;
        storageSet('autoRefresh', state.autoRefresh ? '1' : '0');
      } else if (id === 'set-name') {
        if (state.access === 'platform') {
          const data = await api('PUT', '/api/me', { name: e.target.value });
          state.me = data.user;
          render();
        } else {
          const data = await api('PUT', '/api/settings', { displayName: e.target.value });
          state.settings = data.settings;
        }
        toast('Navn gemt', 'success');
      } else if (id === 'set-cash') {
        const n = parseInput(e.target.value);
        if (e.target.value.trim() && (!isNum(n) || n < 0)) throw new Error('Kontanter skal være et tal, f.eks. 12.500');
        const data = await api('PUT', '/api/settings', { cash: n ?? 0 });
        state.settings = data.settings;
        toast('Kontanter gemt', 'success');
        await loadPortfolio({ silent: true, fresh: true });
      } else if (e.target.classList.contains('account-name')) {
        await renameAccount(e.target.dataset.id, e.target.value);
      } else if (id === 'add-account') {
        applyAddMode();
      } else if (id === 'import-file') {
        const file = e.target.files[0];
        e.target.value = '';
        if (file) await handleImportFile(file);
      } else if (id === 'restore-file') {
        const file = e.target.files[0];
        e.target.value = '';
        if (file) await restoreFromFile(file);
      }
    } catch (err) {
      toast(err.message, 'error');
      if (id === 'set-currency') render();
    }
  });

  // Tastatur i søgeresultater
  $('#add-search').addEventListener('keydown', (e) => {
    if (!add.results.length) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = e.target.value.trim();
        if (q) {
          clearTimeout(add.timer);
          runSearch(q);
        }
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      add.active = (add.active + delta + add.results.length) % add.results.length;
      renderAddResults(add.results);
      $(`#add-results li[data-index="${add.active}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (add.active >= 0) selectStock(add.results[add.active]);
    }
  });

  $('#form-add').addEventListener('submit', (e) => {
    e.preventDefault();
    if (add.selected) submitAdd();
  });
  $('#add-back').addEventListener('click', () => {
    add.selected = null;
    add.quote = null;
    setError('#add-error', '');
    $('#add-submit').disabled = false;
    showAddStep('search');
    setTimeout(() => $('#add-search').select(), 30);
  });
  $('#form-edit').addEventListener('submit', (e) => { e.preventDefault(); submitEdit(); });
  $('#edit-delete').addEventListener('click', () => { $('#dlg-edit').close(); deleteHolding(edit.id); });
  $('#form-trade').addEventListener('submit', (e) => { e.preventDefault(); submitTrade(); });
  $('#form-password').addEventListener('submit', (e) => { e.preventDefault(); submitPassword(); });
  $('#form-setup-pw').addEventListener('submit', (e) => { e.preventDefault(); submitSetup(); });
  $('#form-import').addEventListener('submit', (e) => { e.preventDefault(); submitImport(); });
  $('#dlg-confirm form').addEventListener('submit', (e) => { e.preventDefault(); $('#dlg-confirm').close('ok'); });

  // Luk dialog ved klik på baggrunden
  $$('dialog').forEach((dlg) => {
    let downOnBackdrop = false;
    dlg.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && downOnBackdrop) dlg.close();
      downOnBackdrop = false;
    });
  });

  // ======================================================================
  // Tema & start
  // ======================================================================

  function applyTheme() {
    const root = document.documentElement;
    if (state.theme === 'dark' || state.theme === 'light') root.setAttribute('data-theme', state.theme);
    else root.removeAttribute('data-theme');
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#0f172a');
  }

  async function init() {
    applyTheme();
    document.body.classList.toggle('private', state.privacy);
    render();
    try {
      const status = await serverApi('GET', '/api/auth/status');
      state.usesEnvPassword = status.usesEnvPassword;
      state.storage = status.storage === 'browser' ? 'browser' : 'server';
      state.access = status.access || (state.storage === 'browser' ? 'browser' : 'login');
      state.canSetPassword = state.access === 'open' && status.setupRequired === true;
      document.body.classList.toggle('platform', state.access === 'platform');
      if (state.access === 'platform') {
        state.me = status.user;
        loadMe();
      }
      document.body.classList.toggle('browser-mode', state.storage === 'browser');
      document.body.classList.toggle('open-access', state.access === 'open');
      // Ved åben adgang findes der intet login at sende brugeren til.
      if (state.access === 'login' && !status.authenticated) return location.replace('/login');
      checkLocalImport();
    } catch {}
    // Vis beholdningerne med det samme; kurserne fylder ind, når de er hentet.
    const quick = api('GET', '/api/holdings')
      .then((data) => {
        if (state.portfolio) return;
        state.settings = data.settings || {};
        state.baseCurrency = data.settings?.baseCurrency || state.baseCurrency;
        state.pending = data.holdings.map((h) => ({ ...h, status: 'loading', price: null, valueBase: null, weight: null }));
        render();
      })
      .catch(() => {});
    await Promise.all([quick, loadPortfolio(), loadAllHoldings()]);
    scheduleRefresh();
  }

  init();
})();
