// Priznanice: redni broj po godini, nepromjenjiv sadržaj, storno se samo označava.
const { db } = require('./db');
const h = require('./helpers');
const { stamp } = require('./audit');

// lines: [{ student_id, student, class_name, period, amount }]
// Poziva se unutar iste transakcije kao i upis uplata.
function createReceipt(user, { paidOn, method, payer = '', phone = '', branchId = null, departmentId = null, lines }) {
  const year = Number(paidOn.slice(0, 4));
  const seq = (db.prepare('SELECT MAX(seq) AS m FROM receipts WHERE year = ?').get(year).m || 0) + 1;
  const number = `${year}-${String(seq).padStart(5, '0')}`;
  const total = lines.reduce((t, l) => t + l.amount, 0);
  const info = db.prepare(`INSERT INTO receipts (number, year, seq, created_at, created_by, created_by_name, paid_on, method, payer, phone, branch_id, department_id, total, lines)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(number, year, seq, stamp(), user.id, user.name, paidOn, method, payer, phone, branchId, departmentId, total, JSON.stringify(lines));
  return { id: Number(info.lastInsertRowid), number, total };
}

function getReceipt(id) {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, lines: JSON.parse(r.lines) };
}

// Storno jedne uplate s priznanice: priznanica ostaje, ali se označi.
function markVoided(receiptId, note) {
  const r = db.prepare('SELECT void_note FROM receipts WHERE id = ?').get(receiptId);
  if (!r) return;
  db.prepare('UPDATE receipts SET voided = 1, void_note = ? WHERE id = ?').run([r.void_note, note].filter(Boolean).join(' · '), receiptId);
}

// Tekst priznanice za slanje roditelju (WhatsApp/Viber/SMS).
function receiptText(r, settings) {
  const cur = settings.currency;
  const byStudent = new Map();
  for (const l of r.lines) {
    if (!byStudent.has(l.student)) byStudent.set(l.student, []);
    byStudent.get(l.student).push(`${h.periodShort(l.period)} ${h.money(l.amount, cur)}`);
  }
  const items = [...byStudent].map(([name, list]) => `${name}: ${list.join(', ')}`).join('; ');
  return `${settings.school_name} — priznanica br. ${r.number} od ${h.formatDate(r.paid_on)}. Uplaćeno ${h.money(r.total, cur)} (${items}). Primio: ${r.created_by_name}. Hvala!`;
}

module.exports = { createReceipt, getReceipt, markVoided, receiptText };
