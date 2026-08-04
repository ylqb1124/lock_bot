# Repository Guidelines

## Project Structure & Module Organization

LockBot is a Python package with an optional web platform. Core bot logic lives in `python/lockbot/core/`: `device_bot.py`, `node_bot.py`, and `queue_bot.py` implement the bot types, while handlers, schedulers, renderers, i18n, and IM-platform adapters support them. The FastAPI backend is in `python/lockbot/backend/app/`, organized by feature areas such as `auth`, `bots`, `audit`, `admin`, and `settings`; shared application setup is in `main.py`, `config.py`, `database.py`, and `rate_limit.py`. Tests mirror the Python areas under `tests/core/` and `tests/backend/`.

The Vue 3 frontend is in `frontend/src/`, with `components/` (including bot form components), `views/` and `views/admin/`, `layouts/`, `stores/`, `router/`, `utils/`, `i18n/`, and shared styles in `assets/styles/`. Deployment assets live in `docker/`, operational scripts in `tools/` and `scripts/dev/`, and supporting docs in `docs/`. Do not commit generated runtime data, `logs/`, `frontend/dist/`, local environment files, or database files.

## Build, Test, and Development Commands

- `pip install -e ".[dev]"`: install the Python package plus pytest and Ruff.
- `pytest`: run all backend and core tests defined by `pyproject.toml`.
- `ruff check python tests` / `ruff format python tests`: lint and format Python.
- `PYTHONPATH=python uvicorn lockbot.backend.app.main:app --reload`: run the FastAPI app locally.
- `scripts/dev/backend.sh`: run the backend with reload and write its output to `logs/backend.log`; install the package first so `lockbot` is importable.
- `cd frontend && npm install`: install frontend dependencies.
- `cd frontend && npm run dev`: start the Vite development server.
- `scripts/dev/frontend.sh`: start Vite on port 3000 with its API proxy and write output to `logs/frontend.log`.
- `cd frontend && npm run build`: build static frontend assets for backend serving.
- `cd frontend && npm run lint`: run ESLint on Vue and JavaScript sources.

## Coding Style & Naming Conventions

Python targets 3.10+ and uses Ruff with 120-character lines and double quotes. Keep modules and functions in `snake_case`, classes in `PascalCase`, and tests named `test_*.py`. Follow existing FastAPI patterns: routers, schemas, models, and services stay inside their feature package. Frontend code uses Vue 3 single-file components; name components and views in `PascalCase.vue`, matching nearby files.

## Testing Guidelines

Use pytest for Python changes. Add focused tests near the affected area: `tests/core/` for standalone bot behavior and `tests/backend/` for API, auth, persistence, rate limiting, and webhook behavior. Prefer deterministic fixtures over live services. For frontend changes, run `npm run lint`; also run `npm run build` when changes affect the production bundle, and add manual verification notes when behavior is UI-only.

## Commit & Pull Request Guidelines

Recent history uses short, imperative summaries, often in Chinese, for example `修复lock详情入库问题` or `QUEUE bot query 新增排队同学列`. Keep the subject concise and specific. Pull requests should describe the behavior change, list tests run, link related issues when available, and include screenshots or short recordings for visible frontend changes.

## Security & Configuration Tips

Do not commit generated secrets, tokens, SQLite databases, runtime state, or Docker environment files. Use `tools/gen_keys.py` to create `JWT_SECRET` and `ENCRYPTION_KEY`, and keep environment-specific values in local shell exports or files based on `docker/lockbot.env.example`. Treat `DEV_MODE=true` as development-only because it creates test users; production configuration must set it to `false`.
