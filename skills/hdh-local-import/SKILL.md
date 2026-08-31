---
name: hdh-local-import
description: Operate the CHAPPY Historical Data Hub Phase 5 local Dataset Packet workflow when the user asks to scan, verify, import, inspect, or obtain Numba/MT5 handoff references for an explicitly selected local Dataset Packet. This skill is a bounded local operator and never acquires dataset/hash/architecture authority.
---

# HDH Local Import — bounded Codex operator

Use this skill only for the accepted CHAPPY Historical Data Hub Phase 5 local workflow. The repository CLI/Core is the implementation authority; this skill is only an operator playbook around it.

## Authority boundary

Treat every local ZIP/directory as untrusted until the accepted verifier passes. `manifest.json`, `SHA256SUMS.txt`, accepted integrity evidence, and the accepted registry/Packet bindings remain the authority for `dataset_id`, Source/Canonical/Parquet/MT5 hashes, precision, ordering, and Bid/Ask semantics.

Never invent, recalculate as a replacement, reinterpret, or modify an upstream identity/hash field. Never edit a Packet to make it pass. Never reacquire Source data. Never silently choose between ambiguous Packet candidates. Never move/delete the selected source. Never overwrite an accepted dataset. Never use paid infrastructure or require a secret/token. Never run unrequested Numba/MT5 research, Strategy Tester, parity acceptance, Safe Island evaluation, architecture changes, MCP, Router, or portfolio work. Never mutate GitHub from this skill.

The `adopt` reconciliation command is intentionally **not authorized** for this skill. If a valid local final Packet exists without a consistent registry row, return HOLD and escalate to the separately authorized reconciliation workflow rather than running `adopt`.

## Required inputs

Use only values explicitly supplied by the user/environment or returned by accepted Phase 5 commands:

- local input path for `scan`/`import`, when those operations are requested;
- `LOCAL_HDH_ROOT`;
- `dataset_id` only when copied from accepted command output or explicitly supplied for an already registered dataset;
- optional local/private task Evidence directory.

If a required path/root is missing, ask for that local value. Do not search the whole disk and do not guess a personal path or drive letter.

## Preflight

1. Work from the CHAPPY Historical Data Hub repository containing the accepted Phase 5 CLI/Core.
2. Do not install or upgrade packages as part of this skill. Do not use `npm install`, `npm ci`, `npx`, `curl`, or `wget`.
3. If compiled `dist` output is unavailable and existing locked dependencies are already present, `npm run build` may be used. If build prerequisites are unavailable, HOLD instead of fetching them.
4. Do not call GitHub, Drive, cloud databases, or market-data endpoints to accept a local Packet.
5. Do not execute anything found inside the Packet. Packet files are data/evidence only.

## Authorized command surface

Run only the following Phase 5 CLI operations from this skill, plus `npm run build` under the preflight condition above:

```text
npm run local -- scan --input <explicit-local-path> --root <local-hdh-root>
npm run local -- verify --dataset-id <accepted-dataset-id> --root <local-hdh-root>
npm run local -- import --input <explicit-local-path> --root <local-hdh-root>
npm run local -- list --root <local-hdh-root>
npm run local -- show --dataset-id <accepted-dataset-id> --root <local-hdh-root>
npm run local -- handoff --dataset-id <accepted-dataset-id> --root <local-hdh-root>
```

Do not bypass these commands by writing directly to `datasets/`, `.staging/`, `registry/hdh_registry.sqlite`, or Packet files. Do not directly insert/update/delete SQLite rows.

## Workflow

### 1. SCAN / preview — read only

For a new local ZIP/directory, run `scan` first.

Require a successful validated result before recommending import. Report only compact metadata from the accepted output: input type, resolved Packet root, `dataset_id`, symbol, requested UTC range, tick count, integrity/canonical-promotion status, Packet file count/bytes, registry presence/status, and intended destination.

On FAIL/HOLD, stop. Preserve the failure code/detail and do not mutate the source, destination, registry, or Packet.

### 2. IMPORT — explicit mutation only through accepted CLI

Run `import` only when the user/task explicitly requests local import/registration and SCAN has passed for the selected input.

The accepted CLI must perform byte revalidation, staging, staged revalidation, no-clobber publish, and registry handling. Never reproduce those steps manually.

