(function () {
  'use strict';

  var ROLE_LABELS = {
    admin: 'Administrador',
    staff: 'Equipa',
    viewer: 'Consulta'
  };

  var PUBLIC_REQUEST_TYPE_LABELS = {
    membership: 'Adesão de sócio',
    quota: 'Pagamento de quota',
    donation: 'Donativo'
  };

  var PUBLIC_REQUEST_STATUS_LABELS = {
    pending: 'Pendente',
    approved: 'Aprovado',
    rejected: 'Rejeitado'
  };

  var CAPABILITIES = {
    admin: {
      manageMembers: true,
      manageReceipts: true,
      printReceipts: true,
      managePublicRequests: true,
      importMembers: true,
      exportData: true
    },
    staff: {
      manageMembers: true,
      manageReceipts: true,
      printReceipts: true,
      managePublicRequests: true,
      importMembers: false,
      exportData: false
    },
    viewer: {
      manageMembers: false,
      manageReceipts: false,
      printReceipts: true,
      managePublicRequests: false,
      importMembers: false,
      exportData: false
    }
  };

  var state = {
    client: null,
    xlsx: null,
    config: null,
    session: null,
    profile: null,
    members: [],
    receipts: [],
    publicRequests: [],
    selectedYear: null,
    years: [],
    importDraft: null,
    lastIssuedReceipt: null,
    selectedPublicRequest: null,
    activeModal: null,
    focusBeforeModal: null,
    authQueue: Promise.resolve(),
    authUserId: null,
    pendingMember: false,
    pendingReceipt: false,
    pendingPublicRequest: false,
    pendingImport: false,
    toastTimer: null,
    denyingAccess: false
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function listen(target, eventName, handler) {
    if (target) target.addEventListener(eventName, handler);
  }

  function valueOf(id) {
    var element = byId(id);
    return element ? String(element.value || '').trim() : '';
  }

  function setText(id, value) {
    var element = byId(id);
    if (element) element.textContent = value == null ? '' : String(value);
  }

  function setValue(id, value) {
    var element = byId(id);
    if (element) element.value = value == null ? '' : String(value);
  }

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = Boolean(hidden);
    element.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  }

  function setScreen(screenId) {
    ['loading-screen', 'setup-screen', 'login-screen', 'app-shell'].forEach(function (id) {
      setHidden(byId(id), id !== screenId);
    });
  }

  function showToast(message, isError) {
    var toast = byId('toast');
    if (!toast) return;
    window.clearTimeout(state.toastTimer);
    toast.textContent = String(message);
    toast.classList.toggle('toast--error', Boolean(isError));
    toast.classList.add('toast--visible');
    toast.setAttribute('role', isError ? 'alert' : 'status');
    state.toastTimer = window.setTimeout(function () {
      toast.classList.remove('toast--visible');
    }, 4500);
  }

  function explainError(error, fallback) {
    var code = error && error.code ? String(error.code) : '';
    var message = error && error.message ? String(error.message).toLowerCase() : '';
    if (message.indexOf('invalid login credentials') >= 0) return 'Email ou palavra-passe incorretos.';
    if (message.indexOf('email not confirmed') >= 0) return 'Confirme o email antes de iniciar sessão.';
    if (code === '23505') return 'Já existe um registo com estes dados únicos.';
    if (code === '42501' || message.indexOf('row-level security') >= 0) {
      return 'A sua conta não tem permissão para esta operação.';
    }
    if (message.indexOf('failed to fetch') >= 0 || message.indexOf('network') >= 0) {
      return 'Não foi possível contactar o serviço. Confirme a ligação e tente novamente.';
    }
    return fallback || 'Ocorreu um erro inesperado. Tente novamente.';
  }

  function failClosed(message) {
    state.session = null;
    state.profile = null;
    state.members = [];
    state.receipts = [];
    state.publicRequests = [];
    disableAllActions();
    var setup = byId('setup-screen');
    if (setup) {
      setScreen('setup-screen');
      setText('setup-message', message);
      setText('setup-error', message);
    } else {
      setScreen('login-screen');
      setText('login-error', message);
      var loginForm = byId('login-form');
      if (loginForm) {
        all('input, button', loginForm).forEach(function (control) {
          control.disabled = true;
        });
      }
    }
  }

  function disableAllActions() {
    [
      'import-button',
      'export-button',
      'new-member-button',
      'empty-new-button',
      'issue-receipt-button',
      'print-receipt',
      'confirm-import-button',
      'remove-member-button',
      'restore-member-button',
      'approve-public-request',
      'reject-public-request'
    ].forEach(function (id) {
      var control = byId(id);
      if (control) control.disabled = true;
    });
  }

  function readConfig() {
    var config = window.TEAM_JM_UAT_CONFIG;
    if (!config || typeof config !== 'object') {
      throw new Error('A configuração UAT não foi carregada.');
    }

    var url = String(config.supabaseUrl || '').trim();
    var key = String(config.supabaseAnonKey || '').trim();
    var isPlaceholder =
      !url ||
      !key ||
      /SEU-PROJETO|YOUR|EXEMPLO/i.test(url) ||
      /SUA_CHAVE|YOUR|EXEMPLO/i.test(key);

    if (isPlaceholder || url.indexOf('https://') !== 0) {
      throw new Error('Preencha a URL e a chave pública do projeto Supabase de UAT.');
    }

    var annualFee = Number(config.annualFee);
    var startYear = Number(config.startYear);
    var maxImportRows = Number(config.maxImportRows);
    var pageSize = Number(config.pageSize || 500);

    if (!Number.isFinite(annualFee) || annualFee <= 0) {
      throw new Error('O valor anual da quota na configuração UAT não é válido.');
    }
    if (!Number.isInteger(startYear) || startYear < 1900 || startYear > 2200) {
      throw new Error('O ano inicial na configuração UAT não é válido.');
    }
    if (!Number.isInteger(maxImportRows) || maxImportRows < 1) {
      throw new Error('O limite de linhas de importação não é válido.');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) pageSize = 500;

    return {
      supabaseUrl: url,
      supabaseAnonKey: key,
      annualFee: annualFee,
      startYear: startYear,
      maxImportRows: maxImportRows,
      pageSize: pageSize
    };
  }

  function configuredYears() {
    var currentYear = new Date().getFullYear();
    var finalYear = Math.max(currentYear, state.config.startYear + 4);
    var years = [];
    for (var year = state.config.startYear; year <= finalYear; year += 1) years.push(year);
    return years;
  }

  function capabilities() {
    return CAPABILITIES[state.profile && state.profile.role] || CAPABILITIES.viewer;
  }

  function can(capability) {
    return Boolean(capabilities()[capability]);
  }

  async function boot() {
    bindUi();
    setScreen('loading-screen');

    try {
      var supabaseSdk = window.supabase || window.Supabase;
      var sheetJsSdk = window.XLSX || window.SheetJS;
      if (!supabaseSdk || typeof supabaseSdk.createClient !== 'function') {
        throw new Error('A biblioteca local do Supabase não foi carregada.');
      }
      if (!sheetJsSdk || !sheetJsSdk.utils || typeof sheetJsSdk.read !== 'function') {
        throw new Error('A biblioteca local do SheetJS não foi carregada.');
      }

      state.config = readConfig();
      state.xlsx = sheetJsSdk;
      state.years = configuredYears();
      state.selectedYear = state.years.indexOf(new Date().getFullYear()) >= 0
        ? new Date().getFullYear()
        : state.years[0];
      initializeReceiptForm();

      state.client = supabaseSdk.createClient(
        state.config.supabaseUrl,
        state.config.supabaseAnonKey,
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
          }
        }
      );

      state.client.auth.onAuthStateChange(function (_event, session) {
        window.setTimeout(function () {
          queueAuthState(session);
        }, 0);
      });

      var sessionResult = await state.client.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      await queueAuthState(sessionResult.data.session);
    } catch (error) {
      failClosed(error && error.message ? error.message : 'Não foi possível iniciar a aplicação UAT.');
    }
  }

  function queueAuthState(session) {
    state.authQueue = state.authQueue
      .catch(function () {
        return undefined;
      })
      .then(function () {
        return applyAuthState(session);
      });
    return state.authQueue;
  }

  async function applyAuthState(session) {
    if (!session || !session.user) {
      state.session = null;
      state.profile = null;
      state.authUserId = null;
      state.members = [];
      state.receipts = [];
      state.publicRequests = [];
      state.lastIssuedReceipt = null;
      state.selectedPublicRequest = null;
      closeAllModals();
      clearLoginPending();
      setScreen('login-screen');
      setText('login-error', '');
      return;
    }

    if (state.authUserId === session.user.id && state.profile) {
      state.session = session;
      return;
    }

    state.session = session;
    setScreen('loading-screen');

    var roleResult = await state.client
      .from('app_users')
      .select('user_id, role, display_name')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (roleResult.error) {
      await denyAuthenticatedUser('Não foi possível confirmar o perfil de acesso desta conta.');
      return;
    }

    var profile = roleResult.data;
    if (!profile || !Object.prototype.hasOwnProperty.call(CAPABILITIES, profile.role)) {
      await denyAuthenticatedUser('Esta conta ainda não tem um perfil autorizado na aplicação.');
      return;
    }

    state.profile = profile;
    state.authUserId = session.user.id;
    clearLoginPending();
    applyRoleToUi();

    try {
      await refreshData();
      setScreen('app-shell');
      switchView('dashboard');
    } catch (error) {
      state.members = [];
      state.receipts = [];
      state.publicRequests = [];
      renderAll();
      setScreen('app-shell');
      showToast(explainError(error, 'Não foi possível carregar os dados.'), true);
    }
  }

  async function denyAuthenticatedUser(message) {
    state.profile = null;
    state.authUserId = null;
    state.members = [];
    state.receipts = [];
    state.publicRequests = [];
    if (state.denyingAccess) return;
    state.denyingAccess = true;
    try {
      await state.client.auth.signOut();
    } catch (_error) {
      // O acesso continua fechado mesmo quando o encerramento remoto falha.
    } finally {
      state.denyingAccess = false;
      clearLoginPending();
      setScreen('login-screen');
      setText('login-error', message);
    }
  }

  async function fetchAllRows(table, orderColumn, ascending) {
    var rows = [];
    var from = 0;
    var pageSize = state.config.pageSize;

    while (true) {
      var query = state.client
        .from(table)
        .select('*')
        .order(orderColumn, { ascending: ascending });
      var result = await query.range(from, from + pageSize - 1);
      if (result.error) throw result.error;

      var page = Array.isArray(result.data) ? result.data : [];
      rows = rows.concat(page);
      if (page.length < pageSize) break;
      from += pageSize;
    }

    return rows;
  }

  async function refreshData() {
    var results = await Promise.all([
      fetchAllRows('members', 'member_number', true),
      fetchAllRows('receipts', 'receipt_number', false),
      can('managePublicRequests')
        ? fetchAllRows('public_requests', 'submitted_at', false)
        : Promise.resolve([])
    ]);
    state.members = results[0].map(normalizeMember);
    state.receipts = results[1].map(normalizeReceipt);
    state.publicRequests = results[2].map(normalizePublicRequest);
    renderAll();
  }

  async function refreshMembers() {
    state.members = (await fetchAllRows('members', 'member_number', true)).map(normalizeMember);
    renderAll();
  }

  function normalizeMember(row) {
    var copy = Object.assign({}, row || {});
    copy.member_number = Number(copy.member_number);
    copy.removed = Boolean(copy.removed);
    copy.dues = copy.dues && typeof copy.dues === 'object' && !Array.isArray(copy.dues)
      ? Object.assign({}, copy.dues)
      : {};
    return copy;
  }

  function normalizeReceipt(row) {
    var copy = Object.assign({}, row || {});
    copy.receipt_number = Number(copy.receipt_number);
    copy.member_number = copy.member_number == null || copy.member_number === ''
      ? null
      : Number(copy.member_number);
    copy.amount = Number(copy.amount);
    copy.quota_years = normalizeQuotaYears(copy.quota_years, copy.quota_year);
    copy.quota_year = copy.quota_years.length ? copy.quota_years[0] : null;
    return copy;
  }

  function normalizePublicRequest(row) {
    var copy = Object.assign({}, row || {});
    copy.request_number = Number(copy.request_number);
    copy.member_number = copy.member_number == null || copy.member_number === ''
      ? null
      : Number(copy.member_number);
    copy.quota_year = copy.quota_year == null || copy.quota_year === ''
      ? null
      : Number(copy.quota_year);
    copy.amount = copy.amount == null || copy.amount === '' ? null : Number(copy.amount);
    return copy;
  }

  function normalizeQuotaYears(value, legacyYear) {
    var values = [];

    if (Array.isArray(value)) {
      values = value.slice();
    } else if (typeof value === 'string' && value.trim()) {
      values = value
        .trim()
        .replace(/^[{[]|[}\]]$/g, '')
        .split(',');
    }

    if (!values.length && legacyYear != null && legacyYear !== '') values.push(legacyYear);

    return values
      .map(function (year) { return Number(year); })
      .filter(function (year, index, allYears) {
        return Number.isInteger(year) &&
          year >= 1900 &&
          year <= 2200 &&
          allYears.indexOf(year) === index;
      })
      .sort(function (a, b) { return a - b; });
  }

  function normalizeDue(value) {
    var normalized = canonicalText(value);
    if (!normalized) return '';
    if (['pago', 'paga', 'emdia', 'sim', 'paid', 'ok'].indexOf(normalized) >= 0) return 'Pago';
    if (
      ['emfalta', 'pendente', 'naopago', 'nao', 'unpaid', 'porpagar'].indexOf(normalized) >= 0
    ) {
      return 'Pendente';
    }
    return null;
  }

  function statusFor(member, year) {
    var due = normalizeDue(member && member.dues ? member.dues[String(year)] : '');
    if (!due) return 'Sem dados';
    return due === 'Pago' ? 'Em dia' : 'Em falta';
  }

  function euro(value) {
    return Number(value || 0).toLocaleString('pt-PT', {
      style: 'currency',
      currency: 'EUR'
    });
  }

  function dateForDisplay(value) {
    if (!value) return '—';
    var parts = String(value).slice(0, 10).split('-');
    if (parts.length !== 3) return String(value);
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  function dateTimeForDisplay(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('pt-PT', {
      dateStyle: 'short',
      timeStyle: 'short'
    });
  }

  function createElement(tag, options) {
    var element = document.createElement(tag);
    var settings = options || {};
    if (settings.className) element.className = settings.className;
    if (settings.text != null) element.textContent = String(settings.text);
    if (settings.type) element.type = settings.type;
    if (settings.value != null) element.value = String(settings.value);
    if (settings.name) element.name = settings.name;
    if (settings.id) element.id = settings.id;
    return element;
  }

  function statusBadge(status) {
    var classes = {
      'Em dia': 'paid',
      'Pago': 'paid',
      'Em falta': 'unpaid',
      'Pendente': 'unpaid',
      'Sem dados': 'empty',
      'Removido': 'removed'
    };
    var key = classes[status] || 'neutral';
    var span = createElement('span', {
      className: 'status status-' + (key || 'empty'),
      text: status
    });
    return span;
  }

  function renderAll() {
    if (!state.config) return;
    renderYearControls();
    renderDashboard();
    renderMembers();
    renderReceiptMembers();
    renderReceiptYearOptions();
    renderReceiptHistory();
    renderPublicRequests();
    renderFeeLabels();
    if (!state.lastIssuedReceipt) renderDraftReceipt();
  }

  function renderYearControls() {
    var dashboardYear = byId('dashboard-year');
    if (dashboardYear) {
      var previous = String(state.selectedYear);
      dashboardYear.replaceChildren();
      state.years.forEach(function (year) {
        var option = createElement('option', { text: year, value: year });
        dashboardYear.appendChild(option);
      });
      dashboardYear.value = previous;
      if (!dashboardYear.value) dashboardYear.value = String(state.years[0]);
    }

    setText('table-year', state.selectedYear);
    setText('table-year-header', state.selectedYear);
  }

  function renderFeeLabels() {
    all('[data-annual-fee]').forEach(function (element) {
      element.textContent = euro(state.config.annualFee);
    });
    setText('annual-fee', euro(state.config.annualFee));
  }

  function activeMembers() {
    return state.members.filter(function (member) {
      return !member.removed;
    });
  }

  function renderDashboard() {
    var active = activeMembers();
    var paid = active.filter(function (member) {
      return statusFor(member, state.selectedYear) === 'Em dia';
    }).length;
    var missing = active.filter(function (member) {
      return statusFor(member, state.selectedYear) === 'Em falta';
    }).length;
    var unrecorded = active.filter(function (member) {
      return statusFor(member, state.selectedYear) === 'Sem dados';
    }).length;
    var receiptsInYear = state.receipts.filter(function (receipt) {
      return String(receipt.receipt_date || '').slice(0, 4) === String(state.selectedYear);
    });
    var receivedInYear = receiptsInYear.reduce(function (total, receipt) {
      return total + (Number.isFinite(Number(receipt.amount)) ? Number(receipt.amount) : 0);
    }, 0);

    setText('total-members', active.length);
    setText('paid-members', paid);
    setText('unpaid-members', missing);
    setText('unrecorded-members', unrecorded);
    setText('receipt-count', receiptsInYear.length);
    setText('paid-rate', active.length ? Math.round((paid / active.length) * 100) + '% do total' : '0% do total');
    setText('received-value', euro(receivedInYear));

    var yearBars = byId('year-bars');
    if (yearBars) {
      yearBars.replaceChildren();
      var max = Math.max(
        1,
        active.length,
        state.years.reduce(function (current, year) {
          var count = active.filter(function (member) {
            return statusFor(member, year) === 'Em dia';
          }).length;
          return Math.max(current, count);
        }, 0)
      );

      state.years.forEach(function (year) {
        var count = active.filter(function (member) {
          return statusFor(member, year) === 'Em dia';
        }).length;
        var row = createElement('div', { className: 'year-bar-row' });
        row.appendChild(createElement('span', { text: year }));
        var track = createElement('div', { className: 'year-bar-track' });
        var fill = createElement('div', { className: 'year-bar-fill' });
        fill.style.width = Math.round((count / max) * 100) + '%';
        fill.setAttribute('aria-label', year + ': ' + count + ' quotas pagas');
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(createElement('strong', { text: count }));
        yearBars.appendChild(row);
      });
    }

    var attention = byId('attention-list');
    if (attention) {
      attention.replaceChildren();
      var needsAttention = active.filter(function (member) {
        return statusFor(member, state.selectedYear) === 'Em falta';
      }).slice(0, 8);

      if (!needsAttention.length) {
        attention.appendChild(createElement('p', {
          className: 'muted',
          text: 'Não existem quotas em falta neste ano.'
        }));
      } else {
        needsAttention.forEach(function (member) {
          var item = createElement('div', { className: 'attention-item' });
          var identity = createElement('div');
          identity.appendChild(createElement('strong', { text: member.name || 'Sem nome' }));
          identity.appendChild(createElement('span', {
            className: 'muted',
            text: 'Sócio n.º ' + member.member_number
          }));
          item.appendChild(identity);
          item.appendChild(statusBadge('Em falta'));
          attention.appendChild(item);
        });
      }
    }
  }

  function filteredMembers() {
    var search = canonicalText(valueOf('search-input'));
    var filter = valueOf('status-filter') || 'all';
    return state.members.filter(function (member) {
      var searchable = canonicalText([
        member.name,
        member.nif,
        member.contact,
        member.locality,
        member.email,
        member.member_number
      ].join(' '));
      if (search && searchable.indexOf(search) < 0) return false;
      if (filter === 'removed') return member.removed;
      if (member.removed) return false;
      if (filter === 'all') return true;
      if (filter === 'empty') return statusFor(member, state.selectedYear) === 'Sem dados';
      return statusFor(member, state.selectedYear) === filter;
    });
  }

  function appendCell(row, content) {
    var cell = document.createElement('td');
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content == null || content === '' ? '—' : String(content);
    row.appendChild(cell);
    return cell;
  }

  function renderMembers() {
    var body = byId('members-table');
    if (!body) return;
    var members = filteredMembers();
    body.replaceChildren();

    members.forEach(function (member) {
      var row = document.createElement('tr');
      if (member.removed) row.classList.add('removed-row');
      appendCell(row, member.member_number);

      var identity = createElement('div', { className: 'member-identity' });
      identity.appendChild(createElement('strong', { text: member.name || 'Sem nome' }));
      if (member.email) {
        identity.appendChild(createElement('div', {
          className: 'member-meta',
          text: member.email
        }));
      }
      appendCell(row, identity);
      appendCell(row, member.contact || '—');
      appendCell(row, member.locality || '—');
      appendCell(row, statusBadge(member.removed ? 'Removido' : statusFor(member, state.selectedYear)));

      if (member.removed) {
        appendCell(row, createElement('span', { className: 'muted', text: '—' }));
      } else {
        var due = statusFor(member, state.selectedYear);
        appendCell(row, due === 'Sem dados'
          ? createElement('span', { className: 'muted', text: 'Sem dados' })
          : statusBadge(due));
      }

      var action = createElement('button', {
        className: 'row-action',
        text: can('manageMembers') ? 'Abrir' : 'Ver',
        type: 'button'
      });
      action.dataset.edit = member.id;
      action.setAttribute('aria-label', (can('manageMembers') ? 'Abrir ' : 'Ver ') + (member.name || 'sócio'));
      appendCell(row, action);
      body.appendChild(row);
    });

    setText('members-count', members.length + (members.length === 1 ? ' sócio' : ' sócios'));
    var empty = byId('empty-state');
    if (empty) empty.hidden = members.length !== 0;
  }

  function renderReceiptMembers() {
    var select = byId('receipt-member');
    if (!select) return;
    var previous = select.value;
    select.replaceChildren();
    select.appendChild(createElement('option', {
      text: valueOf('receipt-type') === 'Donativo'
        ? 'Sem sócio — doador externo'
        : 'Selecionar sócio',
      value: ''
    }));
    activeMembers().forEach(function (member) {
      select.appendChild(createElement('option', {
        text: member.member_number + ' — ' + (member.name || 'Sem nome'),
        value: member.id
      }));
    });
    select.value = previous;
    updateReceiptMemberRequirement();
  }

  function renderReceiptHistory() {
    var container = byId('receipt-history');
    if (!container) return;
    container.replaceChildren();

    state.receipts.forEach(function (receipt) {
      if (container.tagName === 'TBODY') {
        var row = document.createElement('tr');
        appendCell(row, receipt.receipt_number);
        appendCell(row, dateForDisplay(receipt.receipt_date));
        appendCell(row, receipt.member_number || '—');
        appendCell(row, receipt.payer_name || '—');
        appendCell(row, receipt.receipt_type || '—');
        appendCell(row, quotaYearsForDisplay(receipt));
        appendCell(row, euro(receipt.amount));
        var previewButton = createElement('button', {
          className: 'row-action',
          text: 'Pré-visualizar',
          type: 'button'
        });
        previewButton.dataset.receiptPreview = String(receipt.receipt_number);
        previewButton.setAttribute(
          'aria-label',
          'Pré-visualizar recibo n.º ' + receipt.receipt_number + ' para reimpressão'
        );
        appendCell(row, previewButton);
        container.appendChild(row);
      } else {
        var item = createElement('article', { className: 'receipt-history-item' });
        item.appendChild(createElement('strong', {
          text: 'Recibo n.º ' + receipt.receipt_number
        }));
        item.appendChild(createElement('span', {
          text: (receipt.payer_name || '—') + ' · ' + dateForDisplay(receipt.receipt_date)
        }));
        item.appendChild(createElement('span', {
          text: receipt.receipt_type === 'Quota'
            ? 'Quota: ' + quotaYearsForDisplay(receipt)
            : (receipt.receipt_type || '—')
        }));
        item.appendChild(createElement('span', { text: euro(receipt.amount) }));
        var itemPreviewButton = createElement('button', {
          className: 'row-action',
          text: 'Pré-visualizar',
          type: 'button'
        });
        itemPreviewButton.dataset.receiptPreview = String(receipt.receipt_number);
        item.appendChild(itemPreviewButton);
        container.appendChild(item);
      }
    });

    if (!state.receipts.length) {
      if (container.tagName === 'TBODY') {
        var emptyRow = document.createElement('tr');
        var emptyCell = createElement('td', {
          className: 'empty-table-cell',
          text: 'Ainda não existem recibos emitidos.'
        });
        emptyCell.colSpan = 8;
        emptyRow.appendChild(emptyCell);
        container.appendChild(emptyRow);
      } else {
        container.appendChild(createElement('p', {
          className: 'muted',
          text: 'Ainda não existem recibos emitidos.'
        }));
      }
    }
    var selectedYearCount = state.receipts.filter(function (receipt) {
      return String(receipt.receipt_date || '').slice(0, 4) === String(state.selectedYear);
    }).length;
    setText('receipt-count', selectedYearCount);
  }

  function publicRequestTypeLabel(type) {
    return PUBLIC_REQUEST_TYPE_LABELS[type] || 'Pedido';
  }

  function publicRequestStatusLabel(status) {
    return PUBLIC_REQUEST_STATUS_LABELS[status] || 'Desconhecido';
  }

  function publicRequestStatusBadge(status) {
    return createElement('span', {
      className: 'status status-request-' + (status || 'pending'),
      text: publicRequestStatusLabel(status)
    });
  }

  function filteredPublicRequests() {
    var filter = valueOf('request-status-filter') || 'pending';
    if (filter === 'all') return state.publicRequests.slice();
    return state.publicRequests.filter(function (request) {
      return request.status === filter;
    });
  }

  function renderPublicRequests() {
    var body = byId('public-requests-table');
    var pendingCount = state.publicRequests.filter(function (request) {
      return request.status === 'pending';
    }).length;
    var navCount = byId('pending-request-count');
    if (navCount) {
      navCount.textContent = String(pendingCount);
      navCount.hidden = pendingCount === 0 || !can('managePublicRequests');
    }
    if (!body) return;

    body.replaceChildren();
    var requests = filteredPublicRequests();
    requests.forEach(function (request) {
      var row = document.createElement('tr');
      appendCell(row, 'PED-' + request.request_number);
      appendCell(row, dateTimeForDisplay(request.submitted_at));
      appendCell(row, publicRequestTypeLabel(request.request_type));
      appendCell(row, request.name || '—');
      appendCell(row, request.member_number || '—');
      appendCell(row, request.amount == null ? '—' : euro(request.amount));
      appendCell(row, publicRequestStatusBadge(request.status));
      var action = createElement('button', {
        className: 'row-action',
        text: request.status === 'pending' ? 'Rever' : 'Consultar',
        type: 'button'
      });
      action.dataset.reviewPublicRequest = request.id;
      action.setAttribute('aria-label',
        (request.status === 'pending' ? 'Rever ' : 'Consultar ') +
        'pedido PED-' + request.request_number
      );
      appendCell(row, action);
      body.appendChild(row);
    });

    if (!requests.length) {
      var emptyRow = document.createElement('tr');
      var emptyCell = createElement('td', {
        className: 'empty-table-cell',
        text: valueOf('request-status-filter') === 'pending'
          ? 'Não existem pedidos pendentes.'
          : 'Não existem pedidos com este estado.'
      });
      emptyCell.colSpan = 8;
      emptyRow.appendChild(emptyCell);
      body.appendChild(emptyRow);
    }

    setText(
      'request-table-summary',
      requests.length + (requests.length === 1 ? ' pedido' : ' pedidos')
    );
  }

  function publicRequestAddress(request) {
    return [request.address, request.postal, request.locality]
      .filter(function (value) { return Boolean(value); })
      .join(', ') || '—';
  }

  function openPublicRequestReview(request) {
    if (!request || !can('managePublicRequests')) return;
    state.selectedPublicRequest = request;
    setValue('request-review-id', request.id);
    setText('request-review-title', publicRequestTypeLabel(request.request_type));
    setText('request-review-reference', 'PED-' + request.request_number);
    setText('request-review-type', publicRequestTypeLabel(request.request_type));
    setText('request-review-date', dateTimeForDisplay(request.submitted_at));
    setText('request-review-name', request.name || '—');
    setText('request-review-email', request.email || '—');
    setText('request-review-contact', request.contact || '—');
    setText('request-review-nif', request.nif || '—');
    setText('request-review-address', publicRequestAddress(request));
    setText('request-review-member', request.member_number || '—');
    setText('request-review-year', request.quota_year || '—');
    setText('request-review-amount', request.amount == null ? '—' : euro(request.amount));
    setText('request-review-payment', request.payment_method || '—');
    setText('request-review-payment-date', dateForDisplay(request.payment_date));
    setText('request-review-payment-reference', request.payment_reference || '—');
    setText('request-review-message', request.message || '—');
    setValue('request-review-notes', request.review_notes || '');

    var status = byId('request-review-status');
    if (status) {
      status.className = 'status status-request-' + request.status;
      status.textContent = publicRequestStatusLabel(request.status);
    }
    var pending = request.status === 'pending';
    var notes = byId('request-review-notes');
    if (notes) notes.readOnly = !pending;
    setHidden(byId('request-review-warning'), !pending);
    setHidden(byId('approve-public-request'), !pending);
    setHidden(byId('reject-public-request'), !pending);
    setPublicRequestReviewPending(false);
    openDialog(byId('request-review-modal'), pending ? '#request-review-notes' : '#close-request-review');
  }

  function setPublicRequestReviewPending(pending) {
    state.pendingPublicRequest = pending;
    ['approve-public-request', 'reject-public-request', 'cancel-request-review', 'close-request-review']
      .forEach(function (id) {
        var control = byId(id);
        if (control) control.disabled = pending;
      });
    var notes = byId('request-review-notes');
    if (notes) notes.disabled = pending;
    var modal = byId('request-review-modal');
    if (modal) {
      modal.dataset.pending = pending ? 'true' : 'false';
      modal.setAttribute('aria-busy', pending ? 'true' : 'false');
    }
  }

  async function reviewPublicRequest(decision) {
    var request = state.selectedPublicRequest;
    if (!request || request.status !== 'pending' || state.pendingPublicRequest || !can('managePublicRequests')) return;
    var notes = valueOf('request-review-notes');
    if (decision === 'reject' && !notes) {
      showToast('Indique o motivo da rejeição nas notas da revisão.', true);
      byId('request-review-notes').focus();
      return;
    }

    var actionLabel = decision === 'approve' ? 'aprovar' : 'rejeitar';
    var consequence = request.request_type === 'membership'
      ? 'A aprovação irá criar um novo sócio.'
      : 'A aprovação irá registar o pagamento e emitir um recibo.';
    if (!window.confirm(
      'Pretende ' + actionLabel + ' o pedido PED-' + request.request_number + '?\n\n' +
      (decision === 'approve' ? consequence : 'O pedido ficará registado como rejeitado.')
    )) return;

    setPublicRequestReviewPending(true);
    try {
      var result = await state.client.rpc('review_public_request', {
        p_request_id: request.id,
        p_decision: decision,
        p_review_notes: notes || null
      });
      if (result.error) throw result.error;
      var response = result.data || {};
      await refreshData();
      closeDialog(byId('request-review-modal'));
      state.selectedPublicRequest = null;

      var detail = '';
      if (response.member_number) detail = ' Sócio n.º ' + response.member_number + ' criado/atualizado.';
      if (response.receipt_number) detail += ' Recibo n.º ' + response.receipt_number + ' emitido.';
      showToast(
        'Pedido PED-' + request.request_number +
        (decision === 'approve' ? ' aprovado.' : ' rejeitado.') + detail
      );
    } catch (error) {
      showToast(explainError(error, error.message || 'Não foi possível rever o pedido.'), true);
    } finally {
      setPublicRequestReviewPending(false);
    }
  }

  function applyRoleToUi() {
    var role = state.profile ? state.profile.role : '';
    setText('user-email', state.session && state.session.user ? state.session.user.email : '');
    setText('user-role', ROLE_LABELS[role] || '');

    all('[data-role-allow]').forEach(function (element) {
      var allowed = String(element.getAttribute('data-role-allow') || '')
        .split(',')
        .map(function (item) { return item.trim(); })
        .filter(Boolean);
      var permitted = allowed.indexOf(role) >= 0;
      element.hidden = !permitted;
      element.setAttribute('aria-hidden', permitted ? 'false' : 'true');
      if ('disabled' in element) element.disabled = !permitted;
    });

    var importButton = byId('import-button');
    var exportButton = byId('export-button');
    var newButton = byId('new-member-button');
    var emptyButton = byId('empty-new-button');
    if (importButton) {
      importButton.hidden = !can('importMembers');
      importButton.disabled = !can('importMembers');
    }
    if (exportButton) {
      exportButton.hidden = !can('exportData');
      exportButton.disabled = !can('exportData');
    }
    [newButton, emptyButton].forEach(function (button) {
      if (!button) return;
      button.hidden = !can('manageMembers');
      button.disabled = !can('manageMembers');
    });

    applyReceiptPermissions();
  }

  function applyReceiptPermissions() {
    var form = byId('receipt-form');
    var manageable = can('manageReceipts');
    var isQuota = valueOf('receipt-type') === 'Quota';
    var member = findMemberByReceiptSelection();
    updateReceiptMemberRequirement();
    if (form) {
      all('input, select, textarea, button', form).forEach(function (control) {
        var isYearChoice = control.hasAttribute('data-receipt-year');
        var disabledForType =
          isYearChoice && (!isQuota || !member || control.dataset.paid === 'true');
        control.disabled = !manageable || state.pendingReceipt || disabledForType;
      });
    }

    var yearsFieldset = byId('receipt-years-fieldset');
    if (yearsFieldset) {
      yearsFieldset.hidden = !isQuota;
      yearsFieldset.setAttribute('aria-hidden', isQuota ? 'false' : 'true');
      yearsFieldset.disabled = !manageable || state.pendingReceipt || !member;
    }

    var amount = byId('receipt-amount');
    var description = byId('receipt-description');
    if (amount) amount.readOnly = isQuota;
    if (description) description.readOnly = isQuota;

    var issue = byId('issue-receipt-button');
    if (issue) {
      issue.hidden = !manageable;
      issue.disabled = !manageable || state.pendingReceipt;
    }
    var print = byId('print-receipt');
    if (print) print.disabled = !can('printReceipts') || !state.lastIssuedReceipt;
  }

  function switchView(view) {
    if (view === 'requests' && !can('managePublicRequests')) return;
    var target = byId(view + '-view');
    if (!target) return;

    all('.view').forEach(function (section) {
      var active = section === target;
      section.classList.toggle('active-view', active);
      section.hidden = !active;
      section.setAttribute('aria-hidden', active ? 'false' : 'true');
    });

    all('.nav-item[data-view]').forEach(function (button) {
      var active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    var titles = {
      dashboard: 'Resumo de sócios',
      members: 'Listagem de sócios',
      receipts: 'Recibos',
      requests: 'Pedidos públicos'
    };
    setText('page-title', titles[view] || 'Team JM');
  }

  function yearsForMember(member) {
    var values = state.years.slice();
    if (member && member.dues) {
      Object.keys(member.dues).forEach(function (key) {
        var year = Number(key);
        if (Number.isInteger(year) && values.indexOf(year) < 0) values.push(year);
      });
    }
    paidQuotaYears(member).forEach(function (year) {
      if (values.indexOf(year) < 0) values.push(year);
    });
    return values.sort(function (a, b) { return a - b; });
  }

  function buildDues(member) {
    var grid = byId('dues-grid');
    if (!grid) return;
    grid.replaceChildren();
    yearsForMember(member).forEach(function (year) {
      var item = createElement('div', { className: 'due-item' });
      var label = createElement('label', { text: year });
      label.htmlFor = 'due-' + year;
      var select = createElement('select', { id: 'due-' + year });
      select.dataset.dueYear = String(year);
      select.appendChild(createElement('option', { text: 'Sem dados', value: '' }));
      select.appendChild(createElement('option', { text: 'Pago', value: 'Pago' }));
      select.appendChild(createElement('option', { text: 'Em falta', value: 'Pendente' }));
      var normalized = normalizeDue(member && member.dues ? member.dues[String(year)] : '');
      select.value = normalized || '';
      item.appendChild(label);
      item.appendChild(select);
      grid.appendChild(item);
    });
  }

  function openMemberModal(member) {
    var isNew = !member;
    if (isNew && !can('manageMembers')) {
      showToast('A sua conta tem acesso apenas de consulta.', true);
      return;
    }

    setText('modal-title', isNew
      ? 'Novo sócio'
      : (can('manageMembers') ? 'Editar sócio' : 'Consultar sócio'));
    setValue('member-id', member ? member.id : '');
    setValue('member-updated-at', member ? member.updated_at : '');
    setValue('member-name', member ? member.name : '');
    setValue('member-contact', member ? member.contact : '');
    setValue('member-nif', member ? member.nif : '');
    setValue('member-locality', member ? member.locality : '');
    setValue('member-address', member ? member.address : '');
    setValue('member-postal', member ? member.postal : '');
    setValue('member-email', member ? member.email : '');
    setValue('member-payment-mode', member ? member.payment_mode : '');
    setValue('member-date', member ? member.registration_date : '');
    setValue('member-notes', member ? member.notes : '');
    buildDues(member || null);

    var editable = can('manageMembers');
    var form = byId('member-form');
    if (form) {
      all('input:not([type="hidden"]), select, textarea', form).forEach(function (control) {
        control.disabled = !editable;
      });
      var submit = form.querySelector('[type="submit"]');
      if (submit) {
        submit.hidden = !editable;
        submit.disabled = !editable;
      }
    }

    var remove = byId('remove-member-button');
    var restore = byId('restore-member-button');
    if (remove) {
      remove.hidden = !editable || isNew || Boolean(member && member.removed);
      remove.disabled = remove.hidden;
    }
    if (restore) {
      restore.hidden = !editable || isNew || !Boolean(member && member.removed);
      restore.disabled = restore.hidden;
    }

    openDialog(byId('member-modal'), '#member-name');
  }

  function memberPayloadFromForm() {
    var name = valueOf('member-name');
    if (!name) throw new Error('Indique o nome completo do sócio.');
    var email = valueOf('member-email');
    if (email && !isValidEmail(email)) throw new Error('O email indicado não é válido.');

    var dues = {};
    all('[data-due-year]', byId('dues-grid')).forEach(function (select) {
      var normalized = normalizeDue(select.value);
      if (normalized) dues[String(select.dataset.dueYear)] = normalized;
    });

    var payload = {
      name: name,
      contact: valueOf('member-contact'),
      nif: valueOf('member-nif'),
      locality: valueOf('member-locality'),
      address: valueOf('member-address'),
      postal: valueOf('member-postal'),
      email: email,
      payment_mode: valueOf('member-payment-mode'),
      registration_date: valueOf('member-date') || null,
      notes: valueOf('member-notes'),
      dues: dues
    };
    var lengthError = memberLengthError(payload);
    if (lengthError) throw new Error(lengthError);
    return payload;
  }

  function memberLengthError(member) {
    var limits = [
      ['name', 200, 'nome'],
      ['contact', 64, 'contacto'],
      ['nif', 32, 'NIF/NIPC'],
      ['locality', 160, 'localidade'],
      ['address', 500, 'morada'],
      ['postal', 32, 'código postal'],
      ['email', 320, 'email'],
      ['payment_mode', 80, 'modo de pagamento'],
      ['notes', 5000, 'observações']
    ];
    for (var index = 0; index < limits.length; index += 1) {
      var rule = limits[index];
      if (textValue(member[rule[0]]).length > rule[1]) {
        return 'O campo ' + rule[2] + ' excede o limite de ' + rule[1] + ' caracteres.';
      }
    }
    return '';
  }

  function setMemberPending(pending) {
    state.pendingMember = pending;
    var form = byId('member-form');
    if (!form) return;
    var submit = form.querySelector('[type="submit"]');
    if (submit) {
      submit.disabled = pending || !can('manageMembers');
      submit.setAttribute('aria-busy', pending ? 'true' : 'false');
    }
    ['remove-member-button', 'restore-member-button', 'cancel-modal', 'close-modal'].forEach(function (id) {
      var button = byId(id);
      if (button) button.disabled = pending;
    });
    var modal = byId('member-modal');
    if (modal) modal.dataset.pending = pending ? 'true' : 'false';
  }

  async function saveMember(event) {
    event.preventDefault();
    if (state.pendingMember || !can('manageMembers')) return;
    var form = byId('member-form');
    if (form && !form.reportValidity()) return;

    try {
      var payload = memberPayloadFromForm();
      var id = valueOf('member-id');
      var updatedAt = valueOf('member-updated-at');
      setMemberPending(true);
      var result;

      if (id) {
        if (!updatedAt) throw new Error('Atualize a página antes de alterar este registo.');
        result = await state.client
          .from('members')
          .update(payload)
          .eq('id', id)
          .eq('updated_at', updatedAt)
          .select('*')
          .maybeSingle();
        if (!result.error && !result.data) {
          throw new Error('Este sócio foi alterado por outra pessoa. Atualize os dados e tente novamente.');
        }
      } else {
        result = await state.client
          .from('members')
          .insert(payload)
          .select('*')
          .single();
      }

      if (result.error) throw result.error;
      closeDialog(byId('member-modal'), true);
      await refreshMembers();
      showToast(id ? 'Sócio atualizado com sucesso.' : 'Sócio criado com sucesso.');
    } catch (error) {
      showToast(
        error && error.message && error.message.indexOf('outra pessoa') >= 0
          ? error.message
          : explainError(error, error && error.message ? error.message : 'Não foi possível guardar o sócio.'),
        true
      );
    } finally {
      setMemberPending(false);
    }
  }

  async function setMemberRemoved(removed) {
    if (state.pendingMember || !can('manageMembers')) return;
    var id = valueOf('member-id');
    var updatedAt = valueOf('member-updated-at');
    var member = state.members.find(function (item) { return item.id === id; });
    if (!member || !updatedAt) return;

    var question = removed
      ? 'Remover ' + (member.name || 'este sócio') + ' do registo ativo?'
      : 'Restaurar ' + (member.name || 'este sócio') + '?';
    if (!window.confirm(question)) return;

    try {
      setMemberPending(true);
      var result = await state.client
        .from('members')
        .update({ removed: removed })
        .eq('id', id)
        .eq('updated_at', updatedAt)
        .select('*')
        .maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) {
        throw new Error('Este sócio foi alterado por outra pessoa. Atualize os dados e tente novamente.');
      }
      closeDialog(byId('member-modal'), true);
      await refreshMembers();
      showToast(removed ? 'Sócio removido do registo ativo.' : 'Sócio restaurado com sucesso.');
    } catch (error) {
      showToast(explainError(error, error.message || 'Não foi possível atualizar o sócio.'), true);
    } finally {
      setMemberPending(false);
    }
  }

  function findMemberByReceiptSelection() {
    var id = valueOf('receipt-member');
    return state.members.find(function (member) {
      return member.id === id && !member.removed;
    }) || null;
  }

  function paidQuotaYears(member) {
    if (!member) return [];
    var years = new Set();

    Object.keys(member.dues || {}).forEach(function (yearValue) {
      var year = Number(yearValue);
      if (
        Number.isInteger(year) &&
        year >= 1900 &&
        year <= 2200 &&
        normalizeDue(member.dues[String(year)]) === 'Pago'
      ) {
        years.add(year);
      }
    });

    state.receipts.forEach(function (receipt) {
      var belongsToMember = receipt.member_id
        ? receipt.member_id === member.id
        : Number(receipt.member_number) === Number(member.member_number);
      if (!belongsToMember || receipt.receipt_type !== 'Quota') return;
      normalizeQuotaYears(receipt.quota_years, receipt.quota_year).forEach(function (year) {
        years.add(year);
      });
    });

    return Array.from(years).sort(function (a, b) { return a - b; });
  }

  function selectedQuotaYears() {
    var container = byId('receipt-years-options');
    if (container) {
      return all('input[data-receipt-year]:checked', container)
        .filter(function (input) { return input.dataset.paid !== 'true'; })
        .map(function (input) { return Number(input.dataset.receiptYear); })
        .filter(function (year, index, years) {
          return Number.isInteger(year) && years.indexOf(year) === index;
        })
        .sort(function (a, b) { return a - b; });
    }

    return [];
  }

  function quotaYearsForDisplay(receipt) {
    var years = normalizeQuotaYears(
      receipt && receipt.quota_years,
      receipt && receipt.quota_year
    );
    return years.length ? years.join(', ') : '—';
  }

  function quotaReceiptDescription(member, selectedYears) {
    var paidBefore = paidQuotaYears(member).filter(function (year) {
      return selectedYears.indexOf(year) < 0;
    });
    return 'Quotas pagas agora: ' + (selectedYears.length ? selectedYears.join(', ') : 'nenhum') +
      '. Anos já pagos anteriormente: ' + (paidBefore.length ? paidBefore.join(', ') : 'nenhum') + '.';
  }

  function syncReceiptQuotaPreview() {
    if (valueOf('receipt-type') !== 'Quota') return;
    var member = findMemberByReceiptSelection();
    var selectedYears = selectedQuotaYears();
    var amount = selectedYears.length
      ? Number((state.config.annualFee * selectedYears.length).toFixed(2))
      : '';
    setValue('receipt-amount', amount);
    setValue('receipt-description', quotaReceiptDescription(member, selectedYears));
  }

  function updateReceiptMemberRequirement() {
    var select = byId('receipt-member');
    var label = byId('receipt-member-label');
    var help = byId('receipt-member-help');
    var optional = valueOf('receipt-type') === 'Donativo';

    if (select) {
      select.required = !optional;
      select.setAttribute('aria-required', optional ? 'false' : 'true');
      var emptyOption = select.querySelector('option[value=""]');
      if (emptyOption) {
        emptyOption.textContent = optional
          ? 'Sem sócio — doador externo'
          : 'Selecionar sócio';
      }
    }

    if (label) {
      label.replaceChildren(document.createTextNode('Sócio'));
      if (!optional) {
        label.appendChild(document.createTextNode(' '));
        var requiredMark = createElement('b', { text: '*' });
        requiredMark.setAttribute('aria-hidden', 'true');
        label.appendChild(requiredMark);
      }
    }

    if (help) {
      help.textContent = optional
        ? 'Opcional. Deixe “Sem sócio” para emitir o donativo a uma pessoa ou entidade externa.'
        : 'Obrigatório para este tipo de recibo.';
    }
  }

  function renderReceiptYearOptions() {
    var container = byId('receipt-years-options');
    if (!container) {
      syncReceiptQuotaPreview();
      applyReceiptPermissions();
      return;
    }

    var member = findMemberByReceiptSelection();
    var memberId = member ? String(member.id) : '';
    var sameMember = container.dataset.memberId === memberId;
    var previousSelection = sameMember ? selectedQuotaYears() : [];
    var paidYears = paidQuotaYears(member);
    var isQuota = valueOf('receipt-type') === 'Quota';
    var manageable = can('manageReceipts') && !state.pendingReceipt;
    var availableYears = yearsForMember(member);

    if (!sameMember && member && paidYears.indexOf(state.selectedYear) < 0) {
      previousSelection = [state.selectedYear];
    }

    container.replaceChildren();
    container.dataset.memberId = memberId;

    availableYears.forEach(function (year) {
      var paid = paidYears.indexOf(year) >= 0;
      var label = createElement('label', {
        className: 'receipt-year-option' + (paid ? ' receipt-year-option--paid' : '')
      });
      var checkbox = createElement('input', {
        type: 'checkbox',
        id: 'receipt-year-' + year,
        value: year
      });
      checkbox.className = 'receipt-year-checkbox';
      checkbox.dataset.receiptYear = String(year);
      checkbox.dataset.paid = paid ? 'true' : 'false';
      checkbox.checked = !paid && previousSelection.indexOf(year) >= 0;
      checkbox.disabled = !member || !isQuota || !manageable || paid;
      checkbox.setAttribute('aria-label', paid ? year + ', já pago' : 'Pagar quota de ' + year);
      if (paid) checkbox.title = 'Quota já paga';

      label.htmlFor = checkbox.id;
      label.appendChild(checkbox);
      label.appendChild(createElement('span', {
        text: paid ? year + ' — já pago' : year
      }));
      container.appendChild(label);
    });

    var paidMessage = byId('receipt-paid-years');
    if (paidMessage) {
      paidMessage.textContent = member
        ? 'Anos já pagos anteriormente: ' + (paidYears.length ? paidYears.join(', ') : 'nenhum') + '.'
        : 'Selecione um sócio para consultar os anos pagos anteriormente.';
    }

    syncReceiptQuotaPreview();
    applyReceiptPermissions();
  }

  function receiptMemberChanged() {
    var member = findMemberByReceiptSelection();
    setValue('receipt-name', member ? member.name : '');
    setValue('receipt-nif', member ? member.nif : '');
    setValue('receipt-address', member ? member.address : '');
    renderReceiptYearOptions();
    receiptDraftChanged();
  }

  function invalidateReceiptPrint() {
    state.lastIssuedReceipt = null;
    var print = byId('print-receipt');
    if (print) print.disabled = true;
    setText('print-receipt-number', '—');
    setText('receipt-preview-status', 'Rascunho');
  }

  function receiptDraftChanged() {
    invalidateReceiptPrint();
    renderDraftReceipt();
  }

  function setReceiptPending(pending) {
    state.pendingReceipt = pending;
    var form = byId('receipt-form');
    if (form) {
      form.setAttribute('aria-busy', pending ? 'true' : 'false');
    }
    applyReceiptPermissions();
  }

  function receiptPayload() {
    var member = findMemberByReceiptSelection();
    var type = valueOf('receipt-type');
    if (!member && type !== 'Donativo') throw new Error('Selecione um sócio ativo.');
    var quotaYears = type === 'Quota' ? selectedQuotaYears() : [];
    if (type === 'Quota' && !quotaYears.length) {
      throw new Error('Selecione pelo menos um ano da quota.');
    }
    if (type === 'Quota' && quotaYears.some(function (year) {
      return paidQuotaYears(member).indexOf(year) >= 0;
    })) {
      throw new Error('Uma das quotas selecionadas já está paga. Atualize os dados e tente novamente.');
    }

    var amount = type === 'Quota'
      ? Number((state.config.annualFee * quotaYears.length).toFixed(2))
      : Number(valueOf('receipt-amount').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Indique um valor superior a zero.');
    }
    var receiptDate = valueOf('receipt-date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) {
      throw new Error('Indique uma data válida.');
    }
    var payload = {
      member_id: member ? member.id : null,
      receipt_date: receiptDate,
      receipt_type: type,
      payment_method: valueOf('receipt-payment'),
      payer_name: valueOf('receipt-name') || (member ? member.name : ''),
      payer_tax_id: valueOf('receipt-nif') || (member ? member.nif : '') || '',
      payer_address: valueOf('receipt-address') || (member ? member.address : '') || '',
      amount: amount,
      description: type === 'Quota'
        ? quotaReceiptDescription(member, quotaYears)
        : valueOf('receipt-description'),
      quota_years: type === 'Quota' ? quotaYears : null,
      quota_year: type === 'Quota' ? quotaYears[0] : null
    };
    if (payload.payer_name.length > 200) throw new Error('O nome no recibo excede 200 caracteres.');
    if (payload.payer_tax_id.length > 32) throw new Error('O NIF/NIPC no recibo excede 32 caracteres.');
    if (!payload.payer_address) throw new Error('Indique a morada da pessoa ou entidade.');
    if (payload.payer_address.length > 500) throw new Error('A morada no recibo excede 500 caracteres.');
    if (!payload.description) throw new Error('Indique a descrição do recibo.');
    if (payload.description.length > 500) throw new Error('A descrição do recibo excede 500 caracteres.');
    return payload;
  }

  async function issueReceipt(event) {
    event.preventDefault();
    if (state.pendingReceipt || !can('manageReceipts')) return;
    var form = byId('receipt-form');
    if (valueOf('receipt-type') === 'Quota' && !selectedQuotaYears().length) {
      showToast('Selecione pelo menos um ano da quota.', true);
      var firstAvailableYear = all(
        'input[data-receipt-year]:not(:disabled)',
        byId('receipt-years-options') || document
      )[0];
      if (firstAvailableYear) firstAvailableYear.focus();
      return;
    }
    if (form && !form.reportValidity()) return;

    try {
      var payload = receiptPayload();
      setReceiptPending(true);
      var result = await state.client.rpc('issue_receipt', { payload: payload });
      if (result.error) throw result.error;
      var receipt = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!receipt || !receipt.receipt_number) {
        throw new Error('O serviço não devolveu o recibo persistido.');
      }

      state.lastIssuedReceipt = normalizeReceipt(receipt);
      await refreshData();
      renderIssuedReceipt(state.lastIssuedReceipt);
      applyReceiptPermissions();
      showToast(
        'Recibo n.º ' + state.lastIssuedReceipt.receipt_number +
        ' emitido. Reveja a versão final e escolha “Imprimir recibo”.'
      );
    } catch (error) {
      invalidateReceiptPrint();
      showToast(explainError(error, error.message || 'Não foi possível emitir o recibo.'), true);
    } finally {
      setReceiptPending(false);
    }
  }

  function renderReceiptPreview(receipt, status) {
    if (!receipt) return;
    setText('print-receipt-number', receipt.receipt_number || '—');
    setText('print-receipt-date', dateForDisplay(receipt.receipt_date));
    setText('print-receipt-name', receipt.payer_name || '—');
    setText('print-receipt-nif', receipt.payer_tax_id || '—');
    setText('print-receipt-address', receipt.payer_address || '—');
    setText(
      'print-receipt-member',
      receipt.member_number || (receipt.receipt_type === 'Donativo' ? 'Não sócio' : '—')
    );
    setText('print-receipt-type', receipt.receipt_type || '—');
    setText('print-receipt-payment', receipt.payment_method || '—');
    setText('print-receipt-description', receipt.description || '—');
    setText('print-receipt-value', euro(receipt.amount));
    setText('print-receipt-year', quotaYearsForDisplay(receipt));
    setText('receipt-preview-status', status || 'Rascunho');
  }

  function renderDraftReceipt() {
    var member = findMemberByReceiptSelection();
    var type = valueOf('receipt-type') || 'Quota';
    renderReceiptPreview({
      receipt_number: null,
      receipt_date: valueOf('receipt-date'),
      member_number: member ? member.member_number : null,
      payer_name: valueOf('receipt-name') || (member ? member.name : ''),
      payer_tax_id: valueOf('receipt-nif') || (member ? member.nif : ''),
      payer_address: valueOf('receipt-address') || (member ? member.address : ''),
      receipt_type: type,
      payment_method: valueOf('receipt-payment'),
      description: valueOf('receipt-description'),
      amount: Number(valueOf('receipt-amount').replace(',', '.')) || 0,
      quota_years: type === 'Quota' ? selectedQuotaYears() : [],
      quota_year: null
    }, 'Rascunho');
  }

  function renderIssuedReceipt(receipt) {
    renderReceiptPreview(receipt, 'Emitido');
  }

  function previewPersistedReceipt(receiptNumber) {
    var receipt = state.receipts.find(function (item) {
      return Number(item.receipt_number) === Number(receiptNumber);
    });
    if (!receipt) {
      showToast('Não foi possível encontrar esse recibo.', true);
      return;
    }
    state.lastIssuedReceipt = receipt;
    renderIssuedReceipt(receipt);
    applyReceiptPermissions();
    var preview = byId('receipt-print-sheet');
    if (preview) preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Recibo n.º ' + receipt.receipt_number + ' pronto para reimpressão.');
  }

  function printPersistedReceipt() {
    if (!state.lastIssuedReceipt) {
      showToast('Emita e guarde primeiro o recibo antes de imprimir.', true);
      return;
    }
    renderIssuedReceipt(state.lastIssuedReceipt);
    window.print();
  }

  function canonicalText(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  function textValue(value) {
    if (value == null) return '';
    return String(value).trim();
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function parseImportDate(value) {
    if (value == null || value === '') return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return [
        value.getFullYear(),
        String(value.getMonth() + 1).padStart(2, '0'),
        String(value.getDate()).padStart(2, '0')
      ].join('-');
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      var parsed = state.xlsx.SSF && state.xlsx.SSF.parse_date_code
        ? state.xlsx.SSF.parse_date_code(value)
        : null;
      if (parsed) {
        return [
          parsed.y,
          String(parsed.m).padStart(2, '0'),
          String(parsed.d).padStart(2, '0')
        ].join('-');
      }
    }

    var text = textValue(value);
    var iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    var portuguese = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    var year;
    var month;
    var day;
    if (iso) {
      year = Number(iso[1]);
      month = Number(iso[2]);
      day = Number(iso[3]);
    } else if (portuguese) {
      day = Number(portuguese[1]);
      month = Number(portuguese[2]);
      year = Number(portuguese[3]);
    } else {
      return null;
    }

    var date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return [
      year,
      String(month).padStart(2, '0'),
      String(day).padStart(2, '0')
    ].join('-');
  }

  var IMPORT_ALIASES = {
    member_number: ['nsocio', 'numerosocio', 'numero', 'n', 'membernumber'],
    name: ['nome', 'nomecompleto', 'socio', 'name'],
    contact: ['contacto', 'contato', 'telefone', 'telemovel', 'phone'],
    nif: ['nif', 'nifnipc', 'nipc', 'contribuinte', 'taxid'],
    locality: ['localidade', 'cidade', 'locality'],
    address: ['morada', 'moradacompleta', 'endereco', 'address'],
    postal: ['codigopostal', 'codpostal', 'cp', 'postal'],
    email: ['email', 'correioeletronico'],
    payment_mode: ['mododepagamento', 'formadepagamento', 'pagamento', 'paymentmode'],
    registration_date: ['datadeinscricao', 'data', 'registrationdate'],
    notes: ['observacoes', 'observacao', 'notas', 'notes'],
    removed: ['removido', 'situacaoatual', 'estado', 'removed']
  };

  function importFieldForHeader(header) {
    var canonical = canonicalText(header);
    var fields = Object.keys(IMPORT_ALIASES);
    for (var index = 0; index < fields.length; index += 1) {
      if (IMPORT_ALIASES[fields[index]].indexOf(canonical) >= 0) return fields[index];
    }
    if (/^(19|20|21)\d{2}$/.test(canonical)) return 'due:' + canonical;
    return '';
  }

  function locateHeader(matrix) {
    var best = null;
    var limit = Math.min(matrix.length, 30);
    for (var rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      var row = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
      var mapping = {};
      var score = 0;
      row.forEach(function (header, columnIndex) {
        var field = importFieldForHeader(header);
        if (field && !Object.prototype.hasOwnProperty.call(mapping, field)) {
          mapping[field] = columnIndex;
          score += field === 'name' ? 5 : (field.indexOf('due:') === 0 ? 1 : 2);
        }
      });
      if (mapping.name != null && (!best || score > best.score)) {
        best = { rowIndex: rowIndex, mapping: mapping, score: score };
      }
    }
    return best;
  }

  function cell(row, mapping, field) {
    return mapping[field] == null ? '' : row[mapping[field]];
  }

  function normalizeImportedRow(row, mapping, sheetRow, duplicateMaps) {
    var errors = [];
    var rawNumber = textValue(cell(row, mapping, 'member_number'));
    var memberNumber = rawNumber === '' ? null : Number(rawNumber);
    if (!rawNumber) errors.push('número de sócio obrigatório');
    if (rawNumber && (!/^\d+$/.test(rawNumber) || !Number.isSafeInteger(memberNumber) || memberNumber <= 0)) {
      errors.push('número de sócio inválido');
    }

    var name = textValue(cell(row, mapping, 'name')).replace(/\s+/g, ' ');
    if (!name) errors.push('nome obrigatório');

    var nif = textValue(cell(row, mapping, 'nif')).replace(/\s+/g, '');
    if (nif && !/^[A-Za-z0-9][A-Za-z0-9 .\/-]{2,24}$/.test(nif)) {
      errors.push('NIF/NIPC inválido');
    }

    var email = textValue(cell(row, mapping, 'email')).toLowerCase();
    if (email && !isValidEmail(email)) errors.push('email inválido');

    var registrationDate = parseImportDate(cell(row, mapping, 'registration_date'));
    if (registrationDate === null) errors.push('data de inscrição inválida');

    var removedValue = canonicalText(cell(row, mapping, 'removed'));
    var removed = ['sim', 'true', '1', 'removido', 'inativo', 'inactive'].indexOf(removedValue) >= 0;

    var dues = {};
    Object.keys(mapping).forEach(function (field) {
      if (field.indexOf('due:') !== 0) return;
      var year = field.slice(4);
      var rawDue = cell(row, mapping, field);
      var normalized = normalizeDue(rawDue);
      if (normalized === null) {
        errors.push('quota de ' + year + ' inválida');
      } else if (normalized) {
        dues[year] = normalized;
      }
    });

    [
      ['Número de sócio', memberNumber == null ? '' : String(memberNumber), duplicateMaps.memberNumber],
      ['NIF/NIPC', canonicalText(nif), duplicateMaps.nif],
      ['email', canonicalText(email), duplicateMaps.email]
    ].forEach(function (entry) {
      var label = entry[0];
      var key = entry[1];
      var map = entry[2];
      if (!key) return;
      if (map.has(key)) errors.push(label + ' duplicado com a linha ' + map.get(key));
      else map.set(key, sheetRow);
    });

    var payload = {
      member_number: memberNumber,
      name: name,
      contact: textValue(cell(row, mapping, 'contact')),
      nif: nif,
      locality: textValue(cell(row, mapping, 'locality')),
      address: textValue(cell(row, mapping, 'address')),
      postal: textValue(cell(row, mapping, 'postal')),
      email: email,
      payment_mode: textValue(cell(row, mapping, 'payment_mode')),
      registration_date: registrationDate || null,
      notes: textValue(cell(row, mapping, 'notes')),
      removed: removed,
      dues: dues
    };
    var lengthError = memberLengthError(payload);
    if (lengthError) errors.push(lengthError);

    return {
      sheetRow: sheetRow,
      payload: payload,
      errors: errors
    };
  }

  function chooseMemberSheet(workbook) {
    var preferred = workbook.SheetNames.find(function (name) {
      var normalized = canonicalText(name);
      return normalized === 'listagemdesocios' || normalized === 'socios' || normalized === 'members';
    });
    return preferred || workbook.SheetNames[0];
  }

  async function prepareImport(file) {
    if (!can('importMembers')) {
      showToast('Apenas administradores podem importar dados.', true);
      return;
    }
    if (!file) return;
    if (!/\.(xlsx|xls)$/i.test(file.name || '')) {
      showToast('Selecione um ficheiro Excel .xlsx ou .xls.', true);
      return;
    }

    try {
      var buffer = await file.arrayBuffer();
      var workbook = state.xlsx.read(buffer, { type: 'array', cellDates: true });
      if (!workbook.SheetNames || !workbook.SheetNames.length) {
        throw new Error('O ficheiro não contém folhas.');
      }
      var sheetName = chooseMemberSheet(workbook);
      var matrix = state.xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        defval: '',
        raw: true
      });
      var header = locateHeader(matrix);
      if (!header) {
        throw new Error('Não foi encontrada uma linha de cabeçalhos com a coluna Nome.');
      }

      var meaningfulImportFields = Object.keys(header.mapping).filter(function (field) {
        return field !== 'member_number' && field !== 'removed';
      });
      var dataRows = matrix
        .slice(header.rowIndex + 1)
        .map(function (row, offset) {
          return { row: row, sheetRow: header.rowIndex + offset + 2 };
        })
        .filter(function (entry) {
          return Array.isArray(entry.row) && meaningfulImportFields.some(function (field) {
            return textValue(entry.row[header.mapping[field]]) !== '';
          });
        });

      if (dataRows.length > state.config.maxImportRows) {
        throw new Error(
          'O ficheiro tem ' + dataRows.length + ' linhas; o limite é ' + state.config.maxImportRows + '.'
        );
      }

      var duplicateMaps = {
        memberNumber: new Map(),
        nif: new Map(),
        email: new Map()
      };
      var normalized = dataRows.map(function (entry) {
        return normalizeImportedRow(entry.row, header.mapping, entry.sheetRow, duplicateMaps);
      });
      var errors = [];
      normalized.forEach(function (entry) {
        entry.errors.forEach(function (message) {
          errors.push('Linha ' + entry.sheetRow + ': ' + message + '.');
        });
      });

      state.importDraft = {
        fileName: file.name,
        sheetName: sheetName,
        rows: normalized.map(function (entry) { return entry.payload; }),
        errors: errors
      };
      renderImportPreview();
      openDialog(byId('import-modal'), 'input[name="import-mode"]:checked, #import-mode');
    } catch (error) {
      state.importDraft = null;
      showToast(error.message || 'Não foi possível ler o ficheiro Excel.', true);
    }
  }

  function renderImportPreview() {
    var draft = state.importDraft;
    var summary = byId('import-summary');
    if (summary) {
      summary.replaceChildren();
      if (draft) {
        summary.appendChild(createElement('strong', { text: draft.fileName }));
        summary.appendChild(createElement('span', {
          text: draft.rows.length + (draft.rows.length === 1 ? ' linha encontrada' : ' linhas encontradas')
        }));
        summary.appendChild(createElement('span', { text: 'Folha: ' + draft.sheetName }));
        var preview = createElement('ul', { className: 'import-preview-list' });
        draft.rows.slice(0, 8).forEach(function (member) {
          preview.appendChild(createElement('li', {
            text: 'N.º ' + (member.member_number || '—') + ' — ' + (member.name || 'Sem nome')
          }));
        });
        if (draft.rows.length > 8) {
          preview.appendChild(createElement('li', {
            text: '… e mais ' + (draft.rows.length - 8) + ' registos'
          }));
        }
        summary.appendChild(preview);
      }
    }

    var errors = byId('import-errors');
    if (errors) {
      errors.replaceChildren();
      var hasErrors = Boolean(draft && draft.errors.length);
      errors.hidden = !hasErrors;
      if (hasErrors) {
        errors.appendChild(createElement('strong', {
          text: draft.errors.length + (draft.errors.length === 1 ? ' erro impede' : ' erros impedem') + ' a importação'
        }));
        var list = document.createElement('ul');
        draft.errors.slice(0, 100).forEach(function (message) {
          list.appendChild(createElement('li', { text: message }));
        });
        if (draft.errors.length > 100) {
          list.appendChild(createElement('li', {
            text: 'Existem mais ' + (draft.errors.length - 100) + ' erros.'
          }));
        }
        errors.appendChild(list);
      }
    }
    updateImportControls();
  }

  function importMode() {
    var checked = document.querySelector('input[name="import-mode"]:checked');
    if (checked) return checked.value === 'replace' ? 'replace' : 'merge';
    return valueOf('import-mode') === 'replace' ? 'replace' : 'merge';
  }

  function updateImportControls() {
    var mode = importMode();
    var confirmation = byId('replace-confirm');
    if (confirmation) {
      confirmation.disabled = mode !== 'replace' || state.pendingImport;
      confirmation.setAttribute('aria-required', mode === 'replace' ? 'true' : 'false');
    }
    var confirmButton = byId('confirm-import-button');
    if (confirmButton) {
      var ready =
        can('importMembers') &&
        state.importDraft &&
        state.importDraft.rows.length > 0 &&
        state.importDraft.errors.length === 0 &&
        (mode !== 'replace' || canonicalText(valueOf('replace-confirm')) === 'substituir');
      confirmButton.disabled = !ready || state.pendingImport;
    }
  }

  function setImportPending(pending) {
    state.pendingImport = pending;
    var modal = byId('import-modal');
    if (modal) modal.dataset.pending = pending ? 'true' : 'false';
    ['close-import-modal', 'cancel-import'].forEach(function (id) {
      var button = byId(id);
      if (button) button.disabled = pending;
    });
    all('input[name="import-mode"]').forEach(function (control) {
      control.disabled = pending;
    });
    var modeSelect = byId('import-mode');
    if (modeSelect) modeSelect.disabled = pending;
    updateImportControls();
  }

  async function confirmImport() {
    if (state.pendingImport || !can('importMembers') || !state.importDraft) return;
    updateImportControls();
    var button = byId('confirm-import-button');
    if (button && button.disabled) return;
    var replace = importMode() === 'replace';

    try {
      setImportPending(true);
      var result = await state.client.rpc('admin_import_members', {
        payload: state.importDraft.rows,
        replace_existing: replace
      });
      if (result.error) throw result.error;
      var details = Array.isArray(result.data) ? result.data[0] : result.data;
      closeDialog(byId('import-modal'), true);
      state.importDraft = null;
      setValue('replace-confirm', '');
      await refreshData();

      var imported = details && Number.isFinite(Number(details.imported))
        ? Number(details.imported)
        : state.members.length;
      showToast(imported + (imported === 1 ? ' sócio importado com sucesso.' : ' sócios importados com sucesso.'));
    } catch (error) {
      showToast(explainError(error, 'Não foi possível concluir a importação.'), true);
    } finally {
      setImportPending(false);
    }
  }

  function exportData() {
    if (!can('exportData')) {
      showToast('Apenas administradores podem exportar dados.', true);
      return;
    }

    try {
      var yearSet = new Set(state.years);
      state.members.forEach(function (member) {
        Object.keys(member.dues || {}).forEach(function (year) {
          if (/^(19|20|21)\d{2}$/.test(year)) yearSet.add(Number(year));
        });
      });
      var years = Array.from(yearSet).sort(function (a, b) { return a - b; });
      var memberRows = state.members.map(function (member) {
        var row = {
          'ID interno': member.id || '',
          'Nº Sócio': member.member_number,
          'Nome': member.name || '',
          'Contacto': member.contact || '',
          'NIF': member.nif || '',
          'Localidade': member.locality || '',
          'Morada completa': member.address || '',
          'Código Postal': member.postal || '',
          'Email': member.email || '',
          'Modo de pagamento': member.payment_mode || '',
          'Data de inscrição': member.registration_date || '',
          'Observações': member.notes || '',
          'Removido': member.removed ? 'Sim' : 'Não',
          'Criado em': member.created_at || '',
          'Atualizado em': member.updated_at || '',
          'Atualizado por': member.updated_by || ''
        };
        years.forEach(function (year) {
          row[String(year)] = normalizeDue(member.dues && member.dues[String(year)]) || '';
        });
        return row;
      });

      var receiptRows = state.receipts.map(function (receipt) {
        return {
          'ID interno': receipt.id || '',
          'Nº Recibo': receipt.receipt_number,
          'ID interno do sócio': receipt.member_id || '',
          'Nº Sócio': receipt.member_number,
          'Data': receipt.receipt_date || '',
          'Tipo': receipt.receipt_type || '',
          'Pagamento': receipt.payment_method || '',
          'Nome / entidade': receipt.payer_name || '',
          'NIF / NIPC': receipt.payer_tax_id || '',
          'Morada': receipt.payer_address || '',
          'Valor (€)': receipt.amount,
          'Descrição / Referência': receipt.description || '',
          'Ano da quota': receipt.quota_year || '',
          'Anos da quota': normalizeQuotaYears(receipt.quota_years, receipt.quota_year).join(', '),
          'Criado por': receipt.created_by || '',
          'Criado em': receipt.created_at || ''
        };
      });

      var workbook = state.xlsx.utils.book_new();
      var memberSheet = state.xlsx.utils.json_to_sheet(memberRows, {
        header: [
          'ID interno',
          'Nº Sócio',
          'Nome',
          'Contacto',
          'NIF',
          'Localidade',
          'Morada completa',
          'Código Postal',
          'Email',
          'Modo de pagamento',
          'Data de inscrição',
          'Observações',
          'Removido',
          'Criado em',
          'Atualizado em',
          'Atualizado por'
        ].concat(years.map(String))
      });
      memberSheet['!cols'] = [
        { wch: 38 }, { wch: 11 }, { wch: 32 }, { wch: 16 }, { wch: 14 }, { wch: 20 },
        { wch: 38 }, { wch: 14 }, { wch: 30 }, { wch: 20 }, { wch: 16 },
        { wch: 40 }, { wch: 10 }, { wch: 24 }, { wch: 24 }, { wch: 38 }
      ].concat(years.map(function () { return { wch: 11 }; }));
      state.xlsx.utils.book_append_sheet(workbook, memberSheet, 'Listagem de Sócios');

      var receiptSheet = state.xlsx.utils.json_to_sheet(receiptRows);
      state.xlsx.utils.book_append_sheet(workbook, receiptSheet, 'Recibos');
      var today = new Date().toISOString().slice(0, 10);
      state.xlsx.writeFile(workbook, 'Team_JM_UAT_v3_' + today + '.xlsx');
      showToast('Excel exportado com sucesso.');
    } catch (error) {
      showToast('Não foi possível criar o ficheiro Excel.', true);
    }
  }

  function openDialog(modal, initialFocusSelector) {
    if (!modal) return;
    if (state.activeModal && state.activeModal !== modal) closeDialog(state.activeModal);
    state.focusBeforeModal = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    state.activeModal = modal;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    var first = initialFocusSelector ? modal.querySelector(initialFocusSelector) : null;
    if (!first) first = focusableElements(modal)[0];
    if (first) window.requestAnimationFrame(function () { first.focus(); });
  }

  function closeDialog(modal, force) {
    if (!modal || (!force && modal.dataset.pending === 'true')) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    if (state.activeModal === modal) state.activeModal = null;
    if (modal.id === 'request-review-modal') state.selectedPublicRequest = null;
    var previous = state.focusBeforeModal;
    state.focusBeforeModal = null;
    if (previous && document.contains(previous)) previous.focus();
  }

  function closeAllModals() {
    ['member-modal', 'import-modal', 'request-review-modal'].forEach(function (id) {
      var modal = byId(id);
      if (!modal) return;
      modal.dataset.pending = 'false';
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
    });
    state.activeModal = null;
    state.focusBeforeModal = null;
    state.selectedPublicRequest = null;
    state.pendingPublicRequest = false;
    document.body.classList.remove('modal-open');
  }

  function focusableElements(root) {
    return all(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      root
    ).filter(function (element) {
      return !element.hidden && element.getAttribute('aria-hidden') !== 'true';
    });
  }

  function modalKeydown(event) {
    var modal = state.activeModal;
    if (!modal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog(modal);
      return;
    }
    if (event.key !== 'Tab') return;
    var focusable = focusableElements(modal);
    if (!focusable.length) {
      event.preventDefault();
      modal.focus();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function setLoginPending(pending) {
    var form = byId('login-form');
    if (!form) return;
    all('input, button', form).forEach(function (control) {
      control.disabled = pending;
    });
    form.setAttribute('aria-busy', pending ? 'true' : 'false');
  }

  function clearLoginPending() {
    setLoginPending(false);
  }

  async function login(event) {
    event.preventDefault();
    if (!state.client) return;
    setText('login-error', '');
    setLoginPending(true);
    try {
      var result = await state.client.auth.signInWithPassword({
        email: valueOf('login-email'),
        password: valueOf('login-password')
      });
      if (result.error) throw result.error;
      await queueAuthState(result.data.session);
    } catch (error) {
      setText('login-error', explainError(error, 'Não foi possível iniciar sessão.'));
      setScreen('login-screen');
      clearLoginPending();
    }
  }

  async function logout() {
    if (!state.client) return;
    var button = byId('logout-button');
    if (button) button.disabled = true;
    try {
      var result = await state.client.auth.signOut();
      if (result.error) throw result.error;
      await queueAuthState(null);
    } catch (error) {
      showToast(explainError(error, 'Não foi possível terminar a sessão.'), true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function initializeReceiptForm() {
    setValue('receipt-date', new Date().toISOString().slice(0, 10));
    setValue('receipt-member', '');
    setValue('receipt-name', '');
    setValue('receipt-nif', '');
    setValue('receipt-address', '');
    setValue('receipt-amount', '');
    setValue('receipt-description', quotaReceiptDescription(null, []));
    var receiptType = byId('receipt-type');
    if (receiptType) receiptType.dataset.previousType = valueOf('receipt-type') || 'Quota';
    updateReceiptMemberRequirement();
    renderReceiptYearOptions();
    receiptDraftChanged();
  }

  function bindUi() {
    listen(byId('login-form'), 'submit', login);
    listen(byId('logout-button'), 'click', logout);
    listen(document, 'keydown', modalKeydown);

    all('.nav-item[data-view]').forEach(function (button) {
      listen(button, 'click', function () { switchView(button.dataset.view); });
    });
    all('[data-view-link]').forEach(function (button) {
      listen(button, 'click', function () { switchView(button.dataset.viewLink); });
    });

    listen(byId('dashboard-year'), 'change', function (event) {
      state.selectedYear = Number(event.target.value);
      renderAll();
    });
    listen(byId('search-input'), 'input', renderMembers);
    listen(byId('status-filter'), 'change', renderMembers);

    listen(byId('new-member-button'), 'click', function () { openMemberModal(null); });
    listen(byId('empty-new-button'), 'click', function () { openMemberModal(null); });
    listen(byId('member-form'), 'submit', saveMember);
    listen(byId('close-modal'), 'click', function () { closeDialog(byId('member-modal')); });
    listen(byId('cancel-modal'), 'click', function () { closeDialog(byId('member-modal')); });
    listen(byId('remove-member-button'), 'click', function () { setMemberRemoved(true); });
    listen(byId('restore-member-button'), 'click', function () { setMemberRemoved(false); });
    listen(byId('members-table'), 'click', function (event) {
      var button = event.target.closest('[data-edit]');
      if (!button) return;
      var member = state.members.find(function (item) { return item.id === button.dataset.edit; });
      if (member) openMemberModal(member);
    });

    listen(byId('member-modal'), 'mousedown', function (event) {
      if (event.target === byId('member-modal')) closeDialog(byId('member-modal'));
    });

    listen(byId('receipt-form'), 'submit', issueReceipt);
    listen(byId('issue-receipt-button'), 'click', function (event) {
      if (!byId('receipt-form') || event.currentTarget.form) return;
      issueReceipt(event);
    });
    listen(byId('receipt-member'), 'change', receiptMemberChanged);
    [
      'receipt-date',
      'receipt-payment',
      'receipt-name',
      'receipt-nif',
      'receipt-address',
      'receipt-amount',
      'receipt-description'
    ].forEach(function (id) {
      var element = byId(id);
      listen(element, 'input', receiptDraftChanged);
      listen(element, 'change', receiptDraftChanged);
    });
    listen(byId('receipt-type'), 'change', function (event) {
      var previousType = event.currentTarget.dataset.previousType || 'Quota';
      var currentType = valueOf('receipt-type');
      if (previousType === 'Quota' && currentType !== 'Quota') {
        setValue('receipt-amount', '');
        setValue('receipt-description', currentType);
      }
      event.currentTarget.dataset.previousType = currentType;
      updateReceiptMemberRequirement();
      renderReceiptYearOptions();
      applyReceiptPermissions();
      receiptDraftChanged();
    });
    listen(byId('receipt-years-options'), 'change', function (event) {
      if (!event.target.closest('input[data-receipt-year]')) return;
      syncReceiptQuotaPreview();
      receiptDraftChanged();
    });
    listen(byId('print-receipt'), 'click', printPersistedReceipt);
    listen(byId('receipt-history'), 'click', function (event) {
      var button = event.target.closest('[data-receipt-preview]');
      if (!button) return;
      previewPersistedReceipt(button.dataset.receiptPreview);
    });

    listen(byId('request-status-filter'), 'change', renderPublicRequests);
    listen(byId('public-requests-table'), 'click', function (event) {
      var button = event.target.closest('[data-review-public-request]');
      if (!button) return;
      var request = state.publicRequests.find(function (item) {
        return item.id === button.dataset.reviewPublicRequest;
      });
      if (request) openPublicRequestReview(request);
    });
    listen(byId('close-request-review'), 'click', function () {
      closeDialog(byId('request-review-modal'));
    });
    listen(byId('cancel-request-review'), 'click', function () {
      closeDialog(byId('request-review-modal'));
    });
    listen(byId('approve-public-request'), 'click', function () {
      reviewPublicRequest('approve');
    });
    listen(byId('reject-public-request'), 'click', function () {
      reviewPublicRequest('reject');
    });
    listen(byId('request-review-modal'), 'mousedown', function (event) {
      if (event.target === byId('request-review-modal')) {
        closeDialog(byId('request-review-modal'));
      }
    });

    listen(byId('export-button'), 'click', exportData);
    listen(byId('import-button'), 'click', function () {
      if (!can('importMembers')) {
        showToast('Apenas administradores podem importar dados.', true);
        return;
      }
      var input = byId('import-file');
      if (input) input.click();
    });
    listen(byId('import-file'), 'change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) prepareImport(file);
      event.target.value = '';
    });
    listen(byId('confirm-import-button'), 'click', confirmImport);
    listen(byId('close-import-modal'), 'click', function () { closeDialog(byId('import-modal')); });
    listen(byId('cancel-import'), 'click', function () { closeDialog(byId('import-modal')); });
    listen(byId('import-modal'), 'mousedown', function (event) {
      if (event.target === byId('import-modal')) closeDialog(byId('import-modal'));
    });
    all('input[name="import-mode"]').forEach(function (control) {
      listen(control, 'change', function () {
        if (importMode() !== 'replace') setValue('replace-confirm', '');
        updateImportControls();
      });
    });
    listen(byId('import-mode'), 'change', updateImportControls);
    listen(byId('replace-confirm'), 'input', updateImportControls);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initializeReceiptForm();
      boot();
    }, { once: true });
  } else {
    initializeReceiptForm();
    boot();
  }
}());
