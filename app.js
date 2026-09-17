'use strict';

// ---------------------------------------------------------------------------
// Dealership config
// ---------------------------------------------------------------------------
// The dealership's own ZIP is fixed per deployment (this calculator is
// wired to one dealership at a time) rather than asked of every customer.
// It's still sent to the backend for record-keeping on saved deals, but it
// never drives the tax calculation — that's always based on the
// customer's registration ZIP, per §4.3.
//
// UPDATE THIS to Mario Toyota's real ZIP code before going live.
const DEALERSHIP_ZIP = '07075'; // Mario Toyota

// All calls go through the /api/* redirect defined in netlify.toml, which
// maps to /.netlify/functions/*. This means the frontend works identically
// whether it's deployed at a site root or as calculator.mariotoyota.com.
const API = {
  catalog: (params) => fetch(`/api/catalog?${new URLSearchParams(params)}`).then(parseJson),
  resolveTax: (zip) => fetch(`/api/resolve-tax?${new URLSearchParams({ zip })}`).then(parseJson),
  calculateDeal: (body) =>
    fetch('/api/calculate-deal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(parseJson),
};

async function parseJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mode: 'customer',
  trade: false,
  manualVehicle: false,
  termMonths: 60,
  objective: 'best_balance',
  vehicle: { trimId: null, msrp: null },
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Init: populate dropdowns that don't depend on other selections
// ---------------------------------------------------------------------------

async function init() {
  try {
    const { data: manufacturers } = await API.catalog({ resource: 'manufacturers' });
    fillSelect($('selMake'), manufacturers, 'Select make…');
  } catch (err) {
    console.warn('Could not load manufacturers — is the backend connected?', err);
  }

  try {
    const { data: tiers } = await API.catalog({ resource: 'creditTiers' });
    fillSelect(
      $('selCreditTier'),
      tiers.map((t) => ({ id: t.id, name: t.label })),
      'Select credit tier…'
    );
  } catch (err) {
    console.warn('Could not load credit tiers', err);
  }

  wireEvents();
}

function fillSelect(selectEl, items, placeholder) {
  selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name || item.year;
    selectEl.appendChild(opt);
  });
}

// ---------------------------------------------------------------------------
// Cascading vehicle dropdowns
// ---------------------------------------------------------------------------

function wireEvents() {
  $('selMake').addEventListener('change', onMakeChange);
  $('selModel').addEventListener('change', onModelChange);
  $('selYear').addEventListener('change', onYearChange);
  $('selTrim').addEventListener('change', onTrimChange);

  $('btnManualVehicle').addEventListener('click', () => {
    state.manualVehicle = true;
    $('manualVehicleFields').classList.remove('hidden');
    $('notListedNotice').classList.add('hidden');
  });

  document.querySelectorAll('.segment[data-trade]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segment[data-trade]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.trade = btn.dataset.trade === 'yes';
      $('tradeFields').classList.toggle('hidden', !state.trade);
      updateEquityHint();
    });
  });
  ['inTradeValue', 'inTradePayoff'].forEach((id) => $(id).addEventListener('input', updateEquityHint));

  document.querySelectorAll('.segment[data-term]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segment[data-term]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.termMonths = Number(btn.dataset.term);
    });
  });

  document.querySelectorAll('.segment[data-objective]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segment[data-objective]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.objective = btn.dataset.objective;
    });
  });

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.mode = btn.dataset.mode;
      // NOTE: this is a UI convenience toggle only. Dealer Mode does not
      // hide anything sensitive here because there is no auth layer yet —
      // see README-integration.md "Before going live" for what's required
      // before Dealer Mode should be exposed to real customers.
    });
  });

  $('inCustomerZip').addEventListener('blur', onCustomerZipBlur);

  $('btnCalculate').addEventListener('click', onCalculate);
  $('btnToggleTaxDetails').addEventListener('click', () => toggle($('taxDetails')));
  $('btnExplain').addEventListener('click', () => toggle($('explainBox')));
}

async function onMakeChange() {
  resetSelect($('selModel'), 'Select model…', true);
  resetSelect($('selYear'), 'Select year…', true);
  resetSelect($('selTrim'), 'Select trim…', true);
  $('notListedNotice').classList.add('hidden');
  state.vehicle = { trimId: null, msrp: null };
  updateMsrpNote();

  const manufacturerId = $('selMake').value;
  if (!manufacturerId) return;
  try {
    const { data } = await API.catalog({ resource: 'models', manufacturerId });
    if (data.length === 0) {
      $('notListedNotice').classList.remove('hidden');
      return;
    }
    fillSelect($('selModel'), data, 'Select model…');
    $('selModel').disabled = false;
  } catch (err) {
    showError(err.message);
  }
}

