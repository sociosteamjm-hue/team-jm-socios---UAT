const YEARS = [2026, 2027, 2028, 2029, 2030];
const STORAGE_KEY = 'team-jm-members-v1';
const API_URL = '/api/members';
let members = [];
let selectedYear = 2026;
const cloudDatabase = window.teamJmSupabase;
let authenticated = !cloudDatabase;
let loginInProgress = false;

const $ = (selector) => document.querySelector(selector);
const statusFor = (member, year) => {
  if (!member.name) return 'Sem dados';
  return member.dues?.[year] === 'Pago' ? 'Em dia' : 'Em falta';
};
function loadLocalMembers() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
async function loadMembers() {
  if (!cloudDatabase) return loadLocalMembers();
  if (!authenticated) return [];
  const { data, error } = await cloudDatabase.from('members').select('*').order('number');
  if (error) throw error;
  return data.map((member) => ({ id: member.id, number: member.number, name: member.name, contact: member.contact || '', nif: member.nif || '', locality: member.locality || '', address: member.address || '', postal: member.postal || '', email: member.email || '', paymentMode: member.payment_mode || '', date: member.registration_date || '', notes: member.notes || '', removed: member.removed || false, dues: member.dues || {} }));
}
async function refreshMembers() {
  try {
    members = await loadMembers();
    render();
  } catch (error) {
    showLogin(`Erro de ligação: ${error.message}`);
  }
}
function showLogin(message = '') {
  $('#login-screen').hidden = false;
  $('.app-shell').style.display = 'none';
  $('#login-error').textContent = message;
  if (loginInProgress) {
    loginInProgress = false;
  }
}
function showApplication() {
  authenticated = true;
  loginInProgress = false;
  $('#login-form').reset();
  $('#login-screen').hidden = true;
  $('.app-shell').style.display = '';
}
async function logout() {
  if (!cloudDatabase) {
    authenticated = false;
    members = [];
    render();
    showLogin('Sessão terminada.');
    return;
  }

  const { error } = await cloudDatabase.auth.signOut();
  if (error) {
    showToast(`Erro ao sair: ${error.message}`);
    return;
  }

  authenticated = false;
  members = [];
  render();
  showLogin('Sessão terminada.');
}
async function initializeAuthentication() {
  if (!cloudDatabase) {
    authenticated = true;
    showApplication();
    await refreshMembers();
    return;
  }

  const { data } = await cloudDatabase.auth.getSession();
  authenticated = Boolean(data.session);
  if (authenticated) {
    showApplication();
    await refreshMembers();
    return;
  }

  showLogin();
  cloudDatabase.auth.onAuthStateChange(async (_event, session) => {
    authenticated = Boolean(session);
    if (session) {
      showApplication();
      await refreshMembers();
    } else {
      showLogin();
      members = [];
      render();
    }
  });
}
async function saveMembers() {
  if (cloudDatabase) {
    if (!authenticated) throw new Error('É necessário iniciar sessão para guardar os dados.');
    const rows = members.map((member) => ({ id: member.id, number: member.number, name: member.name, contact: member.contact, nif: member.nif, locality: member.locality, address: member.address, postal: member.postal, email: member.email, payment_mode: member.paymentMode, registration_date: member.date || null, notes: member.notes, removed: member.removed || false, dues: member.dues || {}, updated_at: new Date().toISOString() }));
    const { error } = await cloudDatabase.from('members').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(members));
}
function nextNumber() { return members.length ? Math.max(...members.map((member) => Number(member.number) || 0)) + 1 : 1; }
async function resolveNextAvailableNumber() {
  if (!cloudDatabase) return nextNumber();
  try {
    const { data, error } = await cloudDatabase.from('members').select('number');
    if (error) throw error;
    const usedNumbers = (data || []).map((item) => Number(item.number)).filter((value) => Number.isFinite(value));
    return usedNumbers.length ? Math.max(...usedNumbers) + 1 : 1;
  } catch (_error) {
    return nextNumber();
  }
}
function formatDate(value) { if (!value) return ''; return new Intl.DateTimeFormat('pt-PT').format(new Date(`${value}T00:00:00`)); }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2400); }
function statusBadge(status) { const cls = status === 'Em dia' ? 'status-paid' : status === 'Em falta' ? 'status-unpaid' : status === 'Removido' ? 'status-removed' : 'status-empty'; return `<span class="status ${cls}">${status}</span>`; }

