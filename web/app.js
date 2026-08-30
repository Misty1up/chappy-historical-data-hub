import { serializeWebJobRequest, validateWebJobDraft } from './contract.js';
import { assertWebJobView, createSyntheticJobFixture } from './status-result.js';

const form = document.querySelector('#job-form');
const symbolInput = document.querySelector('#symbol');
const modeInput = document.querySelector('#mode');
const fromInput = document.querySelector('#from');
const toInput = document.querySelector('#to');
const errors = document.querySelector('#errors');
const payload = document.querySelector('#payload');
const validationState = document.querySelector('#validation-state');
const reset = document.querySelector('#reset');
const fixtureActions = document.querySelector('#fixture-actions');
const jobStatus = document.querySelector('#job-status');
const jobDetail = document.querySelector('#job-detail');
const resultPanel = document.querySelector('#result-panel');
const resultMetadata = document.querySelector('#result-metadata');
const packetReference = document.querySelector('#packet-reference');

let symbols = [];
let validatedRequest = null;

function asUtcIso(localValue) {
  return localValue ? `${localValue}.000Z` : '';
}

function renderErrors(items) {
  errors.hidden = items.length === 0;
  errors.innerHTML = items.length ? `<strong>Request rejected.</strong><ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '';
}

function setStatus(element, text, className) {
  element.textContent = text;
  element.className = `status ${className}`;
}

function statusClass(status) {
  if (status === 'PASS' || status === 'VALIDATED') return 'status-pass';
  if (status === 'FAIL') return 'status-fail';
  if (status === 'HOLD') return 'status-hold';
  return 'status-draft';
}

function resetExecutionPreview() {
  setStatus(jobStatus, 'DRAFT', 'status-draft');
  jobDetail.textContent = 'Generate a validated request, then load a synthetic execution fixture.';
  resultPanel.hidden = true;
  resultMetadata.innerHTML = '';
  packetReference.textContent = 'No packet reference.';
}

function resetReview() {
  validatedRequest = null;
  renderErrors([]);
  payload.textContent = 'No validated request yet.';
  setStatus(validationState, 'DRAFT', 'status-draft');
  fixtureActions.hidden = true;
  resetExecutionPreview();
}

function renderResult(view) {
  assertWebJobView(view);
  setStatus(jobStatus, view.status, statusClass(view.status));
  jobDetail.textContent = view.detail;

  if (!view.result) {
    resultPanel.hidden = true;
    resultMetadata.innerHTML = '';
    packetReference.textContent = 'No packet reference available for this state.';
    return;
  }

  resultPanel.hidden = false;
  const fields = [
    ['dataset_id', view.result.dataset_id],
    ['symbol', view.result.symbol],
    ['requested_from_utc', view.result.requested_from_utc],
    ['requested_to_utc', view.result.requested_to_utc],
    ['tick_count_total', String(view.result.tick_count_total)],
    ['source_hash_root', view.result.source_hash_root],
    ['canonical_logical_hash_root', view.result.canonical_logical_hash_root],
    ['integrity_status', view.result.integrity_status],
    ['canonical_promotion_allowed', String(view.result.canonical_promotion_allowed)]
  ];
  resultMetadata.innerHTML = fields.map(([key, value]) => `<div class="result-row"><dt>${key}</dt><dd>${value}</dd></div>`).join('');
  packetReference.textContent = view.result.packet_artifact_reference;
}

async function loadSymbols() {
  const response = await fetch('./symbol_registry.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`symbol registry load failed: ${response.status}`);
  const registry = await response.json();
  symbols = registry.symbols.map((item) => ({
    canonical_symbol: item.canonical_symbol,
    enabled: item.enabled,
    precision_status: item.precision_status
  }));
  symbolInput.innerHTML = symbols
    .filter((item) => item.enabled)
    .map((item) => `<option value="${item.canonical_symbol}">${item.canonical_symbol} · ${item.precision_status}</option>`)
    .join('');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const result = validateWebJobDraft({
    symbol: symbolInput.value,
    requested_from_utc: asUtcIso(fromInput.value),
    requested_to_utc: asUtcIso(toInput.value),
    mode: modeInput.value
  }, symbols);

  if (!result.ok || !result.request) {
    validatedRequest = null;
    renderErrors(result.errors);
    payload.textContent = 'No validated request generated.';
    setStatus(validationState, 'FAIL', 'status-fail');
    fixtureActions.hidden = true;
    resetExecutionPreview();
    return;
  }

  validatedRequest = result.request;
  renderErrors([]);
  payload.textContent = serializeWebJobRequest(result.request);
  setStatus(validationState, 'VALIDATED', 'status-pass');
  fixtureActions.hidden = false;
  resetExecutionPreview();
});

fixtureActions.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-scenario]');
  if (!button || !validatedRequest) return;
  renderResult(createSyntheticJobFixture(validatedRequest, button.dataset.scenario));
});

reset.addEventListener('click', () => {
  form.reset();
  resetReview();
});

loadSymbols().catch((error) => {
  renderErrors([error instanceof Error ? error.message : String(error)]);
  setStatus(validationState, 'HOLD', 'status-hold');
  setStatus(jobStatus, 'HOLD', 'status-hold');
  jobDetail.textContent = 'Symbol registry could not be loaded; execution preview is blocked.';
});

resetReview();