async function onModelChange() {
  resetSelect($('selYear'), 'Select year…', true);
  resetSelect($('selTrim'), 'Select trim…', true);

  const modelId = $('selModel').value;
  if (!modelId) return;
  try {
    const { data } = await API.catalog({ resource: 'modelYears', modelId });
    if (data.length === 0) {
      $('notListedNotice').classList.remove('hidden');
      return;
    }
    fillSelect($('selYear'), data, 'Select year…');
    $('selYear').disabled = false;
  } catch (err) {
    showError(err.message);
  }
}

async function onYearChange() {
  resetSelect($('selTrim'), 'Select trim…', true);
  const modelYearId = $('selYear').value;
  if (!modelYearId) return;
  try {
    const { data } = await API.catalog({ resource: 'trims', modelYearId });
    if (data.length === 0) {
      $('notListedNotice').classList.remove('hidden');
      return;
    }
    fillSelect($('selTrim'), data, 'Select trim…');
    $('selTrim').disabled = false;
  } catch (err) {
    showError(err.message);
  }
}

async function onTrimChange() {
  const trimId = $('selTrim').value;
  state.vehicle = { trimId: trimId || null, msrp: null };
  updateMsrpNote();
  if (!trimId) return;

  try {
    const { pricing } = await API.catalog({ resource: 'pricing', trimId });
    if (pricing) {
      state.vehicle.msrp = Number(pricing.msrp);
      $('inSellingPrice').value = pricing.msrp;
    } else {
      $('notListedNotice').classList.remove('hidden');
    }
    updateMsrpNote();
  } catch (err) {
    showError(err.message);
  }
}

function updateMsrpNote() {
  $('msrpNote').textContent = state.vehicle.msrp
    ? `MSRP: $${Number(state.vehicle.msrp).toLocaleString()} — editable`
    : '';
}

function resetSelect(selectEl, placeholder, disable) {
  selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  selectEl.disabled = !!disable;
}

// ---------------------------------------------------------------------------
// Live hints: trade equity, tax location
// ---------------------------------------------------------------------------

function updateEquityHint() {
  if (!state.trade) {
    $('equityHint').textContent = '';
    return;
  }
  const value = Number($('inTradeValue').value || 0);
  const payoff = Number($('inTradePayoff').value || 0);
  const equity = value - payoff;
  const label = equity > 0 ? 'positive equity' : equity < 0 ? 'negative equity' : 'no equity';
  $('equityHint').textContent = `Trade equity: ${money(Math.abs(equity))} ${equity !== 0 ? label : '(break-even)'}`;
}

async function onCustomerZipBlur() {
  const zip = $('inCustomerZip').value.trim();
  if (!/^\d{5}$/.test(zip)) return;
  $('taxLocationHint').textContent = 'Looking up estimated tax…';
  try {
    const tax = await API.resolveTax(zip);
    $('taxLocationHint').textContent = `${tax.city ? tax.city + ', ' : ''}${tax.state || ''} — estimated tax rate ${(
      tax.estimatedTaxRate * 100
    ).toFixed(3)}%`;
  } catch (err) {
    $('taxLocationHint').textContent = 'Could not resolve tax rate for that ZIP right now.';
  }
}

// ---------------------------------------------------------------------------
// Calculate
// ---------------------------------------------------------------------------

