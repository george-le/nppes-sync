# CLAUDE.md

NPPES Delta Pipeline & DuckDB Manager: a single-process dashboard for tracking changes to the CMS NPPES provider registry. An Express server stores provider and sync data in DuckDB and serves a React + Vite dashboard.

## Commands

- `npm run dev`: runs `tsx server.ts`. Express listens on `0.0.0.0:3000` and mounts Vite in middleware mode, so the frontend and `/api` share one port.
- `npm run build`: `vite build` to `dist/`.
- `npm run preview`: serves the Vite build.
- `npm run lint`: `tsc --noEmit`. This is the only type check; there are no tests.
- `npm run clean`: removes `dist` and `server.js`.

The lockfile is `bun.lock`, so prefer `bun install` when adding dependencies.

## Architecture

- `server.ts` (single file): Express app, DuckDB setup, all API routes, and the Vite/static wiring.
  - DuckDB file: `/mnt/data/provider-data/nppes_pipeline.duckdb`, hardcoded in `server.ts`. It is outside the repo, and `*.duckdb` / `*.duckdb.wal` are git-ignored anyway.
  - Tables: `sources` (registry: NPPES plus each payer directory), `providers` (keyed by `(source, source_provider_id)`, npi not unique; has `first_seen`, `last_seen`, `deactivated_at`), `provider_events` (append-only change log: added / updated / deactivated / reactivated, plus `raw_changed` for every changed column of the raw NPPES record or payer FHIR resource, with the field as `Type.field` for FHIR), `sync_jobs` (has a `source` column), `pipeline_config`. All provider writes go through `applyProviderRecord` inside `withTransaction`, which diffs and logs changes. Use it for any new loader.
  - DuckDB's Node driver returns `COUNT(*)` as a JS bigint. `allDb` converts these to numbers; keep that conversion if you change the helper. `initDatabase()` creates them, migrates a pre-multi-source `providers` table by renaming it and copying rows under source `nppes`, and seeds the sources registry and default config only when empty. No sample providers or jobs are seeded; the database holds only real loads and syncs.
  - Mode: if `NODE_ENV !== 'production'`, Vite dev middleware serves the app. Otherwise it serves `dist/`.
- `src/App.tsx`: the entire UI in one ~1000-line component with five tabs: `overview`, `providers`, `jobs`, `sql`, `docker`. It calls `/api/status`, `/api/providers`, `/api/providers/:source/:id/events`, `/api/providers/:source/:id/fhir`, `/api/sql`, `/api/config`, and `/api/docker-artifacts`. Its Run Sync button is removed.
- `src/main.tsx` mounts `App`. `src/index.css` imports Tailwind v4.
- Styling uses Tailwind v4 via `@tailwindcss/vite`. Charts use Recharts, icons use lucide-react.

## Payer sources (sources/, data/)

