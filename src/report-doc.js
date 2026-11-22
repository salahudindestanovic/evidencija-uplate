// Finansijski izvještaj u stilu dosadašnjih izvještaja Škole (naslov, uvod, odjeljci, spiskovi po
// gradovima i odjeljenjima, "Ukupno za …", mjesto i datum, potpis) — plus sažetak, poređenje s
// prethodnim periodom i pregledna tabela. Isti sadržaj se prikazuje kao stranica za štampu/PDF i kao Word.
//
// Sadržaj je niz blokova:
//   { type: 'h', text }                     podnaslov odjeljka
//   { type: 'p', text }                     pasus; **tekst** je podebljan
//   { type: 'summary', items: [{ label, value, note }] }
//   { type: 'group', title, items: [text], total }   spisak s crticama, kao u njihovim izvještajima
//   { type: 'list', items: [text] }
//   { type: 'table', head: [], rows: [[]], foot: [], align: ['l','r',…] }
//   { type: 'note', text }

const { db } = require('./db');
const h = require('./helpers');
const billing = require('./billing');
const { scopeSql } = require('./middleware');

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function previousPeriod(P) {
  if (P.kind === 'godina') {
    const periods = h.schoolYearPeriods(P.year - 1, P.startMonth);
    return { from: periods[0], to: periods[periods.length - 1], label: `školsku ${h.schoolYearLabel(P.year - 1, P.startMonth)}. godinu` };
  }
  const prev = h.addMonths(P.month, -1);
  return { from: prev, to: prev, label: `${h.MONTH_NAMES[h.monthOf(prev) - 1].toLowerCase()} ${prev.slice(0, 4)}.` };
}

// Naplata članarine za mjesec `period`, uračunate samo uplate do određenog datuma.
function paidUntil(period, untilDate, scope) {
  const f = scopeSql(scope, { branch: 'ch.branch_id', department: 'ch.department_id' });
  return db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN ch.waived = 1 THEN 0 ELSE ch.amount END), 0) AS due,
      COALESCE(SUM(MIN(CASE WHEN ch.waived = 1 THEN 0 ELSE ch.amount END,
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.student_id = ch.student_id AND p.period = ch.period AND p.paid_on <= ?))), 0) AS paid
    FROM charges ch WHERE ch.period = ? ${f.sql}`).get(untilDate, period, ...f.params);
}

// Poređenje s prethodnim periodom, jednom rečenicom. Mjesec u toku se poredi s istim brojem dana
// prošlog mjeseca, da poređenje bude pošteno.
function comparisonText(P, totals, scope) {
  const nowPct = pct(totals.paid, totals.due);
  const points = (d) => `${Math.abs(d)} ${h.plural(Math.abs(d), 'procentni poen', 'procentna poena', 'procentnih poena')}`;
  if (P.kind === 'mjesec' && P.isCurrent) {
    const day = Number(h.todayISO().slice(8, 10));
    const prevMonth = h.addMonths(P.month, -1);
    const lastDay = new Date(Number(prevMonth.slice(0, 4)), h.monthOf(prevMonth), 0).getDate();
    const until = `${prevMonth}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
    const then = paidUntil(prevMonth, until, scope);
    if (!then.due) return '';
    const thenPct = pct(then.paid, then.due);
    const diff = nowPct - thenPct;
    return `Do ${day}. ${h.MONTH_GENITIVE[h.monthOf(P.month) - 1]} naplaćeno je ${nowPct} % članarine za ovaj mjesec, a do ${Math.min(day, lastDay)}. ${h.MONTH_GENITIVE[h.monthOf(prevMonth) - 1]} bilo je naplaćeno ${thenPct} % članarine za ${h.MONTH_NAMES[h.monthOf(prevMonth) - 1].toLowerCase()}`
      + (diff === 0 ? ' — naplata ide istim tempom.' : ` — naplata ide ${diff > 0 ? 'bolje' : 'sporije'} za ${points(diff)}.`)
      + ' Mjesec je još u toku, pa iznosi nisu konačni.';
  }
  const prev = previousPeriod(P);
  const prevTotals = billing.summary(prev.from, scope, billing.levelFor(scope), prev.to).totals;
  if (!prevTotals.due) return '';
  const prevPct = pct(prevTotals.paid, prevTotals.due);
  const diff = nowPct - prevPct;
  let text = diff === 0
    ? `Procenat naplate je isti kao za ${prev.label} (${prevPct} %).`
    : `U odnosu na ${prev.label} (${prevPct} %), procenat naplate je ${diff > 0 ? 'veći' : 'manji'} za ${points(diff)}.`;
  if (P.isCurrent) text += ' Školska godina je još u toku, pa iznosi nisu konačni.';
  return text;
}

