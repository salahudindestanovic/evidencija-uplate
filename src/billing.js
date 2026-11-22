const { db, getSettings, transaction } = require('./db');
const h = require('./helpers');
const { scopeSql } = require('./middleware');

const STUDENT_SQL = `
  SELECT s.*, c.monthly_fee AS class_fee, c.name AS class_name, c.program, c.teacher_id,
    b.name AS branch_name, d.name AS department_name
  FROM students s LEFT JOIN classes c ON c.id = s.class_id
  LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN departments d ON d.id = s.department_id`;

const getStudent = (id) => (id == null ? undefined : db.prepare(`${STUDENT_SQL} WHERE s.id = ?`).get(id));

function nonBillable(settings = getSettings()) {
  return new Set(String(settings.non_billable_months || '').split(',').map(Number).filter((n) => n >= 1 && n <= 12));
}

// Standardna mjesečna cijena: cijena grupe + doplata za prevoz (npr. 25 € ili 25 + 25 = 50 €).
function standardFee(student, settings = getSettings()) {
  const base = student.class_fee != null ? student.class_fee : Number(settings.default_fee) || 0;
  return base + (student.transport ? Number(settings.transport_fee) || 0 : 0);
}

// Koliko dijete plaća mjesečno: posebna cijena (popust) je UKUPAN iznos, s prevozom ako ga koristi.
function feeFor(student, settings = getSettings()) {
  return student.fee_override != null ? student.fee_override : standardFee(student, settings);
}

// Dio mjesečnog iznosa koji se odnosi na prevoz (za izvještaje)
function transportFor(student, settings = getSettings()) {
  if (!student.transport) return 0;
  return Math.min(Number(settings.transport_fee) || 0, feeFor(student, settings));
}

// Dug iz ranije (iz svezaka, prije uvođenja sistema). Ne može se smanjiti ispod već uplaćenog.
function openingDebt(studentId) {
  const c = db.prepare('SELECT amount, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE student_id = ? AND period = ?) AS paid FROM charges WHERE student_id = ? AND period = ?')
    .get(studentId, h.OPENING, studentId, h.OPENING);
  return c ? { amount: c.amount, paid: c.paid } : { amount: 0, paid: 0 };
}

function setOpeningDebt(student, amount) {
  const cur = openingDebt(student.id);
  if (amount < cur.paid) return `Dug iz ranije ne može biti manji od već uplaćenog (${h.amount(cur.paid)}).`;
  if (amount === cur.amount) return null;
  if (!amount && !cur.paid) {
    db.prepare('DELETE FROM charges WHERE student_id = ? AND period = ?').run(student.id, h.OPENING);
  } else {
    db.prepare(`INSERT INTO charges (student_id, period, amount, transport, class_id, branch_id, department_id) VALUES (?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT (student_id, period) DO UPDATE SET amount = excluded.amount`)
      .run(student.id, h.OPENING, amount, student.class_id ?? null, student.branch_id ?? null, student.department_id ?? null);
  }
  return null;
}

// Zaduženja se kreiraju automatski za svaki naplatni mjesec od upisa do danas.
// Ponovno se pokreće samo kad se nešto promijeni ili počne novi mjesec.
let dirty = true;
let lastRun = null;
const markDirty = () => { dirty = true; };

function ensureCharges() {
  const now = h.currentPeriod();
  if (!dirty && lastRun === now) return;
  const settings = getSettings();
  const skip = nonBillable(settings);
  const students = db.prepare(STUDENT_SQL).all();
  const insert = db.prepare('INSERT OR IGNORE INTO charges (student_id, period, amount, transport, class_id, branch_id, department_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  transaction(() => {
    for (const s of students) {
      const end = s.left_at && s.left_at < now ? s.left_at : now;
      if (s.enrolled_from > end) continue;
      const fee = feeFor(s, settings);
      const transport = transportFor(s, settings);
      for (const period of h.periodRange(s.enrolled_from, end)) {
        if (!skip.has(h.monthOf(period))) insert.run(s.id, period, fee, transport, s.class_id ?? null, s.branch_id ?? null, s.department_id ?? null);
      }
    }
  });
  dirty = false;
  lastRun = now;
}

