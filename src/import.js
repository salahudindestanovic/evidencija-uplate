// Uvoz učenika iz Excela: korisnik kopira redove iz tabele (Ctrl+C) i zalijepi ih (Ctrl+V), ili učita CSV.
// Kolone se prepoznaju po zaglavlju (Ime, Prezime, Roditelj, Telefon, Grupa…), a mogu se i ručno odabrati.

const { db } = require('./db');
const h = require('./helpers');

const FIELDS = {
  '': '— ne uvozi —',
  first_name: 'Ime',
  last_name: 'Prezime',
  full_name: 'Ime i prezime',
  full_name_rev: 'Prezime i ime',
  parent_name: 'Roditelj',
  phone: 'Telefon',
  class_name: 'Grupa',
  fee: 'Mjesečno plaća',
  debt: 'Dug iz ranije',
  transport: 'Prevoz (da/ne)',
  note: 'Napomena',
};

// Nazivi kolona kakvi se obično pišu u tabelama (bez kvačica, mala slova).
const ALIASES = [
  ['full_name_rev', ['prezime i ime', 'prezime ime']],
  ['full_name', ['ime i prezime', 'ime prezime', 'ucenik', 'ucenica', 'polaznik', 'polaznica', 'ime i prezime ucenika', 'naziv']],
  ['parent_name', ['roditelj', 'ime roditelja', 'roditelj staratelj', 'staratelj', 'otac', 'majka', 'ime oca', 'ime majke']],
  ['first_name', ['ime', 'ime ucenika']],
  ['last_name', ['prezime', 'prezime ucenika']],
  ['phone', ['telefon', 'tel', 'broj telefona', 'telefon roditelja', 'mobilni', 'mob', 'mobitel', 'kontakt', 'broj']],
  ['class_name', ['grupa', 'nivo', 'program', 'razred', 'odjel']],
  ['fee', ['mjesecno', 'mesecno', 'mjesecno placa', 'mesecno placa', 'posebna cijena', 'cijena', 'cena', 'clanarina', 'iznos', 'popust']],
  ['debt', ['dug', 'dug iz ranije', 'dugovanje', 'duguje', 'stari dug', 'dug do sada']],
  ['transport', ['prevoz', 'prijevoz', 'kombi', 'prevoz kombi', 'koristi prevoz']],
  ['note', ['napomena', 'komentar', 'opis', 'biljeska']],
];

const norm = (s) => h.fold(String(s || '')).replace(/[^a-z0-9]+/g, ' ').trim();

function guessField(header) {
  const n = norm(header);
  if (!n) return '';
  for (const [field, names] of ALIASES) if (names.includes(n)) return field;
  for (const [field, names] of ALIASES) if (names.some((a) => n.startsWith(`${a} `))) return field;
  return '';
}

// Jedan red CSV-a s navodnicima ("Hodžić; Amar" ostaje jedno polje).
function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"' && cur === '') quoted = true;
    else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseTable(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines[0].includes(';') ? ';' : ',';
  const rows = lines.map((l) => (sep === '\t' ? l.split('\t') : splitCsvLine(l, sep)).map((c) => c.trim()));
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
}

// Redoslijed kad tabela nema zaglavlje.
const DEFAULT_ORDER = ['first_name', 'last_name', 'parent_name', 'phone', 'class_name', 'fee', 'note'];

function detectColumns(rows) {
  const guessed = rows[0].map(guessField);
  const hasHeader = guessed.filter(Boolean).length >= 1
    && guessed.some((f) => ['first_name', 'last_name', 'full_name', 'full_name_rev'].includes(f));
  if (hasHeader) return { hasHeader, map: guessed };
  const width = rows[0].length;
  return { hasHeader, map: width === 1 ? ['full_name'] : DEFAULT_ORDER.slice(0, width).concat(Array(Math.max(0, width - DEFAULT_ORDER.length)).fill('')) };
}

// "AMAR HODŽIĆ" i "amar hodžić" -> "Amar Hodžić"; mješovita slova ostaju kako su upisana.
function tidyName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t || (t !== t.toUpperCase() && t !== t.toLowerCase())) return t;
  return t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

function guessProgram(name) {
  const n = norm(name);
  if (n.includes('sufar')) return 'Sufara';
  if (n.includes('tedzvid')) return 'Tedžvid';
  if (n.includes('amme')) return 'Amme džuz';
  if (n.includes('hifz')) return 'Hifz';
  return '';
}

