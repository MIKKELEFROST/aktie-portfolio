import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/import-csv.js er et browser-script; her køres det med et falsk window-objekt.
const window = {};
new Function('window', readFileSync(new URL('../public/import-csv.js', import.meta.url), 'utf8'))(window);
const parse = window.parseBrokerCsv;

const HEADER = ['Id', 'Bogføringsdag', 'Handelsdag', 'Valørdag', 'Depot', 'Transaktionstype', 'Værdipapirer', 'ISIN', 'Antal', 'Kurs', 'Rente', 'Samlede afgifter', 'Valuta', 'Beløb', 'Valuta', 'Indkøbsværdi', 'Valuta', 'Resultat', 'Valuta', 'Totalt antal', 'Saldo', 'Vekslingskurs', 'Transaktionstekst', 'Makuleringsdato', 'Notanummer', 'Verifikationsnummer', 'Kurtage', 'Valuta', 'Middelkurs', 'Oprindelig rente'];

// Kolonner: id, dato, depot, type, navn, isin, antal, kurs, beløb, indkøbsværdi+valuta, saldo, vekslingskurs, kurtage
function row({ id, dato = '2026-09-08', depot = '111', type, navn = '', isin = '', antal = '', kurs = '', afgifter = '', beloeb = '', indkoeb = '', valuta = 'DKK', saldo = '', fx = '', kurtage = '' }) {
  const r = new Array(30).fill('');
  r[0] = id; r[1] = dato; r[2] = dato; r[3] = dato; r[4] = depot; r[5] = type; r[6] = navn; r[7] = isin;
  r[8] = antal; r[9] = kurs; r[11] = afgifter; r[12] = 'DKK'; r[13] = beloeb; r[14] = 'DKK';
  r[15] = indkoeb; r[16] = valuta; r[18] = valuta; r[20] = saldo; r[21] = fx; r[26] = kurtage; r[27] = 'DKK';
  return r.join('\t');
}
const file = (rows) => [HEADER.join('\t'), ...rows].join('\r\n');