// Briše neplaćena zaduženja koja više ne važe (promjena upisa/ispisa ili neplatnih mjeseci).
function pruneCharges(studentId = null) {
  const skip = [...nonBillable()];
  const skipCond = skip.length ? ` OR CAST(substr(c.period, 6, 2) AS INTEGER) IN (${skip.join(',')})` : '';
  const sql = `
    DELETE FROM charges WHERE id IN (
      SELECT c.id FROM charges c JOIN students s ON s.id = c.student_id
      WHERE (c.period < s.enrolled_from OR (s.left_at IS NOT NULL AND c.period > s.left_at)${skipCond})
        AND c.period <> '${h.OPENING}'
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.student_id = c.student_id AND p.period = c.period)
        ${studentId ? 'AND c.student_id = ?' : ''})`;
  if (studentId) db.prepare(sql).run(studentId);
  else db.prepare(sql).run();
  markDirty();
}

// Nova cijena / grupa važi od tekućeg mjeseca za zaduženja koja još nisu plaćena.
function refreshOpenCharges(studentId) {
  const s = getStudent(studentId);
  if (!s) return;
  db.prepare(`
    UPDATE charges SET amount = ?, transport = ?, class_id = ?, branch_id = ?, department_id = ?
    WHERE student_id = ? AND period >= ? AND waived = 0
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.student_id = charges.student_id AND p.period = charges.period)`)
    .run(feeFor(s), transportFor(s), s.class_id ?? null, s.branch_id ?? null, s.department_id ?? null, studentId, h.currentPeriod());
}

// Stanje po mjesecima za jednog učenika.
function studentMonths(student, periods, settings = getSettings()) {
  const from = periods[0];
  const to = periods[periods.length - 1];
  const charges = new Map(db.prepare('SELECT * FROM charges WHERE student_id = ? AND period BETWEEN ? AND ?')
    .all(student.id, from, to).map((c) => [c.period, c]));
  const paid = new Map(db.prepare('SELECT period, SUM(amount) AS total FROM payments WHERE student_id = ? AND period BETWEEN ? AND ? GROUP BY period')
    .all(student.id, from, to).map((r) => [r.period, r.total]));
  const skip = nonBillable(settings);
  const now = h.currentPeriod();
  const fee = feeFor(student, settings);

  return periods.map((period) => {
    const charge = charges.get(period) || null;
    const p = paid.get(period) || 0;
    const due = charge ? (charge.waived ? 0 : charge.amount) : 0;
    const billable = !skip.has(h.monthOf(period)) && period >= student.enrolled_from
      && (!student.left_at || period <= student.left_at);
    const expected = charge ? due : billable ? fee : 0;
    return {
      period, charge, due, paid: p, billable, expected,
      future: period > now,
      remaining: Math.max(expected - p, 0),
      status: h.chargeStatus(charge, p),
    };
  });
}

function studentTotals(studentId) {
  return db.prepare(`
    SELECT COALESCE(SUM(due), 0) AS due,
           COALESCE(SUM(MAX(due - paid, 0)), 0) AS debt,
           (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE student_id = ?) AS paid
    FROM charge_status WHERE student_id = ?`).get(studentId, studentId);
}

function openCharges(studentId) {
  return db.prepare('SELECT * FROM charge_status WHERE student_id = ? AND due > paid ORDER BY period')
    .all(studentId)
    .map((c) => ({ ...c, remaining: c.due - c.paid, status: h.chargeStatus(c, c.paid) }));
}

// Nivo prikaza: sve -> po gradovima, grad -> po odjeljenjima, odjeljenje (ili profesor) -> po grupama.
function levelFor(scope) {
  if (scope.teacherId || scope.departmentId) return 'class';
  return scope.branchId ? 'department' : 'branch';
}

const LEVELS = {
  branch: { name: "COALESCE(b.name, 'Bez grada')", label: 'Grad' },
  department: { name: "COALESCE(d.name, 'Bez odjeljenja')", label: 'Odjeljenje' },
  class: { name: "COALESCE(c.name, 'Bez grupe')", label: 'Grupa' },
};

