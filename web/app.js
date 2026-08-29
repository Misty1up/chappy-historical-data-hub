import { serializeWebJobRequest, validateWebJobDraft } from "./contract.js";

const form = document.querySelector("#job-form");
const symbolInput = document.querySelector("#symbol");
const modeInput = document.querySelector("#mode");
const fromInput = document.querySelector("#from");
const toInput = document.querySelector("#to");
const errors = document.querySelector("#errors");
const payload = document.querySelector("#payload");
const validationState = document.querySelector("#validation-state");
const reset = document.querySelector("#reset");

let symbols = [];

function asUtcIso(localValue) {
  return localValue ? `${localValue}.000Z` : "";
}

function renderErrors(items) {
  errors.hidden = items.length === 0;
  errors.innerHTML = items.length ? `<strong>Request rejected.</strong><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : "";
}

function setStatus(text, className) {
  validationState.textContent = text;
  validationState.className = `status ${className}`;
}

function resetReview() {
  renderErrors([]);
  payload.textContent = "No validated request yet.";
  setStatus("DRAFT", "status-draft");
}

async function loadSymbols() {
  const response = await fetch("./symbol_registry.json", { cache: "no-store" });
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
    .join("");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const result = validateWebJobDraft({
    symbol: symbolInput.value,
    requested_from_utc: asUtcIso(fromInput.value),
    requested_to_utc: asUtcIso(toInput.value),
    mode: modeInput.value
  }, symbols);

  if (!result.ok || !result.request) {
    renderErrors(result.errors);
    payload.textContent = "No validated request generated.";
    setStatus("FAIL", "status-fail");
    return;
  }

  renderErrors([]);
  payload.textContent = serializeWebJobRequest(result.request);
  setStatus("VALIDATED", "status-pass");
});

reset.addEventListener("click", () => {
  form.reset();
  resetReview();
});

loadSymbols().catch((error) => {
  renderErrors([error instanceof Error ? error.message : String(error)]);
  setStatus("HOLD", "status-hold");
});
