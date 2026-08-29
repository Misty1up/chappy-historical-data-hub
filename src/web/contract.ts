export const WEB_REQUEST_SCHEMA_VERSION = "0.1" as const;
export const WEB_ACCEPTED_CONTRACT_VERSION = "HDH_PHASE2_ACCEPTED_V1" as const;

export type WebMode = "QUICK_DOWNLOAD" | "RESEARCH_MASTER" | "MT5_PARITY_MASTER";

export interface WebSymbolContract {
  canonical_symbol: string;
  enabled: boolean;
  precision_status: "VERIFIED" | "UNVERIFIED";
}

export interface WebJobRequest {
  request_schema_version: typeof WEB_REQUEST_SCHEMA_VERSION;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  mode: WebMode;
  requested_output: "QUICK_EXPORT" | "DATASET_PACKET";
  accepted_contract_version: typeof WEB_ACCEPTED_CONTRACT_VERSION;
}

export interface WebJobDraft {
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  mode: WebMode;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  request?: WebJobRequest;
}

const RESEARCH_MODES = new Set<WebMode>(["RESEARCH_MASTER", "MT5_PARITY_MASTER"]);

function isStrictUtcIso(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

export function validateWebJobDraft(draft: WebJobDraft, symbols: readonly WebSymbolContract[]): ValidationResult {
  const errors: string[] = [];
  const symbol = symbols.find((item) => item.canonical_symbol === draft.symbol && item.enabled);
  if (!symbol) errors.push("symbol must exist in the enabled accepted registry");
  if (!isStrictUtcIso(draft.requested_from_utc)) errors.push("requested_from_utc must be a strict UTC ISO timestamp");
  if (!isStrictUtcIso(draft.requested_to_utc)) errors.push("requested_to_utc must be a strict UTC ISO timestamp");

  const fromMs = Date.parse(draft.requested_from_utc);
  const toMs = Date.parse(draft.requested_to_utc);
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs >= toMs) errors.push("requested_from_utc must be before requested_to_utc");
  if (symbol && RESEARCH_MODES.has(draft.mode) && symbol.precision_status !== "VERIFIED") {
    errors.push("research modes require precision_status=VERIFIED");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    request: {
      request_schema_version: WEB_REQUEST_SCHEMA_VERSION,
      symbol: draft.symbol,
      requested_from_utc: draft.requested_from_utc,
      requested_to_utc: draft.requested_to_utc,
      mode: draft.mode,
      requested_output: draft.mode === "QUICK_DOWNLOAD" ? "QUICK_EXPORT" : "DATASET_PACKET",
      accepted_contract_version: WEB_ACCEPTED_CONTRACT_VERSION
    }
  };
}

export function serializeWebJobRequest(request: WebJobRequest): string {
  return JSON.stringify(request, null, 2) + "\n";
}
