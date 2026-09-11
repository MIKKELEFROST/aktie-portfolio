// HTTP-applikationen: routing, auth, API og statiske filer.
// createApp() returnerer en request-handler, så den kan testes uden netværk.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from './store.js';
import { computePortfolio, computeValueHistory, parseDanishNumber } from './portfolio-math.js';
import { resolveSecurities } from './resolve.js';
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken, createLoginLimiter, passwordVersion } from './auth.js';
import { createAccounts, publicProfile, SignupError, normalizeEmail } from './accounts.js';
import { sendJson, sendError, readJsonBody, parseCookies, cookieHeader, serveStatic, clientIp, isLoopback, safeDecode, HttpError } from './http-utils.js';
import { timingSafeEqual } from 'node:crypto';
import { YahooError } from './yahoo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, 'views'); // HTML-sider ligger uden for public/, så de altid går gennem login-kontrollen

const COOKIE_NAME = 'aktie_session';
const SESSION_LONG_MS = 30 * 24 * 60 * 60 * 1000; // "Husk mig": 30 dage
const SESSION_SHORT_MS = 12 * 60 * 60 * 1000; // ellers 12 timer
const MIN_PASSWORD_LENGTH = 8;

const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.\-=^]{0,24}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
// Sider klienten kan tegne. Står en sti ikke her, giver et direkte besøg eller en
// genindlæsning 404, selv om navigation inde i appen virker.
// Skal holdes i takt med ROUTES i public/app.js – test/pages.test.js kontrollerer det.
const PAGE_ROUTES = new Set(['/', '/beholdninger', '/indstillinger', '/folk']);
// Profil-sider: /profil/<id> viser en andens portefølje, hvis man følger vedkommende.
const PERSON_PAGE = /^\/profil\/[^/]+$/;
const HISTORY_RANGES = new Set(['5d', '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', 'max']);
const HOLDABLE_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND']);
const MAX_HOLDINGS = 200;
const MAX_ACCOUNTS = 20;
const TYPE_NAMES = { INDEX: 'et indeks', CRYPTOCURRENCY: 'en kryptovaluta', CURRENCY: 'en valuta', FUTURE: 'en future', OPTION: 'en option' };

