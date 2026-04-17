# Infinitoai Security + Stability Remediation v3

## Summary

Status: completed on 2026-04-17.

This pass implemented the `安全+稳定性` hardening work without changing the core 1-9 step workflow.

This pass will:

- remove secret exposure from logs, shared state, and generic message handlers
- keep the Side Panel as the only trusted UI for secret display
- tighten host/permission scope around the user-provided VPS panel
- restore the test suite to green and add trust-boundary regressions

## Completed Result

- `GET_STATE` is now reserved for Side Panel requests.
- Content scripts use `GET_RUNTIME_STATE` and receive only sanitized runtime state.
- Passwords, OAuth URLs, localhost callbacks, account history, TMailor tokens, email leases, verification codes, and log history are excluded from content-script runtime state.
- Password fill logs no longer include the plaintext password.
- OAuth and localhost callback logs are redacted before persistence and broadcast.
- Generic background message logging records message type/source only, not full payloads.
- `DATA_UPDATED` payloads are sanitized and no longer carry secret-bearing fields.
- Side Panel refreshes trusted values by pulling full state from the background.
- Static extension host access no longer includes `<all_urls>`.
- VPS panel origins are requested dynamically from the configured VPS URL before Step 1, OAuth refresh, or Step 9 touches the VPS page.
- README now documents the canonical test command, security model, and VPS permission behavior.

## Verification Result

Fresh verification run:

```powershell
node --test .\tests\*.test.js
```

Result:

- 465 tests passed
- 0 tests failed

Additional checks:

- `node --check` passed for changed JavaScript entry points.
- `git diff --check` passed.
- Source search found no remaining production-code matches for the removed plaintext password, raw OAuth, raw localhost callback, broad session access, or sensitive `DATA_UPDATED` patterns.

## Implementation Changes

### 1. Split trusted and untrusted state access

Update `background.js`.

State classification:

- Sensitive fields:
  - `password`
  - `customPassword`
  - `oauthUrl`
  - `localhostUrl`
  - `accounts`
  - `tmailorAccessToken`
- Non-sensitive fields:
  - step status
  - current step metadata
  - mail provider/source config
  - tmailor domain stats
  - auto-run stats
  - last email timestamp
  - non-secret UI state

Required changes:

- Remove `initializeSessionStorageAccess()` behavior that sets `TRUSTED_AND_UNTRUSTED_CONTEXTS`.
- Keep `chrome.storage.session` trusted-only.
- Replace the current universal `GET_STATE` behavior with:
  - `GET_STATE`
    - Side Panel only
    - requires `message.source === 'sidepanel'`
    - returns full trusted operator state
  - `GET_RUNTIME_STATE`
    - content-script safe
    - returns only sanitized runtime state
- If a non-sidepanel caller sends `GET_STATE`, return `{ error: 'Unauthorized state access.' }`.

Sanitized runtime state must exclude:

- `password`
- `customPassword`
- `oauthUrl`
- `localhostUrl`
- `accounts`
- `tmailorAccessToken`

Content-script call migration:

- `content/signup-page.js`: replace `chrome.runtime.sendMessage({ type: 'GET_STATE' })` with `GET_RUNTIME_STATE`.
- `content/vps-panel.js`: replace `GET_STATE` with `GET_RUNTIME_STATE`.
- `sidepanel/sidepanel.js`: keep using `GET_STATE`.

No content script may read full state after this pass.

### 2. Remove secret leakage from logs and generic broadcasts

Update:

- `background.js`
- `content/signup-page.js`
- `content/openai-auth-step6-flow.js`

Required removals:

- Delete the raw password logs in step 3 and step 6.
- Replace `console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates)... )` with a redacted metadata log or remove it entirely.
- Replace `console.log(LOG_PREFIX, Received..., message)` with a log that includes only message type and source, never payload.
- Do not log raw OAuth URLs, localhost callback URLs, or TMailor access tokens.

Required replacements:

- `Step 3: Password filled` instead of including the actual password.
- `Step 6: Password filled` instead of including the actual password.
- `OAuth URL updated` instead of printing the URL.
- `Localhost callback captured` instead of printing the callback in generic logs.

Persistence rule:

- Redact before log persistence.
- Stored log history, copied log history, and toast text must all be secret-free.

