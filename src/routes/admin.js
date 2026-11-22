const express = require('express');
const bcrypt = require('bcryptjs');
const { db, setSetting, transaction } = require('../db');
const h = require('../helpers');
const billing = require('../billing');
const {
  ROLES, requireAdmin, requireManager, isMainAdmin, inUserArea, scopeSql, toInt, forbidden, notFound,
} = require('../middleware');

const router = express.Router();

// Glavni admin dodjeljuje sve uloge; koordinator dodaje profesore i blagajnike u svom gradu/odjeljenju.
const allowedRoles = (user) => (isMainAdmin(user) ? Object.keys(ROLES) : ['teacher', 'cashier']);

function canManageUser(user, target) {
  if (isMainAdmin(user)) return true;
  if (user.role !== 'branch_admin' || !['teacher', 'cashier'].includes(target.role)) return false;
  return inUserArea(user, target);
}

function renderForm(req, res, title, u, error = null) {
  const roles = Object.fromEntries(allowedRoles(req.user).map((k) => [k, ROLES[k]]));
  const deps = res.locals.departments.filter((d) => inUserArea(req.user, { branch_id: d.branch_id, department_id: d.id }));
  res.render('users/form', { title, u, roles, departmentOptions: deps, error });
}

router.get('/korisnici', requireManager, (req, res) => {
  // Korisnik "pripada" odjeljenju ako je vezan za njega, ili gradu ako nije vezan ni za jedno odjeljenje.
  const f = scopeSql(req.scope, { branch: 'u.branch_id' });
  const depFilter = req.scope.departmentId ? ' AND (u.department_id IS NULL OR u.department_id = ?)' : '';
  const users = db.prepare(`
    SELECT u.*, b.name AS branch_name, d.name AS department_name,
      (SELECT GROUP_CONCAT(name, ', ') FROM classes c WHERE c.teacher_id = u.id AND c.active = 1) AS class_names
    FROM users u LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN departments d ON d.id = u.department_id
    WHERE 1 = 1 ${f.sql} ${depFilter} ${isMainAdmin(req.user) && !req.scope.branchId ? '' : "AND u.role <> 'admin'"}
    ORDER BY u.active DESC, CASE u.role WHEN 'admin' THEN 0 WHEN 'branch_admin' THEN 1 WHEN 'cashier' THEN 2 ELSE 3 END,
      b.name COLLATE NOCASE, d.name COLLATE NOCASE, u.name COLLATE NOCASE`).all(...f.params, ...(depFilter ? [req.scope.departmentId] : []))
    .map((u) => ({ ...u, editable: canManageUser(req.user, u) }));
  res.render('users/list', { title: 'Korisnici', users });
});

router.get('/korisnici/novi', requireManager, (req, res) => {
  const role = allowedRoles(req.user).includes(req.query.uloga) ? req.query.uloga : 'teacher';
  renderForm(req, res, 'Novi korisnik', {
    role, active: 1,
    branch_id: isMainAdmin(req.user) ? toInt(req.query.grad) ?? req.scope.branchId : req.user.branch_id,
    department_id: toInt(req.query.odjeljenje) ?? req.user.department_id ?? req.scope.departmentId,
  });
});

function readUser(req, isNew) {
  const body = req.body;
  const d = {
    name: String(body.name || '').trim(),
    username: String(body.username || '').trim(),
    role: allowedRoles(req.user).includes(body.role) ? body.role : 'teacher',
    branch_id: null,
    department_id: null,
    active: body.active === '0' ? 0 : 1,
    password: String(body.password || ''),
  };
  // Mjesto se bira kao 'b<id>' (cijeli grad) ili 'd<id>' (jedno odjeljenje).
  const m = /^([bd])(\d+)$/.exec(String(body.place || ''));
  if (m && m[1] === 'd') {
    const dep = db.prepare('SELECT * FROM departments WHERE id = ?').get(Number(m[2]));
    if (dep) { d.department_id = dep.id; d.branch_id = dep.branch_id; }
  } else if (m) {
    d.branch_id = db.prepare('SELECT id FROM branches WHERE id = ?').get(Number(m[2]))?.id ?? null;
  }
  if (!isMainAdmin(req.user)) {
    // Koordinator ne može dodijeliti mjesto izvan svog područja.
    if (!d.branch_id || !inUserArea(req.user, d)) { d.branch_id = req.user.branch_id; d.department_id = req.user.department_id; }
  }
  // Glavni administrator vidi sve; grad je samo oznaka da je ujedno koordinator tog grada (npr. sekretar škole).
  if (d.role === 'admin') d.department_id = null;
  let error = null;
  if (!d.name || !d.username) error = 'Unesite ime i korisničko ime.';
  else if (!/^[a-zA-Z0-9._-]{3,}$/.test(d.username)) error = 'Korisničko ime: najmanje 3 znaka, slova bez kvačica, brojevi, tačka ili crtica.';
  else if (d.role !== 'admin' && !d.branch_id) error = 'Odaberite grad ili odjeljenje.';
  else if ((isNew || d.password) && d.password.length < 8) error = 'Lozinka mora imati najmanje 8 znakova.';
  return { d, error };
}

