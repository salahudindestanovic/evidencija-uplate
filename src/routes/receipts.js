const express = require('express');
const { db } = require('../db');
const h = require('../helpers');
const { getReceipt, receiptText } = require('../receipts');
const billing = require('../billing');
const { requireLogin, isFinance, inUserArea, canAccessStudent, toInt, forbidden, notFound } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

// Priznanicu vidi ko ju je izdao, finansije u svom području, ili profesor tog učenika.
function canSee(user, r) {
  if (r.created_by === user.id) return true;
  if (isFinance(user)) return inUserArea(user, { branch_id: r.branch_id, department_id: r.department_id });
  const first = billing.getStudent(r.lines[0]?.student_id);
  return !!first && canAccessStudent(user, first);
}

router.get('/:id', (req, res) => {
  const r = getReceipt(toInt(req.params.id));
  if (!r) return notFound(res);
  if (!canSee(req.user, r)) return forbidden(res);
  const settings = res.locals.settings;
  const text = receiptText(r, settings);
  const phone = h.intlPhone(r.phone, settings.phone_prefix);
  const byStudent = [];
  for (const l of r.lines) {
    let g = byStudent.find((x) => x.student === l.student);
    if (!g) byStudent.push(g = { student: l.student, student_id: l.student_id, class_name: l.class_name, lines: [] });
    g.lines.push(l);
  }
  res.render('receipt', { title: `Priznanica ${r.number}`, r, byStudent, text, phone });
});

module.exports = router;
