// Formatiranje i rad s mjesecima. Dostupno u svim view-ovima kao `h`.
const fs = require('node:fs');
const path = require('node:path');

// Lucide ikone kao inline SVG: <%- h.icon('users') %>
const ICON_DIR = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const iconCache = new Map();
function icon(name, size = 16) {
  if (!iconCache.has(name)) {
    const svg = fs.readFileSync(path.join(ICON_DIR, `${name}.svg`), 'utf8')
      .replace(/<!--[\s\S]*?-->\s*/, '')
      .replace(/\s*\n\s*/g, ' ')
      .replace('class="lucide', 'aria-hidden="true" focusable="false" class="icon lucide')
      .replace('stroke-width="2"', 'stroke-width="1.75"');
    iconCache.set(name, svg);
  }
  return iconCache.get(name).replace('width="24"', `width="${size}"`).replace('height="24"', `height="${size}"`);
}

const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const MONTH_NAMES = ['Januar', 'Februar', 'Mart', 'April', 'Maj', 'Juni', 'Juli', 'August', 'Septembar', 'Oktobar', 'Novembar', 'Decembar'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];

const METHODS = { gotovina: 'Gotovina', banka: 'Banka', ostalo: 'Ostalo' };

const STATUS = {
  paid: { label: 'Plaćeno', cls: 'ok' },
  partial: { label: 'Djelimično', cls: 'warn' },
  unpaid: { label: 'Nije plaćeno', cls: 'bad' },
  waived: { label: 'Oslobođen', cls: 'muted' },
  free: { label: 'Besplatno', cls: 'muted' },
  advance: { label: 'Unaprijed', cls: 'info' },
  none: { label: '—', cls: 'none' },
};

const pad = (n) => String(n).padStart(2, '0');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const currentPeriod = () => todayISO().slice(0, 7);
const isPeriod = (p) => typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const monthOf = (p) => Number(p.slice(5, 7));

function addMonths(period, n) {
  const [y, m] = period.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

function periodRange(from, to) {
  const out = [];
  for (let p = from; p <= to; p = addMonths(p, 1)) out.push(p);
  return out;
}

// "u oktobru 2026." — za rečenice u izvještajima
const MONTH_LOCATIVE = ['januaru', 'februaru', 'martu', 'aprilu', 'maju', 'junu', 'julu', 'augustu', 'septembru', 'oktobru', 'novembru', 'decembru'];
const MONTH_GENITIVE = ['januara', 'februara', 'marta', 'aprila', 'maja', 'juna', 'jula', 'augusta', 'septembra', 'oktobra', 'novembra', 'decembra'];
// Dug iz ranije (prije uvođenja sistema) čuva se kao zaduženje s posebnim "mjesecom" 0000-01,
// pa ga uplate, priznanice i izvještaji o dugu tretiraju kao i svaki drugi neplaćeni mjesec.
const OPENING = '0000-01';
const isOpening = (p) => p === OPENING;

const periodLocative = (p) => (isOpening(p) ? 'dugu iz ranije' : `${MONTH_LOCATIVE[monthOf(p) - 1]} ${p.slice(0, 4)}.`);
const periodLabel = (p) => (isOpening(p) ? 'Dug iz ranije' : `${MONTH_NAMES[monthOf(p) - 1]} ${p.slice(0, 4)}.`);
const periodShort = (p) => (isOpening(p) ? 'Raniji dug' : `${MONTH_SHORT[monthOf(p) - 1]} ${p.slice(2, 4)}.`);
// "Oktobar 2026" (bez tačke), za spiskove mjeseci
const monthLabel = (p) => (isOpening(p) ? 'Dug iz ranije' : `${MONTH_NAMES[monthOf(p) - 1]} ${p.slice(0, 4)}`);

function schoolYearStart(period, startMonth) {
  const year = Number(period.slice(0, 4));
  return monthOf(period) >= startMonth ? year : year - 1;
}

function schoolYearPeriods(startYear, startMonth) {
  const first = `${startYear}-${pad(startMonth)}`;
  return periodRange(first, addMonths(first, 11));
}

const schoolYearLabel = (startYear, startMonth) =>
  startMonth === 1 ? `${startYear}.` : `${startYear}/${String(startYear + 1).slice(2)}`;

// 2050 -> "20,50"
function amount(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents || 0));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}${whole},${pad(abs % 100)}`;
}

const money = (cents, currency) => `${amount(cents)}${currency ? ' ' + currency : ''}`;

// "20", "20,5", "20.50" -> 2050; NaN ako nije ispravno
function parseMoney(str) {
  const s = String(str ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}.`;
}

function chargeStatus(charge, paid) {
  if (!charge) return paid > 0 ? 'advance' : 'none';
  if (charge.waived) return 'waived';
  if (charge.amount === 0) return 'free';
  if (paid >= charge.amount) return 'paid';
  return paid > 0 ? 'partial' : 'unpaid';
}

// Bosanska množina: plural(3, 'mjesec', 'mjeseca', 'mjeseci') -> 'mjeseca'
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Porodica = isti broj telefona roditelja (zadnjih 8 cifara, pa se "061 …" i "+381 61 …" poklapaju).
const familyKey = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 6 ? d.slice(-8) : '';
};

// Broj u međunarodnom obliku za WhatsApp/SMS: "061 234 567" -> "38161234567".
function intlPhone(phone, prefix = '381') {
  const raw = String(phone || '').trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (raw.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return String(prefix).replace(/\D/g, '') + d.slice(1);
  return d;
}

const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pct = (part, whole) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

// Pretraga bez obzira na velika slova i dijakritike (č, ć, š, ž, đ)
const fold = (s) => String(s || '').toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '');

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

module.exports = {
  icon, initials,
  MONTH_NAMES, MONTH_SHORT, METHODS, STATUS,
  todayISO, currentPeriod, isPeriod, isDate, monthOf, addMonths, periodRange,
  MONTH_GENITIVE, periodLabel, periodLocative, periodShort, monthLabel, OPENING, isOpening, schoolYearStart, schoolYearPeriods, schoolYearLabel,
  amount, money, parseMoney, formatDate, chargeStatus, pct, plural, escape, familyKey, intlPhone, fold, qs,
};
