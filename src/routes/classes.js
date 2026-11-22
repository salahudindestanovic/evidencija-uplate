const express = require('express');
const { db, transaction } = require('../db');
const h = require('../helpers');
const billing = require('../billing');
const { audit } = require('../audit');
const {
  requireLogin, requireManager, scopeSql, canAccessClass, inUserArea, isMainAdmin, isManager, canEditStudents, toInt, forbidden, notFound,
} = require('../middleware');

// Grupe prave i uređuju koordinatori, a profesori svoje grupe (ako je u postavkama dozvoljeno upisivanje učenika).
function requireGroupEditor(req, res, next) {
  if (!req.user) return res.redirect('/prijava');
  if (!isManager(req.user) && !canEditStudents(req.user, res.locals.settings)) return forbidden(res);
  next();
}

const router = express.Router();
router.use(requireLogin);

// Profesori koji mogu voditi grupu: profesori i koordinatori iz grada (glavni admin bira iz svih gradova,
// jer neki profesori predaju u više gradova).
function teacherOptions(req) {
  const f = isMainAdmin(req.user) ? { sql: '', params: [] } : scopeSql(req.scope, { branch: 'u.branch_id' });
  return db.prepare(`
    SELECT u.id, u.name, u.role, u.branch_id, b.name AS branch_name
    FROM users u LEFT JOIN branches b ON b.id = u.branch_id
    WHERE u.active = 1 AND u.role IN ('teacher', 'branch_admin') ${f.sql}
    ORDER BY b.name COLLATE NOCASE, u.name COLLATE NOCASE`).all(...f.params);
}

function departmentOptions(req, res) {
  return res.locals.departments.filter((d) => inUserArea(req.user, { branch_id: d.branch_id, department_id: d.id })
    && (!req.scope.branchId || d.branch_id === req.scope.branchId)
    && (!req.scope.departmentId || d.id === req.scope.departmentId));
}
const programs = () => db.prepare("SELECT DISTINCT program FROM classes WHERE program <> '' ORDER BY program").all().map((r) => r.program);

function renderForm(req, res, title, cls, error = null) {
  res.render('classes/form', { title, cls, teachers: teacherOptions(req), departmentOptions: departmentOptions(req, res), programs: programs(), error });
}

router.get('/', (req, res) => {
  const now = h.currentPeriod();
  const f = scopeSql(req.scope, { branch: 'c.branch_id', department: 'c.department_id', teacher: 'c.teacher_id' });
  const showArchived = req.query.arhiva === '1';
  const classes = db.prepare(`
    SELECT c.*, u.name AS teacher_name, b.name AS branch_name, d.name AS department_name,
      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND (s.left_at IS NULL OR s.left_at >= ?)) AS student_count
    FROM classes c LEFT JOIN users u ON u.id = c.teacher_id
    LEFT JOIN branches b ON b.id = c.branch_id LEFT JOIN departments d ON d.id = c.department_id
    WHERE c.active = ? ${f.sql}
    ORDER BY b.name COLLATE NOCASE, d.name COLLATE NOCASE, c.name COLLATE NOCASE`).all(now, showArchived ? 0 : 1, ...f.params);
  res.render('classes/list', { title: 'Grupe', classes, showArchived });
});

function readClass(req, res, existing = null) {
  const body = req.body;
  const d = {
    name: String(body.name || '').trim(),
    program: String(body.program || '').trim(),
    teacher_id: toInt(body.teacher_id),
    department_id: toInt(body.department_id) || req.user.department_id || req.scope.departmentId,
    branch_id: null,
    monthly_fee: h.parseMoney(body.monthly_fee),
    active: body.active === '0' ? 0 : 1,
  };
  // Profesor je uvijek profesor svoje grupe; cijenu određuje koordinator (nova grupa dobija osnovnu cijenu).
  if (!isManager(req.user)) {
    d.teacher_id = req.user.id;
    d.monthly_fee = existing ? existing.monthly_fee : Number(res.locals.settings.default_fee) || 0;
  }
  const dep = d.department_id ? db.prepare('SELECT * FROM departments WHERE id = ?').get(d.department_id) : null;
  if (dep) d.branch_id = dep.branch_id;
  const teacher = d.teacher_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(d.teacher_id) : null;
  let error = null;
  if (!d.name) error = 'Unesite naziv grupe.';
  else if (!dep || !inUserArea(req.user, { branch_id: dep.branch_id, department_id: dep.id })) error = 'Odaberite odjeljenje.';
  else if (isManager(req.user) && d.teacher_id && (!teacher || (!isMainAdmin(req.user) && teacher.branch_id !== d.branch_id))) error = 'Profesor mora biti iz istog grada kao grupa.';
  else if (Number.isNaN(d.monthly_fee)) error = 'Unesite ispravnu mjesečnu članarinu (npr. 10 ili 7,50).';
  return { d, error };
}