function renderDashboard() {
  const activeMembers = members.filter((member) => !member.removed);
  const total = activeMembers.filter((member) => member.name).length;
  const paid = activeMembers.filter((member) => statusFor(member, selectedYear) === 'Em dia').length;
  const unpaid = activeMembers.filter((member) => statusFor(member, selectedYear) === 'Em falta').length;
  $('#total-members').textContent = total;
  $('#paid-members').textContent = paid;
  $('#unpaid-members').textContent = unpaid;
  $('#paid-rate').textContent = `${total ? Math.round((paid / total) * 100) : 0}% do total`;
  $('#received-value').textContent = `${(paid * 12).toLocaleString('pt-PT')} €`;
  $('#year-bars').innerHTML = YEARS.map((year) => { const count = activeMembers.filter((member) => member.dues?.[year] === 'Pago').length; const width = total ? (count / total) * 100 : 0; return `<div class="bar-row"><span>${year}</span><div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div><span class="bar-value">${count} pagos</span></div>`; }).join('');
  const attention = activeMembers.filter((member) => statusFor(member, selectedYear) === 'Em falta').slice(0, 4);
  $('#attention-list').innerHTML = attention.length ? attention.map((member) => `<div class="attention-item"><div><div class="member-name">${escapeHtml(member.name)}</div><div class="member-meta">Sócio nº ${member.number}</div></div>${statusBadge('Em falta')}</div>`).join('') : `<div class="empty-state visible"><div class="empty-icon">✓</div><h3>Tudo regularizado</h3><p>Não há quotas em falta para ${selectedYear}.</p></div>`;
}
function renderMembers() {
  const search = $('#search-input').value.toLowerCase().trim();
  const filter = $('#status-filter').value;
  const filtered = members.filter((member) => { const matchesSearch = [member.name, member.nif, member.contact, member.locality].join(' ').toLowerCase().includes(search); const status = statusFor(member, selectedYear); const matchesFilter = filter === 'removed' ? member.removed : !member.removed && (filter === 'all' || (filter === 'empty' ? status === 'Sem dados' : status === filter)); return matchesSearch && matchesFilter; });
  $('#members-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'sócio' : 'sócios'}`;
  $('#members-table').innerHTML = filtered.map((member) => `<tr><td>${member.number}</td><td><strong>${escapeHtml(member.name || 'Sem nome')}</strong>${member.email ? `<div class="member-meta">${escapeHtml(member.email)}</div>` : ''}</td><td>${escapeHtml(member.contact || '—')}</td><td>${escapeHtml(member.locality || '—')}</td><td>${member.removed ? statusBadge('Removido') : statusBadge(statusFor(member, selectedYear))}</td><td>${member.removed ? '<span class="muted">—</span>' : member.dues?.[selectedYear] === 'Pago' ? statusBadge('Em dia') : '<span class="muted">Pendente</span>'}</td><td><button class="row-action" data-edit="${member.id}">Abrir</button></td></tr>`).join('');
  $('#empty-state').classList.toggle('visible', !filtered.length);
  $('.table-wrap').style.display = filtered.length ? 'block' : 'none';
}
function renderReceipts() { const select = $('#receipt-member'); const current = select.value; select.innerHTML = '<option value="">Selecionar sócio</option>' + members.filter((member) => !member.removed).map((member) => `<option value="${member.number}">${member.number} - ${escapeHtml(member.name)}</option>`).join(''); select.value = current; }
function fillReceipt() { const member = members.find((item) => String(item.number) === $('#receipt-member').value); $('#receipt-name').value = member?.name || ''; $('#receipt-nif').value = member?.nif || ''; $('#print-receipt-name').textContent = member?.name || 'Selecione um sócio'; $('#print-receipt-nif').textContent = member?.nif || '—'; $('#print-receipt-member').textContent = member ? member.number : '—'; }
function updateReceiptName() { $('#print-receipt-name').textContent = $('#receipt-name').value || 'Selecione um sócio'; }
function updateReceiptPreview() { const amount = Number($('#receipt-amount').value || 0); $('#print-receipt-description').textContent = $('#receipt-description').value || 'Quota'; $('#print-receipt-type').textContent = $('#receipt-type').value; $('#print-receipt-payment').textContent = $('#receipt-payment').value; $('#print-receipt-value').textContent = `${amount.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €`; $('#print-receipt-date').textContent = formatDate($('#receipt-date').value); }
function render() { $('#table-year').textContent = selectedYear; $('#table-year-header').textContent = selectedYear; renderDashboard(); renderMembers(); renderReceipts(); }
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

function openModal(member = null) {
  $('#member-form').reset(); $('#member-id').value = member?.id || ''; $('#modal-title').textContent = member ? 'Editar sócio' : 'Novo sócio';
  $('#remove-member-button').style.display = member ? 'inline-block' : 'none';
  if (member) { ['name','contact','nif','locality','address','postal','email','payment-mode','date','notes'].forEach((key) => { const field = $(`#member-${key}`); const property = key === 'payment-mode' ? 'paymentMode' : key; field.value = member[property] || ''; }); }
  $('#dues-grid').innerHTML = YEARS.map((year) => `<div class="due-item"><label for="due-${year}">${year}</label><select id="due-${year}"><option value="Pendente">Pendente</option><option value="Pago">Pago</option></select></div>`).join('');
  YEARS.forEach((year) => { $(`#due-${year}`).value = member?.dues?.[year] || 'Pendente'; });
  $('#member-modal').classList.add('open'); $('#member-modal').setAttribute('aria-hidden', 'false'); $('#member-name').focus();
}
function closeModal() { $('#member-modal').classList.remove('open'); $('#member-modal').setAttribute('aria-hidden', 'true'); }
function collectForm() { const existing = members.find((member) => member.id === $('#member-id').value); const member = { id: existing?.id || crypto.randomUUID(), number: existing?.number || nextNumber(), name: $('#member-name').value.trim(), contact: $('#member-contact').value.trim(), nif: $('#member-nif').value.trim(), locality: $('#member-locality').value.trim(), address: $('#member-address').value.trim(), postal: $('#member-postal').value.trim(), email: $('#member-email').value.trim(), paymentMode: $('#member-payment-mode').value, date: $('#member-date').value, notes: $('#member-notes').value.trim(), dues: Object.fromEntries(YEARS.map((year) => [year, $(`#due-${year}`).value])) }; return member; }

function exportData() { const rows = members.map((member) => ({ 'Nº Sócio': member.number, Nome: member.name, Contacto: member.contact, NIF: member.nif, Localidade: member.locality, 'Morada completa': member.address, 'Código Postal': member.postal, Email: member.email, 'Situação atual': member.removed ? 'Removido' : statusFor(member, new Date().getFullYear()), ...Object.fromEntries(YEARS.map((year) => [year, member.dues?.[year] || 'Pendente'])), 'Modo de pagamento': member.paymentMode, 'Data de inscrição': member.date, Observações: member.notes })); const workbook = XLSX.utils.book_new(); const sheet = XLSX.utils.json_to_sheet(rows); XLSX.utils.book_append_sheet(workbook, sheet, 'Listagem de Sócios'); XLSX.writeFile(workbook, `Socios_export_${new Date().toISOString().slice(0, 10)}.xlsx`); showToast('Excel exportado com sucesso'); }
function importData(file) { const reader = new FileReader(); reader.onload = async (event) => { try { const workbook = XLSX.read(event.target.result, { type: 'array', cellDates: true }); const usesMemberTemplate = workbook.SheetNames.includes('Listagem de Sócios'); const sheetName = usesMemberTemplate ? 'Listagem de Sócios' : workbook.SheetNames[0]; const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', range: usesMemberTemplate ? 2 : 0 }); const imported = rows.map((row, index) => { const get = (...keys) => { const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(row, candidate)); return key ? row[key] : ''; }; const date = get('Data de inscrição', 'Data'); return { id: crypto.randomUUID(), number: Number(get('Nº Sócio', 'Nº', 'Numero')) || index + 1, name: String(get('Nome', 'Nome completo')).trim(), contact: String(get('Contacto', 'Telefone')).trim(), nif: String(get('NIF', 'NIF / NIPC')).trim(), locality: String(get('Localidade')).trim(), address: String(get('Morada completa', 'Morada')).trim(), postal: String(get('Código Postal', 'Codigo Postal')).trim(), email: String(get('Email')).trim(), paymentMode: String(get('Modo de pagamento', 'Pagamento')).trim(), date: date instanceof Date ? date.toISOString().slice(0, 10) : String(date).trim(), notes: String(get('Observações', 'Notas')).trim(), removed: String(get('Situação atual')).toLowerCase() === 'removido', dues: Object.fromEntries(YEARS.map((year) => [year, String(get(String(year), year) || 'Pendente')]) ) }; }).filter((member) => member.name); if (!imported.length) throw new Error('Não foram encontrados sócios na folha selecionada'); members = imported; await saveMembers(); render(); showToast(`${imported.length} sócios importados do Excel`); } catch (error) { showToast(`Importação falhou: ${error.message}`); } }; reader.readAsArrayBuffer(file); }
function switchView(view) { document.querySelectorAll('.view').forEach((section) => section.classList.remove('active-view')); $(`#${view}-view`).classList.add('active-view'); document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view)); $('#page-title').textContent = view === 'dashboard' ? 'Resumo de sócios' : view === 'members' ? 'Listagem de sócios' : 'Recibos'; }

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('[data-view-link]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.viewLink)));
$('#dashboard-year').addEventListener('change', (event) => { selectedYear = Number(event.target.value); render(); });
$('#search-input').addEventListener('input', renderMembers); $('#status-filter').addEventListener('change', renderMembers);
$('#import-button').addEventListener('click', () => $('#import-file').click()); $('#import-file').addEventListener('change', (event) => { if (event.target.files[0]) importData(event.target.files[0]); event.target.value = ''; });
$('#receipt-member').addEventListener('change', fillReceipt); $('#receipt-name').addEventListener('input', updateReceiptName); $('#receipt-description').addEventListener('input', updateReceiptPreview); $('#receipt-amount').addEventListener('input', updateReceiptPreview); $('#receipt-type').addEventListener('change', updateReceiptPreview); $('#receipt-payment').addEventListener('change', updateReceiptPreview); $('#receipt-date').addEventListener('change', updateReceiptPreview); $('#receipt-date').value = new Date().toISOString().slice(0, 10); updateReceiptPreview(); $('#print-receipt').addEventListener('click', () => window.print());
$('#new-member-button').addEventListener('click', () => openModal()); $('#empty-new-button').addEventListener('click', () => openModal()); $('#export-button').addEventListener('click', exportData); $('#logout-button').addEventListener('click', logout);
$('#close-modal').addEventListener('click', closeModal); $('#cancel-modal').addEventListener('click', closeModal); $('#member-modal').addEventListener('click', (event) => { if (event.target.id === 'member-modal') closeModal(); });
$('#member-form').addEventListener('submit', async (event) => { event.preventDefault(); const member = collectForm(); const index = members.findIndex((item) => item.id === member.id); const previous = [...members]; if (index >= 0) members[index] = member; else {
    members.push(member);
    if (!member.id || !members.some((item) => item.id === member.id && item.number === member.number)) {
      const nextNumberValue = await resolveNextAvailableNumber();
      member.number = nextNumberValue;
      members[members.length - 1] = member;
    }
  }
  try { await saveMembers(); closeModal(); render(); showToast(index >= 0 ? 'Sócio atualizado no Excel' : 'Sócio adicionado ao Excel'); } catch (error) { members = previous; showToast(error.message); } });
$('#remove-member-button').addEventListener('click', async () => { const member = members.find((item) => item.id === $('#member-id').value); if (!member || !window.confirm(`Remover ${member.name}?`)) return; const previous = [...members]; member.removed = true; try { await saveMembers(); closeModal(); render(); showToast('Sócio removido do registo ativo'); } catch (error) { members = previous; showToast(error.message); } });
$('#members-table').addEventListener('click', (event) => { const button = event.target.closest('[data-edit]'); if (button) openModal(members.find((member) => member.id === button.dataset.edit)); });
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  if (loginInProgress) return;

  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  if (!email || !password) {
    $('#login-error').textContent = 'Preenche o email e a palavra-passe.';
    return;
  }

  if (!cloudDatabase || !cloudDatabase.auth) {
    $('#login-error').textContent = 'Autenticação não configurada. Verifica a ligação ao Supabase.';
    return;
  }

  loginInProgress = true;
  const submitButton = $('#login-form button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'A entrar...';
  $('#login-error').textContent = 'A entrar...';

  try {
    const { data, error } = await cloudDatabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    authenticated = Boolean(data?.session);
    if (!authenticated) throw new Error('Não foi criada uma sessão válida.');

    showApplication();
    await refreshMembers();
  } catch (error) {
    showLogin(`Não foi possível entrar: ${error.message}`);
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Entrar';
    }
  }
});
render();
initializeAuthentication().catch((error) => showLogin(`Erro de ligação: ${error.message}`));
