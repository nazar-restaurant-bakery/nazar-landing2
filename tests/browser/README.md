# Isolated staff layout browser checks

This fixture mounts the actual `src/pages/StaffPage.tsx` in a BrowserRouter. It does not import the public application, analytics, production credentials, a real Supabase SDK, or a customer record. The fake SDK returns separately labelled normal/test fixtures, logs every RPC and rejects unknown calls. Provider fetches are mocked. Playwright permits only the local Vite server, and blocks every other origin and every unmocked API request. No live-service access is involved. If the execution sandbox denies localhost sockets, request the normal sandbox approval for this test command; do not bypass the denial with another transport.

Run with Node 24+ and existing repo dependencies:

```powershell
& 'C:\Users\Talip\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tests/browser/run.mjs
```

The runner uses the bundled Playwright package if it is not installed in the repository. It uses an existing Chromium, Chrome or Edge executable with a new headless profile. It never downloads or installs a browser. `PLAYWRIGHT_MODULE` may point to an existing `playwright/index.mjs`; `PLAYWRIGHT_CHROMIUM_EXECUTABLE` may point to an existing compatible browser.

Results and synthetic desktop/mobile screenshots are written under ignored `tests/browser/artifacts/`. An alternative destination can be supplied with `--output PATH`.
Use `--grep PATTERN` for a focused run, for example `--grep "^0[1-4] "` for the first four cases. A PR verification run must execute the full suite without that filter.

The first 22 cases reproduce the historical CRM UI acceptance scenarios; further checks cover the Tasks default, authorization on every route, global Internal tests handling, kanban RPC parameters and validation, late responses after sign-out, New York display/write times from a non-New-York device, decision validation, form-error resolution, a 375px mobile screen, drafts across tab changes and uncertain task writes that stay blocked until that task source is read successfully.

The deliberately synthetic normal-segment records test the non-test display path. Their `example.invalid` addresses and fake IDs must never be submitted to live services. The fixture exposes `window.__staffMock` only inside this isolated entry, never in the production app.
