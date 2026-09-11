// Indlæser transaktions-eksport fra banken (Nordnet-formatet og lignende) i browseren.
// Filen forlader aldrig din maskine: kun værdipapirernes navn, ISIN og valuta sendes til
// serveren for at finde det rigtige Yahoo-symbol.
//
// Global funktion, så den kan bruges af app.js og testes for sig.
window.parseBrokerCsv = (function () {
  'use strict';

  // Typenavne varierer: "KØBT" hos Nordnet, "Indbetalingskøb" hos AP Pension.
  // Derfor ledes der efter ordet et vilkårligt sted i teksten, og køb/salg tjekkes før
  // kontantbevægelser, så "Indbetalingskøb" ikke forveksles med "Indbetaling".
  const BUY = /(KØB|KOEB|BUY|TEGNET|TEGNING)/i;
  const SELL = /(SALG|SOLGT|SÆLG|SAELG|SELL|INDLØST|INDLOEST)/i;
  // Rene kontantbevægelser og lignende, som ikke ændrer en beholdning.
  const IGNORED = /(INDBETALING|UDBETALING|HÆVNING|HAEVNING|INDSÆTTELSE|INDSAETTELSE|UDBYTTE|^RENTE|SKAT|UDB\.|GEBYR|VEKSLING|OVERFØRSEL|OVERFOERSEL|DEPOTAFGIFT|PRÆMIE|KORREKTION)/i;

  function num(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim().replace(/\s/g, '').replace(/ /g, '');
    if (!s) return null;
    let norm = s;
    if (s.includes(',') && s.includes('.') && s.lastIndexOf('.') > s.lastIndexOf(',')) norm = s.replace(/,/g, '');
    else if (s.includes(',')) norm = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) norm = s.replace(/\./g, '');
    const n = Number(norm);
    return Number.isFinite(n) ? n : null;
  }

  // Deler en linje op. Håndterer citater, så et felt med skilletegn i ikke knækker.
  function splitLine(line, sep) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (c === sep && !quoted) {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  }

  function detectSeparator(headerLine) {
    const counts = ['\t', ';', ','].map((s) => [s, headerLine.split(s).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 1 ? counts[0][0] : '\t';
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zæøå0-9]/g, '');

  // Datoer sorteres som tekst, så dd-mm-åååå skrives om til åååå-mm-dd.
  function normalizeDate(value) {
    const s = String(value || '').trim();
    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
    return s;
  }

  // Kolonnenavne er ikke entydige: "Valuta" optræder flere gange og hører til kolonnen før.
  function buildIndex(header) {
    const idx = {};
    const currencyOf = {};
    let previous = null;
    header.forEach((raw, i) => {
      const key = norm(raw);
      if (key === 'valuta') {
        if (previous) currencyOf[previous] = i;
        return;
      }
      if (key && idx[key] === undefined) idx[key] = i;
      previous = key;
    });
    return { idx, currencyOf };
  }

  function parseBrokerCsv(text) {
    const clean = String(text || '').replace(/^﻿/, '');
    const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) return { ok: false, error: 'Filen indeholder ingen rækker.' };

    const sep = detectSeparator(lines[0]);
    const header = splitLine(lines[0], sep);
    const { idx, currencyOf } = buildIndex(header);
    // Kolonnenavne varierer mellem banker: "Antal"/"Enheder", "Værdipapirer"/"Fond".
    const alias = { antal: 'enheder', værdipapirer: 'fond', transaktionstype: 'type', handelsdag: 'dato' };
    for (const [key, other] of Object.entries(alias)) if (idx[key] === undefined && idx[other] !== undefined) idx[key] = idx[other];

    const need = ['transaktionstype', 'antal', 'kurs'];
    const missing = need.filter((k) => idx[k] === undefined);
    if (missing.length) {
      return { ok: false, error: `Filen ser ikke ud som en transaktionsoversigt. Manglende kolonner: ${missing.join(', ')}.` };
    }

    const get = (row, key) => (idx[key] === undefined ? '' : row[idx[key]] || '');
    const getCur = (row, key) => (currencyOf[key] === undefined ? '' : (row[currencyOf[key]] || '').toUpperCase());

    const positions = new Map();
    const warnings = [];
    const depots = new Set();
    const entries = [];
    let trades = 0;
    let ignored = 0;
    let cash = null;
    let cashId = -Infinity;

    // Første gennemløb: læs handlerne. Eksporten er typisk sorteret nyest først,
    // så de skal vendes om, før køb og salg kan lægges sammen i rækkefølge.
    for (const line of lines.slice(1)) {
      const row = splitLine(line, sep);
      if (row.length < 3) continue;
      const type = get(row, 'transaktionstype');
      const depot = get(row, 'depot');
      if (depot) depots.add(depot);

      // Nyeste saldo bruges som forslag til kontantbeholdningen.
      const id = num(get(row, 'id'));
      const saldo = num(get(row, 'saldo'));
      if (saldo !== null && id !== null && id > cashId) {
        cashId = id;
        cash = saldo;
      }

      const isBuy = BUY.test(type);
      const isSell = SELL.test(type);
      if (!isBuy && !isSell) {
        if (type && !IGNORED.test(type) && num(get(row, 'antal'))) warnings.push(`Sprang "${type}" over for ${get(row, 'værdipapirer') || 'ukendt papir'}.`);
        else ignored++;
        continue;
      }

      const quantity = Math.abs(num(get(row, 'antal')) ?? 0);
      const price = num(get(row, 'kurs'));
      const name = get(row, 'værdipapirer') || get(row, 'vaerdipapirer');
      const isin = (get(row, 'isin') || '').toUpperCase();
      if (!quantity || price === null) {
        warnings.push(`Sprang en linje over uden antal eller kurs: ${name || type}.`);
        continue;
      }

      // Papirets egen valuta står ved indkøbsværdien; ellers er handlen i kontoens valuta.
      const currency = getCur(row, 'indkøbsværdi') || getCur(row, 'resultat') || getCur(row, 'beløb') || 'DKK';
      const cashCurrency = getCur(row, 'beløb') || 'DKK';
      const fx = num(get(row, 'vekslingskurs')) || 1;
      const feeRaw = num(get(row, 'kurtage')) ?? num(get(row, 'samledeafgifter')) ?? 0;
      const feeCurrency = getCur(row, 'kurtage') || getCur(row, 'samledeafgifter') || cashCurrency;
      // Kurtage er typisk i kontoens valuta; regn den om til papirets valuta.
      const fee = feeCurrency === currency ? feeRaw : fx ? feeRaw / fx : 0;

      entries.push({
        order: id ?? 0,
        date: normalizeDate(get(row, 'handelsdag') || get(row, 'bogføringsdag') || ''),
        key: `${depot}|${isin || norm(name)}`,
        depot,
        isin,
        name,
        currency,
        isBuy,
        quantity,
        price,
        fee: fee || 0,
      });
      trades++;
    }

    // Andet gennemløb: ældste handel først, så gennemsnitskursen bliver rigtig.
    entries.sort((a, b) => (a.date === b.date ? a.order - b.order : String(a.date).localeCompare(String(b.date))));

    for (const e of entries) {
      let p = positions.get(e.key);
      if (!p) {
        p = { depot: e.depot, isin: e.isin, name: e.name, currency: e.currency, quantity: 0, cost: 0, trades: 0, sold: 0, date: '', firstBuy: '', lots: [] };
        positions.set(e.key, p);
      }
      if (!p.name && e.name) p.name = e.name;
      // Valutaen tages fra købene: på salgslinjer står beløbet ofte i kontoens valuta.
      if (e.currency && (e.isBuy || !p.currency)) p.currency = e.currency;
      if (e.date > p.date) p.date = e.date;
      // Købsdatoen er det første køb – dét er dagen, man har ejet papiret siden.
      if (e.isBuy && e.date && (!p.firstBuy || e.date < p.firstBuy)) p.firstBuy = e.date;

      if (e.isBuy) {
        p.quantity += e.quantity;
        p.cost += e.quantity * e.price + e.fee;
        // Hvert køb gemmes for sig med sin egen dato. Kurtagen lægges oveni
        // kursen, så gennemsnittet af købene giver præcis det samme som
        // regnestykket ovenfor.
        p.lots.push({ date: e.date || null, quantity: e.quantity, price: e.quantity > 0 ? e.price + e.fee / e.quantity : e.price });
      } else {
        const avg = p.quantity > 0 ? p.cost / p.quantity : e.price;
        const sold = Math.min(e.quantity, p.quantity);
        // Salg skrumper alle køb forholdsmæssigt – samme gennemsnitsmetode
        // som kostprisen ovenfor, så de to aldrig kommer i utakt.
        const andel = p.quantity > 0 ? (p.quantity - sold) / p.quantity : 0;
        p.lots = andel > 0 ? p.lots.map((l) => ({ ...l, quantity: l.quantity * andel })) : [];
        p.quantity -= sold;
        p.cost -= avg * sold;
        p.sold += e.quantity;
        if (p.quantity < 1e-9) {
          p.quantity = 0;
          p.cost = 0;
          p.lots = [];
        }
      }
      p.trades++;
    }

    const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
    const list = [...positions.values()]
      .filter((p) => p.quantity > 1e-9)
      .map((p) => ({
        depot: p.depot,
        isin: p.isin,
        name: p.name,
        currency: p.currency,
        quantity: round(p.quantity, 6),
        avgPrice: round(p.cost / p.quantity, 6),
        trades: p.trades,
        date: p.date,
        purchasedAt: p.firstBuy || null,
        // Kun værd at gemme køb for sig, når der faktisk er flere af dem med dato.
        lots: p.lots.length > 1 && p.lots.every((l) => l.date)
          ? p.lots.map((l) => ({ date: l.date, quantity: round(l.quantity, 6), price: round(l.price, 6) }))
          : null,
      }))
      .sort((a, b) => (a.depot === b.depot ? a.name.localeCompare(b.name, 'da') : String(a.depot).localeCompare(String(b.depot))));

    const closed = [...positions.values()].filter((p) => p.quantity <= 1e-9 && p.sold > 0).length;
    return {
      ok: true,
      positions: list,
      depots: [...depots],
      cash,
      trades,
      ignored,
      closed,
      warnings: warnings.slice(0, 10),
    };
  }

  // Læser en fil uanset om den er UTF-8 eller UTF-16, som bankernes eksport ofte er.
  parseBrokerCsv.decode = function decode(buffer) {
    const b = new Uint8Array(buffer);
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
    // Uden BOM: mange nul-bytes på lige pladser betyder UTF-16LE.
    let zeros = 0;
    const look = Math.min(b.length, 200);
    for (let i = 1; i < look; i += 2) if (b[i] === 0) zeros++;
    if (zeros > look / 4) return new TextDecoder('utf-16le').decode(b);
    return new TextDecoder('utf-8').decode(b);
  };

  return parseBrokerCsv;
})();