- `data/payer_endpoints.json`: California payer FHIR Provider Directory base URLs, with auth and status notes. Third-party sourced; re-verify before relying on it.
- `sources/fhir_pd.py`: standard-library Python adapter. It pulls PractitionerRole with `_include` for Practitioner, Location, and Organization, retries 5xx and timeouts, and falls back to a plain search when a server rejects `_include` (Molina does).
- `sources/fhir_pd.ts`: the TypeScript FHIR client that the API uses. `POST /api/sources/:id/sync` with body `{ state: "CA"|"ALL", maxPages: 0 (all) or 1+, pageSize: 1..100, specialty?: code }` (defaults CA, 5, 100). It runs as a background job (202 + `jobId`; watch `sync_jobs`), writing each page in its own transaction through `applyProviderRecord`. `maxPages: 0` pulls every page; `specialty` limits a run to one taxonomy code. A repeat pull adds nothing. Each page's transaction also saves a resume point (`sync_jobs.cursor_url` plus `params`, with running totals), and `resumeInterruptedJobs()` continues any job left `running` after a restart. A resume costs at most one repeated page. A job whose saved link expired (HTTP 410/404, as Blue Shield's do after about an hour) is marked failed and has to be rerun. Failed jobs never resume. Pulls can take a minute or more per page on slow payers.
- `scripts/payer_sync.sh`: runs syncs through the API and waits for each job. `sync <source> [--specialty CODE] [--max-pages N]`, `slices <source> <codes-file> [--retries N]` (one sync per specialty code, with retries and a failure summary), and `plans <source>`. Set `API` to override the base URL. Jobs survive an app restart: they resume from the last saved page (see the sync endpoint above).
- `sources/fhir_pd.py`: the Python version, kept as a CLI for inspection. `python3 sources/fhir_pd.py <payer_id> --max-pages 2 --out FILE` or `--all`. It does not write to the database.
- `sources/nppes_bulk.ts`: NPPES bulk loader. Takes the extracted `npidata_pfile_*.csv` (monthly full or weekly incremental), keeps California practices by default (`--state=all` to disable), and applies it in one transaction with set-based SQL. Deactivation dates come from the file. CMS column names are in the header file, not the code.
  - DuckDB allows one writer. Stop the app first: `docker compose stop nppes-sync`, run the loader, then `docker compose start nppes-sync`.
  - Container run: `docker compose run --rm nppes-sync npx tsx sources/nppes_bulk.ts /data/<file>.csv`. Put the extracted CSV in `/mnt/data/provider-data/`.
  - Extract the zip with `python3 -m zipfile -e <file>.zip <dir>` (no `unzip` in the image).
  - The CMS download host returned "down for maintenance" on 2026-10-31. Confirm the file name at download.cms.gov/nppes/NPI_Files.html before loading.
- `/metadata` is not a reliable liveness check for these endpoints. Use a PractitionerRole search.

## API routes (server.ts)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Counts, last 10 jobs, config, top taxonomies, state density, sources |
| GET | `/api/providers` | Filtered list (`search`, `status`, `state`, `source`, `limit`, `offset`) |
| GET | `/api/providers/:source/:id/events` | Change log for one provider (`provider_events`, newest first) |
| GET | `/api/providers/:source/:id/fhir` | Network memberships and raw FHIR role (NPPES: full CSV record) |
| POST | `/api/sources/:id/sync` | Pull a payer FHIR directory and load it through the change log |
| POST | `/api/config` | Upserts config keys |
| POST | `/api/sql` | Runs a query; only `SELECT`, `DESCRIBE`, `SHOW` are allowed |
| POST | `/api/sync` | Retired (410). Was a simulation that wrote fake data |
| GET | `/api/docker-artifacts` | Returns Dockerfile, Python worker, crontab, and compose text as strings |

## Current state (important)

- The NPPES bulk loader (`sources/nppes_bulk.ts`) is not yet run against the real CMS file. The CMS download host was down for maintenance when last checked. The Python worker template in `/api/docker-artifacts` is a stub and is not used.
- The Docker artifacts are generated text. Nothing in this repo builds or runs them.
- `pipeline_config.cron_schedule` and `cron_enabled` are stored but no in-process cron runs. The nightly job described in `metadata.json` does not exist yet.
- `/api/sql` is a prefix check, not a real read-only guard. It only inspects the start of the query. It runs against the same writable DuckDB file, so do not treat it as safe for untrusted input.
- `server.ts` hardcodes port 3000. `.env.example` defines `GEMINI_API_KEY` and `APP_URL`, but nothing reads them yet, and `@google/genai` is a dependency with no usage in the code.
- `/api/config` accepts fields without validation.

## Conventions

- Route errors return `{ error: message }` with status 500 (400 for bad SQL or a missing query).
- Query DuckDB through the `runDb` / `allDb` helpers in `server.ts`.
- There are no tests. Use `npm run lint` (`tsc --noEmit`) and `npm run build` to verify changes.
