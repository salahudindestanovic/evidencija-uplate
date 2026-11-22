const express = require('express');
const { db } = require('../db');
const h = require('../helpers');
const billing = require('../billing');
const { audit } = require('../audit');
const {
  requireLogin, requireManager, scopeSql, canAccessStudent, canAccessClass, canRecord, canEditStudents, isManager, inUserArea,
  toInt, paginate, safeBack, forbidden, notFound,
} = require('../middleware');

const router = express.Router();
router.use(requireLogin);

const FILTERS = {
  aktivni: 'Aktivni',
  neplaceno: 'Nisu platili ovaj mjesec',
  duguju: 'Imaju dug',
  ispisani: 'Ispisani',
  svi: 'Svi',
};

// Grupe koje korisnik smije vidjeti/birati (u odabranom gradu).
function classOptions(req) {
  const f = scopeSql(req.scope, { branch: 'c.branch_id', department: 'c.department_id', teacher: 'c.teacher_id' });
  return db.prepare(`
    SELECT c.id, c.name, c.program, c.monthly_fee, c.branch_id, c.department_id, b.name AS branch_name, d.name AS department_name
    FROM classes c LEFT JOIN branches b ON b.id = c.branch_id LEFT JOIN departments d ON d.id = c.department_id
    WHERE c.active = 1 ${f.sql}
    ORDER BY b.name COLLATE NOCASE, d.name COLLATE NOCASE, c.name COLLATE NOCASE`).all(...f.params);
}

// Odjeljenja u koja korisnik smije upisivati učenike.
function departmentOptions(req, res) {
  return res.locals.departments.filter((d) => inUserArea(req.user, { branch_id: d.branch_id, department_id: d.id })
    && (!req.scope.branchId || d.branch_id === req.scope.branchId)
    && (!req.scope.departmentId || d.id === req.scope.departmentId));
}