// Zbir naplate za jedan mjesec ili raspon mjeseci (from..to), grupisan po nivou, u opsegu korisnika.
// Učenik se broji jednom po grupi; "platio" znači da za cijeli period nema otvorenog iznosa.
function summary(period, scope = {}, level = levelFor(scope), to = period) {
  const L = LEVELS[level];
  const keyCol = { branch: 'branch_id', department: 'department_id', class: 'class_id' }[level];
  const f = scopeSql(scope, { branch: 'cs.branch_id', department: 'cs.department_id', teacher: 'c.teacher_id' });
  const rows = db.prepare(`
    WITH st AS (
      SELECT cs.student_id, cs.${keyCol} AS gid,
        MAX(cs.branch_id) AS branch_id, MAX(cs.department_id) AS department_id, MAX(cs.class_id) AS class_id,
        SUM(cs.due) AS due, SUM(cs.paid) AS paid, SUM(MAX(cs.due - cs.paid, 0)) AS rem
      FROM charge_status cs LEFT JOIN classes c ON c.id = cs.class_id
      WHERE cs.period BETWEEN ? AND ? ${f.sql}
      GROUP BY cs.student_id, cs.${keyCol})
    SELECT st.gid AS id, ${L.name} AS name,
      b.name AS branch_name, d.name AS department_name, COALESCE(c.program, '') AS program, u.name AS teacher_name,
      COUNT(*) AS students,
      SUM(st.due) AS due,
      SUM(st.paid) AS paid,
      SUM(st.rem) AS remaining,
      SUM(CASE WHEN st.due > 0 AND st.rem = 0 THEN 1 ELSE 0 END) AS paid_count,
      SUM(CASE WHEN st.rem > 0 THEN 1 ELSE 0 END) AS unpaid_count
    FROM st
    LEFT JOIN branches b ON b.id = st.branch_id
    LEFT JOIN departments d ON d.id = st.department_id
    LEFT JOIN classes c ON c.id = st.class_id
    LEFT JOIN users u ON u.id = c.teacher_id
    GROUP BY st.gid`).all(period, to, ...f.params);
  // Redoslijed kao u izvještajima Škole: gradovi po veličini, "Centralno odjeljenje" prvo, grupe po nazivu (Sufara 2 prije Sufara 10).
  const byName = new Intl.Collator('bs', { numeric: true, sensitivity: 'base' }).compare;
  const central = (r) => (/^Centralno/i.test(r.name) ? 0 : 1);
  rows.sort(level === 'branch' ? (a, b) => b.students - a.students || byName(a.name, b.name)
    : level === 'department' ? (a, b) => byName(a.branch_name || '', b.branch_name || '') || central(a) - central(b) || byName(a.name, b.name)
      : (a, b) => byName(a.branch_name || '', b.branch_name || '') || byName(a.department_name || '', b.department_name || '') || byName(a.name, b.name));

  // Koordinatori uz gradove i odjeljenja
  if (level !== 'class') {
    const col = level === 'branch' ? 'branch_id' : 'department_id';
    const extra = level === 'branch' ? 'AND department_id IS NULL' : '';
    const coords = db.prepare(`SELECT ${col} AS id, GROUP_CONCAT(name, ', ') AS names FROM users
      WHERE role IN ('branch_admin', 'admin') AND active = 1 AND ${col} IS NOT NULL ${extra} GROUP BY ${col}`).all();
    const byId = new Map(coords.map((c) => [c.id, c.names]));
    for (const r of rows) r.coordinators = byId.get(r.id) || '';
  }

  const keys = ['students', 'due', 'paid', 'remaining', 'paid_count', 'unpaid_count'];
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) for (const k of keys) totals[k] += r[k];
  return { rows, totals, level, label: L.label };
}

module.exports = {
  levelFor, summary, STUDENT_SQL, getStudent, nonBillable, feeFor, standardFee, transportFor, openingDebt, setOpeningDebt, markDirty, ensureCharges, pruneCharges,
  refreshOpenCharges, studentMonths, studentTotals, openCharges,
};