export function createApp({ store, yahoo, config, logger = console, onPortfolioRequest = null }) {
  const limiter = createLoginLimiter({ limit: 8, windowMs: 15 * 60_000 });
  // Browser-tilstand: ingen database og intet login. Beholdninger ligger i brugerens browser;
  // serveren leverer kun kurser og beregninger. API'et er så åbent og beskyttes af en kald-grænse pr. IP.
  const browserMode = config.storageMode === 'browser';
  // Åben adgang: ingen login. Alle der kender adressen ser og redigerer den samme
  // portefølje. Kræver et lager på serveren, ellers er der intet at dele.
  // Den gælder kun, så længe der ikke er nogen adgangskode: opretter man én, er siden
  // lukket fra det øjeblik – også for de øvrige serverless-instanser.
  // Platform: flere profiler, hver med sin egen portefølje, og et følge-forhold imellem dem.
  // Kræver en database; uden den er der kun browser-tilstanden.
  const platform = Boolean(config.platform) && !browserMode && Boolean(store);
  const accounts = platform ? createAccounts(store) : null;
  const openAccessAllowed = !platform && Boolean(config.publicAccess) && !browserMode && Boolean(store);
  const OPEN_CHECK_TTL = 10_000;
  let passwordExists = false;
  let openCheckedAt = 0;

  async function openAccessNow() {
    if (!openAccessAllowed || config.envPassword || passwordExists) return false;
    if (Date.now() - openCheckedAt < OPEN_CHECK_TTL) return true;
    // En adgangskode kan være oprettet fra en anden instans; slås op med jævne mellemrum.
    if ((await store.getAuth()).passwordHash) passwordExists = true;
    openCheckedAt = Date.now();
    return !passwordExists;
  }
  const apiLimiter = createLoginLimiter({ limit: 240, windowMs: 60_000 });
  const USER_CACHE = Symbol('bruger'); // sessionens profil slås kun op én gang pr. kald
  let envPasswordHash = null;

  async function getEnvPasswordHash() {
    if (!config.envPassword) return null;
    if (!envPasswordHash) envPasswordHash = await hashPassword(config.envPassword);
    return envPasswordHash;
  }

  async function authState() {
    if (browserMode) return { usesEnvPassword: false, passwordHash: null, setupRequired: false };
    const auth = await store.getAuth();
    const usesEnvPassword = Boolean(config.envPassword);
    const passwordHash = usesEnvPassword ? await getEnvPasswordHash() : auth.passwordHash;
    return { usesEnvPassword, passwordHash, setupRequired: !passwordHash };
  }

  async function sessionSecret() {
    return store.getSessionSecret(config.sessionSecret);
  }

  // Slår sessionens profil op. Er adgangskoden skiftet, passer pv ikke længere,
  // og sessionen er dermed ugyldig – også på de andre enheder.
  async function currentUser(req) {
    if (!platform) return null;
    if (req[USER_CACHE] !== undefined) return req[USER_CACHE];
    let user = null;
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) {
      const payload = verifySessionToken(await sessionSecret(), token);
      if (payload?.uid) {
        const found = await accounts.byId(payload.uid);
        if (found && payload.pv === passwordVersion(found.passwordHash)) user = found;
      }
    }
    req[USER_CACHE] = user;
    return user;
  }

  // Kaster, hvis man ikke er logget ind. Bruges af alt der rører data.
  async function requireUser(req) {
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, 'Log ind for at fortsætte', { code: 'LOGIN_REQUIRED' });
    return user;
  }

  async function isAuthenticated(req) {
    if (platform) return Boolean(await currentUser(req));
    if (browserMode || (await openAccessNow())) return true;
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    if (!token) return false;
    const { passwordHash } = await authState();
    return Boolean(verifySessionToken(await sessionSecret(), token, { pv: passwordVersion(passwordHash) }));
  }

  // Opsætningsnøgle: kræves for at oprette den første adgangskode, medmindre man sidder
  // på selve maskinen (localhost). Forhindrer at en fremmed "kaprer" en ny, åben instans.
  // Ved åben adgang er der intet at kapre – alt er allerede synligt for enhver med adressen –
  // og at oprette en adgangskode gør kun siden mere lukket. Så kræves nøglen ikke.
  function setupTokenRequired(req, open = false) {
    if (open) return false;
    return Boolean(config.setupToken) && (config.alwaysRequireSetupToken || !isLoopback(req));
  }

  function checkSetupToken(req, body, open = false) {
    if (!setupTokenRequired(req, open)) return;
    const given = Buffer.from(String(body.setupToken ?? ''));
    const expected = Buffer.from(String(config.setupToken));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      limiter.recordFailure(clientIp(req, { trustProxy: config.trustProxy }));
      throw new HttpError(403, 'Forkert opsætningsnøgle – den står i serverens log/terminal');
    }
  }

  function isSecure(req) {
    if (config.secureCookies) return true;
    if (!config.trustProxy) return false;
    const proto = req.headers['x-forwarded-proto'];
    return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
  }

  async function issueSession(req, res, { remember = true, user = null } = {}) {
    const ttlMs = remember ? SESSION_LONG_MS : SESSION_SHORT_MS;
    const pv = user ? passwordVersion(user.passwordHash) : passwordVersion((await authState()).passwordHash);
    const token = createSessionToken(await sessionSecret(), { ttlMs, pv, uid: user?.id ?? null });
    const opts = { secure: isSecure(req) };
    if (remember) opts.maxAgeSeconds = Math.floor(ttlMs / 1000);
    res.setHeader('Set-Cookie', cookieHeader(COOKIE_NAME, token, opts));
  }

  function clearSession(req, res) {
    res.setHeader('Set-Cookie', cookieHeader(COOKIE_NAME, '', { maxAgeSeconds: 0, secure: isSecure(req) }));
  }

  // ---------- portefølje ----------

  // Hvilken portefølje der arbejdes på. Med profiler har hver bruger sin egen;
  // uden dem er der én fælles, som før.
  function scope(userId = null) {
    if (platform && userId) {
      return { get: () => store.getUserPortfolio(userId), update: (fn) => store.updateUserPortfolio(userId, fn) };
    }
    return { get: () => store.getPortfolio(), update: (fn) => store.updatePortfolio(fn) };
  }

  // Porteføljen for den, kaldet gælder – egen som standard.
  const own = async (req) => scope((await currentUser(req))?.id ?? null);

  async function buildPortfolio(account = '', ps = scope()) {
    const data = await ps.get();
    const result = await computeFrom(data, account);
    rememberNames(data, result.quotes, ps).catch((err) => logger.warn('Kunne ikke gemme navne:', err.message));
    if (onPortfolioRequest) onPortfolioRequest();
    delete result.quotes;
    return result;
  }

  // Beregner porteføljen ud fra givne beholdninger/indstillinger (bruges både af det gemte
  // lager og af browser-tilstanden, hvor klienten sender sine beholdninger med).
  // Depot-filter: '' = alle, 'none' = uden depot, ellers depot-id.
  function filterByAccount(holdings, account) {
    if (!account) return holdings;
    if (account === 'none') return holdings.filter((h) => !h.accountId);
    return holdings.filter((h) => h.accountId === account);
  }

  async function computeFrom(data, account = '') {
    const baseCurrency = data.settings.baseCurrency;
    const accounts = data.settings.accounts || [];
    const holdings = filterByAccount(data.holdings, account);
    const symbols = holdings.map((h) => h.symbol);
    const quotes = symbols.length ? await yahoo.getQuotes(symbols) : {};
    const currencies = Object.values(quotes)
      .filter((q) => q.ok && q.quote?.currency)
      .map((q) => q.quote.currency);
    const fxRates = currencies.length ? await yahoo.getFxRates(currencies, baseCurrency) : {};
    const result = computePortfolio({ holdings, quotes, fxRates, baseCurrency });
    const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
    for (const p of result.positions) p.accountName = p.accountId ? nameOf.get(p.accountId) || null : null;
    // Kontanter hører til hele porteføljen, ikke et enkelt depot.
    const cashBase = !account && Number(data.settings.cash) > 0 ? Number(data.settings.cash) : 0;
    result.totals.cashBase = cashBase;
    result.totals.totalValueBase = result.totals.valueBase + cashBase;
    return {
      ...result,
      quotes,
      fxRates,
      settings: data.settings,
      account: account || '',
      updatedAt: new Date().toISOString(),
    };
  }

  // Gem navn/valuta fra Yahoo på beholdningen, så tabellen kan vises når Yahoo er nede.
  async function rememberNames(data, quotes, ps = scope()) {
    const changed = data.holdings.some((h) => {
      const q = quotes[h.symbol]?.quote;
      return q && (h.name !== q.name || h.currency !== q.currency);
    });
    if (!changed) return;
    await ps.update((draft) => {
      for (const h of draft.holdings) {
        const q = quotes[h.symbol]?.quote;
        if (q) {
          h.name = q.name;
          h.currency = q.currency;
        }
      }
    });
  }

  async function buildHistory(range, data = null, account = '', ps = scope()) {
    if (!data) data = await ps.get();
    const baseCurrency = data.settings.baseCurrency;
    const holdings = filterByAccount(data.holdings, account).filter((h) => Number(h.quantity) > 0);
    const histories = {};
    const missing = [];
    await Promise.all(
      holdings.map(async (h) => {
        try {
          histories[h.symbol] = await yahoo.getHistory(h.symbol, range);
        } catch (err) {
          missing.push({ symbol: h.symbol, error: err.message });
        }
      }),
    );
    const currencies = Object.values(histories).map((h) => h.currency);
    const [fxRates, fxHistories] = currencies.length
      ? await Promise.all([
          yahoo.getFxRates(currencies, baseCurrency),
          // Historiske valutakurser, så en dag i juni omregnes med juni-kursen.
          // Kan de ikke hentes, falder hver valuta tilbage til dagens kurs.
          yahoo.getFxHistories ? yahoo.getFxHistories(currencies, baseCurrency, range).catch(() => ({})) : Promise.resolve({}),
        ])
      : [{}, {}];
    for (const h of holdings) {
      const hist = histories[h.symbol];
      if (!hist) continue; // allerede i missing
      if (!hist.points?.length) {
        missing.push({ symbol: h.symbol, error: 'Ingen historiske kurser' });
        delete histories[h.symbol];
        continue;
      }
      const fx = fxRates[hist.currency];
      if (!fx?.ok) {
        missing.push({ symbol: h.symbol, error: fx?.error?.message || `Ingen valutakurs for ${hist.currency}/${baseCurrency}` });
        delete histories[h.symbol];
      }
    }
    const { points, limitedBy } = computeValueHistory({ holdings, histories, fxRates, fxHistories });
    // Hvilke valutaer der måtte bruge dagens kurs i stedet for dagens egen.
    const fxToday = Object.entries(fxHistories)
      .filter(([cur, h]) => cur !== baseCurrency && (!h?.ok || !h.points?.length) && !h?.identity)
      .map(([cur]) => cur);
    return { range, baseCurrency, points, missing, limitedBy, fxToday, approximate: true };
  }

  // ---------- validering ----------

  function parseNumber(value, field, { min = null, allowNull = false, max = 1e12 } = {}) {
    if (value === null || value === undefined || value === '') {
      if (allowNull) return null;
      throw new HttpError(400, `${field} mangler`);
    }
    const n = parseDanishNumber(value);
    if (n === null) {
      if (allowNull) return null;
      throw new HttpError(400, `${field} mangler`);
    }
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${field} skal være et tal`);
    if (min !== null && n < min) throw new HttpError(400, `${field} skal være mindst ${min}`);
    if (n > max) throw new HttpError(400, `${field} er for stort`);
    return Math.round(n * 1e6) / 1e6;
  }

  function parseQuantity(value) {
    const n = parseNumber(value, 'Antal', { min: 0 });
    if (n <= 0) throw new HttpError(400, 'Antal skal være større end 0');
    return n;
  }

  function parseSymbol(value) {
    const s = String(value ?? '').trim().toUpperCase();
    if (!SYMBOL_RE.test(s)) throw new HttpError(400, 'Ugyldigt symbol');
    return s;
  }

  function parseNote(value) {
    const s = String(value ?? '').trim();
    if (s.length > 200) throw new HttpError(400, 'Noten må højst være 200 tegn');
    return s;
  }

  function parseCurrency(value) {
    const c = String(value ?? '').trim().toUpperCase();
    if (!CURRENCY_RE.test(c)) throw new HttpError(400, 'Ugyldig valuta (brug f.eks. DKK, EUR eller USD)');
    return c;
  }

  // Beholdninger sendt fra klienten (browser-tilstand): valideres som ved gendan, uden at gemmes.
  function parseHoldingsList(list, { max = 100, accounts = [] } = {}) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Forventede en liste af beholdninger');
    if (list.length > max) throw new HttpError(400, `Højst ${max} aktier ad gangen`);
    const seen = new Set();
    return list.map((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `Ugyldig post (linje ${i + 1})`);
      const symbol = parseSymbol(raw.symbol);
      const accountId = parseAccountId(raw.accountId, accounts);
      const slot = `${symbol}@${accountId ?? ''}`;
      if (seen.has(slot)) throw new HttpError(400, `Symbolet ${symbol} optræder flere gange i samme depot`);
      seen.add(slot);
      return {
        accountId,
        id: typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : newId(),
        symbol,
        name: String(raw.name || symbol).slice(0, 120),
        currency: raw.currency ? parseCurrency(raw.currency) : null,
        quantity: parseQuantity(raw.quantity),
        avgPrice: parseNumber(raw.avgPrice, 'Købskurs', { min: 0, allowNull: true }),
        note: parseNote(raw.note),
        addedAt: typeof raw.addedAt === 'string' && raw.addedAt.length <= 40 ? raw.addedAt : null,
        updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.length <= 40 ? raw.updatedAt : null,
      };
    });
  }

  function parseSettingsInput(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      baseCurrency: s.baseCurrency ? parseCurrency(s.baseCurrency) : config.baseCurrency || 'DKK',
      cash: s.cash !== undefined ? parseNumber(s.cash, 'Kontanter', { min: 0, allowNull: true }) ?? 0 : 0,
      displayName: String(s.displayName ?? '').trim().slice(0, 40),
      showDecimals: Boolean(s.showDecimals),
      accounts: s.accounts !== undefined ? parseAccounts(s.accounts) : [],
    };
  }

  function parseAccountFilter(value) {
    const v = String(value ?? '').trim();
    if (!v) return '';
    if (v === 'none') return 'none';
    if (!/^[\w-]{1,64}$/.test(v)) throw new HttpError(400, 'Ugyldigt depot-filter');
    return v;
  }

  function parseAccounts(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Depoter skal være en liste');
    if (list.length > MAX_ACCOUNTS) throw new HttpError(400, `Højst ${MAX_ACCOUNTS} depoter`);
    const names = new Set();
    const ids = new Set();
    return list.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, `Ugyldigt depot (nr. ${i + 1})`);
      const name = String(raw.name ?? '').trim().slice(0, 40);
      if (!name) throw new HttpError(400, `Depot nr. ${i + 1} mangler et navn`);
      if (names.has(name.toLowerCase())) throw new HttpError(400, `Depotet "${name}" findes flere gange`);
      names.add(name.toLowerCase());
      const id = typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) && !ids.has(raw.id) ? raw.id : newId();
      ids.add(id);
      return { id, name };
    });
  }

  function parseAccountId(value, accounts) {
    if (value === null || value === undefined || value === '') return null;
    const id = String(value);
    if (!(accounts || []).some((a) => a.id === id)) throw new HttpError(400, 'Ukendt depot – opret det først under Indstillinger');
    return id;
  }

  const sameSlot = (h, symbol, accountId) => h.symbol === symbol && (h.accountId ?? null) === (accountId ?? null);

  function findHolding(data, id) {
    const h = data.holdings.find((x) => x.id === id);
    if (!h) throw new HttpError(404, 'Aktien findes ikke i porteføljen');
    return h;
  }

  function publicHolding(h) {
    return { id: h.id, symbol: h.symbol, name: h.name || h.symbol, currency: h.currency || null, quantity: h.quantity, avgPrice: h.avgPrice ?? null, note: h.note || '', accountId: h.accountId ?? null, addedAt: h.addedAt, updatedAt: h.updatedAt };
  }

  // Alle med en profil kan se alle andres portefølje – man kommer kun ind på
  // platformen med en invitationskode fra en, der allerede er her.
  // Skrivning er en anden sag: ruterne til en andens portefølje findes kun som GET.
  async function viewable(req, targetId) {
    await requireUser(req);
    const target = await accounts.byId(targetId);
    if (!target) throw new HttpError(404, 'Profilen findes ikke');
    return { person: publicProfile(target), ps: scope(target.id) };
  }

  // ---------- API-handlere ----------

  const api = {
    async status(req, res) {
      if (platform) {
        const user = await currentUser(req);
        const antal = await accounts.count();
        return sendJson(res, 200, {
          access: 'platform',
          storage: config.storageMode || 'file',
          authenticated: Boolean(user),
          // Den allerførste profil oprettes uden invitationskode – der er endnu intet at beskytte.
          firstProfile: antal === 0,
          setupRequired: false,
          setupTokenRequired: false,
          usesEnvPassword: false,
          user: publicProfile(user, { includeEmail: true }),
        });
      }
      const { setupRequired, usesEnvPassword } = await authState();
      const open = await openAccessNow();
      sendJson(res, 200, {
        setupRequired,
        setupTokenRequired: setupRequired && setupTokenRequired(req, open),
        usesEnvPassword,
        authenticated: open || (!setupRequired && (await isAuthenticated(req))),
        storage: config.storageMode || 'file',
        access: browserMode ? 'browser' : open ? 'open' : 'login',
      });
    },

    // Finder Yahoo-symboler til værdipapirer fra en bank-eksport. Kun navn, ISIN og
    // valuta sendes hertil – selve filen bliver i browseren.
    async resolve(req, res) {
      const body = await readJsonBody(req);
      const list = Array.isArray(body.securities) ? body.securities : null;
      if (!list) throw new HttpError(400, 'Forventede en liste af værdipapirer');
      if (list.length > 60) throw new HttpError(400, 'Højst 60 værdipapirer ad gangen');
      const input = list.map((raw) => ({
        isin: String(raw?.isin ?? '').slice(0, 20),
        name: String(raw?.name ?? '').slice(0, 120),
        currency: String(raw?.currency ?? '').slice(0, 5),
      }));
      sendJson(res, 200, { results: await resolveSecurities(yahoo, input) });
    },

    // Beregn portefølje ud fra beholdninger sendt af klienten (browser-tilstand).
    async compute(req, res) {
      const body = await readJsonBody(req);
      const settings = parseSettingsInput(body.settings);
      const data = { holdings: parseHoldingsList(body.holdings, { accounts: settings.accounts }), settings };
      const result = await computeFrom(data, parseAccountFilter(body.account));
      delete result.quotes;
      sendJson(res, 200, result);
    },

    async computeHistory(req, res) {
      const body = await readJsonBody(req);
      const range = typeof body.range === 'string' && HISTORY_RANGES.has(body.range) ? body.range : '1y';
      const settings = parseSettingsInput(body.settings);
      const data = { holdings: parseHoldingsList(body.holdings, { accounts: settings.accounts }), settings };
      sendJson(res, 200, await buildHistory(range, data, parseAccountFilter(body.account)));
    },

    async setup(req, res) {
      const { setupRequired } = await authState();
      if (!setupRequired) throw new HttpError(409, 'Der er allerede oprettet en adgangskode');
      const ip = clientIp(req, { trustProxy: config.trustProxy });
      if (limiter.isBlocked(ip)) throw new HttpError(429, 'For mange forsøg – prøv igen senere', { retryAfter: limiter.retryAfterSeconds(ip) });
      const body = await readJsonBody(req);
      checkSetupToken(req, body, await openAccessNow());
      const password = String(body.password ?? '');
      if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Adgangskoden skal være mindst ${MIN_PASSWORD_LENGTH} tegn`);
      if (body.confirm !== undefined && String(body.confirm) !== password) throw new HttpError(400, 'De to adgangskoder er ikke ens');
      const passwordHash = await hashPassword(password);
      await store.updateAuth((draft) => {
        if (draft.passwordHash) throw new HttpError(409, 'Der er allerede oprettet en adgangskode');
        draft.passwordHash = passwordHash;
        draft.createdAt = new Date().toISOString();
      });
      passwordExists = true; // siden er lukket fra nu af – også hvis den var åben
      await issueSession(req, res, { remember: true });
      sendJson(res, 201, { ok: true });
    },

    async login(req, res) {
      const ip = clientIp(req, { trustProxy: config.trustProxy });
      if (limiter.isBlocked(ip)) {
        const wait = limiter.retryAfterSeconds(ip);
        throw new HttpError(429, `For mange forsøg – prøv igen om ${Math.ceil(wait / 60)} min.`, { retryAfter: wait });
      }
      const { passwordHash, setupRequired } = await authState();
      if (setupRequired) throw new HttpError(409, 'Opret først en adgangskode');
      const body = await readJsonBody(req);
      const ok = await verifyPassword(String(body.password ?? ''), passwordHash);
      if (!ok) {
        limiter.recordFailure(ip);
        throw new HttpError(401, 'Forkert adgangskode');
      }
      limiter.reset(ip);
      await issueSession(req, res, { remember: body.remember !== false });
      sendJson(res, 200, { ok: true });
    },

    async logout(req, res) {
      clearSession(req, res);
      sendJson(res, 200, { ok: true });
    },

    async changePassword(req, res) {
      const { passwordHash, usesEnvPassword } = await authState();
      if (usesEnvPassword) throw new HttpError(400, 'Adgangskoden styres af miljøvariablen DASHBOARD_PASSWORD og kan ikke ændres her');
      const body = await readJsonBody(req);
      if (!(await verifyPassword(String(body.currentPassword ?? ''), passwordHash))) throw new HttpError(401, 'Nuværende adgangskode er forkert');
      const next = String(body.newPassword ?? '');
      if (next.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Den nye adgangskode skal være mindst ${MIN_PASSWORD_LENGTH} tegn`);
      const newHash = await hashPassword(next);
      await store.updateAuth((draft) => {
        draft.passwordHash = newHash;
        draft.updatedAt = new Date().toISOString();
        if (!config.sessionSecret) draft.sessionSecret = null; // alle andre enheder logges ud
      });
      await issueSession(req, res, { remember: true }); // denne browser forbliver logget ind
      sendJson(res, 200, { ok: true });
    },

    // Roterer session-nøglen, så alle enheder logges ud (inkl. denne).
    async logoutAll(req, res) {
      if (config.sessionSecret) throw new HttpError(400, 'Session-nøglen styres af miljøvariablen SESSION_SECRET – skift den for at logge alle ud');
      await store.updateAuth((draft) => {
        draft.sessionSecret = null;
      });
      clearSession(req, res);
      sendJson(res, 200, { ok: true });
    },

    async portfolio(req, res, url) {
      sendJson(res, 200, await buildPortfolio(parseAccountFilter(url.searchParams.get('account')), await own(req)));
    },

    async history(req, res, url) {
      const range = url.searchParams.get('range') || '1y';
      if (!HISTORY_RANGES.has(range)) throw new HttpError(400, 'Ugyldigt interval');
      sendJson(res, 200, await buildHistory(range, null, parseAccountFilter(url.searchParams.get('account')), await own(req)));
    },

    // ---------- profiler ----------

    async signup(req, res) {
      const ip = clientIp(req, { trustProxy: config.trustProxy });
      if (limiter.isBlocked(ip)) throw new HttpError(429, 'For mange forsøg – prøv igen senere', { retryAfter: limiter.retryAfterSeconds(ip) });
      const body = await readJsonBody(req);
      const user = await accounts.signup(body, { requireInvite: true });
      limiter.reset(ip);
      await issueSession(req, res, { remember: true, user });
      sendJson(res, 201, { user: publicProfile(user, { includeEmail: true }) });
    },

    async platformLogin(req, res) {
      const ip = clientIp(req, { trustProxy: config.trustProxy });
      if (limiter.isBlocked(ip)) {
        const wait = limiter.retryAfterSeconds(ip);
        throw new HttpError(429, `For mange forsøg – prøv igen om ${Math.ceil(wait / 60)} min.`, { retryAfter: wait });
      }
      const body = await readJsonBody(req);
      const user = await accounts.verify(body.email, body.password);
      if (!user) {
        limiter.recordFailure(ip);
        // Samme svar uanset om e-mailen findes, så listen over profiler ikke kan afsøges.
        throw new HttpError(401, 'Forkert e-mail eller adgangskode');
      }
      limiter.reset(ip);
      await issueSession(req, res, { remember: body.remember !== false, user });
      sendJson(res, 200, { user: publicProfile(user, { includeEmail: true }) });
    },

    async me(req, res) {
      const user = await requireUser(req);
      sendJson(res, 200, {
        user: publicProfile(user, { includeEmail: true }),
        inviteCode: user.isOwner ? await accounts.inviteCode() : null,
      });
    },

    async updateMe(req, res) {
      const user = await requireUser(req);
      const body = await readJsonBody(req);
      const name = await accounts.rename(user.id, body.name);
      sendJson(res, 200, { user: { ...publicProfile(user, { includeEmail: true }), name } });
    },

    async platformChangePassword(req, res) {
      const user = await requireUser(req);
      const body = await readJsonBody(req);
      const newHash = await accounts.changePassword(user.id, body.currentPassword, body.newPassword);
      // Denne browser bliver logget ind igen med det samme; de øvrige enheder falder ud.
      await issueSession(req, res, { remember: true, user: { ...user, passwordHash: newHash } });
      sendJson(res, 200, { ok: true });
    },

    async rotateInvite(req, res) {
      const user = await requireUser(req);
      if (!user.isOwner) throw new HttpError(403, 'Kun den, der oprettede platformen, kan lave en ny invitationskode');
      sendJson(res, 200, { inviteCode: await accounts.rotateInviteCode() });
    },

    // ---------- følg andre ----------

    async people(req, res, url) {
      const user = await requireUser(req);
      sendJson(res, 200, { people: await accounts.browse(url.searchParams.get('q'), { exclude: user.id }) });
    },

    // ---------- en andens portefølje ----------

    async personPortfolio(req, res, url, params) {
      const { person, ps } = await viewable(req, params.id);
      sendJson(res, 200, { person, ...(await buildPortfolio(parseAccountFilter(url.searchParams.get('account')), ps)) });
    },

    async personHistory(req, res, url, params) {
      const { ps } = await viewable(req, params.id);
      const range = url.searchParams.get('range') || '1y';
      if (!HISTORY_RANGES.has(range)) throw new HttpError(400, 'Ugyldigt interval');
      sendJson(res, 200, await buildHistory(range, null, parseAccountFilter(url.searchParams.get('account')), ps));
    },

    async personHoldings(req, res, url, params) {
      const { person, ps } = await viewable(req, params.id);
      const data = await ps.get();
      sendJson(res, 200, { person, holdings: data.holdings.map(publicHolding), settings: data.settings });
    },

    async search(req, res, url) {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 1) return sendJson(res, 200, { results: [] });
      if (q.length > 60) throw new HttpError(400, 'Søgningen er for lang');
      const results = rankSearchResults(await yahoo.search(q), q);
      sendJson(res, 200, { results });
    },

    async quote(req, res, url, params) {
      const symbol = parseSymbol(params.symbol);
      const quotes = await yahoo.getQuotes([symbol]);
      const entry = quotes[symbol];
      if (!entry.ok) throw new HttpError(entry.error.code === 'NOT_FOUND' ? 404 : 502, entry.error.message, { code: entry.error.code });
      sendJson(res, 200, { quote: entry.quote, stale: entry.stale });
    },

    async listHoldings(req, res) {
      const data = await (await own(req)).get();
      sendJson(res, 200, { holdings: data.holdings.map(publicHolding), settings: data.settings });
    },

    async addHolding(req, res) {
      const body = await readJsonBody(req);
      const symbol = parseSymbol(body.symbol);
      const quantity = parseQuantity(body.quantity);
      const avgPrice = parseNumber(body.avgPrice, 'Købskurs', { min: 0, allowNull: true });
      const note = parseNote(body.note);

      const currentData = await (await own(req)).get();
      const current = currentData.holdings;
      const accountId = parseAccountId(body.accountId, currentData.settings.accounts);
      const existing = current.find((h) => sameSlot(h, symbol, accountId));
      if (existing) throw new HttpError(409, `${existing.name || symbol} er allerede i ${accountId ? 'depotet' : 'porteføljen'} – brug "Køb til"`, { id: existing.id });
      if (current.length >= MAX_HOLDINGS) throw new HttpError(409, `Porteføljen kan højst indeholde ${MAX_HOLDINGS} aktier`);

      const quotes = await yahoo.getQuotes([symbol]);
      const entry = quotes[symbol];
      let warning = null;
      if (!entry.ok) {
        if (entry.error.code === 'NOT_FOUND') throw new HttpError(400, `Ukendt symbol "${symbol}" – husk fx .CO for danske aktier`, { code: 'NOT_FOUND' });
        warning = `Kunne ikke hente kurs lige nu (${entry.error.message}). Aktien er tilføjet alligevel.`;
      } else if (entry.quote.type && !HOLDABLE_TYPES.has(entry.quote.type)) {
        throw new HttpError(400, `Kun aktier, ETF'er og fonde kan tilføjes (${symbol} er ${TYPE_NAMES[entry.quote.type] || entry.quote.type.toLowerCase()})`, { code: 'UNSUPPORTED_TYPE' });
      }
      const now = new Date().toISOString();
      const holding = {
        id: newId(),
        symbol,
        name: entry.ok ? entry.quote.name : String(body.name || symbol).slice(0, 120),
        currency: entry.ok ? entry.quote.currency : (body.currency ? parseCurrency(body.currency) : null),
        quantity,
        avgPrice,
        note,
        accountId,
        addedAt: now,
        updatedAt: now,
      };
      await (await own(req)).update((draft) => {
        if (draft.holdings.some((h) => sameSlot(h, symbol, accountId))) throw new HttpError(409, 'Aktien er allerede i porteføljen');
        draft.holdings.push(holding);
      });
      sendJson(res, 201, { holding: publicHolding(holding), warning });
    },

    async updateHolding(req, res, url, params) {
      const body = await readJsonBody(req);
      let updated;
      await (await own(req)).update((draft) => {
        const h = findHolding(draft, params.id);
        if (body.quantity !== undefined) h.quantity = parseQuantity(body.quantity);
        if (body.avgPrice !== undefined) h.avgPrice = parseNumber(body.avgPrice, 'Købskurs', { min: 0, allowNull: true });
        if (body.note !== undefined) h.note = parseNote(body.note);
        if (body.accountId !== undefined) {
          const accountId = parseAccountId(body.accountId, draft.settings.accounts);
          if (draft.holdings.some((x) => x.id !== h.id && sameSlot(x, h.symbol, accountId))) throw new HttpError(409, `${h.name || h.symbol} findes allerede i det depot – brug "Køb til" dér i stedet`);
          h.accountId = accountId;
        }
        h.updatedAt = new Date().toISOString();
        updated = h;
      });
      sendJson(res, 200, { holding: publicHolding(updated) });
    },

    // Køb til / sælg: opdaterer antal og (ved køb) vægtet gennemsnitskurs.
    async trade(req, res, url, params) {
      const body = await readJsonBody(req);
      const type = body.type === 'sell' ? 'sell' : body.type === 'buy' ? 'buy' : null;
      if (!type) throw new HttpError(400, 'Type skal være "buy" eller "sell"');
      const quantity = parseQuantity(body.quantity);
      const price = parseNumber(body.price, 'Kurs', { min: 0, allowNull: type === 'sell' });
      let result;
      await (await own(req)).update((draft) => {
        const h = findHolding(draft, params.id);
        const oldQty = Number(h.quantity) || 0;
        if (type === 'buy') {
          const newQty = oldQty + quantity;
          if (h.avgPrice != null && oldQty > 0) {
            h.avgPrice = Math.round(((oldQty * h.avgPrice + quantity * price) / newQty) * 1e6) / 1e6;
          } else if (oldQty === 0 || h.avgPrice == null) {
            h.avgPrice = oldQty === 0 ? price : h.avgPrice;
          }
          h.quantity = Math.round(newQty * 1e6) / 1e6;
        } else {
          if (quantity > oldQty + 1e-9) throw new HttpError(400, `Du ejer kun ${formatQty(oldQty)} stk.`);
          const newQty = Math.round((oldQty - quantity) * 1e6) / 1e6;
          if (newQty <= 0) {
            draft.holdings = draft.holdings.filter((x) => x.id !== h.id);
            result = { removed: true, holding: publicHolding({ ...h, quantity: 0 }) };
            return;
          }
          h.quantity = newQty;
        }
        h.updatedAt = new Date().toISOString();
        result = { removed: false, holding: publicHolding(h) };
      });
      sendJson(res, 200, result);
    },

    async deleteHolding(req, res, url, params) {
      let removed;
      await (await own(req)).update((draft) => {
        removed = findHolding(draft, params.id);
        draft.holdings = draft.holdings.filter((h) => h.id !== params.id);
      });
      sendJson(res, 200, { ok: true, holding: publicHolding(removed) });
    },

    async getSettings(req, res) {
      const data = await (await own(req)).get();
      sendJson(res, 200, { settings: data.settings });
    },

    async updateSettings(req, res) {
      const body = await readJsonBody(req);
      const patch = {};
      if (body.baseCurrency !== undefined) {
        const cur = parseCurrency(body.baseCurrency);
        if (cur !== 'USD') {
          try {
            await yahoo.getFxRate('USD', cur);
          } catch (err) {
            if (err instanceof YahooError && err.code === 'NOT_FOUND') throw new HttpError(400, `Ukendt valuta: ${cur}`);
            // Andre fejl (Yahoo nede) blokerer ikke for at gemme.
          }
        }
        patch.baseCurrency = cur;
      }
      if (body.displayName !== undefined) patch.displayName = String(body.displayName ?? '').trim().slice(0, 40);
      if (body.showDecimals !== undefined) patch.showDecimals = Boolean(body.showDecimals);
      if (body.cash !== undefined) patch.cash = parseNumber(body.cash, 'Kontanter', { min: 0, allowNull: true }) ?? 0;
      if (body.accounts !== undefined) patch.accounts = parseAccounts(body.accounts);
      const data = await (await own(req)).update((draft) => {
        Object.assign(draft.settings, patch);
        if (patch.accounts) {
          // Slettede depoter: beholdningerne beholdes, men står nu "uden depot".
          const ids = new Set(patch.accounts.map((a) => a.id));
          for (const h of draft.holdings) if (h.accountId && !ids.has(h.accountId)) h.accountId = null;
        }
      });
      sendJson(res, 200, { settings: data.settings });
    },

    async backup(req, res) {
      const data = await (await own(req)).get();
      const stamp = new Date().toISOString().slice(0, 10);
      sendJson(res, 200, { ...data, exportedAt: new Date().toISOString() }, {
        'Content-Disposition': `attachment; filename="aktie-portfolio-${stamp}.json"`,
      });
    },

    async restore(req, res) {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.holdings)) throw new HttpError(400, 'Filen indeholder ingen "holdings"-liste');
      if (body.holdings.length > MAX_HOLDINGS) throw new HttpError(400, `Højst ${MAX_HOLDINGS} aktier kan gendannes`);
      const now = new Date().toISOString();
      const seen = new Set();
      const accounts = body.settings && Array.isArray(body.settings.accounts) ? parseAccounts(body.settings.accounts) : [];
      const holdings = body.holdings.map((raw, i) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `Ugyldig post (linje ${i + 1})`);
        const symbol = parseSymbol(raw.symbol);
        const accountId = parseAccountId(raw.accountId, accounts);
        const slot = `${symbol}@${accountId ?? ''}`;
        if (seen.has(slot)) throw new HttpError(400, `Symbolet ${symbol} optræder flere gange i samme depot (linje ${i + 1})`);
        seen.add(slot);
        return {
          id: typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : newId(),
          symbol,
          accountId,
          name: String(raw.name || symbol).slice(0, 120),
          currency: raw.currency ? parseCurrency(raw.currency) : null,
          quantity: parseQuantity(raw.quantity),
          avgPrice: parseNumber(raw.avgPrice, 'Købskurs', { min: 0, allowNull: true }),
          note: parseNote(raw.note),
          addedAt: typeof raw.addedAt === 'string' && raw.addedAt.length <= 40 && !Number.isNaN(Date.parse(raw.addedAt)) ? raw.addedAt : now,
          updatedAt: now,
        };
      });
      const baseCurrency = body.settings?.baseCurrency ? parseCurrency(body.settings.baseCurrency) : undefined;
      const cash = body.settings?.cash !== undefined ? parseNumber(body.settings.cash, 'Kontanter', { min: 0, allowNull: true }) ?? 0 : undefined;
      const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
      const data = await (await own(req)).update((draft) => {
        draft.holdings = holdings;
        draft.settings.accounts = accounts;
        if (baseCurrency) draft.settings.baseCurrency = baseCurrency;
        if (cash !== undefined) draft.settings.cash = cash;
        if (settings.displayName !== undefined) draft.settings.displayName = String(settings.displayName ?? '').trim().slice(0, 40);
        if (settings.showDecimals !== undefined) draft.settings.showDecimals = Boolean(settings.showDecimals);
      });
      sendJson(res, 200, { ok: true, count: holdings.length, settings: data.settings });
    },
  };

  // ---------- routing ----------

  // Med profiler er login og adgangskode knyttet til en bruger; uden dem er der
  // én fælles adgangskode til hele instansen.
  const authRoutes = platform
    ? [
        ['POST', /^\/api\/auth\/signup$/, api.signup, { public: true }],
        ['POST', /^\/api\/auth\/login$/, api.platformLogin, { public: true }],
        ['POST', /^\/api\/auth\/change-password$/, api.platformChangePassword],
      ]
    : [
        ['POST', /^\/api\/auth\/setup$/, api.setup, { public: true }],
        ['POST', /^\/api\/auth\/login$/, api.login, { public: true }],
        ['POST', /^\/api\/auth\/change-password$/, api.changePassword],
        ['POST', /^\/api\/auth\/logout-all$/, api.logoutAll],
      ];

  const profileRoutes = platform
    ? [
        ['GET', /^\/api\/me$/, api.me],
        ['PUT', /^\/api\/me$/, api.updateMe],
        ['POST', /^\/api\/invite\/rotate$/, api.rotateInvite],
        ['GET', /^\/api\/people$/, api.people],
        ['GET', /^\/api\/users\/(?<id>[^/]+)\/portfolio\/history$/, api.personHistory],
        ['GET', /^\/api\/users\/(?<id>[^/]+)\/portfolio$/, api.personPortfolio],
        ['GET', /^\/api\/users\/(?<id>[^/]+)\/holdings$/, api.personHoldings],
      ]
    : [];

  const routes = [
    ['GET', /^\/api\/health$/, (req, res) => sendJson(res, 200, { ok: true }), { public: true }],
    ['GET', /^\/api\/auth\/status$/, api.status, { public: true }],
    ...authRoutes,
    ...profileRoutes,
    ['POST', /^\/api\/auth\/logout$/, api.logout, { public: true }],
    ['GET', /^\/api\/portfolio$/, api.portfolio],
    ['GET', /^\/api\/portfolio\/history$/, api.history],
    ['POST', /^\/api\/resolve$/, api.resolve],
    ['POST', /^\/api\/compute$/, api.compute],
    ['POST', /^\/api\/compute\/history$/, api.computeHistory],
    ['GET', /^\/api\/search$/, api.search],
    ['GET', /^\/api\/quote\/(?<symbol>[^/]+)$/, api.quote],
    ['GET', /^\/api\/holdings$/, api.listHoldings],
    ['POST', /^\/api\/holdings$/, api.addHolding],
    ['PUT', /^\/api\/holdings\/(?<id>[^/]+)$/, api.updateHolding],
    ['POST', /^\/api\/holdings\/(?<id>[^/]+)\/trade$/, api.trade],
    ['DELETE', /^\/api\/holdings\/(?<id>[^/]+)$/, api.deleteHolding],
    ['GET', /^\/api\/settings$/, api.getSettings],
    ['PUT', /^\/api\/settings$/, api.updateSettings],
    ['GET', /^\/api\/backup$/, api.backup],
    ['POST', /^\/api\/restore$/, api.restore],
  ];

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  }

  function redirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  // I browser-tilstand findes intet lager på serveren – disse ruter giver ingen mening.
  const STORE_ROUTES = /^\/api\/(portfolio|holdings|settings|backup|restore|auth\/(setup|login|change-password|logout-all))(\/|$)/;
  // Ved åben adgang findes der intet login at bruge – men /api/auth/setup skal være åben,
  // for det er dén vej, man lukker siden med en adgangskode.
  const AUTH_ROUTES_WHEN_OPEN = /^\/api\/auth\/(login|change-password|logout-all|logout)$/;

  async function handleApi(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const open = !browserMode && (await openAccessNow());
    if (browserMode || open) {
      // Uden login beskytter en kald-grænse pr. IP mod misbrug.
      const ip = clientIp(req, { trustProxy: config.trustProxy });
      apiLimiter.recordFailure(ip);
      if (apiLimiter.isBlocked(ip)) throw new HttpError(429, 'For mange kald – prøv igen om lidt', { retryAfter: apiLimiter.retryAfterSeconds(ip) });
      if (browserMode && STORE_ROUTES.test(url.pathname)) throw new HttpError(404, 'Ikke tilgængelig i browser-tilstand (ingen database på serveren)', { code: 'BROWSER_MODE' });
      if (open && AUTH_ROUTES_WHEN_OPEN.test(url.pathname)) throw new HttpError(404, 'Login er slået fra (åben adgang)', { code: 'OPEN_ACCESS' });
    }
    for (const [m, pattern, handler, opts = {}] of routes) {
      const match = url.pathname.match(pattern);
      if (!match) continue;
      if (m !== method) continue;
      if (!opts.public && !(await isAuthenticated(req))) throw new HttpError(401, 'Du er ikke logget ind', { code: 'UNAUTHENTICATED' });
      if (method !== 'GET') {
        // CSRF-værn: cross-site formularer kan ikke sende application/json uden CORS-preflight.
        const type = String(req.headers['content-type'] || '');
        if (!type.startsWith('application/json')) throw new HttpError(415, 'Forventede application/json');
      }
      const params = {};
      for (const [k, v] of Object.entries(match.groups || {})) {
        const decoded = safeDecode(v);
        if (decoded === null) throw new HttpError(400, 'Ugyldig sti');
        params[k] = decoded;
      }
      await handler(req, res, url, params);
      return;
    }
    const known = routes.some(([, pattern]) => pattern.test(url.pathname));
    throw new HttpError(known ? 405 : 404, known ? 'Metoden er ikke tilladt' : 'Ukendt endpoint');
  }

  async function handlePage(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metoden er ikke tilladt');
    // Med profiler afgør sessionen alene, om man er inde; den fælles adgangskode
    // og opsætnings-tilstanden findes ikke i den tilstand.
    const { setupRequired } = platform ? { setupRequired: false } : await authState();
    const open = !platform && !browserMode && (await openAccessNow());
    const authed = open || (!setupRequired && (await isAuthenticated(req)));

    if (url.pathname === '/login') {
      if (authed || browserMode) return redirect(res, '/');
      if (!(await serveStatic(res, VIEWS_DIR, '/login.html'))) throw new HttpError(500, 'login.html mangler');
      return;
    }
    if (PAGE_ROUTES.has(url.pathname) || (platform && PERSON_PAGE.test(url.pathname))) {
      if (!authed) {
        const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname)}`;
        return redirect(res, `/login${next}`);
      }
      if (!(await serveStatic(res, VIEWS_DIR, '/index.html'))) throw new HttpError(500, 'index.html mangler');
      return;
    }
    if (url.pathname === '/index.html' || url.pathname === '/login.html') return redirect(res, '/');
    const served = await serveStatic(res, PUBLIC_DIR, url.pathname, { cacheControl: 'public, max-age=300' });
    if (!served) throw new HttpError(404, 'Siden findes ikke');
  }

  return async function requestHandler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    securityHeaders(res);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handlePage(req, res, url);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof SignupError && !res.headersSent) {
        if (url.pathname.startsWith('/api/')) return sendError(res, err.status, err.message);
      }
      if (err instanceof HttpError) {
        if (err.status === 429 && err.extra?.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
        if (url.pathname.startsWith('/api/')) sendError(res, err.status, err.message, err.extra);
        else {
          res.writeHead(err.status, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(err.message);
        }
        return;
      }
      if (err instanceof YahooError) {
        sendError(res, err.status === 404 ? 404 : 502, err.message, { code: err.code });
        return;
      }
      logger.error(`Fejl ved ${req.method} ${url.pathname}:`, err);
      sendError(res, 500, 'Der skete en uventet fejl på serveren');
    }
  };
}

// Danske børser først, dernæst øvrige nordiske, så resten. Aktier/ETF'er før fonde/indeks.
const EXCHANGE_PRIORITY = { Copenhagen: 0, CPH: 0, Stockholm: 1, STO: 1, Oslo: 1, OSL: 1, Helsinki: 1, HEL: 1 };
const TYPE_PRIORITY = { EQUITY: 0, ETF: 1, MUTUALFUND: 2, INDEX: 3, CRYPTOCURRENCY: 4 };

export function rankSearchResults(results, query = '') {
  const exact = query.trim().toUpperCase();
  return results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const xa = a.r.symbol === exact ? 0 : 1;
      const xb = b.r.symbol === exact ? 0 : 1;
      if (xa !== xb) return xa - xb;
      const ea = EXCHANGE_PRIORITY[a.r.exchange] ?? 2;
      const eb = EXCHANGE_PRIORITY[b.r.exchange] ?? 2;
      if (ea !== eb) return ea - eb;
      const ta = TYPE_PRIORITY[a.r.type] ?? 9;
      const tb = TYPE_PRIORITY[b.r.type] ?? 9;
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

function formatQty(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6).replace('.', ',');
}
