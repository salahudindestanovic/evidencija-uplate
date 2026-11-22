const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'evidencija.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Struktura: grad (branches) -> odjeljenje (departments) -> grupa (classes) -> učenik.
// Iznosi se čuvaju u centima (cijeli broj), mjeseci kao 'YYYY-MM'.
const USERS_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'branch_admin', 'cashier', 'teacher')),
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,          -- grad; NULL samo za glavnog administratora
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,  -- NULL = cijeli grad
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

db.exec(`
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

${USERS_SQL}

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  program TEXT NOT NULL DEFAULT '',
  branch_id INTEGER REFERENCES branches(id),
  department_id INTEGER REFERENCES departments(id),
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  monthly_fee INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  parent_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  branch_id INTEGER REFERENCES branches(id),
  department_id INTEGER REFERENCES departments(id),
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  fee_override INTEGER,            -- NULL = cijena grupe
  transport INTEGER NOT NULL DEFAULT 0,  -- 1 = koristi prevoz (kombi), plaća doplatu
  enrolled_from TEXT NOT NULL,     -- prvi mjesec naplate
  left_at TEXT,                    -- zadnji mjesec naplate (ispis)
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Zaduženje: koliko učenik duguje za određeni mjesec. Iznos, grupa, odjeljenje i grad se
-- zaključavaju u trenutku kreiranja, pa kasnije promjene ne mijenjaju historiju.
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  amount INTEGER NOT NULL,
  waived INTEGER NOT NULL DEFAULT 0,
  class_id INTEGER,
  branch_id INTEGER,
  department_id INTEGER,
  transport INTEGER NOT NULL DEFAULT 0,  -- dio iznosa koji se odnosi na prevoz
  UNIQUE (student_id, period)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  amount INTEGER NOT NULL,
  paid_on TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'gotovina',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Priznanice: nepromjenjiv dokument s rednim brojem po godini (npr. 2026-00042).
-- Stavke se čuvaju kao snimak u trenutku izdavanja; storno uplate označava priznanicu, ne briše je.
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  paid_on TEXT NOT NULL,
  method TEXT NOT NULL,
  payer TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  branch_id INTEGER,
  department_id INTEGER,
  total INTEGER NOT NULL,
  lines TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  void_note TEXT NOT NULL DEFAULT ''
);

-- Dnevnik finansijski osjetljivih promjena (storniranja, izmjene zaduženja i cijena, brisanja).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,          -- lokalno vrijeme 'YYYY-MM-DD HH:MM:SS'
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  student_id INTEGER,
  student_name TEXT NOT NULL DEFAULT '',
  branch_id INTEGER,
  department_id INTEGER,
  amount INTEGER,
  details TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIEW IF NOT EXISTS charge_status AS
SELECT ch.*,
  CASE WHEN ch.waived = 1 THEN 0 ELSE ch.amount END AS due,
  COALESCE((SELECT SUM(p.amount) FROM payments p
            WHERE p.student_id = ch.student_id AND p.period = ch.period), 0) AS paid
FROM charges ch;
`);

// ---- Nadogradnja starijih verzija baze ----
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
for (const table of ['classes', 'students', 'charges']) {
  for (const col of ['branch_id', 'department_id']) {
    if (!columns(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER`);
  }
}
if (!columns('students').includes('transport')) db.exec('ALTER TABLE students ADD COLUMN transport INTEGER NOT NULL DEFAULT 0');
if (!columns('charges').includes('transport')) db.exec('ALTER TABLE charges ADD COLUMN transport INTEGER NOT NULL DEFAULT 0');
if (!columns('payments').includes('receipt_id')) db.exec('ALTER TABLE payments ADD COLUMN receipt_id INTEGER');
// SQLite ne može izmijeniti CHECK, pa se tabela korisnika ponovo kreira kad se dodaju uloge.
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql.includes('cashier')) {
  const keep = columns('users').filter((c) => ['id', 'name', 'username', 'password_hash', 'role', 'branch_id', 'department_id', 'active', 'created_at'].includes(c)).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  // Redoslijed po SQLite uputstvu: nova tabela, kopija, brisanje stare, preimenovanje nove.
  db.exec(USERS_SQL.replace('IF NOT EXISTS users', 'users_new'));
  db.exec(`INSERT INTO users_new (${keep}) SELECT ${keep} FROM users`);
  db.exec('DROP TABLE users');
  db.exec('ALTER TABLE users_new RENAME TO users');
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys = ON');
}
const hasData = db.prepare('SELECT (SELECT COUNT(*) FROM classes) + (SELECT COUNT(*) FROM students) AS n').get().n > 0;
if (hasData && db.prepare('SELECT COUNT(*) AS n FROM branches').get().n === 0) {
  const id = Number(db.prepare("INSERT INTO branches (name) VALUES ('Glavni grad')").run().lastInsertRowid);
  for (const t of ['classes', 'students', 'charges']) db.prepare(`UPDATE ${t} SET branch_id = ? WHERE branch_id IS NULL`).run(id);
  db.prepare("UPDATE users SET branch_id = ? WHERE role <> 'admin' AND branch_id IS NULL").run(id);
}
// Svaki grad bez odjeljenja dobija "Centralno odjeljenje" u koje idu postojeće grupe i učenici.
for (const b of db.prepare('SELECT id FROM branches WHERE id NOT IN (SELECT branch_id FROM departments)').all()) {
  const used = db.prepare('SELECT (SELECT COUNT(*) FROM classes WHERE branch_id = ?) + (SELECT COUNT(*) FROM students WHERE branch_id = ?) AS n').get(b.id, b.id).n;
  if (!used) continue;
  const dep = Number(db.prepare("INSERT INTO departments (branch_id, name) VALUES (?, 'Centralno odjeljenje')").run(b.id).lastInsertRowid);
  for (const t of ['classes', 'students', 'charges']) db.prepare(`UPDATE ${t} SET department_id = ? WHERE branch_id = ? AND department_id IS NULL`).run(dep, b.id);
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_payments_student_period ON payments (student_id, period);
CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments (paid_on);
CREATE INDEX IF NOT EXISTS idx_charges_period ON charges (period, branch_id, department_id);
CREATE INDEX IF NOT EXISTS idx_students_place ON students (branch_id, department_id);
CREATE INDEX IF NOT EXISTS idx_classes_place ON classes (branch_id, department_id);
CREATE INDEX IF NOT EXISTS idx_receipts_year ON receipts (year, seq);
CREATE INDEX IF NOT EXISTS idx_payments_receipt ON payments (receipt_id);
`);

const DEFAULT_SETTINGS = {
  school_name: "Škola Kur'ana",
  currency: '€',
  default_fee: '2500',
  transport_fee: '2500',
  school_year_start: '9',
  non_billable_months: '7,8',
  teachers_can_record: '1',
  teachers_can_edit_students: '1',
  report_place: 'Novom Pazaru',
  phone_prefix: '381',
  reminder_template: "Poštovani/a {roditelj}, podsjećamo da članarina Škole Kur'ana nije plaćena za: {mjeseci}, ukupno {iznos} (učenik: {ucenik}). Hvala na razumijevanju. {skola}",
  report_signer: '',
  report_intro: '',
  demo_mode: '0',
  demo_accounts: '[]',
  session_secret: crypto.randomBytes(32).toString('hex'),
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, getSettings, setSetting, transaction, DATA_DIR };
