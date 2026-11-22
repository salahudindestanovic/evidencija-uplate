const express = require('express');
const { db, transaction } = require('../db');
const h = require('../helpers');
const billing = require('../billing');
const { requireAdmin, toInt, notFound } = require('../middleware');

const router = express.Router();
router.use(requireAdmin);

const counts = (col, period) => new Map(db.prepare(`
  SELECT x.id,
    (SELECT COUNT(*) FROM departments d WHERE d.${col === 'branch_id' ? 'branch_id = x.id AND d.active = 1' : 'id = x.id'}) AS dept_count,
    (SELECT COUNT(*) FROM classes c WHERE c.${col} = x.id AND c.active = 1) AS class_count,
    (SELECT COUNT(*) FROM students s WHERE s.${col} = x.id AND (s.left_at IS NULL OR s.left_at >= ?)) AS student_count,
    (SELECT COALESCE(SUM(MAX(cs.due - cs.paid, 0)), 0) FROM charge_status cs WHERE cs.${col} = x.id) AS total_debt
  FROM ${col === 'branch_id' ? 'branches' : 'departments'} x`).all(period).map((r) => [r.id, r]));

router.get('/', (req, res) => {
  billing.ensureCharges();
  const period = h.currentPeriod();
  const sums = new Map(billing.summary(period, {}, 'branch').rows.map((r) => [r.id, r]));
  const extra = counts('branch_id', period);
  const cities = db.prepare('SELECT * FROM branches ORDER BY active DESC, name COLLATE NOCASE').all()
    .map((b) => ({ ...b, ...extra.get(b.id), month: sums.get(b.id) || { due: 0, paid: 0 }, coordinators: sums.get(b.id)?.coordinators || '' }));
  const coords = new Map(db.prepare(`SELECT branch_id AS id, GROUP_CONCAT(name, ', ') AS names FROM users
    WHERE role IN ('branch_admin', 'admin') AND active = 1 AND department_id IS NULL GROUP BY branch_id`).all().map((r) => [r.id, r.names]));
  for (const c of cities) c.coordinators = coords.get(c.id) || '';
  res.render('branches/list', { title: 'Gradovi', period, cities });
});

function readPlace(body) {
  const d = { name: String(body.name || '').trim(), address: String(body.address || '').trim(), active: body.active === '0' ? 0 : 1 };
  return { d, error: d.name ? null : 'Unesite naziv.' };
}

router.get('/novi', (req, res) => {
  res.render('branches/form', { title: 'Novi grad', place: { active: 1 }, kind: 'city', error: null });
});

router.post('/', (req, res) => {
  const { d, error } = readPlace(req.body);
  if (error) return res.render('branches/form', { title: 'Novi grad', place: d, kind: 'city', error });
  const id = transaction(() => {
    const bid = Number(db.prepare('INSERT INTO branches (name, address) VALUES (?, ?)').run(d.name, d.address).lastInsertRowid);
    db.prepare("INSERT INTO departments (branch_id, name) VALUES (?, 'Centralno odjeljenje')").run(bid);
    return bid;
  });
  req.flash('ok', `Grad "${d.name}" je dodan s centralnim odjeljenjem. Dodajte ostala odjeljenja i koordinatora.`);
  res.redirect(`/gradovi/${id}`);
});

router.get('/:id', (req, res) => {
  const city = db.prepare('SELECT * FROM branches WHERE id = ?').get(toInt(req.params.id));
  if (!city) return notFound(res);
  billing.ensureCharges();
  const period = h.currentPeriod();
  const sums = new Map(billing.summary(period, { branchId: city.id }, 'department').rows.map((r) => [r.id, r]));
  const extra = counts('department_id', period);
  const coords = new Map(db.prepare(`SELECT department_id AS id, GROUP_CONCAT(name, ', ') AS names FROM users
    WHERE role = 'branch_admin' AND active = 1 AND department_id IS NOT NULL GROUP BY department_id`).all().map((r) => [r.id, r.names]));
  const departments = db.prepare('SELECT * FROM departments WHERE branch_id = ? ORDER BY active DESC, name COLLATE NOCASE').all(city.id)
    .map((d) => ({ ...d, ...extra.get(d.id), month: sums.get(d.id) || { due: 0, paid: 0 }, coordinators: coords.get(d.id) || '' }));
  const cityCoordinators = db.prepare(`SELECT id, name FROM users WHERE role IN ('branch_admin', 'admin') AND active = 1
    AND branch_id = ? AND department_id IS NULL ORDER BY name`).all(city.id);
  res.render('branches/show', { title: city.name, city, departments, cityCoordinators, period });
});

router.get('/:id/uredi', (req, res) => {
  const place = db.prepare('SELECT * FROM branches WHERE id = ?').get(toInt(req.params.id));
  if (!place) return notFound(res);
  res.render('branches/form', { title: 'Uredi grad', place, kind: 'city', error: null });
});

router.post('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM branches WHERE id = ?').get(toInt(req.params.id));
  if (!existing) return notFound(res);
  const { d, error } = readPlace(req.body);
  if (error) return res.render('branches/form', { title: 'Uredi grad', place: { ...d, id: existing.id }, kind: 'city', error });
  db.prepare('UPDATE branches SET name = ?, address = ?, active = ? WHERE id = ?').run(d.name, d.address, d.active, existing.id);
  req.flash('ok', 'Grad je sačuvan.');
  res.redirect(`/gradovi/${existing.id}`);
});

// ---- Odjeljenja ----

router.get('/:id/odjeljenja/novo', (req, res) => {
  const city = db.prepare('SELECT * FROM branches WHERE id = ?').get(toInt(req.params.id));
  if (!city) return notFound(res);
  res.render('branches/form', { title: 'Novo odjeljenje', place: { active: 1, branch_id: city.id }, city, kind: 'department', error: null });
});

router.post('/:id/odjeljenja', (req, res) => {
  const city = db.prepare('SELECT * FROM branches WHERE id = ?').get(toInt(req.params.id));
  if (!city) return notFound(res);
  const { d, error } = readPlace(req.body);
  if (error) return res.render('branches/form', { title: 'Novo odjeljenje', place: { ...d, branch_id: city.id }, city, kind: 'department', error });
  db.prepare('INSERT INTO departments (branch_id, name, address) VALUES (?, ?, ?)').run(city.id, d.name, d.address);
  req.flash('ok', `Odjeljenje "${d.name}" je dodano.`);
  res.redirect(`/gradovi/${city.id}`);
});

router.get('/odjeljenja/:id/uredi', (req, res) => {
  const place = db.prepare('SELECT * FROM departments WHERE id = ?').get(toInt(req.params.id));
  if (!place) return notFound(res);
  const city = db.prepare('SELECT * FROM branches WHERE id = ?').get(place.branch_id);
  res.render('branches/form', { title: 'Uredi odjeljenje', place, city, kind: 'department', error: null });
});

router.post('/odjeljenja/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM departments WHERE id = ?').get(toInt(req.params.id));
  if (!existing) return notFound(res);
  const city = db.prepare('SELECT * FROM branches WHERE id = ?').get(existing.branch_id);
  const { d, error } = readPlace(req.body);
  if (error) return res.render('branches/form', { title: 'Uredi odjeljenje', place: { ...d, id: existing.id, branch_id: city.id }, city, kind: 'department', error });
  db.prepare('UPDATE departments SET name = ?, address = ?, active = ? WHERE id = ?').run(d.name, d.address, d.active, existing.id);
  req.flash('ok', 'Odjeljenje je sačuvano.');
  res.redirect(`/gradovi/${city.id}`);
});

module.exports = router;