test('udenlandske køb: gennemsnitskurs i papirets egen valuta, kurtage regnet med', () => {
  const r = parse(file([
    row({ id: '3', type: 'KØBT', navn: 'NVIDIA', isin: 'US67066G1040', antal: '7', kurs: '230,8599', beloeb: '-10443,09', indkoeb: '1619,9', valuta: 'USD', saldo: '79556,91', fx: '6,4467', kurtage: '25' }),
    row({ id: '2', type: 'KØBT', navn: 'Micron Technology', isin: 'US5951121038', antal: '1', kurs: '1005,2', beloeb: '-6503,57', indkoeb: '1009,08', valuta: 'USD', saldo: '49828,2', fx: '6,445', kurtage: '25' }),
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.trades, 2);
  assert.equal(r.positions.length, 2);
  const nvidia = r.positions.find((p) => p.name === 'NVIDIA');
  assert.equal(nvidia.quantity, 7);
  assert.equal(nvidia.currency, 'USD');
  // 7 x 230,8599 USD + 25 DKK / 6,4467 = 1619,90 USD, altså bankens egen indkøbsværdi
  assert.ok(Math.abs(nvidia.avgPrice * 7 - 1619.9) < 0.01, `fik ${nvidia.avgPrice * 7}`);
  assert.equal(nvidia.isin, 'US67066G1040');
  assert.equal(r.cash, 79556.91, 'saldo tages fra den nyeste linje');
  assert.deepEqual(r.depots, ['111']);
});

test('danske køb uden vekslingskurs', () => {
  const r = parse(file([
    row({ id: '1', type: 'KØBT', navn: 'Novo Nordisk B', isin: 'DK0060534915', antal: '10', kurs: '300', beloeb: '-3029', indkoeb: '3029', valuta: 'DKK', kurtage: '29' }),
  ]));
  const p = r.positions[0];
  assert.equal(p.currency, 'DKK');
  assert.equal(p.quantity, 10);
  assert.equal(p.avgPrice, 302.9);
});

test('flere køb af samme aktie lægges sammen med vægtet gennemsnit', () => {
  const r = parse(file([
    row({ id: '2', dato: '2026-02-01', type: 'KØBT', navn: 'Novo', isin: 'DK1', antal: '10', kurs: '300', valuta: 'DKK' }),
    row({ id: '1', dato: '2026-01-01', type: 'KØBT', navn: 'Novo', isin: 'DK1', antal: '30', kurs: '200', valuta: 'DKK' }),
  ]));
  assert.equal(r.positions.length, 1);
  assert.equal(r.positions[0].quantity, 40);
  assert.equal(r.positions[0].avgPrice, 225);
  assert.equal(r.positions[0].date, '2026-02-01');
});

test('salg reducerer antallet uden at ændre gennemsnitskursen', () => {
  const r = parse(file([
    row({ id: '2', type: 'SOLGT', navn: 'Novo', isin: 'DK1', antal: '10', kurs: '400', valuta: 'DKK' }),
    row({ id: '1', type: 'KØBT', navn: 'Novo', isin: 'DK1', antal: '30', kurs: '200', valuta: 'DKK' }),
  ]));
  assert.equal(r.positions[0].quantity, 20);
  assert.equal(r.positions[0].avgPrice, 200);
});

test('helt solgte positioner udelades', () => {
  const r = parse(file([
    row({ id: '2', type: 'SOLGT', navn: 'Novo', isin: 'DK1', antal: '30', kurs: '400', valuta: 'DKK' }),
    row({ id: '1', type: 'KØBT', navn: 'Novo', isin: 'DK1', antal: '30', kurs: '200', valuta: 'DKK' }),
  ]));
  assert.deepEqual(r.positions, []);
  assert.equal(r.closed, 1);
});

test('samme aktie i to depoter holdes adskilt', () => {
  const r = parse(file([
    row({ id: '2', depot: 'A', type: 'KØBT', navn: 'Novo', isin: 'DK1', antal: '10', kurs: '300', valuta: 'DKK' }),
    row({ id: '1', depot: 'B', type: 'KØBT', navn: 'Novo', isin: 'DK1', antal: '5', kurs: '100', valuta: 'DKK' }),
  ]));
  assert.equal(r.positions.length, 2);
  assert.deepEqual(r.positions.map((p) => `${p.depot}:${p.quantity}`).sort(), ['A:10', 'B:5']);
  assert.deepEqual(r.depots.sort(), ['A', 'B']);
});

test('kontantbevægelser ignoreres, ukendte typer med antal giver en advarsel', () => {
  const r = parse(file([
    row({ id: '4', type: 'INDBETALING', beloeb: '50000', saldo: '90000' }),
    row({ id: '3', type: 'HÆVNING', beloeb: '-214', saldo: '0' }),
    row({ id: '2', type: 'UDBYTTE', navn: 'Novo', beloeb: '120' }),
    row({ id: '1', type: 'SPLIT', navn: 'Novo', isin: 'DK1', antal: '10', kurs: '0', valuta: 'DKK' }),
  ]));
  assert.deepEqual(r.positions, []);
  assert.equal(r.ignored, 3);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /SPLIT/);
  assert.equal(r.cash, 90000);
});

test('semikolon-adskilt fil med citater læses også', () => {
  const text = ['Id;Depot;Transaktionstype;Værdipapirer;ISIN;Antal;Kurs;Indkøbsværdi;Valuta',
    '1;A;KØBT;"Møller, A.P. B";DK1;2;1000;2000;DKK'].join('\n');
  const r = parse(text);
  assert.equal(r.ok, true);
  assert.equal(r.positions[0].name, 'Møller, A.P. B');
  assert.equal(r.positions[0].quantity, 2);
});

test('en fil der ikke er en transaktionsoversigt afvises pænt', () => {
  assert.equal(parse('navn;pris\nNovo;300').ok, false);
  assert.match(parse('navn;pris\nNovo;300').error, /Manglende kolonner/);
  assert.equal(parse('').ok, false);
});

test('decode: UTF-16 med BOM, UTF-16 uden BOM og UTF-8', () => {
  const utf16le = (s) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) { b[2 + i * 2] = s.charCodeAt(i) & 255; b[3 + i * 2] = s.charCodeAt(i) >> 8; } return b.buffer; };
  assert.match(parse.decode(utf16le('Værdipapirer')), /^﻿?Værdipapirer$/);
  const noBom = new Uint8Array(24);
  'Depot\tAntal'.split('').forEach((c, i) => { noBom[i * 2] = c.charCodeAt(0); });
  assert.match(parse.decode(noBom.buffer), /Depot\tAntal/);
  assert.equal(parse.decode(new TextEncoder().encode('Depot;Antal').buffer), 'Depot;Antal');
});

test('valutaen tages fra købene, ikke fra en salgslinje i kontoens valuta', () => {
  const r = parse(file([
    row({ id: '2', type: 'SOLGT', navn: 'ETF', isin: 'IE1', antal: '5', kurs: '191,08', valuta: 'DKK' }),
    row({ id: '1', type: 'KØBT', navn: 'ETF', isin: 'IE1', antal: '20', kurs: '160,08', valuta: 'EUR' }),
  ]));
  assert.equal(r.positions[0].currency, 'EUR');
  assert.equal(r.positions[0].quantity, 15);
});

test('ASK-skattelinjer tælles som ignorerede uden advarsel', () => {
  const r = parse(file([
    row({ id: '2', type: 'AFKASTSKAT ASK', beloeb: '-120' }),
    row({ id: '1', type: 'SKATTEINDBETALING ASK', beloeb: '120' }),
  ]));
  assert.equal(r.ignored, 2);
  assert.deepEqual(r.warnings, []);
});