function loadClass(req, res) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(toInt(req.params.id));
  if (!cls) { notFound(res); return null; }
  if (!canAccessClass(req.user, cls)) { forbidden(res); return null; }
  return cls;
}

router.get('/nova', requireGroupEditor, (req, res) => {
  // Profesoru je unaprijed odabrano odjeljenje u kojem već predaje.
  const ownDept = isManager(req.user) ? null : db.prepare(`SELECT department_id FROM classes WHERE teacher_id = ? AND active = 1
    GROUP BY department_id ORDER BY COUNT(*) DESC LIMIT 1`).get(req.user.id)?.department_id;
  renderForm(req, res, 'Nova grupa', {
    monthly_fee: Number(res.locals.settings.default_fee) || 0, active: 1, department_id: req.scope.departmentId || ownDept || null,
  });
});

router.post('/', requireGroupEditor, (req, res) => {
  const { d, error } = readClass(req, res);
  if (error) return renderForm(req, res, 'Nova grupa', d, error);
  const info = db.prepare('INSERT INTO classes (name, program, branch_id, department_id, teacher_id, monthly_fee, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(d.name, d.program, d.branch_id, d.department_id, d.teacher_id, d.monthly_fee);
  if (isManager(req.user)) {
    req.flash('ok', `Grupa "${d.name}" je dodana.`);
    return res.redirect('/grupe');
  }
  // Profesor odmah upisuje djecu u novu grupu.
  req.flash('ok', `Grupa "${d.name}" je napravljena. Sada upišite učenike.`);
  res.redirect(`/ucenici${h.qs({ grupa: Number(info.lastInsertRowid) })}`);
});

router.get('/:id/uredi', requireGroupEditor, (req, res) => {
  const cls = loadClass(req, res);
  if (cls) renderForm(req, res, 'Uredi grupu', cls);
});

router.post('/:id', requireGroupEditor, (req, res) => {
  const existing = loadClass(req, res);
  if (!existing) return;
  const { d, error } = readClass(req, res, existing);
  if (error) return renderForm(req, res, 'Uredi grupu', { ...d, id: existing.id }, error);
  transaction(() => {
    db.prepare('UPDATE classes SET name = ?, program = ?, branch_id = ?, department_id = ?, teacher_id = ?, monthly_fee = ?, active = ? WHERE id = ?')
      .run(d.name, d.program, d.branch_id, d.department_id, d.teacher_id, d.monthly_fee, d.active, existing.id);
    // Učenici prate odjeljenje svoje grupe.
    const moved = d.department_id !== existing.department_id;
    if (moved) db.prepare('UPDATE students SET branch_id = ?, department_id = ? WHERE class_id = ?').run(d.branch_id, d.department_id, existing.id);
    if (d.monthly_fee !== existing.monthly_fee || moved) {
      for (const { id } of db.prepare('SELECT id FROM students WHERE class_id = ?').all(existing.id)) billing.refreshOpenCharges(id);
    }
  });
  billing.markDirty();
  req.flash('ok', d.monthly_fee !== existing.monthly_fee
    ? 'Grupa je sačuvana. Nova cijena važi od ovog mjeseca za još neplaćena zaduženja.'
    : 'Grupa je sačuvana.');
  res.redirect('/grupe');
});

// Brisanje grupe: samo prazna grupa (bez ijednog učenika, ni ispisanog). Inače se grupa arhivira.
router.post('/:id/obrisi', requireGroupEditor, (req, res) => {
  const cls = loadClass(req, res);
  if (!cls) return;
  const n = db.prepare('SELECT COUNT(*) AS n FROM students WHERE class_id = ?').get(cls.id).n;
  if (n) {
    req.flash('error', `Grupa "${cls.name}" ima ${n} ${h.plural(n, 'učenika', 'učenika', 'učenika')} i ne može se obrisati. Premjestite ili obrišite učenike, ili arhivirajte grupu.`);
    return res.redirect(`/grupe/${cls.id}/uredi`);
  }
  db.prepare('DELETE FROM classes WHERE id = ?').run(cls.id);
  audit(req.user, 'grupa', { place: cls, details: `${cls.name}${cls.program ? ' · ' + cls.program : ''}` });
  req.flash('ok', `Grupa "${cls.name}" je obrisana.`);
  res.redirect('/grupe');
});

// Cijene i dugovi za cijelu grupu: prevoz, popust (mjesečni iznos) i dug iz ranije — popuni se jednom.
function priceRows(cls) {
  const now = h.currentPeriod();
  return db.prepare(`${billing.STUDENT_SQL} WHERE s.class_id = ? AND (s.left_at IS NULL OR s.left_at >= ?)
    ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`).all(cls.id, now)
    .map((s) => ({ ...s, debt: billing.openingDebt(s.id) }));
}

router.get('/:id/cijene', requireManager, (req, res) => {
  const cls = loadClass(req, res);
  if (!cls) return;
  res.render('classes/prices', { title: `Cijene i dugovi — ${cls.name}`, cls, rows: priceRows(cls), errors: {}, form: null });
});

router.post('/:id/cijene', requireManager, (req, res) => {
  const cls = loadClass(req, res);
  if (!cls) return;
  const rows = priceRows(cls);
  const settings = res.locals.settings;
  const errors = {};
  const changes = rows.map((s) => {
    const feeText = String(req.body[`fee_${s.id}`] ?? '').trim();
    const debtText = String(req.body[`debt_${s.id}`] ?? '').trim();
    const d = {
      transport: req.body[`t_${s.id}`] ? 1 : 0,
      fee_override: feeText ? h.parseMoney(feeText) : null,
      opening_debt: debtText ? h.parseMoney(debtText) : 0,
    };
    if (Number.isNaN(d.fee_override)) errors[s.id] = 'Neispravan mjesečni iznos.';
    else if (Number.isNaN(d.opening_debt)) errors[s.id] = 'Neispravan dug.';
    else if (d.opening_debt < s.debt.paid) errors[s.id] = `Dug ne može biti manji od uplaćenog (${h.amount(s.debt.paid)}).`;
    return { s, d };
  });
  if (Object.keys(errors).length) {
    return res.render('classes/prices', { title: `Cijene i dugovi — ${cls.name}`, cls, rows, errors, form: req.body });
  }
  const cur = settings.currency;
  const money = (v) => (v == null ? 'standardno' : h.money(v, cur));
  let n = 0;
  transaction(() => {
    for (const { s, d } of changes) {
      const feeChanged = (s.fee_override ?? null) !== d.fee_override || (s.transport ? 1 : 0) !== d.transport;
      if (feeChanged) {
        db.prepare('UPDATE students SET transport = ?, fee_override = ? WHERE id = ?').run(d.transport, d.fee_override, s.id);
        billing.refreshOpenCharges(s.id);
        audit(req.user, 'cijena', { student: s, details: `${money(s.fee_override)}${s.transport ? ' s prevozom' : ''} → ${money(d.fee_override)}${d.transport ? ' s prevozom' : ''}` });
      }
      if (d.opening_debt !== s.debt.amount) {
        billing.setOpeningDebt(s, d.opening_debt);
        audit(req.user, 'zaduzenje', { student: s, amount: d.opening_debt, details: `Dug iz ranije: ${h.money(s.debt.amount, cur)} → ${h.money(d.opening_debt, cur)}` });
      }
      if (feeChanged || d.opening_debt !== s.debt.amount) n++;
    }
  });
  billing.markDirty();
  req.flash('ok', n ? `Sačuvano: ${n} ${h.plural(n, 'učenik', 'učenika', 'učenika')} u grupi ${cls.name}.` : 'Nije bilo promjena.');
  res.redirect(`/ucenici${h.qs({ grupa: cls.id })}`);
});

module.exports = router;
