const express = require('express');
const { db, transaction } = require('../db');
const h = require('../helpers');
const billing = require('../billing');
const { audit } = require('../audit');
const { createReceipt, markVoided } = require('../receipts');
const {
  requireLogin, requireFinance, scopeSql, canAccessStudent, canAccessClass, canRecord, toInt, safeBack, paginate, forbidden, notFound,
} = require('../middleware');

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  const from = h.isDate(req.query.od) ? req.query.od : `${h.currentPeriod()}-01`;
  const to = h.isDate(req.query.do) ? req.query.do : h.todayISO();
  const grupa = toInt(req.query.grupa);
  const metoda = h.METHODS[req.query.metoda] ? req.query.metoda : '';
  const scope = scopeSql(req.scope, { branch: 's.branch_id', department: 's.department_id', teacher: 'c.teacher_id' });

  let where = `p.paid_on BETWEEN ? AND ? ${scope.sql}`;
  const params = [from, to, ...scope.params];
  if (grupa) { where += ' AND s.class_id = ?'; params.push(grupa); }
  if (metoda) { where += ' AND p.method = ?'; params.push(metoda); }
  const moje = req.query.moje === '1';
  if (moje) { where += ' AND p.created_by = ?'; params.push(req.user.id); }
  const FROM = `FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN classes c ON c.id = s.class_id`;

  const agg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount), 0) AS total ${FROM} WHERE ${where}`).get(...params);
  const pager = paginate(agg.n, toInt(req.query.strana));
  const payments = db.prepare(`
    SELECT p.*, s.first_name, s.last_name, c.name AS class_name, u.name AS created_by_name,
      b.name AS branch_name, d.name AS department_name, r.number AS receipt_number
    ${FROM}
    LEFT JOIN receipts r ON r.id = p.receipt_id
    LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN departments d ON d.id = s.department_id
    LEFT JOIN users u ON u.id = p.created_by
    WHERE ${where}
    ORDER BY p.paid_on DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, pager.perPage, pager.offset);

  const cf = scopeSql(req.scope, { branch: 'c.branch_id', department: 'c.department_id', teacher: 'c.teacher_id' });
  const classes = db.prepare(`SELECT c.id, c.name FROM classes c WHERE c.active = 1 ${cf.sql} ORDER BY c.name COLLATE NOCASE`).all(...cf.params);

  res.render('payments/list', {
    title: moje ? 'Moje uplate' : 'Uplate', payments, pager, from, to, grupa, metoda, moje, classes, total: agg.total,
    canRecord: canRecord(req.user, res.locals.settings),
  });
});

router.get('/nova', (req, res) => {
  const settings = res.locals.settings;
  if (!canRecord(req.user, settings)) return forbidden(res);
  billing.ensureCharges();
  const scope = scopeSql(req.scope, { branch: 's.branch_id', department: 's.department_id', teacher: 'c.teacher_id' });
  const studentId = toInt(req.query.ucenik);

  if (!studentId) {
    // Pretraga na serveru: s hiljadama učenika prikazuje se najviše 50 pogodaka.
    const q = String(req.query.q || '').trim();
    const now = h.currentPeriod();
    let students = db.prepare(`
      SELECT s.id, s.first_name, s.last_name, s.parent_name, c.name AS class_name,
        b.name AS branch_name, d.name AS department_name
      FROM students s LEFT JOIN classes c ON c.id = s.class_id
      LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN departments d ON d.id = s.department_id
      WHERE (s.left_at IS NULL OR s.left_at >= ?) ${scope.sql}
      ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`).all(now, ...scope.params);
    if (q) {
      const needle = h.fold(q);
      students = students.filter((s) => h.fold(`${s.first_name} ${s.last_name} ${s.last_name} ${s.first_name} ${s.parent_name}`).includes(needle));
    }
    const total = students.length;
    students = students.slice(0, 50);
    const debt = db.prepare('SELECT COALESCE(SUM(MAX(due - paid, 0)), 0) AS d FROM charge_status WHERE student_id = ?');
    for (const s of students) s.debt = debt.get(s.id).d;
    const view = req.query.partial === '1' ? 'payments/pick-list' : 'payments/pick';
    return res.render(view, { title: 'Nova uplata', students, total, q });
  }

  const student = billing.getStudent(studentId);
  if (!student) return notFound(res);
  if (!canAccessStudent(req.user, student)) return forbidden(res);

  res.render('payments/new', {
    title: 'Nova uplata', student, months: payableMonths(student, settings), back: safeBack(req.query.nazad, ''),
    totals: billing.studentTotals(student.id), today: h.todayISO(),
    siblings: siblingsOf(student, req).filter((s) => s.id !== student.id && s.debt > 0),
  });
});