test('AP Pensions format: "Indbetalingskøb", "Salg", dd-mm-åååå og kolonnen "Enheder"', () => {
  // Kolonnenavne og rækkefølge som i AP Pensions ordrebog.
  const text = [
    'Dato;Type;Fond;Enheder;Kurs;Værdi;Status',
    '03-09-2026;Indbetalingskøb;Sparinvest Index S&P 500 SYN;36,17;102,11;3693,01;Gennemført',
    '31-08-2026;Salg;Sparinvest Index S&P 500 SYN;-0,64;102,75;-65,33;Gennemført',
    '13-08-2026;Indbetalingskøb;Sparinvest Index S&P 500 SYN;60,51;103,76;6278,58;Gennemført',
    '13-08-2026;Salg;AP Active 2065;-15,41;272,36;-4197,69;Gennemført',
    '06-08-2026;Indbetalingskøb;AP Active 2065;15,41;272,85;4205,20;Gennemført',
  ].join('\n');
  const r = parse(text);
  assert.equal(r.ok, true);
  assert.equal(r.trades, 5);
  assert.equal(r.positions.length, 1, 'AP Active er solgt helt igen');
  const p = r.positions[0];
  assert.equal(p.name, 'Sparinvest Index S&P 500 SYN');
  assert.ok(Math.abs(p.quantity - 96.04) < 0.001, `antal ${p.quantity}`);
  // Købt 60,51 @ 103,76, solgt 0,64 til gennemsnittet, købt 36,17 @ 102,11
  assert.ok(Math.abs(p.avgPrice - 103.1386) < 0.001, `gns. ${p.avgPrice}`);
  assert.equal(r.closed, 1);
});

test('datoer i dd-mm-åååå sorteres rigtigt, så salg efter køb regnes korrekt', () => {
  const text = [
    'Dato;Type;Fond;Enheder;Kurs',
    '02-01-2026;Salg;Fond A;-10;200',
    '01-01-2026;Indbetalingskøb;Fond A;30;100',
  ].join('\n');
  const r = parse(text);
  assert.equal(r.positions[0].quantity, 20);
  assert.equal(r.positions[0].avgPrice, 100, 'salg ændrer ikke gennemsnittet');
});

test('flere køb af samme papir bliver til en liste med dato, antal og kurs', () => {
  const r = parse(file([
    row({ id: '1', dato: '2025-01-10', type: 'KØBT', navn: 'Novo', isin: 'DK0062498333', antal: '10', kurs: '100', beloeb: '-1000' }),
    row({ id: '2', dato: '2025-06-10', type: 'KØBT', navn: 'Novo', isin: 'DK0062498333', antal: '30', kurs: '200', beloeb: '-6000' }),
  ]));
  const p = r.positions[0];
  assert.equal(p.quantity, 40);
  assert.equal(p.lots.length, 2);
  assert.deepEqual(p.lots.map((l) => l.date), ['2025-01-10', '2025-06-10']);
  assert.deepEqual(p.lots.map((l) => l.quantity), [10, 30]);
  assert.equal(p.purchasedAt, '2025-01-10');
  // Gennemsnittet af købene skal ramme præcis det samme som den samlede kurs.
  const vægtet = p.lots.reduce((s, l) => s + l.quantity * l.price, 0) / p.quantity;
  assert.ok(Math.abs(vægtet - p.avgPrice) < 1e-6, `${vægtet} mod ${p.avgPrice}`);
});

test('kurtage lægges oveni kursen på det enkelte køb, så listen stemmer med gennemsnittet', () => {
  const r = parse(file([
    row({ id: '1', dato: '2025-01-10', type: 'KØBT', navn: 'Novo', isin: 'DK0062498333', antal: '10', kurs: '100', beloeb: '-1029', kurtage: '29' }),
    row({ id: '2', dato: '2025-06-10', type: 'KØBT', navn: 'Novo', isin: 'DK0062498333', antal: '10', kurs: '200', beloeb: '-2029', kurtage: '29' }),
  ]));
  const p = r.positions[0];
  assert.equal(p.lots[0].price, 102.9);
  assert.equal(p.lots[1].price, 202.9);
  assert.equal(p.avgPrice, 152.9);
});

test('salg skrumper købene forholdsmæssigt, så gennemsnitskursen ikke flytter sig', () => {
  const r = parse(file([
    row({ id: '1', dato: '2025-01-10', type: 'KØBT', navn: 'Novo', isin: 'DK0062498333', antal: '10', kurs: '100', beloeb: '-1000' }),
    row({ id: '2', dato: '2025-06-10', type: 'KØBT', navn: 'Novo', isin: 'DK0062498333', antal: '30', kurs: '200', beloeb: '-6000' }),
    row({ id: '3', dato: '2025-08-10', type: 'SOLGT', navn: 'Novo', isin: 'DK0062498333', antal: '20', kurs: '300', beloeb: '6000' }),
  ]));
  const p = r.positions[0];
  assert.equal(p.quantity, 20);
  assert.equal(p.avgPrice, 175);
  assert.deepEqual(p.lots.map((l) => l.quantity), [5, 15]);
});

test('ét enkelt køb får ingen liste – der er ikke noget at holde adskilt', () => {
  const r = parse(file([
    row({ id: '1', dato: '2025-01-10', type: 'KØBT', navn: 'Novo', isin: 'DK0062498333', antal: '10', kurs: '100', beloeb: '-1000' }),
  ]));
  assert.equal(r.positions[0].lots, null);
  assert.equal(r.positions[0].purchasedAt, '2025-01-10');
});
