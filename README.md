# React + TypeScript + Vite

## Isolated test environment — K3 preparation

The K3 branch is based on current `main`, independently of held CRM/Ops PRs #52/#53. It does not deploy or merge those PRs. Talip chose a separate Supabase test project and a single synthetic `Nazar-test` business. The new test project ref and business ID are environment configuration only.

- [Preview routing and exact variable/secret names](K3_PREVIEW.md): configure only Pages **Preview**, rebuild, and keep Production bindings unchanged. No real email, Klaviyo write or production GA4 event is sent from the isolated build.
- [Migration provenance and readiness](K3_MIGRATIONS.md): the legacy source inventory is verified, but a reviewed canonical full baseline and a successful full replay are still prerequisites. The held Ops migration is excluded. Do not treat inventory success as an installed database.
- [Synthetic seed and reset](K3_SEED_AND_RESET.md): explicit test markers, reserved-domain contacts, inactive offer and a local-only reset guard. The local guard remains blocked while baseline/replay proof is missing; hosted reset is not claimed ready.
- [Bounded native PostgreSQL compatibility probe](K3_LOCAL_TEST.md): its synthetic Auth/installation metadata is not a real Supabase/JWT or hosted staging acceptance test.

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