async function onCalculate() {
  hideError();
  const payload = buildPayload();
  if (!payload) return;

  const btn = $('btnCalculate');
  btn.disabled = true;
  btn.textContent = 'Calculating…';

  try {
    const result = await API.calculateDeal(payload);
    $('taxOverrideFields').classList.add('hidden');
    renderResults(result);
  } catch (err) {
    if (err.code === 'TAX_UNAVAILABLE') {
      $('taxOverrideFields').classList.remove('hidden');
      showError('Automatic tax lookup is unavailable right now. Enter a tax rate manually above and calculate again.');
    } else {
      showError(err.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Calculate deal';
  }
}

function buildPayload() {
  const sellingPrice = Number($('inSellingPrice').value);
  const customerRegistrationZip = $('inCustomerZip').value.trim();
  const creditTierId = $('selCreditTier').value;

  if (!sellingPrice || !customerRegistrationZip || !creditTierId) {
    showError('Please fill in vehicle price, the ZIP code, and credit tier before calculating.');
    return null;
  }

  let vehicleSource;
  if (state.manualVehicle) {
    vehicleSource = {
      type: 'manual',
      manualEntry: {
        year: Number($('manYear').value) || null,
        make: $('manMake').value,
        model: $('manModel').value,
        trim: $('manTrim').value,
        condition: $('selCondition').value,
        enteredPrice: sellingPrice,
      },
    };
  } else if (state.vehicle.trimId) {
    vehicleSource = { type: 'trim', trimId: state.vehicle.trimId };
  } else {
    showError('Select a vehicle from the dropdowns, or use "Enter it manually".');
    return null;
  }

  return {
    dealershipZip: DEALERSHIP_ZIP,
    customerRegistrationZip,
    vehicleSource,
    vehicleCondition: $('selCondition').value,
    sellingPrice,
    dealerDiscount: 0,
    otherDiscount: 0,
    accessoriesTotal: 0,
    dealerInstalledProductsTotal: 0,
    appliedIncentiveIds: [],
    trade: state.trade
      ? { hasTrade: true, tradeValue: Number($('inTradeValue').value || 0), payoff: Number($('inTradePayoff').value || 0) }
      : { hasTrade: false, tradeValue: 0, payoff: 0 },
    downPayment: Number($('inDownPayment').value || 0),
    cashAvailable: $('inCashAvailable').value ? Number($('inCashAvailable').value) : undefined,
    creditTierId,
    termMonths: state.termMonths,
    targetPayment: $('inTargetPayment').value ? Number($('inTargetPayment').value) : undefined,
    objective: state.objective,
    mode: state.mode,
    taxRateOverride: $('inTaxOverride').value ? Number($('inTaxOverride').value) / 100 : undefined,
  };
}

// ---------------------------------------------------------------------------
// Render results
// ---------------------------------------------------------------------------

function renderResults(result) {
  $('resultsEmpty').classList.add('hidden');
  $('resultsContent').classList.remove('hidden');

  const current = result.scenarios[0];
  $('outMonthlyPayment').textContent = money(current.monthlyPayment);
  $('outAmountFinanced').textContent = money(current.amountFinanced);
  $('outApr').textContent = `${result.financing.estimatedApr}%`;
  $('outTerm').textContent = `${result.financing.termMonths} months`;
  $('outTotalInterest').textContent = money(current.totalInterest);
  $('outTotalPayments').textContent = money(current.totalPayments);
  $('outCashRequired').textContent = money(current.cashRequired);

  const gapBanner = $('paymentGapBanner');
  if (result.paymentGap && result.paymentGap.direction !== 'on_target') {
    gapBanner.classList.remove('hidden', 'above', 'below');
    gapBanner.classList.add(result.paymentGap.direction === 'above_target' ? 'above' : 'below');
    const word = result.paymentGap.direction === 'above_target' ? 'above' : 'below';
    gapBanner.textContent = `${money(result.paymentGap.difference)} ${word} your target`;
  } else {
    gapBanner.classList.add('hidden');
  }

  $('taxDetails').innerHTML = `
    <p><strong>Estimated tax:</strong> ${money(result.tax.estimatedTax)} (${(result.tax.taxRate * 100).toFixed(3)}%, ${
    result.tax.jurisdiction.city ? result.tax.jurisdiction.city + ', ' : ''
  }${result.tax.jurisdiction.state || ''})</p>
    ${result.tax.isManualOverride ? '<p><em>Manually entered rate.</em></p>' : ''}
    ${result.tax.isStale ? '<p><em>This rate may be more than 30 days old — a refresh will run automatically.</em></p>' : ''}
    <p><strong>Fees:</strong> ${money(result.fees.total)}</p>
    <p>${result.tax.disclaimer}</p>
  `;

  $('scenarioList').innerHTML = '';
  result.scenarios.forEach((s) => {
    const card = document.createElement('div');
    card.className = `scenario-card${s.isRecommended ? ' is-recommended' : ''}`;
    card.innerHTML = `
      <span class="scenario-name">${s.scenarioLabel}</span>
      <div class="scenario-payment">${money(s.monthlyPayment)}<span style="font-size:0.9rem;color:var(--text-muted)">/mo</span></div>
      <div class="scenario-meta"><span>Cash: ${money(s.cashRequired)}</span><span>Interest: ${money(s.totalInterest)}</span></div>
    `;
    $('scenarioList').appendChild(card);
  });

  $('explainBox').innerHTML = `<p>${result.explanation}</p>`;
  $('explainBox').classList.add('hidden');

  const dealerBox = $('dealerBox');
  if (result.dealerOnly) {
    dealerBox.classList.remove('hidden');
    dealerBox.innerHTML = `
      <p><strong>Dealer note:</strong> ${result.dealerOnly.dealerExplanation}</p>
    `;
  } else {
    dealerBox.classList.add('hidden');
  }

  if (result.warnings && result.warnings.length) {
    showError(result.warnings.join(' '), true);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function money(n) {
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function toggle(el) {
  el.classList.toggle('hidden');
}

function showError(message, isWarning) {
  const box = $('formErrors');
  box.textContent = message;
  box.classList.remove('hidden');
  box.style.borderColor = isWarning ? 'var(--accent)' : 'var(--negative)';
  box.style.color = isWarning ? 'var(--accent)' : 'var(--negative)';
}

function hideError() {
  $('formErrors').classList.add('hidden');
}

init();

