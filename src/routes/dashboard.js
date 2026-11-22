const express = require('express');
const { db } = require('../db');
const h = require('../helpers');
const { ensureCharges, summary } = require('../billing');
const { requireLogin, scopeSql, canRecord } = require('../middleware');

const router = express.Router();

const PLACE_JOINS = 'LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN departments d ON d.id = s.department_id';

router.get('/', requireLogin, (req, res) => {
  ensureCharges();
  const period = h.currentPeriod();
  const byStudent = scopeSql(req.scope, { branch: 's.branch_id', department: 's.department_id', teacher: 'c.teacher_id' });
  // Tabela ide jedan nivo niže od odabranog: sve -> gradovi, grad -> odjeljenja, odjeljenje -> grupe.
  const breakdown = summary(period, req.scope);

  const totalDebt = db.prepare(`
    SELECT COALESCE(SUM(MAX(cs.due - cs.paid, 0)), 0) AS debt
    FROM charge_status cs JOIN students s ON s.id = cs.student_id LEFT JOIN classes c ON c.id = s.class_id
    WHERE 1 = 1 ${byStudent.sql}`).get(...byStudent.params).debt;

  const cashThisMonth = db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS total, COUNT(*) AS n
    FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN classes c ON c.id = s.class_id
    WHERE substr(p.paid_on, 1, 7) = ? ${byStudent.sql}`).get(period, ...byStudent.params);

  const recent = db.prepare(`
    SELECT p.*, s.first_name, s.last_name, u.name AS created_by_name, b.name AS branch_name, d.name AS department_name
    FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN classes c ON c.id = s.class_id
    LEFT JOIN users u ON u.id = p.created_by ${PLACE_JOINS}
    WHERE 1 = 1 ${byStudent.sql}
    ORDER BY p.paid_on DESC, p.id DESC LIMIT 8`).all(...byStudent.params);

  const topDebtors = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, c.name AS class_name, b.name AS branch_name, d.name AS department_name,
      SUM(cs.due - cs.paid) AS debt, COUNT(*) AS months
    FROM charge_status cs JOIN students s ON s.id = cs.student_id
    LEFT JOIN classes c ON c.id = s.class_id ${PLACE_JOINS}
    WHERE cs.due > cs.paid ${byStudent.sql}
    GROUP BY s.id ORDER BY debt DESC, months DESC LIMIT 6`).all(...byStudent.params);

  const byClass = scopeSql(req.scope, { branch: 'c.branch_id', department: 'c.department_id', teacher: 'c.teacher_id' });
  const classCount = db.prepare(`SELECT COUNT(*) AS n FROM classes c WHERE active = 1 ${byClass.sql}`).get(...byClass.params).n;

  // Moj dan: koliko je prijavljeni korisnik danas primio (za večernje usklađivanje s novcem u ruci).
  const today = h.todayISO();
  const myDay = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total,
      COALESCE(SUM(CASE WHEN method = 'gotovina' THEN amount ELSE 0 END), 0) AS gotovina
    FROM payments WHERE created_by = ? AND paid_on = ?`).get(req.user.id, today);

  res.render('dashboard', {
    myDay, today,
    title: 'Pregled', period, breakdown, totals: breakdown.totals, totalDebt, cashThisMonth, recent, topDebtors, classCount,
    canRecord: canRecord(req.user, res.locals.settings),
  });
});

module.exports = router;
