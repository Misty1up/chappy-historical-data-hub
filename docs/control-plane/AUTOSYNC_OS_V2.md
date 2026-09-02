# HDH Control Plane AUTOSYNC OS v2

Canonical Drive authority: `CHAPPY_CONTROL_PLANE_AUTOSYNC_OS_v2_20260903`

Drive document ID: `1LKtAneQXtfGVuvMmEgaK0FCsVgQjg_HlEu6l7hQtQrQ`

This document governs workflow synchronization only. It does not change HDH scientific/data contracts, Phase 6 authority, MT5 safety boundaries, or existing gates.

## User responsibility

The user does not maintain `PROJECT_STATE`, `PROMPT_REGISTRY`, or `EVENT_LOG`. The user supplies GO/final decisions and truly manual actions only.

For the current P6.4 state, the user action remains: manually close Titan FX MT5. After the user confirms completion, CHAPPY records the completion/event, verifies the already-persisted R09 prompt, and advances the Control Plane to the same-R09 CODEX handoff without asking the user to edit the Sheet.

## CHAPPY responsibility

CHAPPY performs canonical state writes in the same handoff as GO/manual-action completion, Codex return receipt, CHAPPY review completion, task/actor/status changes, and prompt generation/change.

New or changed Codex prompts are persisted before they are displayed. A prompt is not CODEX-ready until its exact canonical artifact and registry identity exist.

## Codex return

Codex returns a machine-readable Return Packet through the existing Exchange Hub return route. At minimum it records project/task, execution status, exact repository head, evidence/tests, blockers, and `recommended_next_actor=CHAPPY_REVIEW`.

Codex does not grant P6.4 formal acceptance, P6.5 authorization, PASS/DONE, or PR merge authority to itself. CHAPPY independently reviews Evidence and GitHub/Drive truth and then writes canonical state.

## Drift

CHAPPY owns recovery. The user is never asked to transcribe workflow state into the Sheet.
