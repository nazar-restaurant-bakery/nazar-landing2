# React + TypeScript + Vite

## Isolated test environment — K3 preparation

The K3 branch is based on current `main`, independently of held CRM/Ops PRs #52/#53. It does not deploy or merge those PRs. Talip chose to repurpose the existing separate catering sandbox for a single synthetic `Nazar-test` business. Target ref and business ID remain environment configuration only. Remote app reset is conditionally authorized only after health, verified recovery, Talip-operated disconnection and reviewed baseline evidence exist.

- [Preview routing and exact variable/secret names](K3_PREVIEW.md): configure only Pages **Preview**, rebuild, and keep live Nazar **Production** bindings unchanged. The old sandbox Pages project's separate Production intake is disconnected by Talip. Ordinary K3 routes block real email/provider writes and production GA4 events. The separately guarded K5 profile-sync path had one explicitly approved, exact-customer Klaviyo test exception; its profile and isolated fixture were subsequently removed, its temporary key was revoked, and the path is now disabled. This does not grant general provider access from Preview; see [the controlled K5 evidence and limits](docs/k5/controlled-acceptance.md).
- [Reviewed application baseline](supabase/baselines/README.md): the actual production schema-only baseline was reviewed, restored in a new owned local database and compared against live read-only effective privileges. This is not hosted Auth/REST acceptance or permission to skip the remaining reset gates.
- [Migration provenance and readiness](K3_MIGRATIONS.md): the legacy source inventory and MD5 guards remain unchanged; the old chain is historical evidence, not the selected baseline installation route. The held Ops migration is excluded.
- [Synthetic seed and reset](K3_SEED_AND_RESET.md): explicit test markers, reserved-domain contacts, inactive offer, offline hosted-plan compiler and masked operator. The historical local reset guard stays blocked; actual hosted installation requires the gated operator receipt and independent readback.
- [Bounded native PostgreSQL compatibility probe](K3_LOCAL_TEST.md): its synthetic Auth/installation metadata is not a real Supabase/JWT or hosted staging acceptance test.
- [Private schema capture and scoped sandbox recovery](K3_SCHEMA_CAPTURE.md): production `pg_dump --schema-only`, exact four sandbox test orders, anonymous staff and masked password handoff. Raw files remain outside Git; capture cannot apply or reset SQL.
- [Actual schema baseline review](tools/test-env/SCHEMA_BASELINE_REVIEW.md): current production schema is the baseline source; historical SQL remains unchanged and is not replayed. Captured objects, grants and private-core boundaries require recorded review before rendering a baseline.
- [Recovery validation](tools/test-env/RECOVERY_VALIDATION.md): exact source hashes and independent restored readback are distinct from capture success. Neither authorizes reset by itself.
- [Bounded sandbox recovery restore](tools/test-env/SANDBOX_RECOVERY_LOCAL.md): archive-bound offline review, immutable source evidence, four exact test orders and full-column readback in a new owned local database. Actual recovery passed; anonymous staff metadata does not recreate an Auth identity.
- [Existing-account Auth / REST verification](K3_AUTH_REST.md): exact private configuration, public-key preflight before credential fields unlock, one masked existing staff sign-in, read-only endpoint checks and current-session logout. The restricted root OpenAPI catalogue is not used as service readiness; a successful public RPC proves REST readiness. Configuration validation and mocked tests are separate from a real hosted receipt; no new Auth user, staff permission or application row is created by this helper.
- [Installed-schema read-only observation](tools/test-env/inspect-installed-readonly.sql): aggregate table/test-marker counts, catalogue hashes and security observations after the reviewed installation. SQL observation does not prove real Auth/JWT, provider Data API exposure or a Preview write.

Run the requested change's unit tests with `node --test tests/*.test.mjs`. For provenance alone use `node tools/test-env/audit-migrations.mjs --integrity-only`; default readiness audit intentionally exits nonzero until actual environment setup is complete. **Migration order: first test, then a separate Talip-controlled production release using the same reviewed SQL.** No production migration, production secret or cloud project is changed by this preparation.

For the eventual live Preview proof, reuse one reserved `.invalid` customer identity from the installed seed and choose a fresh request UUID. The existing customer must be reused and stay `is_test=true`; its same-email signup count goes from one to **two**, and an exact repeated request adds no third signup. `tools/test-env/verify-preview-write.sql` supplies aggregate read-only counts for the test target and production: production must have zero matches for that request and synthetic identity. A fresh unseeded email is not interchangeable because the existing RPC does not set the new customer marker. Follow [the seed identity/count contract](K3_SEED_AND_RESET.md); fake-fetch or Auth-only tests do not establish Preview write proof.

## Cloudflare Pages routing

The deployed site uses Cloudflare Pages' [default SPA fallback](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering). Keep the build output free of a top-level `404.html` so direct visits and reloads of client routes such as `/vip`, `/catering`, and `/staff/crm` serve the app shell. Pages Functions continue to handle `/api/*` routes separately.

Do not add a catch-all `/* /index.html 200` rule: Pages rejects it as an infinite loop, so it only adds a deployment warning. After changing routing or adding a top-level `404.html`, verify direct route visits and reloads on a Pages Preview deployment; a Vite preview alone does not validate Pages routing.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```


## K4 consent and staff offers

See [K4_SUPPRESSION.md](K4_SUPPRESSION.md) for the LF migration, same-psql test/production procedure, human-only authentication and acceptance limits. Production application and merge are performed by Talip.

## K5 profile attributes and error queue — controlled test completed

See [K5_PROFILE_SYNC.md](K5_PROFILE_SYNC.md) for the disabled-by-default adapter, exact Preview/Production secret names, profile-only scope and manual queue/retry limits. The TEST migration and hosted checks passed. A separately approved controlled test demonstrated one mock retry, one real profile success, an unchanged second command processing zero jobs, and scoped cleanup. The temporary provider key is revoked and removed from Preview; the final keyless Preview is disabled. [Controlled acceptance and cleanup](docs/k5/controlled-acceptance.md) separates observations from inference. **Formal Talip acceptance, the Production migration and PR merge remain separate; K5 is not declared closed here.**
