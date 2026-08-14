# Repository Guidelines

## Project Structure & Module Organization

The current production dashboard is `web/`, a Vue 3/Vite app. `web/src/views/ClusterDashboard.vue` orchestrates the UI; `src/services/` owns API calls, data adaptation, time handling, charts, refresh policy, and Lock Bot state merging. `web/server/` provides the Node proxy plus persisted cluster trends and Lock Bot history cache. `web/shared/cluster-scope.json` is the source of truth for the current 74-node, 8-card scope and its China-time `nodeGroups` rollout history.

The repository root retains the legacy static dashboard (`index.html`, `api.js`, `adapter.js`, `timeline.js`, `proxy.js`). `person/` is a separate personal Vue dashboard. Deployment files include `web/pm2.config.cjs` and `web/xpu-monitor.service`.

## Build, Test, and Development Commands

- `cd web && npm run dev` starts Vite development.
- `cd web && npm test` runs `node:test` coverage for metrics, Lock Bot merging, trend queries, caching, and refresh behavior.
- `cd web && npm run build` creates the production bundle; `npm start` serves it with the proxy.
- `cd person && npm run dev` or `npm run build` develops or builds the personal view.

Run the relevant test suite and production build for every change. Manually verify login, loading/error handling, refresh behavior, and the modified dashboard path against the local proxy.

## Deployment Verification

Do not start a Vite development server or provide `localhost` preview links for routine changes: these ports are not accessible to the user and are not an acceptance path. After a successful production build, restart the deployed service with `pm2 restart xpu-monitor`, then verify its PM2 status and relevant logs. Use a local Vite server only when the user explicitly requests it.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, and single quotes in Vue/JavaScript. Use camelCase for functions (`fetchLockBotList`), PascalCase for components (`ClusterDashboard.vue`), and kebab-case for multiword files (`trend-service.cjs`). Keep fetches in `services/api.js`, response transformations in adapters, and rendering in views. Preserve China-time conversion and the shared cluster scope instead of duplicating constants.

## Testing Guidelines

Add focused cases to `web/test/cluster-data.test.mjs` for changes to aggregation, lock coverage, ranges, cache behavior, or historical node scope. Lock-trend tests must verify the denominator at both sides of a `nodeGroups.effectiveFrom` boundary. Use descriptive `node:test` names that state the business rule. No lint task is configured.

## Commit, Security & Configuration

Use concise imperative Chinese commits, such as `修复趋势节点范围校验`. PRs should describe user-visible behavior, API/configuration effects, validation commands, related issues, and screenshots for UI work. Start from `config.example.json`; never commit credentials, tokens, or authorization headers. Prefer `PROXY_PORT`, `LOCKBOT_HOST`, and `MONQUERY_HOST` overrides for deployment-specific configuration.
