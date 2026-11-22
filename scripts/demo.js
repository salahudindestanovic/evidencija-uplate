// Puni praznu bazu demo-podacima po strukturi iz godišnjeg izvještaja Škole za 2025. godinu:
// gradovi, 42 odjeljenja, koordinatori, blagajnici, profesori i muhaffizi, te oko 2.450 izmišljenih učenika s uplatama.
// Pokretanje: npm run demo   (samo na praznoj bazi)

const bcrypt = require('bcryptjs');
const { db, setSetting, transaction } = require('../src/db');
const h = require('../src/helpers');
const billing = require('../src/billing');

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.error('Baza već ima podatke. Demo se puni samo u praznu bazu (obrišite folder data/ za novi početak).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Struktura škole (izvor: Godišnji izvještaj o radu Škole Kur'ana Časnog za 2025.)
// ---------------------------------------------------------------------------

const MUHAFFIZI = {
  'Novi Pazar': ['Hfz. Irfan ef. Malić', 'Hfz. Faris Dautović', 'Hfz. Elvedin Avdović', 'Hfz. Šemsa Dacić-Saračević',
    'Halida Dacić-Dazdarević', 'Hfz. Amela Aličković', 'Hfz. Binasa Šabanović'],
  Sjenica: ['Hfz. Kemal ef. Mahmutović', 'Hfz. Abdulkadir ef. Mahmutović'],
  Tutin: ['Hfz. Entas ef. Pramenković', 'Hfz. Khawla Omar-Džanko'],
};

