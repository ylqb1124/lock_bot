# Repository Guidelines

## Project Structure & Module Organization

The root application is a static dashboard backed by a Node proxy: `index.html`, `cluster.html`, and `value.html` contain page orchestration; `api.js`, `adapter.js`, and `timeline.js` hold data and canvas logic; `proxy.js` serves files and proxies Lock Bot/Monquery requests. Trend persistence lives in `trend-store.js` and `trend-service.js`.

`web/` and `person/` are separate Vue 3/Vite applications. Their feature code is organized as `src/views/`, `src/services/`, and component-specific CSS. Deployment definitions live in `pm2.config.cjs` and `xpu-monitor.service`. Start configuration from `config.example.json`; do not commit environment-specific endpoints or credentials.

## Build, Test, and Development Commands

- `node proxy.js`: run the root dashboard and proxy on the configured port (default `8900`).
- `cd web && npm install && npm run dev`: run the Vue web application with Vite.
- `cd web && npm run build`: produce the web production bundle; use `npm start` to run its proxy.
- `cd person && npm install && npm run dev` or `npm run build`: develop or build the personal Vue variant.

No automated test or lint command is configured. For each change, run the relevant production build and manually verify login, refresh/error states, and the affected dashboard view against the local proxy.

## Coding Style & Naming Conventions

Follow the surrounding file's formatting: JavaScript and Vue files use two-space indentation, semicolons, and single quotes in the Vue code. Use descriptive camelCase for variables/functions (`fetchLockBotList`), PascalCase for Vue components (`ClusterDashboard.vue`), and lowercase kebab-case for multiword file names (`trend-service.js`). Keep API fetching in `services/api.js` or root `api.js`, transformations in adapters, and rendering code in views/pages.

## Commit & Pull Request Guidelines

Recent commits use concise Chinese, imperative summaries such as `集群、节点视图解耦` or `提交历史数据显示`. Keep each commit focused and name the affected behavior. Pull requests should state the user-visible change, configuration or API implications, commands run, and include screenshots for dashboard/UI changes. Link the relevant issue or task when one exists.

## Security & Configuration

The proxy handles internal service requests and browser tokens. Keep tokens out of source control and do not log authorization headers. Prefer environment overrides (`PROXY_PORT`, `LOCKBOT_HOST`, `MONQUERY_HOST`) for deployment-specific values.