router.get('/', (req, res) => {
  billing.ensureCharges();
  const now = h.currentPeriod();
  const q = String(req.query.q || '').trim();
  const grupa = toInt(req.query.grupa);
  const filter = FILTERS[req.query.filter] ? req.query.filter : 'aktivni';
  const scope = scopeSql(req.scope, { branch: 's.branch_id', department: 's.department_id', teacher: 'c.teacher_id' });

  let extra = '';
  const params = [];
  if (grupa) { extra += ' AND s.class_id = ?'; params.push(grupa); }
  if (filter === 'ispisani') { extra += ' AND s.left_at IS NOT NULL AND s.left_at < ?'; params.push(now); }
  else if (filter !== 'svi') { extra += ' AND (s.left_at IS NULL OR s.left_at >= ?)'; params.push(now); }

  let students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.parent_name, s.phone, s.left_at,
      c.name AS class_name, b.name AS branch_name, d.name AS department_name,
      ch.id AS cur_id, ch.amount AS cur_amount, ch.waived AS cur_waived,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.student_id = s.id AND p.period = ?), 0) AS cur_paid,
      COALESCE((SELECT SUM(MAX(cs.due - cs.paid, 0)) FROM charge_status cs WHERE cs.student_id = s.id), 0) AS debt
    FROM students s
    LEFT JOIN classes c ON c.id = s.class_id
    LEFT JOIN branches b ON b.id = s.branch_id
    LEFT JOIN departments d ON d.id = s.department_id
    LEFT JOIN charges ch ON ch.student_id = s.id AND ch.period = ?
    WHERE 1 = 1 ${scope.sql} ${extra}
    ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`)
    .all(now, now, ...scope.params, ...params)
    .map((s) => ({
      ...s,
      cur_status: h.chargeStatus(s.cur_id ? { amount: s.cur_amount, waived: s.cur_waived } : null, s.cur_paid),
    }));

  if (filter === 'duguju') students = students.filter((s) => s.debt > 0);
  if (filter === 'neplaceno') students = students.filter((s) => s.cur_status === 'unpaid' || s.cur_status === 'partial');
  if (q) {
    const needle = h.fold(q);
    students = students.filter((s) => h.fold(`${s.first_name} ${s.last_name} ${s.last_name} ${s.first_name} ${s.parent_name} ${s.phone}`).includes(needle));
  }

  const pager = paginate(students.length, toInt(req.query.strana));
  res.render('students/list', {
    title: 'Učenici', students: students.slice(pager.offset, pager.offset + pager.perPage), pager,
    q, grupa, filter, FILTERS, classes: classOptions(req), period: now, canRecord: canRecord(req.user, res.locals.settings),
    totalDebt: students.reduce((t, s) => t + s.debt, 0),
  });
});

// Upis i uređivanje učenika: koordinatori, a profesori samo u svojim grupama (ako je uključeno u postavkama).
function requireStudentEditor(req, res, next) {
  if (!req.user) return res.redirect('/prijava');
  if (!canEditStudents(req.user, res.locals.settings)) return forbidden(res);
  next();
}

// Čita formu; grad učenika se određuje iz grupe, a bez grupe iz grada korisnika.
// Profesor ne mijenja novčane podatke: posebnu cijenu i (kod postojećeg učenika) mjesec od kojeg se naplaćuje.
function readStudent(req, existing = null) {
  const body = req.body;
  const fee = String(body.fee_override || '').trim();
  const d = {
    first_name: String(body.first_name || '').trim(),
    last_name: String(body.last_name || '').trim(),
    parent_name: String(body.parent_name || '').trim(),
    phone: String(body.phone || '').trim(),
    note: String(body.note || '').trim(),
    class_id: toInt(body.class_id),
    branch_id: null,
    department_id: null,
    fee_override: fee ? h.parseMoney(fee) : null,
    transport: body.transport ? 1 : 0,
    opening_debt: String(body.opening_debt || '').trim() ? h.parseMoney(body.opening_debt) : 0,
    enrolled_from: String(body.enrolled_from || '').trim(),
    left_at: String(body.left_at || '').trim() || null,
  };
  const teacher = !isManager(req.user);
  if (teacher) {
    d.fee_override = existing ? existing.fee_override : null;
    d.transport = existing ? existing.transport : 0;
    d.opening_debt = existing ? billing.openingDebt(existing.id).amount : 0;
    if (existing) d.enrolled_from = existing.enrolled_from;
  }
  let error = null;
  const cls = d.class_id ? db.prepare('SELECT * FROM classes WHERE id = ?').get(d.class_id) : null;
  // Učenik pripada odjeljenju svoje grupe; bez grupe se odjeljenje bira ručno.
  const depId = cls ? cls.department_id : (toInt(body.department_id) || req.user.department_id || req.scope.departmentId);
  const dep = depId ? db.prepare('SELECT * FROM departments WHERE id = ?').get(depId) : null;
  // Profesor smije upisati u odjeljenje svoje grupe (i kad predaje u drugom gradu).
  if (dep && ((teacher && cls && canAccessClass(req.user, cls)) || inUserArea(req.user, { branch_id: dep.branch_id, department_id: dep.id }))) {
    d.department_id = dep.id;
    d.branch_id = dep.branch_id;
  }

  if (!d.first_name || !d.last_name) error = 'Unesite ime i prezime učenika.';
  else if (teacher && !d.class_id) error = 'Odaberite grupu.';
  else if (d.class_id && (!cls || !canAccessClass(req.user, cls))) error = 'Odabrana grupa ne postoji.';
  else if (!d.department_id) error = 'Odaberite grupu ili odjeljenje učenika.';
  else if (!h.isPeriod(d.enrolled_from)) error = 'Unesite mjesec od kojeg se naplaćuje članarina.';
  else if (d.left_at && !h.isPeriod(d.left_at)) error = 'Neispravan mjesec ispisa.';
  else if (d.left_at && d.left_at < d.enrolled_from) error = 'Mjesec ispisa ne može biti prije mjeseca upisa.';
  else if (Number.isNaN(d.fee_override)) error = 'Neispravan mjesečni iznos (npr. 25 ili 20,50).';
  else if (Number.isNaN(d.opening_debt)) error = 'Neispravan iznos duga iz ranije.';
  else if (existing && d.opening_debt < billing.openingDebt(existing.id).paid) error = `Dug iz ranije ne može biti manji od već uplaćenog (${h.amount(billing.openingDebt(existing.id).paid)}).`;
  return { d, error };
}

function renderForm(req, res, title, student, error = null) {
  res.render('students/form', { title, student, classes: classOptions(req), departmentOptions: departmentOptions(req, res), error });
}

function loadStudent(req, res) {
  const student = billing.getStudent(toInt(req.params.id));
  if (!student) { notFound(res); return null; }
  if (!canAccessStudent(req.user, student)) { forbidden(res); return null; }
  return student;
}

router.get('/novi', requireStudentEditor, (req, res) => {
  renderForm(req, res, 'Novi učenik', { enrolled_from: h.currentPeriod(), class_id: toInt(req.query.grupa), department_id: req.scope.departmentId });
});

router.post('/', requireStudentEditor, (req, res) => {
  const { d, error } = readStudent(req);
  if (error) return renderForm(req, res, 'Novi učenik', d, error);
  const info = db.prepare(`
    INSERT INTO students (first_name, last_name, parent_name, phone, note, branch_id, department_id, class_id, fee_override, transport, enrolled_from, left_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.first_name, d.last_name, d.parent_name, d.phone, d.note, d.branch_id, d.department_id, d.class_id, d.fee_override, d.transport, d.enrolled_from, d.left_at);
  if (d.opening_debt) billing.setOpeningDebt({ ...d, id: Number(info.lastInsertRowid) }, d.opening_debt);
  billing.markDirty();
  req.flash('ok', `Učenik ${d.first_name} ${d.last_name} je upisan.`);
  if (req.body.again) return res.redirect(`/ucenici/novi${h.qs({ grupa: d.class_id })}`);
  // Profesor se vraća na spisak svoje grupe; koordinator na karticu učenika.
  res.redirect(isManager(req.user) ? `/ucenici/${info.lastInsertRowid}` : `/ucenici${h.qs({ grupa: d.class_id })}`);
});

