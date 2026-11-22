const express = require('express');
const bcrypt = require('bcryptjs');
const { db, setSetting } = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

router.get('/setup', (req, res) => {
  if (userCount() > 0) return res.redirect('/prijava');
  res.render('setup', { title: 'Početno podešavanje', error: null, form: {} });
});

router.post('/setup', (req, res) => {
  if (userCount() > 0) return res.redirect('/prijava');
  const { name = '', username = '', password = '', password2 = '', school_name = '', city = '' } = req.body;
  let error = null;
  if (!city.trim()) error = 'Unesite naziv prvog grada.';
  else if (!name.trim() || !username.trim()) error = 'Unesite ime i korisničko ime.';
  else if (password.length < 8) error = 'Lozinka mora imati najmanje 8 znakova.';
  else if (password !== password2) error = 'Lozinke se ne podudaraju.';
  if (error) return res.render('setup', { title: 'Početno podešavanje', error, form: req.body });

  if (school_name.trim()) setSetting('school_name', school_name.trim());
  const cityId = Number(db.prepare('INSERT INTO branches (name) VALUES (?)').run(city.trim()).lastInsertRowid);
  db.prepare("INSERT INTO departments (branch_id, name) VALUES (?, 'Centralno odjeljenje')").run(cityId);
  const info = db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name.trim(), username.trim(), bcrypt.hashSync(password, 10), 'admin');
  req.session.uid = Number(info.lastInsertRowid);
  req.flash('ok', 'Račun je kreiran. Dodajte ostale gradove, zatim administratore gradova.');
  res.redirect('/gradovi');
});

// Demo režim (samo demo baza): na stranici za prijavu su ponuđene uloge za prijavu jednim klikom,
// da se sistem može pokazati bez kucanja lozinki. Uključuje ga `npm run demo`, isključuje se u postavkama.
function demoAccounts(settings) {
  if (settings.demo_mode !== '1') return [];
  let list = [];
  try { list = JSON.parse(settings.demo_accounts || '[]'); } catch { return []; }
  const find = db.prepare(`
    SELECT u.id, u.name, b.name AS branch_name, d.name AS department_name FROM users u
    LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.username = ? AND u.active = 1`);
  return list.map((a) => ({ ...a, user: find.get(a.username) })).filter((a) => a.user);
}

const renderLogin = (res, status, error, username) =>
  res.status(status).render('login', { title: 'Prijava', error, username, demo: demoAccounts(res.locals.settings) });

router.get('/prijava', (req, res) => {
  if (req.user) return res.redirect('/');
  renderLogin(res, 200, null, '');
});

router.post('/demo-prijava', (req, res) => {
  const account = demoAccounts(res.locals.settings).find((a) => a.username === String(req.body.username || ''));
  if (!account) return res.redirect('/prijava');
  req.session.uid = account.user.id;
  req.session.place = null;
  res.redirect('/');
});

// Zaštita od pogađanja lozinke: nakon 8 pogrešnih pokušaja (po korisniku i IP adresi) pauza od 15 minuta.
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

router.post('/prijava', (req, res) => {
  const { username = '', password = '' } = req.body;
  const key = `${req.ip}|${username.trim().toLowerCase()}`;
  const now = Date.now();
  const a = attempts.get(key);
  if (a && now - a.first < WINDOW && a.count >= MAX_ATTEMPTS) {
    const min = Math.ceil((WINDOW - (now - a.first)) / 60000);
    return renderLogin(res, 429, `Previše neuspjelih pokušaja. Pokušajte ponovo za ${min} min.`, username);
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const cur = a && now - a.first < WINDOW ? a : { first: now, count: 0 };
    cur.count += 1;
    attempts.set(key, cur);
    if (attempts.size > 5000) for (const [k, v] of attempts) if (now - v.first > WINDOW) attempts.delete(k);
    return renderLogin(res, 401, 'Pogrešno korisničko ime ili lozinka.', username);
  }
  attempts.delete(key);
  req.session.uid = user.id;
  res.redirect('/');
});

router.post('/odjava', (req, res) => {
  req.session = null;
  res.redirect('/prijava');
});

router.get('/profil', requireLogin, (req, res) => {
  res.render('profile', { title: 'Moj profil', error: null });
});

router.post('/profil', requireLogin, (req, res) => {
  const { current = '', password = '', password2 = '' } = req.body;
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  let error = null;
  if (!bcrypt.compareSync(current, user.password_hash)) error = 'Trenutna lozinka nije tačna.';
  else if (password.length < 8) error = 'Nova lozinka mora imati najmanje 8 znakova.';
  else if (password !== password2) error = 'Lozinke se ne podudaraju.';
  if (error) return res.render('profile', { title: 'Moj profil', error });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.user.id);
  req.flash('ok', 'Lozinka je promijenjena.');
  res.redirect('/profil');
});

module.exports = router;
