// Datumi uplata se računaju po lokalnom vremenu škole, bez obzira gdje je server.
process.env.TZ = process.env.TZ || 'Europe/Belgrade';

const path = require('node:path');
const express = require('express');
const cookieSession = require('cookie-session');
const { db, getSettings, DATA_DIR } = require('./src/db');
const h = require('./src/helpers');
const { ROLES, isManager, isFinance, isMainAdmin, scopeFor, canRecord, canEditStudents, toInt, safeBack } = require('./src/middleware');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Osnovna sigurnosna zaglavlja
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (process.env.SITE_PASSWORD) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Provjera da server radi (za hosting); ne otkriva ništa i ne traži šifru.
app.get('/zdravlje', (req, res) => res.type('text').send('ok'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource', 'ibm-plex-sans', 'files'), { maxAge: '30d' }));
// Veća granica zbog uvoza učenika iz Excela (nekoliko hiljada redova).
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use(cookieSession({
  name: 'evidencija',
  keys: [process.env.SESSION_SECRET || getSettings().session_secret],
  maxAge: 12 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === '1',
}));

// Šifra za ulaz na cijeli sajt (za javnu demo verziju): postavlja se varijablom SITE_PASSWORD.
// Pamti se u posebnom kolačiću 30 dana, pa odjava i promjena uloge ne traže šifru ponovo.
if (process.env.SITE_PASSWORD) {
  const crypto = require('node:crypto');
  const secret = process.env.SESSION_SECRET || getSettings().session_secret;
  const token = crypto.createHmac('sha256', secret).update(`ulaz:${process.env.SITE_PASSWORD}`).digest('hex');
  const cookieOf = (req, name) => (String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`)) || '').slice(name.length + 1);
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const gatePage = (error) => `<!doctype html><html lang="bs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ulaz — Evidencija naplate</title><link rel="stylesheet" href="/style.css"><meta name="robots" content="noindex"></head><body>
<div class="auth"><div class="auth-box"><div class="auth-brand auth-brand-lg"><div><div class="org">Evidencija naplate</div><div class="org-sub">Demo verzija za pregled</div></div></div>
<div class="panel"><div class="panel-body"><h1>Šifra za ulaz</h1><p class="muted" style="margin-bottom:20px">Unesite šifru koju ste dobili uz link.</p>
${error ? '<div class="notice notice-error"><span>Pogrešna šifra.</span></div>' : ''}
<form method="post" action="/ulaz"><div class="field"><label for="sifra">Šifra</label><input type="password" id="sifra" name="sifra" autofocus required></div>
<div class="field" style="margin-top:20px"><button class="btn btn-primary btn-block">Uđi</button></div></form></div></div></div></div></body></html>`;
  const tries = new Map();
  app.post('/ulaz', (req, res) => {
    const key = req.ip;
    const t = tries.get(key) || { n: 0, at: Date.now() };
    if (Date.now() - t.at > 15 * 60 * 1000) { t.n = 0; t.at = Date.now(); }
    if (t.n >= 10) return res.status(429).send(gatePage(true));
    if (!same(String(req.body.sifra || ''), process.env.SITE_PASSWORD)) {
      t.n += 1; tries.set(key, t);
      return res.status(401).send(gatePage(true));
    }
    tries.delete(key);
    res.cookie('ulaz', token, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/prijava');
  });
  app.use((req, res, next) => {
    if (same(cookieOf(req, 'ulaz'), token)) return next();
    res.status(401).send(gatePage(false));
  });
}

app.use((req, res, next) => {
  res.locals.settings = getSettings();
  res.locals.h = h;
  res.locals.currentPath = req.path;
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) req.session.flash = null;
  req.flash = (type, msg, link = null) => { req.session.flash = { type, msg, link }; };

  const uid = req.session.uid;
  req.user = uid ? db.prepare(`
    SELECT u.id, u.name, u.username, u.role, u.branch_id, u.department_id,
      b.name AS branch_name, d.name AS department_name
    FROM users u LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.id = ? AND u.active = 1`).get(uid) || null : null;
  res.locals.user = req.user;
  res.locals.ROLES = ROLES;
  res.locals.isManager = req.user ? isManager(req.user) : false;
  res.locals.isFinance = req.user ? isFinance(req.user) : false;
  res.locals.canRecordHere = req.user ? canRecord(req.user, res.locals.settings) : false;
  res.locals.canEditStudents = req.user ? canEditStudents(req.user, res.locals.settings) : false;

  if (req.user) {
    const u = req.user;
    // Mjesta koja korisnik smije birati u meniju: admin sve, koordinator grada odjeljenja svog grada.
    const departments = db.prepare(`
      SELECT d.id, d.name, d.branch_id, b.name AS branch_name FROM departments d JOIN branches b ON b.id = d.branch_id
      WHERE d.active = 1 AND b.active = 1 ORDER BY b.name COLLATE NOCASE, d.name COLLATE NOCASE`).all();
    const branches = db.prepare('SELECT id, name FROM branches WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
    const pick = req.session.place || {};
    let selected = {};
    if (isMainAdmin(u)) {
      const dep = departments.find((d) => d.id === pick.d);
      const br = branches.find((b) => b.id === (dep ? dep.branch_id : pick.b));
      selected = { branchId: br?.id || null, departmentId: dep?.id || null };
    } else if (u.role !== 'teacher' && !u.department_id) {
      const dep = departments.find((d) => d.id === pick.d && d.branch_id === u.branch_id);
      selected = { departmentId: dep?.id || null };
    }
    req.scope = scopeFor(u, selected);
    res.locals.scope = req.scope;
    res.locals.branches = branches;
    res.locals.departments = departments;
    res.locals.switchable = isMainAdmin(u)
      ? { branches, departments }
      : (u.role !== 'teacher' && !u.department_id ? { branches: [], departments: departments.filter((d) => d.branch_id === u.branch_id) } : null);

    const branchName = branches.find((b) => b.id === req.scope.branchId)?.name || u.branch_name;
    const depName = departments.find((d) => d.id === req.scope.departmentId)?.name || u.department_name;
    // Kolone "Grad" i "Odjeljenje" se prikazuju samo kad se gleda više mjesta odjednom.
    res.locals.showBranch = !req.scope.branchId && !req.scope.teacherId;
    // Profesor koji predaje u samo jednom odjeljenju ne treba kolonu "Odjeljenje".
    res.locals.showDept = req.scope.teacherId
      ? db.prepare('SELECT COUNT(DISTINCT department_id) AS n FROM classes WHERE teacher_id = ? AND active = 1').get(u.id).n > 1
      : !req.scope.departmentId;
    res.locals.placeLabel = req.scope.teacherId ? 'Moje grupe'
      : !req.scope.branchId ? 'Svi gradovi'
        : req.scope.departmentId ? `${branchName} · ${depName}` : `${branchName} · sva odjeljenja`;
    // "Grad · Odjeljenje", bez ponavljanja kad se zovu isto (npr. Brodarevo · Brodarevo).
    res.locals.placeOf = (r) => [...new Set([res.locals.showBranch ? r.branch_name : null, r.department_name].filter(Boolean))].join(' · ') || '—';
  }

  // Prvo pokretanje: nema korisnika -> kreiranje administratora.
  if (req.path !== '/setup' && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    return res.redirect('/setup');
  }
  next();
});

// Izbor grada/odjeljenja u meniju. Vrijednost: '' (sve), 'b<id>' (grad) ili 'd<id>' (odjeljenje).
app.post('/odabir', (req, res) => {
  if (!req.user) return res.redirect('/prijava');
  const m = /^([bd])(\d+)$/.exec(String(req.body.place || ''));
  req.session.place = m ? { [m[1]]: toInt(m[2]) } : {};
  res.redirect(safeBack(req.body.back, '/'));
});

app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/dashboard'));
app.use('/ucenici/uvoz', require('./src/routes/import'));
app.use('/ucenici', require('./src/routes/students'));
app.use('/grupe', require('./src/routes/classes'));
app.use('/uplate', require('./src/routes/payments'));
app.use('/izvjestaji', require('./src/routes/reports'));
app.use('/gradovi', require('./src/routes/branches'));
app.use('/priznanice', require('./src/routes/receipts'));
app.use('/', require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Nije pronađeno', message: 'Tražena stranica ne postoji.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Greška', message: 'Došlo je do greške. Pokušajte ponovo.' });
});

// Rezervna kopija baze jednom dnevno u data/backups (čuva se posljednjih 30 dana).
function dailyBackup() {
  try {
    const fs = require('node:fs');
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `evidencija-${h.todayISO()}.db`);
    if (!fs.existsSync(file)) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const old = fs.readdirSync(dir).filter((f) => /^evidencija-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -30);
      for (const f of old) fs.unlinkSync(path.join(dir, f));
      console.log(`Rezervna kopija: ${file}`);
    }
  } catch (err) {
    console.error('Rezervna kopija nije uspjela:', err.message);
  }
}
dailyBackup();
setInterval(dailyBackup, 60 * 60 * 1000).unref();

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Evidencija naplate radi na http://localhost:${PORT}`);
  // Adrese za telefone u istoj Wi-Fi mreži (npr. za prezentaciju).
  const lan = Object.values(require('node:os').networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => `http://${a.address}:${PORT}`);
  if (lan.length) console.log(`Na telefonu u istoj Wi-Fi mreži: ${lan.join('  ili  ')}`);
});