router.get('/:id', (req, res) => {
  billing.ensureCharges();
  const student = loadStudent(req, res);
  if (!student) return;

  const settings = res.locals.settings;
  const startMonth = Number(settings.school_year_start) || 9;
  const currentYear = h.schoolYearStart(h.currentPeriod(), startMonth);
  const year = toInt(req.query.godina) ?? currentYear;
  const periods = h.schoolYearPeriods(year, startMonth);

  const payments = db.prepare(`
    SELECT p.*, u.name AS created_by_name, r.number AS receipt_number FROM payments p
    LEFT JOIN users u ON u.id = p.created_by LEFT JOIN receipts r ON r.id = p.receipt_id
    WHERE p.student_id = ? ORDER BY p.paid_on DESC, p.id DESC`).all(student.id);

  res.render('students/show', {
    title: `${student.first_name} ${student.last_name}`,
    student, year, currentYear, startMonth,
    months: billing.studentMonths(student, periods, settings),
    totals: billing.studentTotals(student.id),
    olderOpen: billing.openCharges(student.id).filter((c) => c.period < periods[0]),
    fee: billing.feeFor(student, settings),
    payments,
    canRecord: canRecord(req.user, settings),
  });
});

// Podsjetnik roditelju: gotova poruka za WhatsApp, Viber ili SMS.
router.get('/:id/podsjetnik', (req, res) => {
  billing.ensureCharges();
  const student = loadStudent(req, res);
  if (!student) return;
  const settings = res.locals.settings;
  const open = billing.openCharges(student.id);
  const total = open.reduce((t, c) => t + c.remaining, 0);
  // Mjeseci malim slovom, jer stoje usred rečenice ("nije plaćena za: januar 2026, oktobar 2026").
  const months = open.map((c) => (h.isOpening(c.period) ? 'dug iz ranije' : `${h.MONTH_NAMES[h.monthOf(c.period) - 1].toLowerCase()} ${c.period.slice(0, 4)}`)).join(', ');
  const fill = (tpl) => String(tpl || '')
    .replace(/\{roditelj\}/g, student.parent_name || 'roditelju')
    .replace(/\{ucenik\}/g, `${student.first_name} ${student.last_name}`)
    .replace(/\{mjeseci\}/g, months || '—')
    .replace(/\{iznos\}/g, h.money(total, settings.currency))
    .replace(/\{skola\}/g, settings.school_name);
  res.render('students/reminder', {
    title: 'Podsjetnik roditelju', student, open, total,
    text: fill(settings.reminder_template), phone: h.intlPhone(student.phone, settings.phone_prefix),
    back: safeBack(req.query.nazad, `/ucenici/${student.id}`),
  });
});

router.get('/:id/uredi', requireStudentEditor, (req, res) => {
  const student = loadStudent(req, res);
  if (student) renderForm(req, res, 'Uredi učenika', { ...student, opening_debt: billing.openingDebt(student.id).amount });
});

