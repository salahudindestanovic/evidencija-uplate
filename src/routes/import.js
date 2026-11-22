const express = require('express');
const { db, getSettings, transaction } = require('../db');
const h = require('../helpers');
const billing = require('../billing');
const { audit } = require('../audit');
const { FIELDS, planImport } = require('../import');
const { requireManager, inUserArea, toInt, sendCsv } = require('../middleware');

// Uvoz učenika iz Excela: 1) zalijepi tabelu, 2) pregled s greškama i duplikatima, 3) potvrda.
const router = express.Router();
router.use(requireManager);

function departmentOptions(req, res) {
  return res.locals.departments.filter((d) => inUserArea(req.user, { branch_id: d.branch_id, department_id: d.id })
    && (!req.scope.branchId || d.branch_id === req.scope.branchId)
    && (!req.scope.departmentId || d.id === req.scope.departmentId));
}

function readForm(req, res) {
  const b = req.body;
  const departments = departmentOptions(req, res);
  const width = toInt(b.width) || 0;
  return {
    text: String(b.text || ''),
    department_id: toInt(b.department_id) || (departments.length === 1 ? departments[0].id : req.scope.departmentId),
    default_class_id: toInt(b.default_class_id),
    enrolled_from: h.isPeriod(b.enrolled_from) ? b.enrolled_from : h.currentPeriod(),
    header: ['0', '1'].includes(String([].concat(b.header ?? []).pop())) ? String([].concat(b.header).pop()) : '',
    map: width ? Array.from({ length: width }, (_, i) => String(b[`map_${i}`] ?? '')) : null,
    departments,
  };
}

function render(res, form, plan = null, error = null) {
  // Grupe svih ponuđenih odjeljenja; na stranici se prikazuju samo grupe odabranog odjeljenja.
  const ids = new Set(form.departments.map((d) => d.id));
  const classes = db.prepare('SELECT id, name, program, monthly_fee, department_id FROM classes WHERE active = 1 ORDER BY name COLLATE NOCASE')
    .all().filter((c) => ids.has(c.department_id));
  res.render('students/import', { title: 'Uvoz učenika', form, plan, classes, FIELDS, error });
}

router.get('/', (req, res) => {
  render(res, readForm({ ...req, body: {} }, res));
});

router.get('/primjer.csv', (req, res) => {
  sendCsv(res, 'uvoz-ucenika-primjer.csv', ['Ime', 'Prezime', 'Roditelj', 'Telefon', 'Grupa', 'Prevoz', 'Mjesečno', 'Dug', 'Napomena'], [
    ['Amina', 'Hodžić', 'Senad Hodžić', '063 123 456', 'Sufara 1', 'da', '', '50', ''],
    ['Harun', 'Hodžić', 'Senad Hodžić', '063 123 456', 'Tedžvid', 'ne', '', '', ''],
  ]);
});

function validate(form) {
  if (!form.departments.some((d) => d.id === form.department_id)) return 'Odaberite odjeljenje u koje se upisuju učenici.';
  if (!form.text.trim()) return 'Zalijepite redove iz Excela ili učitajte CSV datoteku.';
  return null;
}

// Pregled: ništa se ne upisuje dok korisnik ne potvrdi.
router.post('/pregled', (req, res) => {
  const form = readForm(req, res);
  const error = validate(form);
  if (error) return render(res, form, null, error);
  const plan = planImport({ text: form.text, map: form.map, header: form.header, departmentId: form.department_id, defaultClassId: form.default_class_id });
  if (!plan.items.length) return render(res, form, null, 'U zalijepljenom tekstu nema redova s učenicima.');
  if (!plan.map.some((f) => ['first_name', 'last_name', 'full_name', 'full_name_rev'].includes(f))) {
    return render(res, form, plan, 'Označite koja kolona sadrži ime i prezime učenika.');
  }
  render(res, form, plan);
});

router.post('/', (req, res) => {
  const form = readForm(req, res);
  const error = validate(form);
  if (error) return render(res, form, null, error);
  const plan = planImport({ text: form.text, map: form.map, header: form.header, departmentId: form.department_id, defaultClassId: form.default_class_id });
  const ok = plan.items.filter((x) => x.status === 'ok');
  if (!ok.length) return render(res, form, plan, 'Nema učenika za upis (svi redovi su preskočeni).');

  const dep = db.prepare('SELECT d.id, d.branch_id, d.name, b.name AS branch_name FROM departments d JOIN branches b ON b.id = d.branch_id WHERE d.id = ?').get(form.department_id);
  const fee = Number(getSettings().default_fee) || 0;
  const since = `${h.MONTH_GENITIVE[h.monthOf(form.enrolled_from) - 1]} ${form.enrolled_from.slice(0, 4)}.`;
  const insertClass = db.prepare('INSERT INTO classes (name, program, branch_id, department_id, teacher_id, monthly_fee, active) VALUES (?, ?, ?, ?, NULL, ?, 1)');
  const insertStudent = db.prepare(`
    INSERT INTO students (first_name, last_name, parent_name, phone, note, branch_id, department_id, class_id, fee_override, transport, enrolled_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  transaction(() => {
    for (const g of plan.newGroups) g.id = Number(insertClass.run(g.name, g.program, dep.branch_id, dep.id, fee).lastInsertRowid);
    for (const x of ok) {
      const classId = x.class ? x.class.id : x.newGroup ? x.newGroup.id : null;
      const info = insertStudent.run(x.first_name, x.last_name, x.parent_name, x.phone, x.note, dep.branch_id, dep.id, classId, x.fee, x.transport, form.enrolled_from);
      if (x.debt > 0) billing.setOpeningDebt({ id: Number(info.lastInsertRowid), class_id: classId, branch_id: dep.branch_id, department_id: dep.id }, x.debt);
    }
    audit(req.user, 'uvoz', {
      place: { branch_id: dep.branch_id, department_id: dep.id },
      details: `${ok.length} ${h.plural(ok.length, 'učenik', 'učenika', 'učenika')} u ${dep.branch_name} · ${dep.name}, naplata od ${since}`
        + (plan.newGroups.length ? `; nove grupe: ${plan.newGroups.map((g) => g.name).join(', ')}` : ''),
    });
  });
  billing.markDirty();

  const msg = `${h.plural(ok.length, 'Upisan je', 'Upisana su', 'Upisano je')} ${ok.length} ${h.plural(ok.length, 'učenik', 'učenika', 'učenika')} u odjeljenje ${dep.name}, s naplatom od ${since}.`
    + (plan.newGroups.length ? ` Kreirane su nove grupe (${plan.newGroups.map((g) => g.name).join(', ')}) s cijenom ${h.money(fee, getSettings().currency)} — provjerite cijenu i profesora.` : '');
  req.flash('ok', msg, plan.newGroups.length ? { href: '/grupe', label: 'Grupe' } : null);
  req.session.place = { d: dep.id };
  res.redirect('/ucenici');
});

module.exports = router;
