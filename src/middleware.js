// Uloge:
//  admin         glavni administrator (uprava škole): svi gradovi, odjeljenja, korisnici, postavke
//  branch_admin  koordinator: sve u svom gradu ili samo u svom odjeljenju (može i predavati)
//  cashier       blagajnik: uplate, storniranje i izvještaji u svom gradu/odjeljenju; bez uređivanja
//  teacher       profesor / muhaffiz: samo svoje grupe
const ROLES = { admin: 'Glavni administrator', branch_admin: 'Koordinator', cashier: 'Blagajnik', teacher: 'Profesor' };

const isMainAdmin = (user) => user.role === 'admin';
// Uređuje učenike, grupe i profesore.
const isManager = (user) => user.role === 'admin' || user.role === 'branch_admin';
// Vidi izvještaje i stornira uplate.
const isFinance = (user) => isManager(user) || user.role === 'cashier';

function forbidden(res) {
  res.status(403).render('error', { title: 'Nema pristupa', message: 'Nemate pristup ovoj stranici.' });
}

function notFound(res) {
  res.status(404).render('error', { title: 'Nije pronađeno', message: 'Tražena stranica ili zapis ne postoji.' });
}

const guard = (check) => (req, res, next) => {
  if (!req.user) return res.redirect('/prijava');
  if (!check(req.user)) return forbidden(res);
  next();
};
const requireLogin = guard(() => true);
const requireManager = guard(isManager);
const requireFinance = guard(isFinance);
const requireAdmin = guard(isMainAdmin);

// Opseg podataka za korisnika. `selected` je grad/odjeljenje odabrano u meniju ({ branchId, departmentId }).
function scopeFor(user, selected = {}) {
  if (user.role === 'teacher') return { branchId: null, departmentId: null, teacherId: user.id };
  if (isMainAdmin(user)) return { branchId: selected.branchId || null, departmentId: selected.departmentId || null, teacherId: null };
  // Korisnik bez grada ne vidi ništa, umjesto da vidi sve.
  const branchId = user.branch_id || -1;
  const departmentId = user.department_id || selected.departmentId || null;
  return { branchId, departmentId, teacherId: null };
}

// SQL uslov za opseg. cols kaže koje kolone upit ima:
// { branch: 's.branch_id', department: 's.department_id', teacher: 'c.teacher_id' }
function scopeSql(scope, cols) {
  let sql = '';
  const params = [];
  const add = (col, val) => { if (val && col) { sql += ` AND ${col} = ?`; params.push(val); } };
  add(cols.branch, scope.branchId);
  add(cols.department, scope.departmentId);
  add(cols.teacher, scope.teacherId);
  return { sql, params };
}

// Smije li korisnik raditi sa zapisom koji ima branch_id / department_id.
function inUserArea(user, rec) {
  if (isMainAdmin(user)) return true;
  if (rec.branch_id !== user.branch_id) return false;
  return !user.department_id || rec.department_id === user.department_id;
}

const canAccessStudent = (user, student) => (user.role === 'teacher' ? student.teacher_id === user.id : inUserArea(user, student));
const canAccessClass = (user, cls) => (user.role === 'teacher' ? cls.teacher_id === user.id : inUserArea(user, cls));
const canRecord = (user, settings) => isFinance(user) || settings.teachers_can_record === '1';
const canEditStudents = (user, settings) => isManager(user) || (user.role === 'teacher' && settings.teachers_can_edit_students === '1');

function toInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// Samo lokalne putanje, da redirect ne može odvesti na drugi sajt.
const safeBack = (v, fallback) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : fallback);

// Stranice za duge spiskove.
function paginate(total, page, perPage = 100) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page || 1), pages);
  return { total, pages, page: current, perPage, offset: (current - 1) * perPage };
}

// CSV sa ";" i BOM-om, da ga Excel s našim regionalnim postavkama odmah ispravno otvori.
function sendCsv(res, filename, header, rows) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+@\t]/.test(s)) s = `'${s}`;
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + body);
}

module.exports = {
  ROLES, isMainAdmin, isManager, isFinance, forbidden, notFound,
  requireLogin, requireManager, requireFinance, requireAdmin,
  scopeFor, scopeSql, inUserArea, canAccessStudent, canAccessClass, canRecord, canEditStudents, toInt, safeBack, paginate, sendCsv,
};
