const express = require('express');
const { db } = require('../db');
const h = require('../helpers');
const billing = require('../billing');
const { requireFinance, scopeSql, toInt, sendCsv } = require('../middleware');
const { buildDocument, comparisonText } = require('../report-doc');
const { renderDocx } = require('../report-docx');
const { stamp } = require('../audit');

const router = express.Router();
router.use(requireFinance);
router.use((req, res, next) => { billing.ensureCharges(); next(); });

// Na ekranu se dugi spiskovi skraćuju; Excel izvoz uvijek ima sve redove.
const SCREEN_LIMIT = 500;

// Naziv mjesta u imenu CSV datoteke, da se izvještaji različitih gradova ne pomiješaju.
function fileSuffix(res) {
  const slug = h.fold(res.locals.placeLabel || '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug ? `-${slug}` : '';
}

const PLACE_COLS = { branch: 'cs.branch_id', department: 'cs.department_id' };
const STUDENT_PLACE = { branch: 's.branch_id', department: 's.department_id' };
const sub = (level) => ({ branch: 'department', department: 'class' }[level] || null);
const placeCsv = (r) => [r.branch_name || '', r.department_name || ''];

// ---------------------------------------------------------------------------
// Glavni izvještaj: jedan mjesec ili cijela školska godina, odgovara na tri pitanja:
// koliko smo naplatili, ko duguje i gdje je novac.
// ---------------------------------------------------------------------------

function readPeriod(req, res) {
  const startMonth = Number(res.locals.settings.school_year_start) || 9;
  const now = h.currentPeriod();
  const currentYear = h.schoolYearStart(now, startMonth);
  const kind = req.query.vrsta === 'godina' ? 'godina' : 'mjesec';
  if (kind === 'godina') {
    const year = toInt(req.query.godina) ?? currentYear;
    const periods = h.schoolYearPeriods(year, startMonth);
    return {
      kind, year, currentYear, startMonth, periods, from: periods[0], to: periods[periods.length - 1],
      label: `Školska ${h.schoolYearLabel(year, startMonth)}`,
      prev: { vrsta: 'godina', godina: year - 1 }, next: { vrsta: 'godina', godina: year + 1 },
      isCurrent: year === currentYear, slug: `${year}-${year + 1}`,
    };
  }
  const month = h.isPeriod(req.query.mjesec) ? req.query.mjesec : now;
  return {
    kind, month, currentYear, startMonth, periods: [month], from: month, to: month,
    label: h.periodLabel(month).replace(/\.$/, ''),
    prev: { mjesec: h.addMonths(month, -1) }, next: { mjesec: h.addMonths(month, 1) },
    isCurrent: month === now, slug: month,
  };
}

function buildOverview(req, res) {
  const P = readPeriod(req, res);
  const scope = req.scope;
  const level = billing.levelFor(scope);
  const main = billing.summary(P.from, scope, level, P.to);
  // Za štampu ide i nivo niže (npr. sva odjeljenja ispod gradova).
  const detailLevel = { branch: 'department', department: 'class' }[level];
  const detail = detailLevel ? billing.summary(P.from, scope, detailLevel, P.to) : null;

  // Po mjesecima (za godinu)
  const byCharge = scopeSql(scope, PLACE_COLS);
  const monthMap = new Map(db.prepare(`
    SELECT cs.period, SUM(cs.due) AS due, SUM(cs.paid) AS paid FROM charge_status cs
    WHERE cs.period BETWEEN ? AND ? ${byCharge.sql} GROUP BY cs.period`).all(P.from, P.to, ...byCharge.params).map((r) => [r.period, r]));
  const months = P.periods.map((p) => ({ period: p, ...(monthMap.get(p) || { due: 0, paid: 0 }) }));

  // Ko duguje — ukupno, do danas (svi neplaćeni mjeseci), grupisano po broju mjeseci.
  const byStudent = scopeSql(scope, STUDENT_PLACE);
  const debtors = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.phone, c.name AS class_name, b.name AS branch_name, d.name AS department_name,
      SUM(cs.due - cs.paid) AS debt, COUNT(*) AS months
    FROM charge_status cs JOIN students s ON s.id = cs.student_id
    LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN departments d ON d.id = s.department_id
    WHERE cs.due > cs.paid ${byStudent.sql}
    GROUP BY s.id ORDER BY debt DESC, months DESC`).all(...byStudent.params);
  const aging = [
    { label: '1 mjesec', test: (m) => m === 1 },
    { label: '2 mjeseca', test: (m) => m === 2 },
    { label: '3 i više mjeseci', test: (m) => m >= 3 },
  ].map((a) => {
    const list = debtors.filter((d) => a.test(d.months));
    return { label: a.label, students: list.length, debt: list.reduce((t, d) => t + d.debt, 0) };
  });
  const debtTotal = debtors.reduce((t, d) => t + d.debt, 0);

  // Gdje je novac — sve uplate primljene u periodu (po datumu uplate).
  const cashFrom = `${P.from}-01`;
  const lastDay = new Date(Number(P.to.slice(0, 4)), h.monthOf(P.to), 0).getDate();
  const cashTo = [`${P.to}-${String(lastDay).padStart(2, '0')}`, h.todayISO()].sort()[0];
  const received = db.prepare(`
    SELECT p.method, COALESCE(u.name, '—') AS user_name, u.role, p.amount
    FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN users u ON u.id = p.created_by
    WHERE p.paid_on BETWEEN ? AND ? ${byStudent.sql}`).all(cashFrom, cashTo, ...byStudent.params);
  const sum = (list) => list.reduce((t, p) => t + p.amount, 0);
  const cash = {
    total: sum(received), count: received.length,
    gotovina: sum(received.filter((p) => p.method === 'gotovina')),
    banka: sum(received.filter((p) => p.method === 'banka')),
    ostalo: sum(received.filter((p) => p.method !== 'gotovina' && p.method !== 'banka')),
  };
  const people = new Map();
  for (const p of received) {
    const cur = people.get(p.user_name) || { name: p.user_name, role: p.role, count: 0, gotovina: 0, ostalo: 0, total: 0 };
    cur.count += 1;
    cur.total += p.amount;
    if (p.method === 'gotovina') cur.gotovina += p.amount; else cur.ostalo += p.amount;
    people.set(p.user_name, cur);
  }
  const byPerson = [...people.values()].sort((a, b) => b.total - a.total);

  // Novac po gradovima / odjeljenjima
  const placeCol = level === 'branch' ? 'b.name' : level === 'department' ? 'd.name' : null;
  const cashByPlace = placeCol ? db.prepare(`
    SELECT ${placeCol} AS name, COUNT(*) AS n, SUM(p.amount) AS total, SUM(CASE WHEN p.method = 'gotovina' THEN p.amount ELSE 0 END) AS gotovina
    FROM payments p JOIN students s ON s.id = p.student_id
    LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN departments d ON d.id = s.department_id
    WHERE p.paid_on BETWEEN ? AND ? ${byStudent.sql} GROUP BY ${placeCol} ORDER BY total DESC`).all(cashFrom, cashTo, ...byStudent.params) : null;

  // Po nivoima nastave (programima)
  const PROGRAM_ORDER = ['Sufara', 'Tedžvid', "Kur'an", 'Amme džuz', 'Hifz'];
  const byProgram = db.prepare(`
    SELECT COALESCE(NULLIF(c.program, ''), 'Bez programa') AS program_name, COUNT(DISTINCT cs.student_id) AS students,
      SUM(cs.due) AS due, SUM(cs.paid) AS paid, SUM(MAX(cs.due - cs.paid, 0)) AS remaining
    FROM charge_status cs LEFT JOIN classes c ON c.id = cs.class_id
    WHERE cs.period BETWEEN ? AND ? ${byCharge.sql} GROUP BY program_name`).all(P.from, P.to, ...byCharge.params)
    .map((r) => ({ ...r, name: r.program_name }))
    .sort((a, b) => ((PROGRAM_ORDER.indexOf(a.name) + 1) || 99) - ((PROGRAM_ORDER.indexOf(b.name) + 1) || 99));

  // Kretanje: za godinu svi mjeseci, za mjesec posljednjih 6 mjeseci (bez mjeseci bez naplate)
  const trendFrom = P.kind === 'godina' ? P.from : h.addMonths(P.from, -5);
  const trendMap = new Map(db.prepare(`
    SELECT cs.period, COUNT(DISTINCT cs.student_id) AS students, SUM(cs.due) AS due, SUM(cs.paid) AS paid,
      SUM(CASE WHEN cs.due > cs.paid THEN 1 ELSE 0 END) AS unpaid
    FROM charge_status cs WHERE cs.period BETWEEN ? AND ? ${byCharge.sql} GROUP BY cs.period`).all(trendFrom, P.to, ...byCharge.params).map((x) => [x.period, x]));
  const trend = h.periodRange(trendFrom, P.to)
    .map((p) => ({ period: p, ...(trendMap.get(p) || { students: 0, due: 0, paid: 0, unpaid: 0 }) }))
    .filter((m) => P.kind === 'godina' || m.due > 0);

  // Nisu platili (samo za mjesec): spisak za pozive roditeljima
  let unpaid = [];
  if (P.kind === 'mjesec') {
    unpaid = db.prepare(`
      SELECT cs.student_id, cs.due, cs.paid, s.first_name, s.last_name, s.parent_name, s.phone,
        COALESCE(c.name, 'Bez grupe') AS class_name, b.name AS branch_name, d.name AS department_name,
        (SELECT COUNT(*) FROM charge_status x WHERE x.student_id = cs.student_id AND x.due > x.paid) AS open_months
      FROM charge_status cs JOIN students s ON s.id = cs.student_id
      LEFT JOIN classes c ON c.id = cs.class_id LEFT JOIN branches b ON b.id = cs.branch_id LEFT JOIN departments d ON d.id = cs.department_id
      WHERE cs.period = ? AND cs.due > cs.paid ${byCharge.sql}
      ORDER BY b.name COLLATE NOCASE, d.name COLLATE NOCASE, c.name COLLATE NOCASE, s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`)
      .all(P.from, ...byCharge.params);
  }

  const comparison = comparisonText(P, main.totals, scope);

  // Prevoz (kombi): koliko od zaduženja otpada na doplatu za prevoz i koliko djece ga koristi.
  const transport = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN cs.waived = 1 THEN 0 ELSE MIN(cs.transport, cs.amount) END), 0) AS due,
      COUNT(DISTINCT CASE WHEN cs.transport > 0 THEN cs.student_id END) AS students
    FROM charge_status cs WHERE cs.period BETWEEN ? AND ? ${byCharge.sql}`).get(P.from, P.to, ...byCharge.params);

  // Upisi i ispisi po mjesecima. Učenici iz prvog mjeseca evidencije su zatečeno stanje, ne novi upis.
  const firstMonth = db.prepare('SELECT MIN(enrolled_from) AS m FROM students').get().m;
  const movement = (col) => new Map(db.prepare(`
    SELECT s.${col} AS period, COUNT(*) AS n FROM students s
    WHERE s.${col} BETWEEN ? AND ? ${col === 'enrolled_from' ? 'AND s.enrolled_from > ?' : ''} ${byStudent.sql}
    GROUP BY s.${col}`).all(P.from, P.to, ...(col === 'enrolled_from' ? [firstMonth || ''] : []), ...byStudent.params).map((r) => [r.period, r.n]));
  const joined = movement('enrolled_from');
  const left = movement('left_at');
  const enrollment = {
    firstMonth: firstMonth >= P.from && firstMonth <= P.to ? firstMonth : null,
    months: P.periods.map((p) => ({ period: p, joined: joined.get(p) || 0, left: left.get(p) || 0 })).filter((m) => m.joined || m.left),
  };
  enrollment.joined = enrollment.months.reduce((t, m) => t + m.joined, 0);
  enrollment.left = enrollment.months.reduce((t, m) => t + m.left, 0);

  return {
    P, level, main, detail, months, aging, debtTotal, debtorCount: debtors.length, topDebtors: debtors.slice(0, 10),
    cash, cashFrom, cashTo, byPerson, cashByPlace, byProgram, trend, unpaid, comparison, enrollment, transport,
  };
}