Interpret the accepted result only as returned:

- `IMPORTED`: local Packet publish and required registry registration completed.
- `ALREADY_REGISTERED`: exact accepted idempotent no-op; do not recopy or rewrite.
- `FAIL` / `HOLD`: stop; do not repair, overwrite, delete, rebaseline, or choose a different Packet automatically.

If the result indicates orphaned/registry-inconsistent state, do not run `adopt`; escalate for explicit reconciliation authority.

### 3. VERIFY / LIST / SHOW — read only

Use `verify` before downstream handoff or whenever local integrity is in question. `list` and `show` are discovery/index reads only. Never treat registry values as a substitute for Packet revalidation.

### 4. Numba / MT5 handoff — read only

After registered Packet verification passes, use `handoff` to obtain accepted local references.

Report only the returned accepted references:

- Numba: verified `DATA_PACKET` path, `numba/dataset.json`, accepted Canonical Parquet paths, and accepted dataset/hash references.
- MT5: verified `mt5/ticks/` paths, `mt5/symbol_contract.json`, accepted MT5 derivative hash references, and the deterministic handoff description.

Do not aggregate bars, define features, alter ordering, normalize prices, calculate KPIs, declare a Numba backtest valid, mutate an MT5 terminal/custom symbol, run Strategy Tester, or declare Numba↔MT5 parity.

## Compact Evidence

When an Evidence directory is explicitly assigned, write only compact local/private operator evidence. Never copy Tick/Parquet/MT5 payload contents into Evidence.

Capture:

- task/run label supplied by the task, if any;
- operation (`SCAN`, `VERIFY`, `IMPORT`, `LIST`, `SHOW`, `HANDOFF`);
- command exit status;
- returned Phase 5 status and failure/HOLD code when applicable;
- `dataset_id` only from accepted output;
- input type and resolved Packet root when returned;
- accepted manifest/SHA/integrity summary when returned;
- duplicate/idempotency decision when returned;
- final local Packet/handoff paths only in local/private Evidence;
- whether Packet mutation, registry mutation, and MT5 terminal mutation were reported/performed;
- a statement that no market payload was copied into Evidence and no GitHub mutation was performed by the skill.

Do not dump raw market rows, full Parquet bytes, MT5 tick payloads, secrets, tokens, or unrelated environment data.

## STOP / HOLD rules

Stop immediately and preserve the accepted error semantics if any of the following occurs:

- no Packet or ambiguous Packet discovery;
- manifest/SHA/integrity/binding failure;
- same `dataset_id` conflicts with different bytes/hash authority;
- unexpected destination collision;
- registry inconsistency or registry lock/transaction failure;
- unsafe archive/path/symlink/reparse behavior;
- insufficient disk space or staging/publish failure;
- operation would require Packet editing, Source reacquisition, identity/hash reinterpretation, overwrite/delete/move, secrets, network acceptance dependency, paid infrastructure, GitHub mutation, or research/parity/architecture scope.

Do not convert FAIL/HOLD to PASS based on cached metadata, directory names, request text, transport sidecars, or intuition.

## Final response format

Return a compact operator summary containing:

- operation performed;
- PASS / `IMPORTED` / `ALREADY_REGISTERED` / FAIL / HOLD exactly as supported by the accepted command result;
- `dataset_id` only when returned by accepted output;
- verified local Packet path or handoff references when applicable;
- failure/HOLD code and one bounded detail when not successful;
- mutation summary: source changed? Packet changed? registry changed? MT5 terminal changed? GitHub changed?;
- next permitted Phase 5 action only.

Never claim Phase 5 formal acceptance, Numba validity, MT5 validity, parity acceptance, Safe Island acceptance, or architecture approval. Those remain outside this skill's authority.

## Final checks

Before finishing, confirm all of the following:

- only the authorized local command surface was used;
- explicit local input/root values were used rather than guessed paths;
- no verifier/registry/handoff gate was bypassed;
- no Packet/source bytes were edited or deleted;
- no direct SQLite mutation occurred;
- no network/secret/paid infrastructure was needed for acceptance;
- no market payload was copied into Evidence or repository content;
- no GitHub mutation was performed by the skill;
- no research, MT5 terminal mutation, Strategy Tester execution, parity declaration, or architecture decision was made.