router.post('/korisnici', requireManager, (req, res) => {
  const { d, error } = readUser(req, true);
  const taken = !error && db.prepare('SELECT 1 FROM users WHERE username = ?').get(d.username);
  if (error || taken) return renderForm(req, res, 'Novi korisnik', d, error || 'Korisničko ime je zauzeto.');
  db.prepare('INSERT INTO users (name, username, password_hash, role, branch_id, department_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.name, d.username, bcrypt.hashSync(d.password, 10), d.role, d.branch_id, d.department_id);
  req.flash('ok', `Korisnik ${d.name} je dodan. Proslijedite mu korisničko ime i lozinku.`);
  res.redirect('/korisnici');
});

function loadUser(req, res) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(toInt(req.params.id));
  if (!u) { notFound(res); return null; }
  if (!canManageUser(req.user, u)) { forbidden(res); return null; }
  return u;
}

router.get('/korisnici/:id/uredi', requireManager, (req, res) => {
  const u = loadUser(req, res);
  if (u) renderForm(req, res, 'Uredi korisnika', u);
});

router.post('/korisnici/:id', requireManager, (req, res) => {
  const existing = loadUser(req, res);
  if (!existing) return;
  const { d, error: formError } = readUser(req, false);
  let error = formError;
  if (!error && db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(d.username, existing.id)) error = 'Korisničko ime je zauzeto.';
  if (!error && existing.id === req.user.id && (d.role !== existing.role || !d.active)) error = 'Ne možete sebi promijeniti ulogu niti deaktivirati svoj račun.';
  if (error) return renderForm(req, res, 'Uredi korisnika', { ...d, id: existing.id }, error);

  db.prepare('UPDATE users SET name = ?, username = ?, role = ?, branch_id = ?, department_id = ?, active = ? WHERE id = ?')
    .run(d.name, d.username, d.role, d.branch_id, d.department_id, d.active, existing.id);
  if (d.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(d.password, 10), existing.id);
  req.flash('ok', d.password ? 'Korisnik je sačuvan, lozinka je promijenjena.' : 'Korisnik je sačuvan.');
  res.redirect('/korisnici');
});

router.get('/postavke', requireAdmin, (req, res) => {
  res.render('settings', { title: 'Postavke', error: null });
});

router.post('/postavke', requireAdmin, (req, res) => {
  const b = req.body;
  const fee = h.parseMoney(b.default_fee);
  const transportFee = h.parseMoney(b.transport_fee || '0');
  const start = toInt(b.school_year_start);
  const nb = [].concat(b.nb || []).map(Number).filter((n) => n >= 1 && n <= 12).sort((a, c) => a - c);
  let error = null;
  if (!String(b.school_name || '').trim()) error = 'Unesite naziv škole.';
  else if (Number.isNaN(fee)) error = 'Neispravna osnovna članarina.';
  else if (Number.isNaN(transportFee)) error = 'Neispravna doplata za prevoz.';
  else if (!start || start < 1 || start > 12) error = 'Odaberite početni mjesec školske godine.';
  if (error) return res.render('settings', { title: 'Postavke', error });

  const nbChanged = nb.join(',') !== res.locals.settings.non_billable_months;
  setSetting('school_name', b.school_name.trim());
  setSetting('currency', String(b.currency || '').trim() || '€');
  setSetting('default_fee', fee);
  const transportChanged = String(transportFee) !== String(Number(res.locals.settings.transport_fee) || 0);
  setSetting('transport_fee', transportFee);
  setSetting('school_year_start', start);
  setSetting('non_billable_months', nb.join(','));
  setSetting('teachers_can_record', b.teachers_can_record ? '1' : '0');
  setSetting('teachers_can_edit_students', b.teachers_can_edit_students ? '1' : '0');
  setSetting('report_place', String(b.report_place || '').trim());
  setSetting('phone_prefix', String(b.phone_prefix || '').replace(/\D/g, '') || '381');
  if (String(b.reminder_template || '').trim()) setSetting('reminder_template', String(b.reminder_template).trim());
  setSetting('report_signer', String(b.report_signer || '').trim());
  setSetting('report_intro', String(b.report_intro || '').trim());
  if (res.locals.settings.demo_mode === '1' || b.demo_mode) setSetting('demo_mode', b.demo_mode ? '1' : '0');
  if (nbChanged) billing.pruneCharges();
  if (transportChanged) {
    transaction(() => { for (const { id } of db.prepare('SELECT id FROM students WHERE transport = 1').all()) billing.refreshOpenCharges(id); });
  }
  billing.markDirty();
  req.flash('ok', 'Postavke su sačuvane.');
  res.redirect('/postavke');
});

module.exports = router;