// ---------------------------------------------------------------------------
// Zajednička logika za unos uplata (jedan učenik, porodica, cijela grupa)
// ---------------------------------------------------------------------------

// Mjeseci koje učenik može platiti: neplaćeni iz ranijih godina + ova školska godina (uklj. unaprijed).
function payableMonths(student, settings) {
  const startMonth = Number(settings.school_year_start) || 9;
  const periods = h.schoolYearPeriods(h.schoolYearStart(h.currentPeriod(), startMonth), startMonth);
  const older = billing.openCharges(student.id)
    .filter((c) => c.period < periods[0])
    .map((c) => ({ period: c.period, status: c.status, expected: c.due, paid: c.paid, remaining: c.remaining, future: false }));
  const thisYear = billing.studentMonths(student, periods, settings)
    .filter((m) => m.billable && m.status !== 'waived' && m.status !== 'free' && m.remaining > 0);
  return [...older, ...thisYear];
}

// Braća i sestre: aktivni učenici s istim brojem telefona roditelja (zadnjih 8 cifara), kojima korisnik ima pristup.
function siblingsOf(student, req) {
  const key = h.familyKey(student.phone);
  if (!key) return [];
  const now = h.currentPeriod();
  return db.prepare(`${billing.STUDENT_SQL} WHERE (s.left_at IS NULL OR s.left_at >= ?) ORDER BY s.first_name`).all(now)
    .filter((s) => h.familyKey(s.phone) === key && canAccessStudent(req.user, s))
    .map((s) => ({ ...s, debt: billing.studentTotals(s.id).debt }));
}

// Provjera iznosa: svaki mjesec najviše do preostalog iznosa. Hvata greške u kucanju (1000 umjesto 10,00)
// i dvostruku naplatu istog mjeseca od dvije osobe.
function checkEntries(student, entries, settings) {
  const who = `${student.first_name} ${student.last_name}`;
  for (const e of entries) {
    const label = h.periodLabel(e.period);
    if (Number.isNaN(e.amount) || e.amount <= 0) return `${who}: neispravan iznos za ${label}.`;
    const [m] = billing.studentMonths(student, [e.period], settings);
    if (!m.charge && !m.billable) return `${who}: ${label} se ne naplaćuje.`;
    if (e.amount > m.remaining) {
      return m.remaining > 0
        ? `${who}: za ${label} preostalo je ${h.money(m.remaining, settings.currency)}, a upisano je ${h.money(e.amount, settings.currency)}.`
        : `${who}: ${label} je već plaćen.`;
    }
  }
  return null;
}

function readCommon(req) {
  return {
    paidOn: h.isDate(req.body.paid_on) ? req.body.paid_on : h.todayISO(),
    method: h.METHODS[req.body.method] ? req.body.method : 'gotovina',
    note: String(req.body.note || '').trim(),
  };
}

// Upisuje uplate i izdaje jednu priznanicu za sve njih. groups: [{ student, entries: [{ period, amount }] }]
function recordPayments(user, { groups, paidOn, method, note }) {
  const insert = db.prepare('INSERT INTO payments (student_id, period, amount, paid_on, method, note, created_by, receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  return transaction(() => {
    const first = groups[0].student;
    const receipt = createReceipt(user, {
      paidOn, method, payer: first.parent_name || '', phone: first.phone || '',
      branchId: first.branch_id ?? null, departmentId: first.department_id ?? null,
      lines: groups.flatMap(({ student, entries }) => entries.map((e) => ({
        student_id: student.id, student: `${student.first_name} ${student.last_name}`, class_name: student.class_name || '',
        period: e.period, amount: e.amount,
      }))),
    });
    for (const { student, entries } of groups) {
      for (const e of entries) insert.run(student.id, e.period, e.amount, paidOn, method, note, user.id, receipt.id);
    }
    return receipt;
  });
}

function flashReceipt(req, receipt, text, settings) {
  req.flash('ok', `${text} Priznanica br. ${receipt.number}.`, { href: `/priznanice/${receipt.id}`, label: 'Prikaži priznanicu' });
}