// Brojevi učenika su stanje krajem decembra 2025. Dolovo i Cetanoviće su zatvoreni 2025. (premalo
// učenika), a otvoreni su Orlje (Tutin) i Nova Varoš. Za Novu Varoš izvještaj ne navodi broj učenika
// ni profesora, pa je broj ovdje pretpostavka.
const CITIES = [
  {
    name: 'Novi Pazar', coordinators: ['Prof. Džemil ef. Destanović'], cashiers: [],
    departments: [
      ['Centralno odjeljenje', 489, ['Hfz. Haris ef. Saračević', 'Hfz. Imran Radičević', 'Nedžad ef. Čupović', 'Aladin Alić',
        'Remzija Kolašinac', 'Dženeta Bećović-Bajrović', 'Azra Mavrić', 'Zehra Ademović-Husović', 'Zehra Demirović-Nicević', 'Emina Nicević']],
      ['El-Džinan', 24, ['Ihsan ef. Eminović', 'Ajkuna Zeković']],
      ['Jošanica', 163, ['Hfz. Aiša Mekić', 'Hfz. Emina Zukorlić', 'Nusejba Vejselović']],
      ['Mur', 55, ['Aida Hasić', 'Muhamed ef. Fehratović']],
      ['Altun-Alem', 18, ['Emina Nicević']],
      ['Hadžimehova džamija', 39, ['Irfan ef. Bećirović', 'Mersiha Islamović']],
      ['IC-Gazilar', 32, ['Muamer ef. Murić', 'Mersiha Malić']],
      ['Nikšićka džamija', 37, ['Hfz. Faris Dautović', 'Mahija Mašović']],
      ['Jalija džamija', 45, ['Hfz. Admir ef. Jašarević', 'Alma Uluč-Jašarević']],
    ],
  },
  {
    name: 'Tutin', coordinators: ['Aldin ef. Hot', 'Amar Zukorlić'], cashiers: [],
    departments: [
      ['Centralno odjeljenje', 27, ['Selma Džemić', 'Hfz. Emin Alić']],
      ['Kleče', 33, ['Hfz. Emin Alić', 'Meliha Hodžić']],
      ['Validejn', 182, ['Hfz. Entas ef. Pramenković', 'Mevljudin ef. Aličković', 'Aiša Pramenković-Kurbardović']],
      ['Firdevs', 30, ['Jasmin ef. Goruždić', 'Mejra Tahirović']],
      ['Miradž', 69, ['Sead ef. Sokolović', 'Enisa Sokolović']],
      ['Bedr', 17, ['Hfz. Khawla Omar-Džanko']],
      ['Draga', 41, ['Anida Hot']],
      ['Orlje', 21, ['Dina Zukorlić']],
      ['Ljeskova', 46, ['Hfz. Demir ef. Šmaković', 'Aiša Zukorlić']],
      ['Delimeđe', 110, ['Nedžla Zukorlić', 'Abdullah Mujević']],
      ['Paljevo', 18, ['Ramiza Brahović']],
      ['Ribariće', 40, ['Muzafer ef. Izberović'], 'Muzafer ef. Izberović'],
      ['Raduhovci', 50, ['Irfan ef. Delić', 'Belkisa Delić'], 'Enver ef. Eminović'],
    ],
  },
  {
    name: 'Sjenica', coordinators: ['Hfz. Kemal ef. Mahmutović'], cashiers: ['Elma Fijuljanin'],
    departments: [
      ['Centralno odjeljenje IC Ebu Hanife', 286, ['Hfz. Kemal ef. Mahmutović', 'Suad ef. Bihorac', 'Arwa Abu Kwaik', 'Islam Abu Kwaik',
        'Binasa Vatić', 'Aida Pepić', 'Adela Karišik']],
      ['Vrhsjenice', 20, ['Anes Papić']],
      ['Duga Poljana', 35, ['Senada Ljaić', 'Dženana Bronja-Dacić'], 'Suad ef. Dacić'],
      ['Ugao', 13, ['Selma Kuč-Mujezinović']],
    ],
  },
  {
    name: 'Prijepolje', coordinators: ['Almir ef. Šantić'], cashiers: [],
    departments: [
      ['Vakuf', 142, ['Almir ef. Šantić', 'Amar Kapidžić', 'Fatima Šantić']],
      ['Župa', 54, ['Almir ef. Šantić', 'Fatima Šantić']],
      ['Ratajska', 15, ['Almir ef. Šantić', 'Fatima Šantić']],
    ],
  },
  { name: 'Nova Varoš', coordinators: [], cashiers: [], departments: [['Nova Varoš', 12, []]] },
  {
    name: 'Vojvodina', coordinators: [], cashiers: [],
    departments: [
      ['Beočin', 15, ['Hfz. Emin ef. Alić']],
      ['Adice', 15, ['Hfz. Emin ef. Alić']],
      ['Veliki Rit', 20, ['Hfz. Emin ef. Alić']],
      ['Subotica', 20, ['Hamid ef. Kamberović']],
    ],
  },
  {
    name: 'Beograd', coordinators: [], cashiers: [],
    departments: [
      ['Centralno odjeljenje', 15, ['Fuad ef. Preljević']],
      ['Krnjača', 20, ['Fuad ef. Preljević']],
      ['Makiš', 20, ['Fuad ef. Preljević']],
    ],
  },
  { name: 'Brodarevo', coordinators: ['Sanel ef. Bjelak'], cashiers: [], departments: [['Brodarevo', 45, ['Sajma Halilović-Gojak']]] },
  {
    name: 'Rožaje', coordinators: ['Hfz. Abdurahman ef. Kujević'], cashiers: [],
    departments: [['Rožaje', 44, ['Seid Klica', 'Aida Kujević', 'Kanita Kurpejović']]],
  },
  {
    name: 'Dijaspora', coordinators: [], cashiers: [], diaspora: true,
    departments: [
      ['Beč', 26, ['Nihad ef. Gegić', 'Mithat ef. Mujović']],
      ['Minhen', 24, ['Izet ef. Bibić']],
      ['Frankfurt', 21, ['Hfz. Nedžad ef. Ljajić']],
    ],
  },
];

// Mjesečna članarina u centima: 25 €, a s prevozom (kombi) 50 € (doplata 25 €).
// Popuste ne izmišljamo: sva demo djeca plaćaju standardno, a škola sama upisuje drugačije iznose.
const FEE = 2500;
const TRANSPORT_FEE = 2500;
// Kombi vozila postoje u Novom Pazaru, Tutinu i Sjenici (godišnji izvještaj 2025.).
const TRANSPORT_SHARE = { 'Novi Pazar': 0.3, Tutin: 0.35, Sjenica: 0.3 };

