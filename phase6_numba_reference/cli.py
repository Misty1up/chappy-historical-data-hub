from __future__ import annotations

import argparse
import json
import sys

from .adapter import run_local_numba_adapter
from .probe import NumbaReferenceError


def main() -> int:
    parser = argparse.ArgumentParser(description="P6_REFERENCE_PARITY_PROBE_V1 Numba reference adapter")
    parser.add_argument("--numba-dataset", required=True, help="Accepted DATA_PACKET/numba/dataset.json")
    parser.add_argument("--parity-run-spec", required=True, help="Bound HDH_P6_PARITY_RUN_SPEC_V1 JSON")
    parser.add_argument("--output-dir", required=True, help="Explicit local output directory outside DATA_PACKET")
    args = parser.parse_args()
    try:
        report = run_local_numba_adapter(
            numba_dataset_path=args.numba_dataset,
            parity_run_spec_path=args.parity_run_spec,
            output_dir=args.output_dir,
        )
    except NumbaReferenceError as exc:
        print(json.dumps({"status": exc.status, "code": exc.code, "message": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps({"status": "PASS", **report}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
