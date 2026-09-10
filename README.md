# Min Portefølje – aktie-dashboard

Et personligt, selv-hostet dashboard til din aktieportefølje. Du logger ind med én adgangskode og ser dine aktier med **live kurser fra Yahoo Finance**, dagens bevægelse, samlet afkast og fordeling – i DKK (eller en anden basisvaluta).

![Dashboard](docs/screenshot-dashboard.png)

## Funktioner

- **Overblik på 3 sekunder**: porteføljeværdi, dagens ændring, samlet afkast og investeret beløb.
- **Beholdningstabel** med live kurs, dagens ændring, gns. købskurs, værdi, afkast og andel – sortérbar, med totaler.
- **Udvikling**: graf over porteføljens værdi (1M–5Å) med "investeret"-linje.
- **Fordeling** pr. aktie og pr. valuta samt **dagens største bevægelser**.
- **Detaljepanel** pr. aktie: dagens interval, 52-ugers interval, din position, valutakurs.
- **Tilføj aktier via søgning** ("novo", "mærsk", "apple" …) – danske børser vises først. Kurs og valuta hentes automatisk.
- **Køb til / Sælg** med automatisk vægtet gennemsnitskurs. Tilføjer du en aktie, du allerede ejer, lægges købet oveni – du skriver bare antal og kurs. Redigér og slet.
- **Depoter**: opret fx Månedsopsparing og Pension, knyt hvert køb til et depot, og se alt samlet eller ét depot ad gangen. Samme aktie kan ligge i flere depoter.
- **Importér fra banken**: læs din transaktionsoversigt som CSV, fx fra Nordnet eller AP Pension. Appen regner antal og gennemsnitskurs ud pr. depot, slår symboler op via ISIN eller navn, og viser det hele til godkendelse, før noget gemmes. Filen bliver i browseren; kun navn, ISIN og valuta sendes til serveren for symbol-opslaget.
- **Flere valutaer**: DKK, USD, EUR, GBP (pence omregnes automatisk) m.fl. – alt summeres i din basisvaluta med dagens valutakurs.
- **Kontanter**: valgfrit beløb, så "Porteføljeværdi" matcher dit depot.
- **Live opdatering** hvert minut mens en børs er åben (pause når fanen er skjult).
- **Ærlige tal**: forældede kurser vises i gråt, aktier uden kurs holdes ude af totalerne, og "I dag" bliver til "Seneste handelsdag" når børserne er lukket.
- **Login** med adgangskode, "husk mig", brute-force-bremse, skift adgangskode og "log ud overalt".
- **Mørkt tema**, mobilvenligt layout (bundmenu + kort), "skjul beløb"-knap til toget, dansk talformat.
- **Sikkerhedskopi**: download/gendan som JSON. Serveren gemmer desuden de 5 seneste versioner automatisk.
- **Ingen afhængigheder**: kun Node.js. Intet build-step, intet framework. Data i en JSON-fil – eller i Supabase/Upstash Redis på Vercel.

## Kom i gang