// Pravi plan uvoza: šta će biti upisano, šta preskočeno i zašto, i koje grupe treba kreirati.
function planImport({ text, map, header, departmentId, defaultClassId }) {
  const rows = parseTable(text);
  if (!rows.length) return { rows: [], columns: [], hasHeader: false, map: [], items: [], newGroups: [], counts: { ok: 0, skip: 0 } };
  const detected = detectColumns(rows);
  // Korisnik može reći da prvi red jeste/nije zaglavlje kad automatsko prepoznavanje pogriješi.
  if (header === '1' || header === '0') detected.hasHeader = header === '1';
  const useMap = Array.isArray(map) && map.length === rows[0].length ? map.map((f) => (FIELDS[f] !== undefined ? f : '')) : detected.map;
  const data = detected.hasHeader ? rows.slice(1) : rows;

  const classes = db.prepare('SELECT id, name, program, monthly_fee FROM classes WHERE department_id = ? AND active = 1').all(departmentId);
  const byName = new Map(classes.map((c) => [norm(c.name), c]));
  const defaultClass = classes.find((c) => c.id === defaultClassId) || null;
  const existing = new Set(db.prepare('SELECT first_name, last_name FROM students WHERE department_id = ? AND left_at IS NULL').all(departmentId)
    .map((s) => norm(`${s.first_name} ${s.last_name}`)));
  const seen = new Set();
  const newGroups = new Map();

  const items = data.map((cells, i) => {
    const get = (field) => { const k = useMap.indexOf(field); return k >= 0 ? cells[k] : ''; };
    let first = tidyName(get('first_name'));
    let last = tidyName(get('last_name'));
    const full = tidyName(get('full_name') || get('full_name_rev'));
    if (full && !first && !last) {
      const parts = full.split(' ');
      if (useMap.includes('full_name_rev')) { last = parts[0]; first = parts.slice(1).join(' '); } else { first = parts[0]; last = parts.slice(1).join(' '); }
    }
    const item = {
      line: i + (detected.hasHeader ? 2 : 1),
      first_name: first, last_name: last,
      parent_name: tidyName(get('parent_name')),
      phone: String(get('phone') || '').trim(),
      note: String(get('note') || '').trim(),
      class_label: String(get('class_name') || '').trim(),
      fee: null, class: null, newGroup: null, status: 'ok', reason: '',
      transport: ['da', 'd', 'x', '1', '+', 'yes', 'kombi', 'prevoz', 'ima'].includes(norm(get('transport'))) ? 1 : 0,
    };
    const feeText = String(get('fee') || '').replace(/€|eur(a|o)?/gi, '').trim();
    if (feeText) item.fee = h.parseMoney(feeText);
    const debtText = String(get('debt') || '').replace(/€|eur(a|o)?/gi, '').trim();
    item.debt = debtText ? h.parseMoney(debtText) : 0;

    if (item.class_label) {
      const found = byName.get(norm(item.class_label));
      if (found) item.class = found;
      else {
        const key = norm(item.class_label);
        if (!newGroups.has(key)) newGroups.set(key, { name: item.class_label.replace(/\s+/g, ' '), program: guessProgram(item.class_label), count: 0 });
        item.newGroup = newGroups.get(key);
      }
    } else item.class = defaultClass;

    const key = norm(`${first} ${last}`);
    if (!first || !last) { item.status = 'error'; item.reason = 'Nedostaje ime ili prezime'; }
    else if (Number.isNaN(item.fee)) { item.status = 'error'; item.reason = `Neispravan mjesečni iznos "${feeText}"`; }
    else if (Number.isNaN(item.debt)) { item.status = 'error'; item.reason = `Neispravan dug "${debtText}"`; }
    else if (existing.has(key)) { item.status = 'skip'; item.reason = 'Već je upisan u ovom odjeljenju'; }
    else if (seen.has(key)) { item.status = 'skip'; item.reason = 'Ponavlja se u tabeli'; }
    if (item.status === 'ok') { seen.add(key); if (item.newGroup) item.newGroup.count += 1; }
    return item;
  });

  return {
    columns: rows[0].map((c, i) => (detected.hasHeader ? c : `Kolona ${i + 1}`)),
    sample: data.slice(0, 1)[0] || [],
    hasHeader: detected.hasHeader,
    map: useMap,
    items,
    newGroups: [...newGroups.values()].filter((g) => g.count > 0),
    counts: { ok: items.filter((x) => x.status === 'ok').length, skip: items.filter((x) => x.status !== 'ok').length },
  };
}

module.exports = { FIELDS, planImport, guessProgram };