// ---------------------------------------------------------------------------
// Uplata za jednog učenika
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const settings = res.locals.settings;
  if (!canRecord(req.user, settings)) return forbidden(res);
  const student = billing.getStudent(toInt(req.body.student_id));
  if (!student) return notFound(res);
  if (!canAccessStudent(req.user, student)) return forbidden(res);

  const done = safeBack(req.body.back, `/ucenici/${student.id}`);
  const back = `/uplate/nova${h.qs({ ucenik: student.id, nazad: req.body.back })}`;
  const { paidOn, method, note } = readCommon(req);
  const months = [].concat(req.body.months || []).filter(h.isPeriod);

  if (!months.length) {
    req.flash('error', 'Označite barem jedan mjesec za koji se plaća.');
    return res.redirect(back);
  }
  if (paidOn > h.todayISO()) {
    req.flash('error', 'Datum uplate ne može biti u budućnosti.');
    return res.redirect(back);
  }
  const entries = months.map((period) => ({ period, amount: h.parseMoney(req.body[`amount_${period}`]) }));
  const error = checkEntries(student, entries, settings);
  if (error) {
    req.flash('error', error);
    return res.redirect(back);
  }

  const receipt = recordPayments(req.user, { groups: [{ student, entries }], paidOn, method, note });
  const label = entries.map((e) => h.periodShort(e.period)).join(', ');
  flashReceipt(req, receipt, `${student.first_name} ${student.last_name}: uplata ${h.money(receipt.total, settings.currency)} evidentirana (${label}).`, settings);
  res.redirect(done);
});

// ---------------------------------------------------------------------------
// Uplata za porodicu (braća i sestre zajedno, jedna priznanica)
// ---------------------------------------------------------------------------
router.get('/porodica', (req, res) => {
  const settings = res.locals.settings;
  if (!canRecord(req.user, settings)) return forbidden(res);
  billing.ensureCharges();
  const student = billing.getStudent(toInt(req.query.ucenik));
  if (!student) return notFound(res);
  if (!canAccessStudent(req.user, student)) return forbidden(res);
  const children = siblingsOf(student, req).map((s) => ({ ...s, months: payableMonths(s, settings) }));
  if (children.length < 2) return res.redirect(`/uplate/nova${h.qs({ ucenik: student.id })}`);
  res.render('payments/family', { title: 'Uplata za porodicu', student, children, today: h.todayISO(), back: safeBack(req.query.nazad, '') });
});

router.post('/porodica', (req, res) => {
  const settings = res.locals.settings;
  if (!canRecord(req.user, settings)) return forbidden(res);
  const first = billing.getStudent(toInt(req.body.student_id));
  if (!first || !canAccessStudent(req.user, first)) return forbidden(res);
  const back = `/uplate/porodica${h.qs({ ucenik: first.id, nazad: req.body.back })}`;
  const { paidOn, method, note } = readCommon(req);
  if (paidOn > h.todayISO()) {
    req.flash('error', 'Datum uplate ne može biti u budućnosti.');
    return res.redirect(back);
  }
  const allowed = new Map(siblingsOf(first, req).map((s) => [s.id, s]));
  const groups = [];
  for (const id of [].concat(req.body.children || []).map(toInt)) {
    const student = allowed.get(id);
    if (!student) continue;
    const months = [].concat(req.body[`months_${id}`] || []).filter(h.isPeriod);
    if (!months.length) continue;
    const entries = months.map((period) => ({ period, amount: h.parseMoney(req.body[`amount_${id}_${period}`]) }));
    const error = checkEntries(student, entries, settings);
    if (error) {
      req.flash('error', error);
      return res.redirect(back);
    }
    groups.push({ student, entries });
  }
  if (!groups.length) {
    req.flash('error', 'Označite barem jedan mjesec za barem jedno dijete.');
    return res.redirect(back);
  }
  const receipt = recordPayments(req.user, { groups, paidOn, method, note });
  const names = groups.map((g) => g.student.first_name).join(', ');
  flashReceipt(req, receipt, `Porodična uplata ${h.money(receipt.total, settings.currency)} evidentirana (${names}).`, settings);
  res.redirect(safeBack(req.body.back, `/ucenici/${first.id}`));
});

// ---------------------------------------------------------------------------
// Brza naplata cijele grupe za jedan mjesec (profesor na času)
// ---------------------------------------------------------------------------
function loadGroup(req, res) {
  const cls = db.prepare(`SELECT c.*, d.name AS department_name, b.name AS branch_name FROM classes c
    LEFT JOIN departments d ON d.id = c.department_id LEFT JOIN branches b ON b.id = c.branch_id WHERE c.id = ?`).get(toInt(req.params.id));
  if (!cls) { notFound(res); return null; }
  if (!canAccessClass(req.user, cls) || !canRecord(req.user, res.locals.settings)) { forbidden(res); return null; }
  return cls;
}

