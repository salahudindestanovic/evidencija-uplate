// Mobilni meni
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-nav-toggle]')) document.body.classList.toggle('nav-open');
  else if (e.target.closest('[data-nav-close]')) document.body.classList.remove('nav-open');
});

// Klik na red tabele otvara zapis
document.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a, button, input, form')) window.location = row.dataset.href;
});

// Potvrda prije brisanja/storniranja i zaštita od duplog slanja
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
  // Storniranje uplate: razlog se upisuje u dnevnik promjena.
  if ('reason' in e.target.dataset) {
    let reason = '';
    while (reason.trim().length < 3) {
      reason = window.prompt('Razlog storniranja (npr. pogrešan mjesec, dvostruki unos):', reason);
      if (reason === null) { e.preventDefault(); return; }
    }
    e.target.querySelector('input[name=reason]').value = reason.trim();
  }
  const btn = e.target.querySelector('button[type=submit], button:not([type])');
  if (btn && e.target.method === 'post') setTimeout(() => { btn.disabled = true; }, 0);
});

// Brza pretraga liste (odabir učenika)
document.querySelectorAll('[data-filter-list]').forEach((input) => {
  const list = document.querySelector(input.dataset.filterList);
  const fold = (s) => s.toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '');
  input.addEventListener('input', () => {
    const q = fold(input.value.trim());
    list.querySelectorAll('[data-search]').forEach((el) => {
      el.style.display = !q || fold(el.dataset.search).includes(q) ? '' : 'none';
    });
  });
});

// Rekapitulacija na formi za uplatu
const payForm = document.querySelector('[data-pay-form]');
if (payForm) {
  const totals = payForm.querySelectorAll('[data-pay-total]');
  const counts = payForm.querySelectorAll('[data-pay-count]');
  const submits = payForm.querySelectorAll('[data-pay-submit]');
  const parse = (v) => {
    const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };
  const fmt = (n) => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const update = () => {
    let sum = 0;
    let n = 0;
    payForm.querySelectorAll('[data-pay-row]').forEach((row) => {
      const cb = row.querySelector('input[type=checkbox]');
      const amt = row.querySelector('input[type=text]');
      amt.disabled = !cb.checked;
      if (cb.checked) { sum += parse(amt.value); n += 1; }
    });
    totals.forEach((el) => { el.textContent = fmt(sum); });
    const m10 = n % 10;
    const m100 = n % 100;
    const form = m10 === 1 && m100 !== 11 ? 0 : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 1 : 2;
    const WORDS = { mjesec: ['mjesec', 'mjeseca', 'mjeseci'], 'učenik': ['učenik', 'učenika', 'učenika'] };
    counts.forEach((el) => { el.textContent = `${n} ${(WORDS[el.dataset.unit] || WORDS.mjesec)[form]}`; });
    submits.forEach((el) => { el.disabled = n === 0; });
  };
  payForm.addEventListener('input', update);
  payForm.addEventListener('change', update);
  update();
}

// Dijalog za izmjenu zaduženja
const chargeDialog = document.getElementById('charge-dialog');
if (chargeDialog) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-charge-edit]');
    if (btn) {
      const f = (name) => chargeDialog.querySelector(`[data-f="${name}"]`);
      f('label').textContent = btn.dataset.label;
      f('period').value = btn.dataset.period;
      f('amount').value = btn.dataset.amount;
      f('waived').checked = btn.dataset.waived === '1';
      chargeDialog.showModal();
      f('amount').select();
    } else if (e.target.closest('[data-dialog-close]')) {
      chargeDialog.close();
    }
  });
}

// Pretraga učenika dok se kuca (server vraća samo spisak)
document.querySelectorAll('[data-live-search]').forEach((form) => {
  const target = document.querySelector(form.dataset.liveSearch);
  const input = form.querySelector('input[name=q]');
  let timer;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      const url = `${form.action}?partial=1&q=${encodeURIComponent(input.value.trim())}`;
      const html = await fetch(url, { credentials: 'same-origin' }).then((r) => r.text());
      if (mine === seq) target.innerHTML = html;
    }, 200);
  });
});