router.post('/:id', requireStudentEditor, (req, res) => {
  const existing = loadStudent(req, res);
  if (!existing) return;
  const { d, error } = readStudent(req, existing);
  if (error) return renderForm(req, res, 'Uredi učenika', { ...d, id: existing.id }, error);
  db.prepare(`
    UPDATE students SET first_name = ?, last_name = ?, parent_name = ?, phone = ?, note = ?, branch_id = ?, department_id = ?, class_id = ?,
      fee_override = ?, transport = ?, enrolled_from = ?, left_at = ? WHERE id = ?`)
    .run(d.first_name, d.last_name, d.parent_name, d.phone, d.note, d.branch_id, d.department_id, d.class_id, d.fee_override, d.transport, d.enrolled_from, d.left_at, existing.id);
  const cur = res.locals.settings.currency;
  const feeLabel = (v) => (v == null ? 'standardno' : h.money(v, cur));
  if ((existing.fee_override ?? null) !== (d.fee_override ?? null)) {
    audit(req.user, 'cijena', { student: { ...existing, ...d }, details: `${feeLabel(existing.fee_override)} → ${feeLabel(d.fee_override)}` });
  }
  if ((existing.transport ? 1 : 0) !== d.transport) {
    audit(req.user, 'cijena', { student: { ...existing, ...d }, details: `Prevoz: ${existing.transport ? 'da' : 'ne'} → ${d.transport ? 'da' : 'ne'}` });
  }
  const prevDebt = billing.openingDebt(existing.id).amount;
  if (prevDebt !== d.opening_debt) {
    billing.setOpeningDebt({ ...existing, ...d }, d.opening_debt);
    audit(req.user, 'zaduzenje', { student: { ...existing, ...d }, amount: d.opening_debt, details: `Dug iz ranije: ${h.money(prevDebt, cur)} → ${h.money(d.opening_debt, cur)}` });
  }
  if (existing.enrolled_from !== d.enrolled_from) {
    audit(req.user, 'upis', { student: { ...existing, ...d }, details: `Naplata od: ${h.periodLabel(existing.enrolled_from)} → ${h.periodLabel(d.enrolled_from)}` });
  }
  billing.pruneCharges(existing.id);
  billing.refreshOpenCharges(existing.id);
  billing.markDirty();
  req.flash('ok', 'Podaci učenika su sačuvani.');
  res.redirect(`/ucenici/${existing.id}`);
});

router.post('/:id/obrisi', requireStudentEditor, (req, res) => {
  const student = loadStudent(req, res);
  if (!student) return;
  if (db.prepare('SELECT 1 FROM payments WHERE student_id = ? LIMIT 1').get(student.id)) {
    req.flash('error', 'Učenik ima evidentirane uplate i ne može se obrisati. Umjesto toga unesite mjesec ispisa.');
    return res.redirect(`/ucenici/${student.id}`);
  }
  audit(req.user, 'brisanje', { student, details: `${student.class_name || 'Bez grupe'} · naplata od ${h.periodLabel(student.enrolled_from)}` });
  db.prepare('DELETE FROM students WHERE id = ?').run(student.id);
  req.flash('ok', `Učenik ${student.first_name} ${student.last_name} je obrisan.`);
  res.redirect('/ucenici');
});

// Izmjena zaduženja za jedan mjesec: drugi iznos ili oslobađanje.
router.post('/:id/zaduzenje', requireManager, (req, res) => {
  const student = loadStudent(req, res);
  if (!student) return;
  const charge = db.prepare('SELECT * FROM charges WHERE student_id = ? AND period = ?').get(student.id, req.body.period);
  if (!charge) return notFound(res);
  const back = `/ucenici/${student.id}${h.qs({ godina: req.body.godina })}`;
  const amount = h.parseMoney(req.body.amount);
  if (Number.isNaN(amount)) {
    req.flash('error', 'Neispravan iznos zaduženja.');
    return res.redirect(back);
  }
  const waived = req.body.waive ? 1 : 0;
  if (amount !== charge.amount || waived !== charge.waived) {
    const cur = res.locals.settings.currency;
    const label = (a, w) => (w ? `oslobođen (${h.money(a, cur)})` : h.money(a, cur));
    audit(req.user, 'zaduzenje', {
      student, amount,
      details: `${h.periodLabel(charge.period)}: ${label(charge.amount, charge.waived)} → ${label(amount, waived)}`,
    });
  }
  db.prepare('UPDATE charges SET amount = ?, waived = ? WHERE id = ?').run(amount, waived, charge.id);
  req.flash('ok', waived
    ? `${h.periodLabel(charge.period)}: učenik je oslobođen plaćanja.`
    : `${h.periodLabel(charge.period)}: zaduženje iznosi ${h.money(amount, res.locals.settings.currency)}.`);
  res.redirect(back);
});

module.exports = router;