function buildDocument(R, { settings, scope, placeLabel, user, printedAt }) {
  const cur = settings.currency;
  // Neprelomivi razmak, da "€" ne pada sam u novi red
  const money = (v) => `${h.amount(v)} ${cur}`;
  // Redoslijed kao u izvještajima Škole: najveći grad prvi, "Centralno odjeljenje" prvo u gradu.
  const bySize = (a, b) => b.students - a.students || String(a.name).localeCompare(String(b.name), 'bs');
  const centralFirst = (a, b) => (/^Centralno/i.test(b.name) - /^Centralno/i.test(a.name)) || String(a.name).localeCompare(String(b.name), 'bs');
  const P = R.P;
  const t = R.main.totals;
  const blocks = [];
  const periodText = P.kind === 'godina'
    ? `školsku ${h.schoolYearLabel(P.year, P.startMonth)}. godinu`
    : `${h.MONTH_NAMES[h.monthOf(P.month) - 1].toLowerCase()} ${P.month.slice(0, 4)}. godine`;
  const inPeriod = P.kind === 'godina' ? `U školskoj ${h.schoolYearLabel(P.year, P.startMonth)}. godini` : `U ${h.periodLocative(P.month)}`;
  const ongoing = P.isCurrent ? (P.kind === 'godina' ? ' (školska godina je u toku)' : ' (mjesec je u toku)') : '';

  // Brojevi učenika i odjeljenja u opsegu
  const byClass = scopeSql(scope, { branch: 'c.branch_id', department: 'c.department_id' });
  const deptCount = db.prepare(`SELECT COUNT(DISTINCT c.department_id) AS n FROM classes c WHERE c.active = 1 ${byClass.sql}`).get(...byClass.params).n;

  // Uvod
  const intro = String(settings.report_intro || '').trim();
  blocks.push({ type: 'p', text: intro || `Škola Kur'ana Časnog ${P.kind === 'godina' ? 'je u školskoj ' + h.schoolYearLabel(P.year, P.startMonth) + '. godini imala' : 'u ' + h.periodLocative(P.month) + ' ima'} **${t.students.toLocaleString('de-DE')} ${h.plural(t.students, 'učenika', 'učenika', 'učenika')}** u **${deptCount} ${h.plural(deptCount, 'odjeljenju', 'odjeljenja', 'odjeljenja')}**. U ovom izvještaju dat je pregled naplate članarine, dugovanja i primljenog novca${scope.branchId ? ` za ${placeLabel}` : ' po gradovima i odjeljenjima Škole'}.` });

  // Sažetak + poređenje
  const nowPct = pct(t.paid, t.due);
  const comparison = R.comparison;
  blocks.push({ type: 'summary', items: [
    { label: 'Zaduženo', value: money(t.due) },
    { label: 'Naplaćeno', value: money(t.paid), note: `${nowPct} %` },
    { label: 'Nenaplaćeno', value: money(t.remaining) },
    { label: 'Ukupan dug do danas', value: money(R.debtTotal), note: `${R.debtorCount.toLocaleString('de-DE')} učenika` },
  ] });

  // 1. Naplata članarine
  let n = 0;
  blocks.push({ type: 'h', text: `${++n}. Naplata članarine` });
  blocks.push({ type: 'p', text: `${inPeriod}${ongoing} zaduženo je ukupno **${money(t.due)}** članarine. Naplaćeno je **${money(t.paid)}**, odnosno **${nowPct} %**, a nenaplaćeno je ostalo **${money(t.remaining)}**. Članarinu je u potpunosti izmirilo ${t.paid_count.toLocaleString('de-DE')} od ${t.students.toLocaleString('de-DE')} učenika.` });
  if (R.transport && R.transport.due) {
    blocks.push({ type: 'p', text: `Od ukupnog zaduženja, **${money(t.due - R.transport.due)}** je članarina, a **${money(R.transport.due)}** doplata za prevoz kombijem, koji koristi ${R.transport.students.toLocaleString('de-DE')} ${h.plural(R.transport.students, 'učenik', 'učenika', 'učenika')}.` });
  }
  if (comparison) blocks.push({ type: 'p', text: comparison });

  // Pregledna tabela (gradovi / odjeljenja / grupe)
  const levelName = { branch: 'Grad', department: 'Odjeljenje', class: 'Grupa' }[R.level];
  blocks.push({
    type: 'table',
    head: [levelName, 'Učenika', 'Zaduženo', 'Naplaćeno', 'Nenaplaćeno', 'Naplata'],
    align: ['l', 'r', 'r', 'r', 'r', 'r'],
    rows: [...R.main.rows].sort(R.level === 'branch' ? bySize : centralFirst).map((r) => [r.name, String(r.students), h.amount(r.due), h.amount(r.paid), h.amount(r.remaining), `${pct(r.paid, r.due)} %`]),
    foot: ['Ukupno', String(t.students), h.amount(t.due), h.amount(t.paid), h.amount(t.remaining), `${nowPct} %`],
  });

  // 2. Naplata po odjeljenjima — spiskovi kao u njihovim izvještajima
  const listLevel = R.level === 'class' ? R.main : (R.detail && R.level === 'branch' ? R.detail : R.main);
  const unit = listLevel.level === 'class' ? 'Grupa' : 'Odjeljenje';
  const groupKey = listLevel.level === 'class' ? (r) => r.department_name || '' : (r) => r.branch_name || '';
  const groups = new Map();
  for (const r of listLevel.rows) {
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  blocks.push({ type: 'h', text: `${++n}. Naplata po ${listLevel.level === 'class' ? 'grupama' : 'odjeljenjima'}` });
  const ordered = [...groups.entries()]
    .map(([title, rows]) => [title, rows.sort(centralFirst), rows.reduce((a, r) => a + r.students, 0)])
    .sort((a, b) => b[2] - a[2]);
  for (const [title, rows] of ordered) {
    const sum = rows.reduce((a, r) => ({ students: a.students + r.students, due: a.due + r.due, paid: a.paid + r.paid, remaining: a.remaining + r.remaining }), { students: 0, due: 0, paid: 0, remaining: 0 });
    const label = (name) => (unit === 'Odjeljenje' && !/odjeljenje/i.test(name) ? `Odjeljenje ${name}` : name);
    blocks.push({
      type: 'group',
      title,
      items: rows.map((r) => `${label(r.name)}: ${r.students} ${h.plural(r.students, 'učenik', 'učenika', 'učenika')}, naplaćeno ${money(r.paid)} od ${money(r.due)} (${pct(r.paid, r.due)} %)${r.remaining ? `, nenaplaćeno ${money(r.remaining)}` : ''};`),
      total: `Ukupno – ${title || placeLabel}: ${sum.students} ${h.plural(sum.students, 'učenik', 'učenika', 'učenika')} u ${rows.length} ${h.plural(rows.length, unit === 'Grupa' ? 'grupi' : 'odjeljenju', unit === 'Grupa' ? 'grupe' : 'odjeljenja', unit === 'Grupa' ? 'grupa' : 'odjeljenja')}, naplaćeno ${money(sum.paid)} od ${money(sum.due)} (${pct(sum.paid, sum.due)} %).`,
    });
  }

  // Upisi i ispisi (kao "Upisi u toku školske godine" u godišnjem izvještaju Škole)
  const E = R.enrollment;
  if (E && (E.joined || E.left)) {
    // "upisan je 141 učenik", "upisana su 3 učenika", "upisano je 184 učenika"
    const moved = (k, verb, aux) => {
      const num = k.toLocaleString('de-DE');
      const [form, be] = h.plural(k, [`${verb}`, 'je'], [`${verb}a`, 'su'], [`${verb}o`, 'je']);
      const what = `${num} ${h.plural(k, 'učenik', 'učenika', 'učenika')}`;
      return aux ? `${form} ${be} **${what}**` : `${form} ${what}`;
    };
    const monthName = h.periodLocative;
    blocks.push({ type: 'h', text: `${++n}. Upisi i ispisi` });
    blocks.push({ type: 'p', text: `${inPeriod}${ongoing} ${E.joined ? moved(E.joined, 'upisan', true) : 'nije bilo novih upisa'}`
      + `${E.left ? `, a ${moved(E.left, 'ispisan', true)}` : ', a nije bilo ispisa'}.`
      + (E.months.length > 1 ? ' Po mjesecima:' : '') });
    if (E.months.length > 1) {
      blocks.push({ type: 'list', items: E.months.map((m, i) => `u ${monthName(m.period)}: ${m.joined ? moved(m.joined, 'upisan') : 'nije bilo upisa'}${m.left ? `, ${moved(m.left, 'ispisan')}` : ''}${i === E.months.length - 1 ? '.' : ';'}`) });
    }
    if (E.firstMonth) blocks.push({ type: 'note', text: `Učenici uneseni u ${monthName(E.firstMonth)}, kad je počelo vođenje evidencije, računaju se kao zatečeno stanje, a ne kao novi upis.` });
  }

  // Po nivoima nastave (programima)
  if (R.byProgram.length) {
    blocks.push({ type: 'h', text: `${++n}. Naplata po nivoima nastave` });
    blocks.push({
      type: 'table',
      head: ['Nivo / program', 'Učenika', 'Zaduženo', 'Naplaćeno', 'Nenaplaćeno', 'Naplata'],
      align: ['l', 'r', 'r', 'r', 'r', 'r'],
      rows: R.byProgram.map((r) => [r.name, String(r.students), h.amount(r.due), h.amount(r.paid), h.amount(r.remaining), `${pct(r.paid, r.due)} %`]),
      foot: ['Ukupno', String(R.byProgram.reduce((a, r) => a + r.students, 0)), h.amount(t.due), h.amount(t.paid), h.amount(t.remaining), `${nowPct} %`],
    });
  }

  // Kretanje naplate po mjesecima
  const trend = R.trend.filter((m) => m.due || m.paid);
  if (trend.length > 1) {
    blocks.push({ type: 'h', text: `${++n}. ${P.kind === 'godina' ? 'Naplata po mjesecima' : 'Kretanje naplate u posljednjim mjesecima'}` });
    blocks.push({
      type: 'table',
      head: ['Mjesec', 'Učenika', 'Zaduženo', 'Naplaćeno', 'Nije platilo', 'Naplata'],
      align: ['l', 'r', 'r', 'r', 'r', 'r'],
      rows: trend.map((m) => [h.periodLabel(m.period), String(m.students), h.amount(m.due), h.amount(m.paid), String(m.unpaid), `${pct(m.paid, m.due)} %`]),
      foot: ['Ukupno', '', h.amount(trend.reduce((a, m) => a + m.due, 0)), h.amount(trend.reduce((a, m) => a + m.paid, 0)), '', `${pct(trend.reduce((a, m) => a + m.paid, 0), trend.reduce((a, m) => a + m.due, 0))} %`],
    });
  }

  // Dugovanja
  blocks.push({ type: 'h', text: `${++n}. Dugovanja` });
  if (!R.debtorCount) {
    blocks.push({ type: 'p', text: `Na dan ${h.formatDate(printedAt)} nema neizmirenih članarina.` });
  } else {
    blocks.push({ type: 'p', text: `Na dan ${h.formatDate(printedAt)} članarinu duguje ukupno **${R.debtorCount.toLocaleString('de-DE')} učenika**, u ukupnom iznosu od **${money(R.debtTotal)}**. Od toga:` });
    blocks.push({ type: 'list', items: R.aging.map((a, i) =>
      `${['jedan mjesec', 'dva mjeseca', 'tri i više mjeseci'][i]} duguje ${a.students.toLocaleString('de-DE')} ${h.plural(a.students, 'učenik', 'učenika', 'učenika')} (${money(a.debt)})${i === 2 ? '.' : ';'}`) });
    const severe = R.aging[2];
    if (severe.students) blocks.push({ type: 'p', text: `Preporučuje se da koordinatori kontaktiraju roditelje ${severe.students.toLocaleString('de-DE')} ${h.plural(severe.students, 'učenika', 'učenika', 'učenika')} koji duguju tri i više mjeseci.` });
  }

  // Primljeni novac
  blocks.push({ type: 'h', text: `${++n}. Primljeni novac` });
  blocks.push({ type: 'p', text: `U periodu od ${h.formatDate(R.cashFrom)} do ${h.formatDate(R.cashTo)} primljeno je ukupno **${money(R.cash.total)}** u ${R.cash.count.toLocaleString('de-DE')} ${h.plural(R.cash.count, 'uplati', 'uplate', 'uplata')}, od čega gotovinom **${money(R.cash.gotovina)}**, a preko banke **${money(R.cash.banka + R.cash.ostalo)}**.` });
  const cashRows = R.cashByPlace || R.byPerson.map((p) => ({ name: p.name, n: p.count, total: p.total, gotovina: p.gotovina }));
  if (cashRows.length) {
    blocks.push({ type: 'list', items: cashRows.map((c, i) =>
      `${c.name || '—'}: ${money(c.total)} (gotovina ${money(c.gotovina)}, banka ${money(c.total - c.gotovina)})${i === cashRows.length - 1 ? '.' : ';'}`) });
  }
  blocks.push({ type: 'note', text: '"Naplaćeno" se odnosi na članarinu za navedeni period. "Primljeno" obuhvata sve uplate primljene u tom periodu, uključujući izmirenje starih dugova i plaćanja unaprijed.' });

  return {
    school: String(settings.school_name || '').toUpperCase(),
    title: P.kind === 'godina' ? `Godišnji finansijski izvještaj za ${periodText}` : `Finansijski izvještaj za ${periodText}`,
    subtitle: scope.branchId ? placeLabel : '',
    blocks,
    place: String(settings.report_place || '').trim() || 'Novom Pazaru',
    date: h.formatDate(printedAt),
    signer: String(settings.report_signer || '').trim() || user.name,
    fileName: `finansijski-izvjestaj-${P.slug}`,
  };
}

module.exports = { buildDocument, comparisonText };
