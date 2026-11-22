const { db } = require('./db');

const ACTIONS = {
  storno: 'Storno uplate',
  zaduzenje: 'Izmjena zaduženja',
  cijena: 'Promjena posebne cijene',
  upis: 'Promjena mjeseca upisa',
  brisanje: 'Brisanje učenika',
  uvoz: 'Uvoz učenika',
  grupa: 'Brisanje grupe',
};

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Upisuje promjenu u dnevnik. student daje ime i mjesto (grad/odjeljenje) radi pretrage po opsegu.
function audit(user, action, { student = null, amount = null, details = '', place = null } = {}) {
  const where = student || place;
  db.prepare(`INSERT INTO audit_log (created_at, user_id, user_name, action, student_id, student_name, branch_id, department_id, amount, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    stamp(), user.id, user.name, action,
    student ? student.id : null, student ? `${student.first_name} ${student.last_name}` : '',
    where ? where.branch_id ?? null : null, where ? where.department_id ?? null : null,
    amount, details,
  );
}

module.exports = { audit, ACTIONS, stamp };