router.get('/', (req, res) => {
  const R = buildOverview(req, res);
  // Na ekranu najviše 300 redova spiska "Nisu platili"; kompletan spisak je u Excelu.
  res.render('reports/overview', {
    title: 'Izvještaj', tab: 'pregled', ...R, unpaid: R.unpaid.slice(0, 300), unpaidCount: R.unpaid.length,
    maxMonth: Math.max(1, ...R.months.map((m) => m.due)),
  });
});

// Finansijski izvještaj u stilu dosadašnjih izvještaja Škole: stranica za štampu/PDF i Word dokument.
function reportDocument(req, res) {
  const R = buildOverview(req, res);
  return buildDocument(R, { settings: res.locals.settings, scope: req.scope, placeLabel: res.locals.placeLabel, user: req.user, printedAt: stamp() });
}

router.get('/stampa', (req, res) => {
  const doc = reportDocument(req, res);
  const q = h.qs({ vrsta: req.query.vrsta, godina: req.query.godina, mjesec: req.query.mjesec });
  res.render('reports/print', { title: doc.title, doc, wordUrl: `/izvjestaji/word${q}`, backUrl: `/izvjestaji${q}` });
});

router.get('/word', async (req, res) => {
  const doc = reportDocument(req, res);
  const buf = await renderDocx(doc);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}${fileSuffix(res)}.docx"`);
  res.send(buf);
});

