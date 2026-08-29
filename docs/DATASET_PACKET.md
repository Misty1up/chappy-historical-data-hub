# Phase 2 P2.5 Dataset Packet Contract

P2.5 binds the already accepted frozen Source Snapshot, Canonical Parquet and MT5 derivative artifacts into one reproducible Dataset Packet. It does **not** reacquire market data and it does not change any P2.1–P2.4 Canonical semantics.

## D-037 — Dataset identity / hash-root serialization

The Frozen Phase 2 spec fixes the dataset identity inputs but intentionally did not specify byte-level serialization. P2.5 uses the existing repository hashing convention: explicit text serialization, UTF-8, LF line endings and SHA-256.

`canonical_schema_version` is `0.1`, directly matching Frozen Spec Section 5 (`CANONICAL TICK SCHEMA v0.1`).

Dataset identity input is exactly:

```text
HDH_DATASET_ID_V1
canonical_schema_version=<value>
symbol=<value>
requested_from_utc=<value>
requested_to_utc=<value>
source_hash_root=<64 lowercase hex>
precision_evidence_sha256=<64 lowercase hex>
generator_git_commit=<exact git commit>
```

There is a final LF after `generator_git_commit`. `dataset_id` is:

```text
HDH_DATASET_V1_<sha256(identity-input-bytes)>
```

`generated_at_utc` is deliberately excluded from identity.

Hash roots use the Phase 1 `source_hash_root` convention: sort entries by their fixed key, serialize each as `key␠␠sha256\n`, concatenate, then SHA-256 the UTF-8 bytes.

- `canonical_logical_hash_root`: key = `date_utc`, value = daily Canonical logical row hash.
- `parquet_file_hash_root`: key = packet-relative Canonical Parquet path, value = physical file SHA-256.
- `mt5_derivative_hash_root`: key = packet-relative MT5 tick CSV path, value = physical file SHA-256.

These roots remain separate by manifest field. Physical encoding differences are never treated as Canonical logical row differences.

## Builder authority

The builder requires:

1. a Phase 1 source-run manifest with `integrity_status=PASS`;
2. exact daily Source Snapshot SHA provenance matching the Phase 1 manifest/audit chain;
3. `precision_evidence.json` with `VERIFIED`, exact-lattice PASS and zero scaled-conversion failures;
4. the already generated P2.3 Canonical Parquet root;
5. the already generated P2.4 MT5 derivative root.

For every UTC day it reconstructs Canonical rows only from the frozen Source Snapshot bytes, independently verifies Parquet semantic readback/logical hash, derives the expected P2.4 MT5 CSV/contract from those same Canonical rows, and requires exact SHA equality before copying any physical artifact into the packet.

No timestamp sorting repair, dedupe, same-timestamp merge, gap fill, silent rounding or Bid/Ask collapse is permitted.

## Packet structure

```text
DATA_PACKET/
  canonical/<symbol>/YYYY/MM/*.parquet
  numba/dataset.json
  mt5/ticks/<symbol>/YYYY/MM/*.ticks.csv
  mt5/symbol_contract.json
  audit/precision_evidence.json
  audit/canonical_daily_audit.jsonl
  audit/integrity_report.json
  manifest.json
  SHA256SUMS.txt
  README.md
```

`numba/dataset.json` and `mt5/symbol_contract.json` both carry the same `dataset_id`, `source_hash_root` and `canonical_logical_hash_root`. The P2.4 per-day source contract remains immutable with `PENDING_P2_5_PACKET`; P2.5 establishes the completed binding at the packet layer rather than rewriting accepted P2.4 artifacts.

## CLI

All paths are relative to the repository working directory.

```bash
npm run packet -- \
  --symbol EURUSD \
  --source-run ./runs/accepted-eurusd-source \
  --precision-evidence ./runs/accepted-eurusd-precision/precision_evidence.json \
  --canonical-root ./runs/accepted-eurusd-parquet \
  --mt5-root ./runs/accepted-eurusd-mt5 \
  --out ./runs/accepted-eurusd-data-packet
```

The output directory is immutable for a build attempt: if it already exists the command fails rather than overwriting it. Build occurs in a sibling temporary directory, all packet hashes are verified, and only then is the directory renamed to its final path.

Large market-data payloads stay on the local PC and must not be committed to GitHub or uploaded into the Drive canonical-document tree.
