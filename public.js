(function () {
  'use strict';

  var state = {
    client: null,
    config: null,
    pending: false
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function valueOf(id) {
    var element = byId(id);
    return element ? String(element.value || '').trim() : '';
  }

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = Boolean(hidden);
    element.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  }

  function setMessage(message, isError) {
    var output = byId('public-form-message');
    if (!output) return;
    output.textContent = message || '';
    output.classList.toggle('form-message--error', Boolean(isError));
    output.setAttribute('role', isError ? 'alert' : 'status');
  }

  function explainError(error) {
    var message = error && error.message ? String(error.message) : '';
    var lower = message.toLowerCase();
    if (lower.indexOf('failed to fetch') >= 0 || lower.indexOf('network') >= 0) {
      return 'Não foi possível contactar o serviço. Confirme a ligação e tente novamente.';
    }
    if (message && message.length <= 240) return message;
    return 'Não foi possível enviar o pedido. Confirme os dados e tente novamente.';
  }

  function setPending(pending) {
    state.pending = pending;
    var form = byId('public-request-form');
    var button = byId('public-submit-button');
    if (form) {
      form.setAttribute('aria-busy', pending ? 'true' : 'false');
      Array.prototype.slice.call(form.querySelectorAll('input, select, textarea, button'))
        .forEach(function (control) { control.disabled = pending; });
    }
    if (button) button.textContent = pending ? 'A enviar…' : 'Enviar pedido';
    if (!pending) updateRequestType();
  }

  function populateYears() {
    var select = byId('public-quota-year');
    if (!select || !state.config) return;
    var currentYear = new Date().getFullYear();
    var finalYear = Math.max(currentYear + 1, state.config.startYear + 4);
    select.replaceChildren();
    for (var year = state.config.startYear; year <= finalYear; year += 1) {
      var option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      if (year === currentYear) option.selected = true;
      select.appendChild(option);
    }
  }

  function updateRequestType() {
    var typeControl = byId('public-request-type');
    var type = valueOf('public-request-type') || 'membership';
    var previousType = typeControl ? typeControl.dataset.previousType || type : type;
    var isQuota = type === 'quota';
    var hasPayment = type === 'quota' || type === 'donation';
    var memberNumber = byId('public-member-number');
    var quotaYear = byId('public-quota-year');
    var amount = byId('public-amount');
    var paymentMethod = byId('public-payment-method');
    var paymentDate = byId('public-payment-date');
    var paymentReference = byId('public-payment-reference');

    setHidden(byId('public-member-number-field'), !isQuota);
    setHidden(byId('public-quota-year-field'), !isQuota);
    setHidden(byId('public-payment-fields'), !hasPayment);
    setHidden(byId('payment-instructions'), !hasPayment);

    if (memberNumber) memberNumber.required = isQuota;
    if (quotaYear) quotaYear.required = isQuota;
    [amount, paymentMethod, paymentDate, paymentReference].forEach(function (control) {
      if (control) control.required = hasPayment;
    });

    if (amount) {
      amount.readOnly = isQuota;
      if (isQuota && state.config) amount.value = state.config.annualFee.toFixed(2);
      if (!hasPayment) amount.value = '';
      if (type === 'donation' && previousType === 'quota') amount.value = '';
    }
    if (typeControl) typeControl.dataset.previousType = type;
  }

  function requestPayload() {
    var type = valueOf('public-request-type');
    var payload = {
      request_type: type,
      name: valueOf('public-name'),
      email: valueOf('public-email'),
      contact: valueOf('public-contact'),
      nif: valueOf('public-nif'),
      address: valueOf('public-address'),
      postal: valueOf('public-postal'),
      locality: valueOf('public-locality'),
      message: valueOf('public-message'),
      consent: Boolean(byId('public-consent') && byId('public-consent').checked),
      website: valueOf('public-website')
    };

    if (type === 'quota') {
      payload.member_number = valueOf('public-member-number');
      payload.quota_year = valueOf('public-quota-year');
    }
    if (type === 'quota' || type === 'donation') {
      payload.amount = valueOf('public-amount');
      payload.payment_method = valueOf('public-payment-method');
      payload.payment_date = valueOf('public-payment-date');
      payload.payment_reference = valueOf('public-payment-reference');
    }
    return payload;
  }

  async function submitRequest(event) {
    event.preventDefault();
    if (state.pending || !state.client) return;
    var form = byId('public-request-form');
    if (form && !form.reportValidity()) return;

    setMessage('', false);
    setPending(true);
    try {
      var result = await state.client.rpc('submit_public_request', {
        payload: requestPayload()
      });
      if (result.error) throw result.error;
      var response = result.data || {};
      if (!response.request_number) throw new Error('O serviço não devolveu a referência do pedido.');

      byId('public-request-reference').textContent = 'PED-' + response.request_number;
      setHidden(form, true);
      setHidden(byId('public-success'), false);
      byId('public-success').focus();
    } catch (error) {
      setMessage(explainError(error), true);
    } finally {
      setPending(false);
    }
  }

  function resetForm() {
    var form = byId('public-request-form');
    if (form) form.reset();
    var today = new Date().toISOString().slice(0, 10);
    var paymentDate = byId('public-payment-date');
    if (paymentDate) {
      paymentDate.value = today;
      paymentDate.max = today;
    }
    populateYears();
    updateRequestType();
    setMessage('', false);
    setHidden(byId('public-success'), true);
    setHidden(form, false);
    var type = byId('public-request-type');
    if (type) type.focus();
  }

  function boot() {
    var sdk = window.supabase || window.Supabase;
    var config = window.TEAM_JM_UAT_CONFIG;
    var button = byId('public-submit-button');
    try {
      if (!sdk || typeof sdk.createClient !== 'function') {
        throw new Error('A biblioteca de ligação não foi carregada.');
      }
      if (!config || !config.supabaseUrl || !config.supabaseAnonKey) {
        throw new Error('A página ainda não está configurada.');
      }
      state.config = {
        annualFee: Number(config.annualFee),
        startYear: Number(config.startYear),
        supabaseUrl: String(config.supabaseUrl),
        supabaseAnonKey: String(config.supabaseAnonKey)
      };
      if (!Number.isFinite(state.config.annualFee) || state.config.annualFee <= 0) {
        throw new Error('O valor da quota não está configurado corretamente.');
      }
      if (!Number.isInteger(state.config.startYear)) {
        throw new Error('O ano inicial não está configurado corretamente.');
      }
      state.client = sdk.createClient(
        state.config.supabaseUrl,
        state.config.supabaseAnonKey,
        { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
      );
      populateYears();
      resetForm();
    } catch (error) {
      if (button) button.disabled = true;
      setMessage(explainError(error), true);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var today = new Date().toISOString().slice(0, 10);
    var paymentDate = byId('public-payment-date');
    if (paymentDate) {
      paymentDate.value = today;
      paymentDate.max = today;
    }
    byId('public-request-type').addEventListener('change', updateRequestType);
    byId('public-request-form').addEventListener('submit', submitRequest);
    byId('public-new-request').addEventListener('click', resetForm);
    boot();
  }, { once: true });
}());