router.get('/excel', (req, res) => {
  const R = buildOverview(req, res);
  const t = R.main.totals;
  // Kolone mjesta samo iznad nivoa tabele (grupa: grad + odjeljenje, odjeljenje: grad).
  const table = (s) => {
    const place = (r) => [...(s.level !== 'branch' ? [r.branch_name || ''] : []), ...(s.level === 'class' ? [r.department_name || ''] : [])];
    return [
      [s.label, ...(s.level !== 'branch' ? ['Grad'] : []), ...(s.level === 'class' ? ['Odjeljenje'] : []),
        'Učenika', 'Platilo', 'Duguje', 'Zaduženo', 'Naplaćeno', 'Otvoreno', 'Naplata %'],
      ...s.rows.map((r) => [r.name, ...place(r), r.students, r.paid_count, r.unpaid_count,
        h.amount(r.due), h.amount(r.paid), h.amount(r.remaining), h.pct(r.paid, r.due)]),
    ];
  };
  sendCsv(res, `izvjestaj-${R.P.slug}${fileSuffix(res)}.csv`, [`Finansijski izvještaj — ${R.P.label} — ${res.locals.placeLabel}`], [
    [],
    ['KOLIKO SMO NAPLATILI'],
    ['Zaduženo', h.amount(t.due)], ['Naplaćeno', h.amount(t.paid)], ['Otvoreno', h.amount(t.remaining)], ['Naplata %', h.pct(t.paid, t.due)],
    [],
    ...table(R.main),
    ...(R.detail ? [[], ...table(R.detail)] : []),
    [],
    ['KO DUGUJE (svi neplaćeni mjeseci do danas)'],
    ['Broj mjeseci', 'Učenika', 'Dug'],
    ...R.aging.map((a) => [a.label, a.students, h.amount(a.debt)]),
    ['Ukupno', R.debtorCount, h.amount(R.debtTotal)],
    [],
    [`GDJE JE NOVAC (primljeno ${h.formatDate(R.cashFrom)} – ${h.formatDate(R.cashTo)})`],
    ['Gotovina', h.amount(R.cash.gotovina)], ['Banka', h.amount(R.cash.banka)], ['Ostalo', h.amount(R.cash.ostalo)], ['Ukupno', h.amount(R.cash.total)],
    [],
    ['Primio', 'Broj uplata', 'Gotovina', 'Banka/ostalo', 'Ukupno'],
    ...R.byPerson.map((p) => [p.name, p.count, h.amount(p.gotovina), h.amount(p.ostalo), h.amount(p.total)]),
  ]);
});

