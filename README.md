# React + TypeScript + Vite

## Isolated test environment — K3 preparation

The K3 branch is based on current `main`, independently of held CRM/Ops PRs #52/#53. It does not deploy or merge those PRs. Talip chose to repurpose the existing separate catering sandbox for a single synthetic `Nazar-test` business. Target ref and business ID remain environment configuration only. Remote app reset is conditionally authorized only after health, verified recovery, Talip-operated disconnection and reviewed baseline evidence exist.

- [Preview routing and exact variable/secret names](K3_PREVIEW.md): configure only Pages **Preview**, rebuild, and keep live Nazar **Production** bindings unchanged. The old sandbox Pages project's separate Production intake is disconnected by Talip. No real email, Klaviyo write or production GA4 event is sent from the isolated build.
- [Reviewed application baseline](supabase/baselines/README.md): the actual production schema-only baseline was reviewed, restored in a new owned local database and compared against live read-only effective privileges. This is not hosted Auth/REST acceptance or permission to skip the remaining reset gates.
- [Migration provenance and readiness](K3_MIGRATIONS.md): the legacy source inventory and MD5 guards remain unchanged; the old chain is historical evidence, not the selected baseline installation route. The held Ops migration is excluded.
- [Synthetic seed and reset](K3_SEED_AND_RESET.md): explicit test markers, reserved-domain contacts, inactive offer and the earlier local-only reset guard. That guard is not the reviewed-dump installer; hosted reset remains gated and is not claimed ready.
- [Bounded native PostgreSQL compatibility probe](K3_LOCAL_TEST.md): its synthetic Auth/installation metadata is not a real Supabase/JWT or hosted staging acceptance test.
- [Private schema capture and scoped sandbox recovery](K3_SCHEMA_CAPTURE.md): production `pg_dump --schema-only`, exact four sandbox test orders, anonymous staff and masked password handoff. Raw files remain outside Git; capture cannot apply or reset SQL.
- [Actual schema baseline review](tools/test-env/SCHEMA_BASELINE_REVIEW.md): current production schema is the baseline source; historical SQL remains unchanged and is not replayed. Captured objects, grants and private-core boundaries require recorded review before rendering a baseline.
- [Recovery validation](tools/test-env/RECOVERY_VALIDATION.md): exact source hashes and independent restored readback are distinct from capture success. Neither authorizes reset by itself.
- [Bounded sandbox recovery restore](tools/test-env/SANDBOX_RECOVERY_LOCAL.md): archive-bound offline review, immutable source evidence, four exact test orders and full-column readback in a new owned local database. Actual recovery passed; anonymous staff metadata does not recreate an Auth identity.

Run the requested change's unit tests with `node --test tests/*.test.mjs`. For provenance alone use `node tools/test-env/audit-migrations.mjs --integrity-only`; default readiness audit intentionally exits nonzero until actual environment setup is complete. **Migration order: first test, then a separate Talip-controlled production release using the same reviewed SQL.** No production migration, production secret or cloud project is changed by this preparation.

For the eventual live Preview proof, use one fresh synthetic `.invalid` email and request UUID; `tools/test-env/verify-preview-write.sql` supplies aggregate read-only counts for the test target and production. Test must show the write once, production zero. No such live proof is claimed by a fake-fetch test.

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
