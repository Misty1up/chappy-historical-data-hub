# Phase 2 P2.4 — MT5 Tick Derivative

## Authority and scope

The MT5 derivative is generated **only from the same Canonical rows** used by the Canonical Parquet path. It is not a new acquisition route and it is not a research master.

Profile: `HDH_MT5_MQLTICK_CSV_V1`.

The P2.4 CLI accepts a Phase 1 Source Tick run, re-runs the accepted Canonical conversion, and then derives an MT5 bridge artifact. A symbol must have `precision_status=VERIFIED`.

```bash
npm run build
npm run mt5 -- \
  --symbol EURUSD \
  --date 2026-01-05 \
  --source-run ./runs/eurusd-source \
  --out ./runs/eurusd-mt5
```

## Derivative CSV

Path:

`mt5/ticks/<SYMBOL>/YYYY/MM/YYYY-MM-DD.ticks.csv`

Columns are fixed and ordered:

1. `time_msc` — direct Canonical `timestamp_msc`;
2. `bid` — exact fixed-digit decimal reconstructed from `bid_scaled` and verified precision;
3. `ask` — exact fixed-digit decimal reconstructed from `ask_scaled` and verified precision;
4. `bid_scaled` — strict Canonical int64 audit bridge;
5. `ask_scaled` — strict Canonical int64 audit bridge;
6. `source_seq` — original Source order.

No sort, dedupe, same-timestamp merge or gap fill is allowed. If Canonical source order contains decreasing `timestamp_msc`, generation fails because `CustomTicksReplace` requires nondecreasing time. The implementation must never sort to manufacture compliance.

## MqlTick mapping

`mt5/HDH_CustomTicksReplace_Import.mq5` is the formal local-import helper baseline.

The mapping is:

- `MqlTick.time_msc = time_msc`;
- `MqlTick.time = floor(time_msc / 1000)`;
- `MqlTick.bid = bid`;
- `MqlTick.ask = ask`;
- `MqlTick.last = 0`;
- `MqlTick.volume = 0`;
- `MqlTick.volume_real = 0`;
- `MqlTick.flags = TICK_FLAG_BID | TICK_FLAG_ASK`.

Dukascopy Canonical keeps separate Bid-side and Ask-side volumes. MqlTick exposes a single volume channel, so P2.4 does **not** invent a lossy merge rule. Both Canonical volume fields remain authoritative in Canonical data and are deliberately unmapped in this derivative.

The helper expects the target Custom Symbol to exist and its Digits to match the derivative contract. It verifies the CSV header, `source_seq`, nondecreasing `time_msc`, positive Bid/Ask and returned `CustomTicksReplace` count.

## Day contract and evidence

Each derivative CSV has a sibling `.contract.json` with precision, Source Snapshot SHA, Canonical logical hash, row count, timestamp bounds and mapping policy. The CLI also writes `mt5_derivative_evidence.json`, `mt5.log` and `repro_command.txt`.

P2.4 intentionally records `dataset_binding_status=PENDING_P2_5_PACKET`. The deterministic `dataset_id`, Packet manifest, derivative hash root and final Dataset Packet binding belong to frozen step P2.5. Therefore P2.4 artifacts are not a completed Dataset Packet by themselves.

## P2-G acceptance focus

The static microcase must prove:

- `timestamp_msc` -> `time_msc` exact;
- Bid/Ask exact from Canonical scaled integers;
- source order exact;
- duplicates and same-timestamp rows preserved;
- decreasing source time is rejected rather than sorted;
- deterministic CSV/contract bytes on rebuild/resume;
- no synthetic spread-only reconstruction;
- no implicit Bid/Ask volume merge.

Actual MT5 compilation/import/readback remains a local verification task after the GitHub implementation gate passes.