// Plaćanje unaprijed: budući mjeseci su skriveni dok se ne zatraže
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-show-advance]');
  if (!btn) return;
  document.querySelectorAll('[data-advance]').forEach((row) => { row.hidden = false; });
  btn.closest('.panel-foot').remove();
});

// Instalacija na telefon (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

// "Prikaži sve" za skraćene tabele
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reveal]');
  if (!btn) return;
  btn.closest('.panel').querySelectorAll('[data-more]').forEach((row) => { row.hidden = false; });
  btn.closest('.panel-foot').remove();
});

// "Označi sve" u brzoj naplati grupe
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-check-all]');
  if (!btn) return;
  const form = btn.closest('form');
  const boxes = [...form.querySelectorAll('[data-pay-row] input[type=checkbox]')];
  const all = boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !all; });
  btn.textContent = all ? 'Označi sve' : 'Poništi sve';
  form.dispatchEvent(new Event('change'));
});

// Dijeljenje (priznanica, podsjetnik): sistemski meni za dijeljenje ili kopiranje teksta
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-share]');
  if (!btn) return;
  const text = btn.dataset.share;
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (err) { /* otkazano */ }
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    const old = btn.innerHTML;
    btn.textContent = 'Kopirano ✓';
    setTimeout(() => { btn.innerHTML = old; }, 1800);
  }
});
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn || !navigator.clipboard) return;
  await navigator.clipboard.writeText(btn.dataset.copy);
  const old = btn.innerHTML;
  btn.textContent = 'Kopirano ✓';
  setTimeout(() => { btn.innerHTML = old; }, 1800);
});

// Podsjetnik: linkovi prate izmijenjenu poruku; Viber prvo kopira poruku
const reminderText = document.querySelector('[data-reminder-text]');
if (reminderText) {
  const sync = () => document.querySelectorAll('[data-reminder-link]').forEach((a) => { a.href = a.dataset.reminderLink + encodeURIComponent(reminderText.value); });
  reminderText.addEventListener('input', sync);
  document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy-reminder], [data-copy-before]');
    if (!copyBtn || !navigator.clipboard) return;
    try { await navigator.clipboard.writeText(reminderText.value); } catch (err) { /* nije dozvoljeno */ }
    if (copyBtn.matches('[data-copy-reminder]')) {
      const old = copyBtn.innerHTML;
      copyBtn.textContent = 'Kopirano ✓';
      setTimeout(() => { copyBtn.innerHTML = old; }, 1800);
    }
  });
}

// Uvoz učenika: CSV datoteka se učitava u polje za tekst (Excel na Windowsu često snima CSV u kodnoj strani 1250);
// grupe u izboru prate odabrano odjeljenje.
const importForm = document.querySelector('[data-import-form]');
if (importForm) {
  const text = importForm.querySelector('[data-import-text]');
  const fileInput = importForm.querySelector('[data-import-file]');
  if (fileInput) fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (err) { content = new TextDecoder('windows-1250').decode(buf); }
    text.value = content;
    const details = text.closest('details');
    if (details) details.open = true;
  });
  const dep = importForm.querySelector('select[data-import-dep]');
  const classes = importForm.querySelector('[data-import-classes]');
  if (dep && classes) dep.addEventListener('change', () => {
    for (const o of classes.options) if (o.dataset.dep) o.hidden = o.dataset.dep !== dep.value;
    if (classes.selectedOptions[0]?.hidden) classes.value = '';
  });
}

// Cijene i dugovi: predlog mjesečnog iznosa prati štiklu "Prevoz"
const pricesForm = document.querySelector('[data-prices]');
if (pricesForm) {
  const base = Number(pricesForm.dataset.base) || 0;
  const tf = Number(pricesForm.dataset.transport) || 0;
  const fmt = (c) => (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  pricesForm.addEventListener('change', (e) => {
    if (!e.target.matches('[data-t]')) return;
    const row = e.target.closest('[data-row]');
    row.querySelector('[data-fee]').placeholder = fmt(base + (e.target.checked ? tf : 0));
  });
}