Kræver [Node.js](https://nodejs.org) 20 eller nyere.

```bash
git clone https://github.com/mikkelefrost/aktie-portfolio.git
cd aktie-portfolio
npm start
```

Åbn <http://localhost:3000>. Første gang bliver du bedt om at **oprette en adgangskode** – derefter er du logget ind og kan tilføje din første aktie.

Åbner du siden fra en *anden* maskine end den, serveren kører på (fx en server eller Docker på en NAS), skal du også indtaste den **opsætningsnøgle**, som serveren skriver i terminalen/loggen ved start. Det forhindrer, at en fremmed opretter adgangskoden før dig.

### Docker

```bash
docker compose up -d
```

Dashboardet kører på port 3000, og dine data ligger i Docker-volumen `aktie-data` (så de overlever genstart og opdateringer). Opsætningsnøglen ses med `docker compose logs`. Bruger du en bind-mount i stedet for volumen, skal mappen kunne skrives af uid 1000.

### Vercel (gratis hosting fra GitHub)

Appen kan køre som én serverless-funktion på [Vercel](https://vercel.com):

1. **Importér repoet** i Vercel: *Add New → Project → Import* `aktie-portfolio`. Framework: *Other*. Deploy.
   Uden trin 2 kører siden i *browser-tilstand*: den virker med det samme, men data ligger kun i den enkelte browser.
2. **Vælg en database** – så følger porteføljen med til alle dine enheder. Enten:
   - **Upstash Redis** (færrest klik): I projektet → *Storage → Create Database* → vælg en Redis-database, fx Upstash → *Connect to Project*. Vercel sætter selv `KV_REST_API_URL` og `KV_REST_API_TOKEN`.
   - **Supabase** (Postgres): opret et projekt på [supabase.com](https://supabase.com), kør SQL'en i [`docs/database.md`](docs/database.md), og sæt `SUPABASE_URL` og `SUPABASE_KEY` under *Settings → Environment Variables*.
3. **Redeploy** (*Deployments → ⋯ → Redeploy*), og åbn projektets URL.

Med en database og ingen `DASHBOARD_PASSWORD` er siden **åben**: porteføljen vises, så snart adressen åbnes – på alle enheder og i alle browsere, uden login. Det er også prisen: alle der kender adressen, kan se og ændre den. Vil du have login i stedet, så sæt:

- `DASHBOARD_PASSWORD` – din adgangskode, mindst 8 tegn. Kræves, fordi hver serverless-instans er sin egen proces og derfor ikke kan dele en midlertidig opsætningsnøgle.
- `SESSION_SECRET` – en lang tilfældig streng, fx fra `openssl rand -hex 32`. Valgfri, men uden den logges du ud, når databasen nulstilles.

Har du allerede brugt siden i browser-tilstand, spørger den, om dine hidtidige aktier skal overføres til databasen. Depoter matches på navn, og aktier der allerede findes i samme depot springes over, så en gentagelse ikke dublerer noget. En kopi bliver liggende i browseren som sikkerhedsnet.

**Uden database virker siden også** – i *browser-tilstand*: dine aktier gemmes kun i din egen browser (localStorage), mens serveren leverer kurser og beregninger. Det er nemt, men data følger ikke med til andre enheder, og rydder du browserdata, er de væk – så brug *Indstillinger → Download sikkerhedskopi*.

Hvert push til `main` deployer automatisk. Bemærk: på Vercel er der ingen baggrunds-opvarmning af kurser, så første visning efter en pause tager 1–2 sekunder. Yahoo kan desuden afvise flere kald fra cloud-IP'er end fra en hjemme-PC; appen viser i så fald seneste kendte kurser tydeligt markeret.

Sådan vælges lageret, i den rækkefølge: findes `SUPABASE_URL`/`SUPABASE_KEY`, bruges Supabase; ellers `KV_REST_API_URL`/`KV_REST_API_TOKEN` (eller `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`) → Redis; ellers JSON-filen i `DATA_DIR`. Det gælder også lokalt og i Docker.

## Konfiguration

Alle indstillinger er valgfrie miljøvariabler. Læg dem i en `.env`-fil i projektmappen (indlæses automatisk af `npm start`), sæt dem i din shell, eller under `environment:` i `docker-compose.yml`. Se `.env.example`.

| Variabel | Standard | Beskrivelse |
|---|---|---|
| `PORT` | `3000` | Port serveren lytter på |
| `HOST` | `0.0.0.0` | Adresse serveren lytter på (`127.0.0.1` = kun denne maskine) |
| `DATA_DIR` | `./data` | Mappe til `portfolio.json`, `auth.json` og `backups/` |
| `DASHBOARD_PASSWORD` | *(tom)* | Fast adgangskode. Hvis tom, oprettes den i browseren første gang |
| `SETUP_TOKEN` | *(genereres)* | Opsætningsnøgle, der kræves for at oprette den første adgangskode fra en anden maskine end serveren. Skrives i loggen ved start |
| `SESSION_SECRET` | *(genereres)* | Nøgle til login-sessioner. Genereres automatisk og gemmes i `auth.json` |
| `BASE_CURRENCY` | `DKK` | Basisvaluta for totaler (kan også ændres under Indstillinger) |
| `QUOTE_CACHE_SECONDS` | `60` | Hvor længe kurser caches (mindst 10). Yahoo blokerer ved for mange kald |
| `TRUST_PROXY` | `0` | Sæt til `1` bag en reverse proxy, så `X-Forwarded-For`/`-Proto` bruges til login-bremse og cookies |
| `SECURE_COOKIES` | `0` | Tving `Secure`-flag på cookies (sættes automatisk bag proxy med `TRUST_PROXY=1` og HTTPS) |
| `WARM_CACHE` | `1` | Genhent kurser i baggrunden mens en børs er åben, så siden loader øjeblikkeligt |
| `YAHOO_MOCK` | `0` | `1` = brug indbyggede testkurser i stedet for Yahoo (til udvikling) |
| `STORAGE` | *(auto)* | `browser` = tving browser-tilstand (intet login, data i brugerens browser). På Vercel vælges den automatisk, når der ingen database er |
| `SUPABASE_URL` + `SUPABASE_KEY` | *(tom)* | Supabase-projekt. Når de findes, gemmes data dér. Kræver tabellerne og funktionerne i [`docs/database.md`](docs/database.md) |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | *(tom)* | Upstash Redis (sættes automatisk af Vercel). Når de findes, gemmes data i Redis i stedet for `DATA_DIR` |
| `PUBLIC_ACCESS` | *(auto)* | `1` = ingen login; alle med adressen ser og redigerer den samme portefølje. På Vercel slås den automatisk til, når der er en database og ingen `DASHBOARD_PASSWORD`. `0` slår den fra igen |

## Sådan virker det

- **Kurser** hentes server-side fra Yahoo Finance' uofficielle endpoints (dem finance.yahoo.com selv bruger). Der er intet officielt API, så det kan i princippet ændre sig. Al Yahoo-kode ligger i `server/yahoo.js`. Kurser kan være op til 15 min. forsinkede.
- **Beholdninger** gemmes som *antal* + *gns. købskurs* pr. aktie (i aktiens egen valuta) – præcis som din bank viser det. Der er bevidst ikke en fuld handelslog.
- **Afkast** = kursafkast i forhold til din gns. købskurs, omregnet til basisvalutaen med *dagens* valutakurs. Valutaudsving siden købet indgår ikke. Det står også i dashboardet.
- **Grafen** beregnes ud fra din nuværende beholdning og historiske lukkekurser (markeret "ca.").
- **Data** ligger som JSON i `DATA_DIR`. Filen skrives atomisk, og de 5 seneste versioner gemmes i `DATA_DIR/backups/`. Der sendes intet til andre end Yahoo Finance (kun aktiesymboler).

## Sikkerhed

- Adgangskoden hashes med scrypt. Sessioner er HMAC-signerede `HttpOnly`-cookies, der ugyldiggøres når adgangskoden skiftes.
- Max 8 mislykkede login pr. IP pr. 15 min. Første adgangskode kan kun oprettes fra localhost eller med opsætningsnøglen.
- Bag en reverse proxy: sæt `TRUST_PROXY=1`, så den rigtige klient-IP bruges.
- CSRF-værn (JSON-only API), Content-Security-Policy, ingen inline scripts, ingen eksterne ressourcer.
- **Kør altid bag HTTPS**, hvis dashboardet skal kunne nås udefra – fx med [Caddy](https://caddyserver.com) (`reverse_proxy localhost:3000`) eller Nginx. Login-siden advarer, hvis den åbnes ukrypteret uden for localhost.
- Glemt adgangskode? Slet `auth.json` i datamappen (eller sæt `DASHBOARD_PASSWORD`) og genstart.

## Udvikling

```bash
npm test                    # kører alle tests (ingen netværk)
YAHOO_MOCK=1 npm run dev    # server med genstart ved ændringer og falske kurser
```

```
api/index.js        Vercel-indgang (serverless)
vercel.json         rewrites + funktionsopsætning til Vercel
server/
  index.js          start, konfiguration, cache-opvarmning, .env
  app.js            routing, auth, API
  storage.js        vælger Supabase-, Redis- eller fil-lager ud fra miljøet
  resolve.js        finder Yahoo-symbol ud fra ISIN eller navn
  store-redis.js    Upstash Redis-lager (REST, compare-and-set, backups)
  store-supabase.js Supabase-lager (PostgREST, compare-and-set, backups)
  views/            index.html og login.html (serveres kun efter login-tjek)
  yahoo.js          Yahoo Finance-klient med cache
  yahoo-mock.js     falske kurser til udvikling/test
  portfolio-math.js beregninger (rene funktioner)
  store.js          JSON-lager med atomiske skrivninger og backups
  auth.js           scrypt + HMAC-sessioner + login-bremse
  http-utils.js     JSON/cookies/statiske filer
public/             statiske filer (serveres direkte)
  app.js            dashboard-klient
  import-csv.js     indlæser bank-eksporter i browseren
  app.css           designsystem (lys/mørk)
  login.js/.css     login og førstegangsopsætning
test/               node:test
```

### API (kort)

Alle `/api/*`-kald kræver login (cookie). Muterende kald skal sende `Content-Type: application/json`.

| Metode | Sti | |
|---|---|---|
| `GET` | `/api/portfolio?account=` | Alle positioner med live kurser og totaler (`account` = depot-id, `none` eller tom for alle) |
| `GET` | `/api/portfolio/history?range=1y&account=` | Porteføljens værdi over tid |
| `POST` | `/api/compute` · `/api/compute/history` | Samme beregninger ud fra beholdninger sendt i kaldet (bruges i browser-tilstand) |
| `POST` | `/api/resolve` | Finder Yahoo-symboler ud fra ISIN, navn og valuta (bruges ved import) |
| `GET` | `/api/search?q=novo` | Søg efter aktier/ETF'er |
| `GET` | `/api/quote/:symbol` | Kurs for ét symbol |
| `GET/POST` | `/api/holdings` | Liste / tilføj |
| `PUT/DELETE` | `/api/holdings/:id` | Redigér / slet |
| `POST` | `/api/holdings/:id/trade` | `{ type: "buy"\|"sell", quantity, price }` |
| `GET/PUT` | `/api/settings` | Basisvaluta, navn, kontanter, decimaler, depoter (`accounts`) |
| `GET` | `/api/backup` · `POST /api/restore` | Sikkerhedskopi |
| `GET` | `/api/health` | Sundhedstjek (kræver ikke login) |
| `POST` | `/api/auth/setup` · `login` · `logout` · `change-password` · `logout-all` | Auth |

## Begrænsninger

- Én bruger, én portefølje. Ingen handelslog, realiseret gevinst, udbytte eller skatteberegning. Importen læser handlerne, men gemmer kun den samlede beholdning pr. depot.
- Yahoo Finance' endpoints er uofficielle og kan ændre sig eller afvise for mange kald (429). Appen viser i så fald seneste kendte kurser tydeligt markeret.
- Ikke investeringsrådgivning.

## Licens

MIT
