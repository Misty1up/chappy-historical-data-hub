import { serializeWebJobRequest, validateWebJobDraft, type WebSymbolContract } from "../../src/web/contract.js";

const symbols: WebSymbolContract[] = [
  { canonical_symbol: "EURUSD", enabled: true, precision_status: "VERIFIED" },
  { canonical_symbol: "XAUUSD", enabled: true, precision_status: "VERIFIED" },
  { canonical_symbol: "TESTUNVERIFIED", enabled: true, precision_status: "UNVERIFIED" }
];

export async function run(): Promise<void> {
  const valid = validateWebJobDraft({
    symbol: "EURUSD",
    requested_from_utc: "2026-01-05T00:00:00.000Z",
    requested_to_utc: "2026-01-06T00:00:00.000Z",
    mode: "RESEARCH_MASTER"
  }, symbols);
  if (!valid.ok || !valid.request) throw new Error(`valid web request rejected: ${valid.errors.join(", ")}`);
  if ("dataset_id" in valid.request) throw new Error("web request must not contain dataset_id authority");
  if ("source_hash_root" in valid.request) throw new Error("web request must not contain source hash authority");
  if ("canonical_logical_hash_root" in valid.request) throw new Error("web request must not contain canonical hash authority");

  const serializedA = serializeWebJobRequest(valid.request);
  const serializedB = serializeWebJobRequest(valid.request);
  if (serializedA !== serializedB) throw new Error("web request serialization is not deterministic");

  const invalidSymbol = validateWebJobDraft({
    symbol: "GBPJPY",
    requested_from_utc: "2026-01-05T00:00:00.000Z",
    requested_to_utc: "2026-01-06T00:00:00.000Z",
    mode: "QUICK_DOWNLOAD"
  }, symbols);
  if (invalidSymbol.ok) throw new Error("invalid symbol accepted");

  const invalidRange = validateWebJobDraft({
    symbol: "EURUSD",
    requested_from_utc: "2026-01-06T00:00:00.000Z",
    requested_to_utc: "2026-01-05T00:00:00.000Z",
    mode: "RESEARCH_MASTER"
  }, symbols);
  if (invalidRange.ok) throw new Error("invalid range accepted");

  const nonUtc = validateWebJobDraft({
    symbol: "EURUSD",
    requested_from_utc: "2026-01-05T09:00:00+09:00",
    requested_to_utc: "2026-01-06T09:00:00+09:00",
    mode: "RESEARCH_MASTER"
  }, symbols);
  if (nonUtc.ok) throw new Error("non-UTC timestamp accepted");

  const unverifiedResearch = validateWebJobDraft({
    symbol: "TESTUNVERIFIED",
    requested_from_utc: "2026-01-05T00:00:00.000Z",
    requested_to_utc: "2026-01-06T00:00:00.000Z",
    mode: "MT5_PARITY_MASTER"
  }, symbols);
  if (unverifiedResearch.ok) throw new Error("unverified symbol accepted for research mode");
}
