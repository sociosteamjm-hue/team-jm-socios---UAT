const YEARS = [2026, 2027, 2028, 2029, 2030];
const STORAGE_KEY = 'team-jm-members-v1';
const API_URL = '/api/members';
let members = [];
let selectedYear = 2026;

const $ = (selector) => document.querySelector(selector);
const statusFor = (member, year) => {
  if (!member.name) return 'Sem dados';
  return member.dues?.[year] === 'Pago' ? 'Em dia' : 'Em falta';
};
function loadLocalMembers() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
async function loadMembers() {
  if (location.protocol === 'file:') return loadLocalMembers();
  const response = await fetch(API_URL);
  if (!response.ok) throw new Error('Não foi possível ler o Excel');
  return response.json();
}
async function saveMembers() {
  if (location.protocol === 'file:') { localStorage.setItem(STORAGE_KEY, JSON.stringify(members)); return; }
  const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(members) });
  if (!response.ok) throw new Error('Não foi possível guardar no Excel');
}
function nextNumber() { return members.length ? Math.max(...members.map((member) => member.number)) + 1 : 1; }
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

function exportData() { const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), members }, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'team-jm-registo-socios.json'; link.click(); URL.revokeObjectURL(link.href); showToast('Dados exportados com sucesso'); }
function switchView(view) { document.querySelectorAll('.view').forEach((section) => section.classList.remove('active-view')); $(`#${view}-view`).classList.add('active-view'); document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view)); $('#page-title').textContent = view === 'dashboard' ? 'Resumo de sócios' : view === 'members' ? 'Listagem de sócios' : 'Recibos'; }

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('[data-view-link]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.viewLink)));
$('#dashboard-year').addEventListener('change', (event) => { selectedYear = Number(event.target.value); render(); });
$('#search-input').addEventListener('input', renderMembers); $('#status-filter').addEventListener('change', renderMembers);
$('#receipt-member').addEventListener('change', fillReceipt); $('#receipt-name').addEventListener('input', updateReceiptName); $('#receipt-description').addEventListener('input', updateReceiptPreview); $('#receipt-amount').addEventListener('input', updateReceiptPreview); $('#receipt-type').addEventListener('change', updateReceiptPreview); $('#receipt-payment').addEventListener('change', updateReceiptPreview); $('#receipt-date').addEventListener('change', updateReceiptPreview); $('#receipt-date').value = new Date().toISOString().slice(0, 10); updateReceiptPreview(); $('#print-receipt').addEventListener('click', () => window.print());
$('#new-member-button').addEventListener('click', () => openModal()); $('#empty-new-button').addEventListener('click', () => openModal()); $('#export-button').addEventListener('click', exportData);
$('#close-modal').addEventListener('click', closeModal); $('#cancel-modal').addEventListener('click', closeModal); $('#member-modal').addEventListener('click', (event) => { if (event.target.id === 'member-modal') closeModal(); });
$('#member-form').addEventListener('submit', async (event) => { event.preventDefault(); const member = collectForm(); const index = members.findIndex((item) => item.id === member.id); const previous = [...members]; if (index >= 0) members[index] = member; else members.push(member); try { await saveMembers(); closeModal(); render(); showToast(index >= 0 ? 'Sócio atualizado no Excel' : 'Sócio adicionado ao Excel'); } catch (error) { members = previous; showToast(error.message); } });
$('#remove-member-button').addEventListener('click', async () => { const member = members.find((item) => item.id === $('#member-id').value); if (!member || !window.confirm(`Remover ${member.name}?`)) return; const previous = [...members]; member.removed = true; try { await saveMembers(); closeModal(); render(); showToast('Sócio removido do registo ativo'); } catch (error) { members = previous; showToast(error.message); } });
$('#members-table').addEventListener('click', (event) => { const button = event.target.closest('[data-edit]'); if (button) openModal(members.find((member) => member.id === button.dataset.edit)); });
render();
loadMembers().then((loadedMembers) => { members = loadedMembers; render(); }).catch((error) => showToast(error.message));