// ---------------------------------------------------------------------------

let seed = 2025;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const DEMO_PASSWORD = 'demo1234';
const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);

// "Hfz. Haris ef. Saračević" -> "haris.saracevic"
function usernameFor(name, taken) {
  const plain = h.fold(name)
    .replace(/\b(hfz|prof|ef|muftija|sandzacki)\.?(\s|$)/g, ' ')
    .replace(/[^a-z\s-]/g, '').trim().split(/\s+/);
  const base = `${plain[0]}.${plain[plain.length - 1]}`.replace(/-/g, '');
  let u = base;
  for (let i = 2; taken.has(u); i++) u = `${base}${i}`;
  taken.add(u);
  return u;
}

const firstM = ['Amar', 'Emir', 'Adnan', 'Harun', 'Kerim', 'Tarik', 'Faris', 'Ahmed', 'Hamza', 'Jusuf', 'Abdullah', 'Omer', 'Ismail', 'Bilal', 'Zakir', 'Eldar', 'Haris', 'Mirza', 'Senad', 'Anes', 'Dženan', 'Jahja', 'Muhamed', 'Salih'];
const firstF = ['Amina', 'Lejla', 'Emina', 'Merjem', 'Ajša', 'Sara', 'Hana', 'Naida', 'Zejneb', 'Belma', 'Dženana', 'Ilma', 'Esma', 'Selma', 'Hafsa', 'Fatima', 'Rabija', 'Melisa', 'Asja', 'Zehra', 'Nejla', 'Lamija', 'Ajla', 'Sumeja'];
const lastNames = ['Hodžić', 'Mehmedović', 'Begić', 'Hasanović', 'Delić', 'Mujović', 'Salihović', 'Čolović', 'Hadžić', 'Ibrahimović', 'Alić', 'Šabotić', 'Omerović',
  'Kurtović', 'Ljajić', 'Zukorlić', 'Dacić', 'Mahmutović', 'Bihorac', 'Kučević', 'Hamidović', 'Nicević', 'Ganić', 'Muratović', 'Gegić', 'Ramović', 'Šaćirović',
  'Bajrović', 'Kolašinac', 'Fetahović', 'Halilović', 'Džudžević', 'Suljović', 'Rovčanin', 'Kuč', 'Pepić', 'Hot', 'Eminović', 'Pramenković', 'Bošnjak'];
const parentM = ['Senad', 'Mirsad', 'Edin', 'Admir', 'Nermin', 'Elvir', 'Sead', 'Enes', 'Ramiz', 'Fikret', 'Suad', 'Ismet', 'Rifat', 'Hajrudin'];

const usernames = new Set(['admin']);
const users = new Map(); // ime -> { id, ... }
const addUser = db.prepare('INSERT INTO users (name, username, password_hash, role, branch_id, department_id) VALUES (?, ?, ?, ?, ?, ?)');
function user(name, role, branchId, deptId = null) {
  if (users.has(name)) return users.get(name).id;
  const username = usernameFor(name, usernames);
  const id = Number(addUser.run(name, username, hash, role, branchId, role === 'admin' ? null : deptId).lastInsertRowid);
  users.set(name, { id, username, role, branchId });
  return id;
}

const now = h.currentPeriod();
const startYear = h.schoolYearStart(now, 9);
const lastYearStart = `${startYear - 1}-09`;
const januaryIntake = `${startYear}-01`;
const thisYearStart = `${startYear}-09`;
const midYear = h.periodRange(h.addMonths(lastYearStart, 1), h.addMonths(thisYearStart, -1))
  .filter((p) => p !== januaryIntake && ![7, 8].includes(h.monthOf(p)));