// Spisak učenika koji nisu platili odabrani mjesec — za pozive roditeljima.
router.get('/nisu-platili', (req, res) => {
  const R = buildOverview(req, res);
  sendCsv(res, `nisu-platili-${R.P.slug}${fileSuffix(res)}.csv`,
    ['Grad', 'Odjeljenje', 'Grupa', 'Učenik', 'Roditelj', 'Telefon', 'Za mjesec', 'Ukupno duguje (mjeseci)'],
    R.unpaid.map((u) => [u.branch_name || '', u.department_name || '', u.class_name, `${u.last_name} ${u.first_name}`, u.parent_name, u.phone,
      h.amount(u.due - u.paid), u.open_months]));
});

// Stare adrese izvještaja vode na novi glavni izvještaj.
router.get('/mjesecni', (req, res) => res.redirect(`/izvjestaji${h.qs({ mjesec: req.query.mjesec })}`));
router.get('/godisnji', (req, res) => res.redirect(`/izvjestaji${h.qs({ vrsta: 'godina', godina: req.query.godina })}`));

router.get('/dugovanja', (req, res) => {
  const grupa = toInt(req.query.grupa);
  const byStudent = scopeSql(req.scope, STUDENT_PLACE);
  const rows = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.parent_name, s.phone,
      COALESCE(c.name, 'Bez grupe') AS class_name, b.name AS branch_name, d.name AS department_name,
      SUM(cs.due - cs.paid) AS debt, COUNT(*) AS months, GROUP_CONCAT(cs.period) AS periods
    FROM charge_status cs JOIN students s ON s.id = cs.student_id
    LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN branches b ON b.id = s.branch_id
    LEFT JOIN departments d ON d.id = s.department_id
    WHERE cs.due > cs.paid ${byStudent.sql} ${grupa ? 'AND s.class_id = ?' : ''}
    GROUP BY s.id ORDER BY debt DESC, s.last_name COLLATE NOCASE`).all(...byStudent.params, ...(grupa ? [grupa] : []))
    .map((r) => ({ ...r, periods: r.periods.split(',').sort() }));
  const cf = scopeSql(req.scope, { branch: 'c.branch_id', department: 'c.department_id' });
  const classes = db.prepare(`
    SELECT c.id, c.name, d.name AS department_name FROM classes c LEFT JOIN departments d ON d.id = c.department_id
    WHERE c.active = 1 ${cf.sql} ORDER BY d.name COLLATE NOCASE, c.name COLLATE NOCASE`).all(...cf.params);
  const total = rows.reduce((t, r) => t + r.debt, 0);

  if (req.query.format === 'csv') {
    return sendCsv(res, `dugovanja${fileSuffix(res)}.csv`,
      ['Učenik', 'Grad', 'Odjeljenje', 'Grupa', 'Roditelj', 'Telefon', 'Broj mjeseci', 'Mjeseci', 'Dug'],
      [
        ...rows.map((r) => [`${r.last_name} ${r.first_name}`, ...placeCsv(r), r.class_name, r.parent_name, r.phone, r.months, r.periods.map(h.periodShort).join(', '), h.amount(r.debt)]),
        ['UKUPNO', '', '', '', '', '', '', '', h.amount(total)],
      ]);
  }

  res.render('reports/debts', {
    title: 'Dugovanja', tab: 'dugovanja', rows: rows.slice(0, SCREEN_LIMIT), rowCount: rows.length, classes, grupa, total,
  });
});

router.get('/blagajna', (req, res) => {
  const from = h.isDate(req.query.od) ? req.query.od : `${h.currentPeriod()}-01`;
  const to = h.isDate(req.query.do) ? req.query.do : h.todayISO();
  const byStudent = scopeSql(req.scope, STUDENT_PLACE);
  const payments = db.prepare(`
    SELECT p.*, s.first_name, s.last_name, COALESCE(c.name, '') AS class_name, COALESCE(u.name, '') AS created_by_name,
      COALESCE(b.name, '') AS branch_name, COALESCE(d.name, '') AS department_name
    FROM payments p JOIN students s ON s.id = p.student_id
    LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN departments d ON d.id = s.department_id
    WHERE p.paid_on BETWEEN ? AND ? ${byStudent.sql} ORDER BY p.paid_on, p.id`).all(from, to, ...byStudent.params);

  const sumBy = (key) => {
    const m = new Map();
    for (const p of payments) {
      const k = key(p);
      const cur = m.get(k) || { name: k, n: 0, total: 0 };
      cur.n += 1;
      cur.total += p.amount;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  };
  const level = billing.levelFor(req.scope);
  const byMethod = sumBy((p) => h.METHODS[p.method] || p.method);
  const byUser = sumBy((p) => p.created_by_name || '—');
  const byPlace = level === 'class' ? null
    : { label: level === 'branch' ? 'Po gradovima' : 'Po odjeljenjima', rows: sumBy((p) => (level === 'branch' ? p.branch_name : p.department_name) || '—') };
  const total = payments.reduce((t, p) => t + p.amount, 0);

  if (req.query.format === 'csv') {
    return sendCsv(res, `blagajna-${from}-${to}${fileSuffix(res)}.csv`,
      ['Datum', 'Učenik', 'Grad', 'Odjeljenje', 'Grupa', 'Za mjesec', 'Iznos', 'Način', 'Evidentirao', 'Napomena'],
      [
        ...payments.map((p) => [h.formatDate(p.paid_on), `${p.last_name} ${p.first_name}`, ...placeCsv(p), p.class_name, h.periodLabel(p.period), h.amount(p.amount), h.METHODS[p.method] || p.method, p.created_by_name, p.note]),
        ['UKUPNO', '', '', '', '', '', h.amount(total)],
      ]);
  }

  res.render('reports/cashbook', {
    title: 'Blagajna', tab: 'blagajna', from, to, payments: payments.slice(-SCREEN_LIMIT).reverse(), paymentCount: payments.length,
    byMethod, byUser: byUser.slice(0, 30), byPlace, total,
  });
});

// Dnevnik finansijski osjetljivih promjena: storniranja, izmjene zaduženja i cijena, brisanja.
router.get('/dnevnik', (req, res) => {
  const { ACTIONS } = require('../audit');
  const from = h.isDate(req.query.od) ? req.query.od : `${h.addMonths(h.currentPeriod(), -2)}-01`;
  const to = h.isDate(req.query.do) ? req.query.do : h.todayISO();
  const vrsta = ACTIONS[req.query.vrsta] ? req.query.vrsta : '';
  const f = scopeSql(req.scope, { branch: 'a.branch_id', department: 'a.department_id' });
  const rows = db.prepare(`
    SELECT a.*, b.name AS branch_name, d.name AS department_name
    FROM audit_log a LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN departments d ON d.id = a.department_id
    WHERE substr(a.created_at, 1, 10) BETWEEN ? AND ? ${f.sql} ${vrsta ? 'AND a.action = ?' : ''}
    ORDER BY a.created_at DESC, a.id DESC`).all(from, to, ...f.params, ...(vrsta ? [vrsta] : []));

  if (req.query.format === 'csv') {
    return sendCsv(res, `dnevnik-${from}-${to}${fileSuffix(res)}.csv`,
      ['Vrijeme', 'Promjena', 'Učenik', 'Grad', 'Odjeljenje', 'Iznos', 'Detalji', 'Izvršio'],
      rows.map((r) => [r.created_at.slice(0, 16), ACTIONS[r.action] || r.action, r.student_name, r.branch_name || '', r.department_name || '',
        r.amount == null ? '' : h.amount(r.amount), r.details, r.user_name]));
  }
  res.render('reports/audit', {
    title: 'Dnevnik promjena', tab: 'dnevnik', rows: rows.slice(0, SCREEN_LIMIT), rowCount: rows.length, from, to, vrsta, ACTIONS,
  });
});

module.exports = router;
