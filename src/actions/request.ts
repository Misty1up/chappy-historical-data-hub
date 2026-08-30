import {
  WEB_ACCEPTED_CONTRACT_VERSION,
  WEB_REQUEST_SCHEMA_VERSION,
  serializeWebJobRequest,
  validateWebJobDraft,
  type WebJobRequest,
  type WebMode,
  type WebSymbolContract
} from '../web/contract.js';

const REQUEST_KEYS = [
  'request_schema_version',
  'symbol',
  'requested_from_utc',
  'requested_to_utc',
  'mode',
  'requested_output',
  'accepted_contract_version'
] as const;

const MODES = new Set<WebMode>(['QUICK_DOWNLOAD', 'RESEARCH_MASTER', 'MT5_PARITY_MASTER']);
const OUTPUTS = new Set(['QUICK_EXPORT', 'DATASET_PACKET'] as const);

export interface ActionRequestValidationResult {
  ok: boolean;
  errors: string[];
  request?: WebJobRequest;
  serialized_request?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAndValidateActionRequestJson(
  requestJson: string,
  symbols: readonly WebSymbolContract[]
): ActionRequestValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return { ok: false, errors: ['request_json must be valid JSON'] };
  }

  if (!isObject(parsed)) {
    return { ok: false, errors: ['request_json must be a JSON object'] };
  }

  const errors: string[] = [];
  const keys = Object.keys(parsed);
  const unexpected = keys.filter((key) => !REQUEST_KEYS.includes(key as (typeof REQUEST_KEYS)[number]));
  const missing = REQUEST_KEYS.filter((key) => !(key in parsed));
  if (unexpected.length > 0) errors.push(`request_json contains unexpected fields: ${unexpected.sort().join(', ')}`);
  if (missing.length > 0) errors.push(`request_json is missing required fields: ${missing.join(', ')}`);

  if (parsed.request_schema_version !== WEB_REQUEST_SCHEMA_VERSION) {
    errors.push(`request_schema_version must equal ${WEB_REQUEST_SCHEMA_VERSION}`);
  }
  if (parsed.accepted_contract_version !== WEB_ACCEPTED_CONTRACT_VERSION) {
    errors.push(`accepted_contract_version must equal ${WEB_ACCEPTED_CONTRACT_VERSION}`);
  }
  if (typeof parsed.symbol !== 'string') errors.push('symbol must be a string');
  if (typeof parsed.requested_from_utc !== 'string') errors.push('requested_from_utc must be a string');
  if (typeof parsed.requested_to_utc !== 'string') errors.push('requested_to_utc must be a string');
  if (typeof parsed.mode !== 'string' || !MODES.has(parsed.mode as WebMode)) errors.push('mode is unsupported');
  if (typeof parsed.requested_output !== 'string' || !OUTPUTS.has(parsed.requested_output as 'QUICK_EXPORT' | 'DATASET_PACKET')) {
    errors.push('requested_output is unsupported');
  }

  if (errors.length > 0) return { ok: false, errors };

  const mode = parsed.mode as WebMode;
  const normalized = validateWebJobDraft({
    symbol: parsed.symbol as string,
    requested_from_utc: parsed.requested_from_utc as string,
    requested_to_utc: parsed.requested_to_utc as string,
    mode
  }, symbols);
  if (!normalized.ok || !normalized.request) return { ok: false, errors: normalized.errors };

  if (parsed.requested_output !== normalized.request.requested_output) {
    return {
      ok: false,
      errors: [`requested_output must equal ${normalized.request.requested_output} for mode ${mode}`]
    };
  }

  return {
    ok: true,
    errors: [],
    request: normalized.request,
    serialized_request: serializeWebJobRequest(normalized.request)
  };
}