const addBranch = db.prepare('INSERT INTO branches (name) VALUES (?)');
const addDept = db.prepare('INSERT INTO departments (branch_id, name) VALUES (?, ?)');
const addClass = db.prepare('INSERT INTO classes (name, program, branch_id, department_id, teacher_id, monthly_fee) VALUES (?, ?, ?, ?, ?, ?)');
const addStudent = db.prepare(`INSERT INTO students (first_name, last_name, parent_name, phone, branch_id, department_id, class_id, fee_override, transport, enrolled_from, left_at, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

let studentCount = 0;
let classCount = 0;

transaction(() => {
  setSetting('school_name', "Škola Kur'ana Časnog");
  setSetting('default_fee', FEE);
  setSetting('transport_fee', TRANSPORT_FEE);
  // Prijava jednim klikom na stranici za prijavu (isključuje se u Postavkama).
  setSetting('demo_mode', '1');
  setSetting('demo_accounts', JSON.stringify([
    { username: 'dzemil.destanovic', label: 'Uprava škole', note: 'Svi gradovi, izvještaji za Mešihat, korisnici i postavke' },
    { username: 'aldin.hot', label: 'Koordinator grada', note: 'Svih 13 odjeljenja u Tutinu, naplata i dugovanja' },
    { username: 'enver.eminovic', label: 'Koordinator odjeljenja', note: 'Vidi i naplaćuje samo svoje odjeljenje' },
    { username: 'elma.fijuljanin', label: 'Blagajnik', note: 'Uplate, priznanice i blagajna za Sjenicu' },
    { username: 'haris.saracevic', label: 'Profesor', note: 'Svoje grupe na telefonu: ko je platio, brza naplata' },
  ]));
  addUser.run('Uprava škole (demo)', 'admin', hash, 'admin', null, null);
  user('Hfz. Irfan ef. Malić', 'admin', null);

  for (const city of CITIES) {
    const branchId = Number(addBranch.run(city.name).lastInsertRowid);
    // Sekretar škole je ujedno koordinator u Novom Pazaru; u demo-u ima ulogu glavnog administratora.
    for (const c of city.coordinators) user(c, c.startsWith('Prof. Džemil') ? 'admin' : 'branch_admin', branchId);
    for (const c of city.cashiers) user(c, 'cashier', branchId);

    for (const [deptName, size, teachers, deptCoordinator] of city.departments) {
      const deptId = Number(addDept.run(branchId, deptName).lastInsertRowid);
      if (deptCoordinator) user(deptCoordinator, 'branch_admin', branchId, deptId);
      const staff = teachers.map((t) => user(t, 'teacher', branchId));
      const central = /^Centralno/.test(deptName);
      const hifzStaff = central && MUHAFFIZI[city.name] ? MUHAFFIZI[city.name].map((t) => user(t, 'teacher', branchId)) : staff;

      // Raspodjela po nivoima nastave: harfovi (sufara), tedžvid, Amme džuz, hifz.
      const share = central ? { Sufara: 0.4, 'Tedžvid': 0.3, 'Amme džuz': 0.15, Hifz: 0.15 } : { Sufara: 0.5, 'Tedžvid': 0.3, 'Amme džuz': 0.15, Hifz: 0.05 };
      let left = size;
      const programs = Object.entries(share).map(([program, s], i, all) => {
        const n = i === all.length - 1 ? left : Math.min(left, Math.round(size * s));
        left -= n;
        return [program, n];
      }).filter(([, n]) => n > 0);

      let t = 0;
      for (const [program, n] of programs) {
        const groupSize = program === 'Hifz' ? 10 : 18;
        const groups = Math.max(1, Math.ceil(n / groupSize));
        const pool = program === 'Hifz' ? hifzStaff : staff;
        for (let g = 0; g < groups; g++) {
          const name = groups > 1 ? `${program} ${g + 1}` : program;
          const teacher = pool.length ? pool[(t++) % pool.length] : null;
          const classId = Number(addClass.run(name, program, branchId, deptId, teacher, FEE).lastInsertRowid);
          classCount++;
          const inGroup = Math.floor(n / groups) + (g < n % groups ? 1 : 0);
          for (let i = 0; i < inGroup; i++) {
            const female = rand() < 0.55;
            const last = pick(lastNames);
            // Upisni rokovi kao u izvještaju: većina je od ranije, manji dio u januaru i septembru, ponešto tokom godine.
            const r = rand();
            const enrolled = r < 0.84 ? lastYearStart : r < 0.9 ? januaryIntake : r < 0.97 ? thisYearStart : pick(midYear);
            const leftAt = enrolled !== thisYearStart && rand() < 0.04 ? `${startYear}-06` : null;
            const fee = null;
            const note = '';
            const transport = rand() < (TRANSPORT_SHARE[city.name] || 0) ? 1 : 0;
            addStudent.run(
              female ? pick(firstF) : pick(firstM), last, `${pick(parentM)} ${last}`,
              city.diaspora ? `+49 ${150 + Math.floor(rand() * 30)} ${1000000 + Math.floor(rand() * 8999999)}` : `06${Math.floor(rand() * 6)} ${100 + Math.floor(rand() * 900)} ${100 + Math.floor(rand() * 900)}`,
              branchId, deptId, classId, fee, transport, enrolled, leftAt, note,
            );
            studentCount++;
          }
        }
      }
    }
  }
});

// Braća i sestre: dio djece dobija brata/sestru u istom odjeljenju (isti roditelj, telefon i prevoz),
// da se vidi porodična uplata.
transaction(() => {
  const byDept = new Map();
  for (const st of db.prepare('SELECT id, department_id, last_name, parent_name, phone, transport, fee_override FROM students').all()) {
    if (!byDept.has(st.department_id)) byDept.set(st.department_id, []);
    byDept.get(st.department_id).push(st);
  }
  const upd = db.prepare('UPDATE students SET last_name = ?, parent_name = ?, phone = ?, transport = ? WHERE id = ?');
  for (const list of byDept.values()) {
    list.sort(() => rand() - 0.5);
    for (let i = 0; i + 1 < list.length; i += 2) {
      if (rand() >= 0.12) continue;
      const a = list[i];
      upd.run(a.last_name, a.parent_name, a.phone, a.transport, list[i + 1].id);
      if (rand() < 0.25 && list[i + 2]) { upd.run(a.last_name, a.parent_name, a.phone, a.transport, list[i + 2].id); i += 1; }
    }
  }
});

billing.ensureCharges();

// ---------------------------------------------------------------------------
// Uplate: većina plaća redovno, dio kasni, dio duguje posljednjih nekoliko mjeseci.
// ---------------------------------------------------------------------------

const charges = db.prepare('SELECT * FROM charges WHERE amount > 0 ORDER BY student_id, period').all();
const recorders = new Map(db.prepare(`
  SELECT s.id, c.teacher_id,
    (SELECT u.id FROM users u WHERE u.role IN ('branch_admin', 'cashier') AND u.branch_id = s.branch_id
       AND (u.department_id IS NULL OR u.department_id = s.department_id) ORDER BY u.role = 'cashier' DESC LIMIT 1) AS office_id
  FROM students s LEFT JOIN classes c ON c.id = s.class_id`).all().map((r) => [r.id, r]));
const mainAdmin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;

const habit = new Map(); // učenik -> 'regular' | 'late' | 'debtor'
const monthsAgo = (p) => (Number(now.slice(0, 4)) * 12 + h.monthOf(now)) - (Number(p.slice(0, 4)) * 12 + h.monthOf(p));
const today = h.todayISO();
const addPayment = db.prepare('INSERT INTO payments (student_id, period, amount, paid_on, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
let paymentCount = 0;

transaction(() => {
  for (const c of charges) {
    if (!habit.has(c.student_id)) {
      const r = rand();
      habit.set(c.student_id, { type: r < 0.72 ? 'regular' : r < 0.9 ? 'late' : 'debtor', owes: 2 + Math.floor(rand() * 3) });
    }
    const { type, owes } = habit.get(c.student_id);
    const ago = monthsAgo(c.period);
    if (type === 'debtor' && ago < owes) continue;
    if (type === 'late' && rand() < 0.2) continue;
    if (ago === 0 && rand() < (type === 'regular' ? 0.55 : 0.85)) continue; // tekući mjesec tek počinje

    // Datum uplate: obično u tom mjesecu, kod onih koji kasne mjesec-dva kasnije.
    const delay = type === 'late' ? Math.floor(rand() * 2) : 0;
    let paidOn = `${h.addMonths(c.period, delay)}-${String(1 + Math.floor(rand() * 25)).padStart(2, '0')}`;
    if (paidOn > today) paidOn = today;
    const partial = type !== 'regular' && rand() < 0.08;
    const who = recorders.get(c.student_id);
    const by = rand() < 0.6 ? (who.teacher_id || who.office_id || mainAdmin) : (who.office_id || who.teacher_id || mainAdmin);
    addPayment.run(c.student_id, c.period, partial ? Math.round(c.amount / 2) : c.amount, paidOn,
      rand() < 0.85 ? 'gotovina' : 'banka', '', by);
    paymentCount++;
  }
});

// Dug iz ranije (iz svezaka, prije uvođenja sistema) za oko 6 % djece koja su bila upisana od početka.
transaction(() => {
  const old = db.prepare(`${billing.STUDENT_SQL} WHERE s.enrolled_from = ?`).all(lastYearStart);
  for (const s of old) if (rand() < 0.06) billing.setOpeningDebt(s, [2500, 5000, 7500, 10000][Math.floor(rand() * 4)]);
});

// Priznanice za sve demo uplate (jedna priznanica = isti učenik, dan, način i osoba koja je primila).
transaction(() => {
  const { createReceipt } = require('../src/receipts');
  const rows = db.prepare(`
    SELECT p.id, p.student_id, p.period, p.amount, p.paid_on, p.method, p.created_by, u.name AS user_name,
      s.first_name, s.last_name, s.parent_name, s.phone, s.branch_id, s.department_id, c.name AS class_name
    FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN users u ON u.id = p.created_by
    ORDER BY p.paid_on, p.created_by, p.student_id, p.period`).all();
  const setReceipt = db.prepare('UPDATE payments SET receipt_id = ? WHERE id = ?');
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const f = group[0];
    const r = createReceipt({ id: f.created_by, name: f.user_name || '' }, {
      paidOn: f.paid_on, method: f.method, payer: f.parent_name, phone: f.phone, branchId: f.branch_id, departmentId: f.department_id,
      lines: group.map((g) => ({ student_id: g.student_id, student: `${g.first_name} ${g.last_name}`, class_name: g.class_name || '', period: g.period, amount: g.amount })),
    });
    db.prepare('UPDATE receipts SET created_at = ? WHERE id = ?').run(`${f.paid_on} ${String(9 + (f.id % 10)).padStart(2, '0')}:${String(f.id % 60).padStart(2, '0')}:00`, r.id);
    for (const g of group) setReceipt.run(r.id, g.id);
    group = [];
  };
  for (const row of rows) {
    const key = (x) => `${x.paid_on}|${x.created_by}|${x.student_id}|${x.method}`;
    if (group.length && key(group[0]) !== key(row)) flush();
    group.push(row);
  }
  flush();
});

console.log(`Demo podaci su ubačeni: ${CITIES.length} gradova, ${db.prepare('SELECT COUNT(*) AS n FROM departments').get().n} odjeljenja, ${classCount} grupa, ${studentCount} učenika, ${paymentCount} uplata, ${users.size + 1} korisnika.`);
console.log(`Lozinka za sve demo korisnike: ${DEMO_PASSWORD}`);
const show = (role, limit = 99) => db.prepare(`
  SELECT u.username, u.name, b.name AS city, d.name AS dept FROM users u
  LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN departments d ON d.id = u.department_id
  WHERE u.role = ? ORDER BY b.name, d.name, u.name LIMIT ?`).all(role, limit)
  .map((u) => `  ${u.username.padEnd(22)} ${u.name}${u.city ? ` — ${u.city}${u.dept ? ' · ' + u.dept : ''}` : ''}`).join('\n');
console.log(`Glavni administratori:\n${show('admin')}`);
console.log(`Koordinatori:\n${show('branch_admin')}`);
console.log(`Blagajnici:\n${show('cashier')}`);
console.log(`Profesori (prvih 5):\n${show('teacher', 5)}`);