router.get('/grupa/:id', (req, res) => {
  billing.ensureCharges();
  const cls = loadGroup(req, res);
  if (!cls) return;
  const settings = res.locals.settings;
  const period = h.isPeriod(req.query.mjesec) ? req.query.mjesec : h.currentPeriod();
  const now = h.currentPeriod();
  const students = db.prepare(`${billing.STUDENT_SQL} WHERE s.class_id = ? AND (s.left_at IS NULL OR s.left_at >= ?)
    ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`).all(cls.id, period)
    .map((s) => ({ ...s, month: billing.studentMonths(s, [period], settings)[0] }));
  res.render('payments/group', {
    title: `Brza naplata — ${cls.name}`, cls, period, students, today: h.todayISO(),
    toPay: students.filter((s) => s.month.billable && !['waived', 'free'].includes(s.month.status) && s.month.remaining > 0),
    paid: students.filter((s) => s.month.status === 'paid'),
    prev: h.addMonths(period, -1), next: period < now ? h.addMonths(period, 1) : null,
  });
});

router.post('/grupa/:id', (req, res) => {
  const cls = loadGroup(req, res);
  if (!cls) return;
  const settings = res.locals.settings;
  const period = h.isPeriod(req.body.period) ? req.body.period : h.currentPeriod();
  const back = `/uplate/grupa/${cls.id}${h.qs({ mjesec: period })}`;
  const { paidOn, method } = readCommon(req);
  if (paidOn > h.todayISO()) {
    req.flash('error', 'Datum uplate ne može biti u budućnosti.');
    return res.redirect(back);
  }
  const ids = [].concat(req.body.students || []).map(toInt).filter(Boolean);
  if (!ids.length) {
    req.flash('error', 'Označite učenike koji su platili.');
    return res.redirect(back);
  }
  // Svaki učenik dobija svoju priznanicu (roditelj prima svoju).
  const plans = [];
  for (const id of ids) {
    const student = billing.getStudent(id);
    if (!student || student.class_id !== cls.id) continue;
    const entries = [{ period, amount: h.parseMoney(req.body[`amount_${id}`]) }];
    const error = checkEntries(student, entries, settings);
    if (error) {
      req.flash('error', error);
      return res.redirect(back);
    }
    plans.push({ student, entries });
  }
  let total = 0;
  for (const g of plans) total += recordPayments(req.user, { groups: [g], paidOn, method, note: '' }).total;
  req.flash('ok', `${cls.name}: evidentirano ${plans.length} ${h.plural(plans.length, 'uplata', 'uplate', 'uplata')} za ${h.periodLabel(period)}, ukupno ${h.money(total, settings.currency)}. Svaki učenik je dobio priznanicu.`);
  res.redirect(back);
});

// ---------------------------------------------------------------------------
// Storno
// ---------------------------------------------------------------------------
router.post('/:id/obrisi', requireFinance, (req, res) => {
  const payment = db.prepare('SELECT p.*, u.name AS created_by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?').get(toInt(req.params.id));
  if (!payment) return notFound(res);
  const student = billing.getStudent(payment.student_id);
  if (!canAccessStudent(req.user, student)) return forbidden(res);
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) {
    req.flash('error', 'Upišite razlog storniranja.');
    return res.redirect(safeBack(req.body.back, `/ucenici/${payment.student_id}`));
  }
  const cur = res.locals.settings.currency;
  transaction(() => {
    audit(req.user, 'storno', {
      student, amount: payment.amount,
      details: `${h.periodLabel(payment.period)} · uplata od ${h.formatDate(payment.paid_on)} (${h.METHODS[payment.method] || payment.method}, evidentirao ${payment.created_by_name || '—'}) · razlog: ${reason}`,
    });
    if (payment.receipt_id) markVoided(payment.receipt_id, `stornirano: ${student.first_name} ${h.periodShort(payment.period)} ${h.money(payment.amount, cur)} (${reason})`);
    db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
  });
  req.flash('ok', `Uplata od ${h.money(payment.amount, cur)} za ${h.periodLabel(payment.period)} je stornirana.`);
  res.redirect(safeBack(req.body.back, `/ucenici/${payment.student_id}`));
});

module.exports = router;