### 3. Stop broadcasting secret-bearing `DATA_UPDATED` payloads

Update `background.js` and `sidepanel/sidepanel.js`.

Current behavior to remove:

- `broadcastDataUpdate({ password })`
- `broadcastDataUpdate({ oauthUrl })`
- `broadcastDataUpdate({ localhostUrl })`

Replacement:

- Keep `DATA_UPDATED` for sanitized fields only.
- Use Side Panel `GET_STATE` refresh after `STEP_STATUS_CHANGED` for trusted updates.
- Preserve current Side Panel UX by letting the panel pull trusted state after step completion and on initial restore.

### 4. Narrow extension permissions and host access

Update `manifest.json`.

Required manifest changes:

- Remove `"<all_urls>"` from `host_permissions`.
- Add `"permissions"` to `permissions` so runtime origin grants can be requested.
- Keep static host coverage only for hardcoded automation domains already declared in `content_scripts`.

VPS handling:

- Add dynamic origin permission flow for the configured `vpsUrl`.
- Derive the origin from the saved `vpsUrl`.
- Before step 1 or step 9 touches the VPS panel, ensure that origin is granted.
- If not granted, fail early with a clear Side Panel error telling the user to approve the origin.
- Do not restore broad host access just to preserve current behavior.

### 5. Keep `debugger`, but constrain it

Keep `debugger` in this pass because step 8 still depends on it.

Rules:

- No redesign of step 8 behavior.
- Preserve current attach -> click -> detach flow.
- Do not expose debugger payloads or click coordinates in persistent logs.
- Do not broaden debugger use beyond the auth consent tab.

### 6. Preserve Side Panel UX, but make it trusted-only

Update `sidepanel/sidepanel.js`.

Rules:

- Side Panel remains allowed to display password, OAuth URL, and localhost callback if the workflow still requires it.
- These values stay out of logs, toasts, copied log text, and generic event payloads.
- Keep current masking/toggle/copy UI behavior where already present.
- No raw unescaped HTML insertion for runtime values beyond the existing escaped rendering helpers.

### 7. Fix current red tests and add trust-boundary tests

Update:

- `tests/vps-panel.test.js`
- add new targeted tests under `tests/`

Required fixes:

- Update the 2 failing `vps-panel` assertions to match the current Chinese log copy instead of stale English wording.

Required new tests:

- `tests/runtime-state-security.test.js`
  - `GET_STATE` succeeds for Side Panel requests.
  - `GET_STATE` rejects non-sidepanel requests.
  - `GET_RUNTIME_STATE` omits all sensitive fields.
- `tests/log-redaction.test.js`
  - step 3 and step 6 logs never contain the plaintext password.
  - background message logging never includes full payload dumps.
- `tests/data-update-redaction.test.js`
  - `DATA_UPDATED` never includes password, OAuth URL, localhost URL, or TMailor token.

### 8. Canonical test command

Do not add a broad tooling refactor in this pass.

Decision:

- Keep the repo lightweight.
- Use `node --test .\tests\*.test.js` as the canonical command for this pass.
- Document that command in `README.md` under a short Testing section.
- Do not introduce `package.json` in this pass.

## Test Plan

### Required automated verification

Run:

```powershell
node --test .\tests\*.test.js
```

Expected result:

- all current tests pass
- the 2 current `vps-panel` failures are resolved
- new security regression tests pass

### Required manual verification

Load the unpacked extension and verify:

- Side Panel still restores trusted state.
- Step 3 still fills email/password and submits correctly.
- Step 6 still logs in correctly.
- Step 8 still captures the localhost callback.
- Side Panel can still show/copy trusted values as intended.
- Content scripts still function with sanitized runtime state only.

### Required security verification

Confirm in extension/service-worker console:

- no plaintext password appears
- no raw OAuth URL appears in generic logs
- no raw localhost callback URL appears in generic logs
- no TMailor access token appears in logs
- no generic `DATA_UPDATED` event carries secrets

## Assumptions

- Side Panel is the only trusted consumer of full operator state.
- Service-worker restart resilience is still required, so sensitive values may remain in trusted-only `chrome.storage.session`.
- This pass is a hardening pass, not a workflow redesign.
- `debugger` remains because step 8 still depends on it.
