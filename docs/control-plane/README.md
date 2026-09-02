# CHAPPY Development Control Plane

The mobile development dashboard must not infer workflow state from D1 alone. The canonical machine-readable workflow pointer is the Google Drive spreadsheet `CHAPPY_CONTROL_STATE_v1`.

## Source roles

1. Google Drive project OS/current-state docs remain workflow and research authority.
2. GitHub remains code, commit, PR, CI and repository runtime truth.
3. `CHAPPY_CONTROL_STATE_v1` is the compact machine-readable control pointer joining those authorities for the dashboard.
4. Dashboard D1 is cache + activity-event storage only.

## Required transition rule

Whenever CHAPPY accepts a Codex return, completes review, receives user GO, creates/changes the next Codex prompt, or changes the next actor, the `PROJECT_STATE` row and (when relevant) `PROMPT_REGISTRY`/`EVENT_LOG` must be updated in the same handoff operation.

A dashboard transition is not considered published until the control-state row is updated.

## Drift rule

If the control row, Drive authority or GitHub truth disagree, return `SYNC_REQUIRED`. Show the conflicting versions and the required sync action. Never silently fall back to cached D1 state.

## Codex gate

`current_actor = CODEX` is allowed only after the exact issued prompt is canonically persisted or referenced by immutable Drive ID/hash.

## Dashboard refresh

No continuous AI monitoring is required. Refresh on app open and on an explicit refresh action; D1 may cache the last successful read.

See `config/chappy-control-plane.json` for stable locator IDs.
