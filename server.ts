import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import duckdb from 'duckdb';
import { pullPages, diffPayloads, fetchReferences, pullResourceType, FhirError, type RawResource } from './sources/fhir_pd.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Initialize DuckDB database file
const dbFile = process.env.DB_FILE || '/mnt/data/provider-data/nppes_pipeline.duckdb';
const db = new duckdb.Database(dbFile);

// Helper to run queries with promises
function runDb(query: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.run(query, ...params, function (this: any, err: any) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// The Node driver returns BIGINT (including COUNT(*)) as a JS bigint, which breaks
// JSON responses and === comparisons. Convert to number at the boundary.
function allDb(query: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(query, ...params, (err: any, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows.map((row) => {
        const out: Record<string, any> = {};
        for (const key of Object.keys(row)) {
          out[key] = typeof row[key] === 'bigint' ? Number(row[key]) : row[key];
        }
        return out;
      }));
    });
  });
}

// Initialize tables on startup
async function initDatabase() {
  try {
    // Source registry: one row per provider data source (NPPES, each payer directory, ...).
    await runDb(`
      CREATE TABLE IF NOT EXISTS sources (
        id VARCHAR PRIMARY KEY,
        name VARCHAR,
        type VARCHAR,
        base_url VARCHAR,
        auth VARCHAR,
        enabled BOOLEAN DEFAULT TRUE,
        last_synced_at VARCHAR
      )
    `);

    // Provider records from all sources. Identity is (source, source_provider_id);
    // npi is not unique because payer directories can omit it or repeat it.
    const providerCols = (await allDb(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'providers'`
    )).map((c: any) => c.column_name);
    const needsMigration = providerCols.length > 0 && !providerCols.includes('source');
    if (needsMigration) {
      // Pre-multi-source table keyed on npi. Keep its rows under source 'nppes'.
      await runDb(`ALTER TABLE providers RENAME TO providers_v1`);
    }

    await runDb(`
      CREATE TABLE IF NOT EXISTS providers (
        source VARCHAR NOT NULL,
        source_provider_id VARCHAR NOT NULL,
        npi VARCHAR,
        entity_type VARCHAR,
        provider_name VARCHAR,
        first_name VARCHAR,
        last_name VARCHAR,
        credential VARCHAR,
        organization_name VARCHAR,
        location_name VARCHAR,
        address_line1 VARCHAR,
        address_line2 VARCHAR,
        city VARCHAR,
        state VARCHAR,
        postal_code VARCHAR,
        phone VARCHAR,
        taxonomy_code VARCHAR,
        taxonomy_desc VARCHAR,
        status VARCHAR,
        active BOOLEAN,
        last_updated VARCHAR,
        is_new BOOLEAN DEFAULT FALSE,
        is_deactivated BOOLEAN DEFAULT FALSE,
        first_seen VARCHAR,
        last_seen VARCHAR,
        deactivated_at VARCHAR,
        PRIMARY KEY (source, source_provider_id)
      )
    `);
    await runDb(`CREATE INDEX IF NOT EXISTS providers_npi_idx ON providers (npi)`);
    // Existing installs predate these columns.
    await runDb(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS first_seen VARCHAR`);
    await runDb(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS last_seen VARCHAR`);
    await runDb(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS deactivated_at VARCHAR`);
    await runDb(`UPDATE providers SET first_seen = last_updated WHERE first_seen IS NULL`);
    await runDb(`UPDATE providers SET last_seen = last_updated WHERE last_seen IS NULL`);

    // Append-only log of every change a sync makes to a provider record.
    await runDb(`CREATE SEQUENCE IF NOT EXISTS provider_events_seq`);
    await runDb(`
      CREATE TABLE IF NOT EXISTS provider_events (
        id BIGINT PRIMARY KEY DEFAULT nextval('provider_events_seq'),
        job_id VARCHAR,
        source VARCHAR NOT NULL,
        source_provider_id VARCHAR NOT NULL,
        event_type VARCHAR NOT NULL,   -- added | updated | deactivated | reactivated
        field VARCHAR,                 -- changed column for 'updated'; 'status' for (de)activations
        old_value VARCHAR,
        new_value VARCHAR,
        occurred_at VARCHAR NOT NULL
      )
    `);
    await runDb(`CREATE INDEX IF NOT EXISTS provider_events_provider_idx ON provider_events (source, source_provider_id)`);

    // Raw FHIR resources exactly as a payer returned them (PractitionerRole and every included resource).
    await runDb(`
      CREATE TABLE IF NOT EXISTS fhir_resources (
        source VARCHAR NOT NULL,
        resource_type VARCHAR NOT NULL,
        resource_id VARCHAR NOT NULL,
        job_id VARCHAR,
        fetched_at VARCHAR,
        payload JSON NOT NULL,
        PRIMARY KEY (source, resource_type, resource_id)
      )
    `);
    // Plans and networks from payer directories (see docs/provider-plan-model.md).
    await runDb(`
      CREATE TABLE IF NOT EXISTS payer_networks (
        source VARCHAR NOT NULL, network_id VARCHAR NOT NULL, name VARCHAR, network_type VARCHAR, fetched_at VARCHAR,
        PRIMARY KEY (source, network_id))
    `);
    await runDb(`
      CREATE TABLE IF NOT EXISTS payer_plans (
        source VARCHAR NOT NULL, plan_id VARCHAR NOT NULL, name VARCHAR, plan_type_raw VARCHAR, lob VARCHAR,
        owner VARCHAR, status VARCHAR, fetched_at VARCHAR,
        PRIMARY KEY (source, plan_id))
    `);
    await runDb(`
      CREATE TABLE IF NOT EXISTS plan_networks (
        source VARCHAR NOT NULL, plan_id VARCHAR NOT NULL, network_id VARCHAR NOT NULL,
        PRIMARY KEY (source, plan_id, network_id))
    `);
    // Per-payer plan type -> line of business. Unmapped types are 'unknown' until reviewed.
    await runDb(`CREATE TABLE IF NOT EXISTS lob_map (plan_type_raw VARCHAR PRIMARY KEY, lob VARCHAR NOT NULL)`);
    for (const [raw, lob] of [
      ['Medicare Advantage', 'Medicare'],
      ['Medicare Part D', 'Medicare'],
      ['Medicaid', 'Medicaid'],
      ['Medi-Cal', 'Medicaid'],
      ['Dual Eligible', 'Medicare-Medicaid (dual)'],
      ['Qualified Health Plan', 'unknown'],
      ['DRUGPOL', 'drug formulary (not medical)'],
    ]) {
      await runDb(`INSERT OR IGNORE INTO lob_map (plan_type_raw, lob) VALUES (?, ?)`, [raw, lob]);
    }

    // Full NPPES CSV row (all columns) as JSON, written by sources/nppes_bulk.ts.
    await runDb(`
      CREATE TABLE IF NOT EXISTS nppes_records (
        npi VARCHAR PRIMARY KEY,
        job_id VARCHAR,
        fetched_at VARCHAR,
        payload JSON NOT NULL
      )
    `);
    // Network memberships from each role's network-reference extension (plans, products, LOBs live here).
    await runDb(`
      CREATE TABLE IF NOT EXISTS provider_networks (
        source VARCHAR NOT NULL,
        source_provider_id VARCHAR NOT NULL,
        network_ref VARCHAR NOT NULL,
        network_name VARCHAR,
        job_id VARCHAR,
        fetched_at VARCHAR,
        PRIMARY KEY (source, source_provider_id, network_ref)
      )
    `);

    if (needsMigration) {
      await runDb(`
        INSERT INTO providers (source, source_provider_id, npi, entity_type, provider_name, first_name,
          last_name, credential, city, state, postal_code, taxonomy_code, taxonomy_desc, status, active,
          last_updated, is_new, is_deactivated)
        SELECT 'nppes', npi, npi, entity_type, provider_name, first_name, last_name, credential, city, state,
          postal_code, taxonomy_code, taxonomy_desc, status, status = 'Active', last_updated, is_new, is_deactivated
        FROM providers_v1
      `);
      await runDb(`DROP TABLE providers_v1`);
      console.log('Migrated providers table to multi-source schema.');
    }

    await runDb(`
      CREATE TABLE IF NOT EXISTS sync_jobs (
        id VARCHAR PRIMARY KEY,
        timestamp VARCHAR,
        type VARCHAR,
        status VARCHAR,
        records_processed INTEGER,
        adds_count INTEGER,
        deactivations_count INTEGER,
        updates_count INTEGER,
        duration_ms INTEGER,
        details VARCHAR
      )
    `);
    await runDb(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS source VARCHAR`);
    // Resume point for FHIR syncs: the next page URL and the job's parameters and running totals.
    await runDb(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS cursor_url VARCHAR`);
    await runDb(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS params VARCHAR`);
    await runDb(`UPDATE sync_jobs SET source = 'nppes' WHERE source IS NULL`);

    await runDb(`
      CREATE TABLE IF NOT EXISTS pipeline_config (
        key VARCHAR PRIMARY KEY,
        value VARCHAR
      )
    `);

    // Seed default config if empty
    const configs = await allDb(`SELECT * FROM pipeline_config`);
    if (configs.length === 0) {
      await runDb(`INSERT INTO pipeline_config VALUES ('cron_schedule', '0 2 * * *')`);
      await runDb(`INSERT INTO pipeline_config VALUES ('source_url', 'https://download.cms.gov/nppes/NPPES_Data_Dissemination_Current_Weekly.zip')`);
      await runDb(`INSERT INTO pipeline_config VALUES ('cron_enabled', 'true')`);
      await runDb(`INSERT INTO pipeline_config VALUES ('batch_size', '50000')`);
      await runDb(`INSERT INTO pipeline_config VALUES ('email_notifications', 'false')`);
      await runDb(`INSERT INTO pipeline_config VALUES ('alert_email', 'admin@healthcare-registry.org')`);
    }

    // Seed the source registry if empty: NPPES plus every payer in data/payer_endpoints.json.
    const sourceCount = await allDb(`SELECT COUNT(*) as cnt FROM sources`);
    if (sourceCount[0].cnt === 0) {
      const nppesUrl = (await allDb(`SELECT value FROM pipeline_config WHERE key = 'source_url'`))[0]?.value ?? null;
      await runDb(
        `INSERT INTO sources (id, name, type, base_url, auth, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
        ['nppes', 'NPPES Weekly Dissemination', 'cms_nppes_dissemination', nppesUrl, 'none', true]
      );
      try {
        const payerFile = path.join(__dirname, 'data', 'payer_endpoints.json');
        const payers: any[] = JSON.parse(fs.readFileSync(payerFile, 'utf8')).payers;
        for (const p of payers) {
          await runDb(
            `INSERT OR REPLACE INTO sources (id, name, type, base_url, auth, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
            [p.id, p.name, 'fhir_provider_directory', p.baseUrl ?? null, p.auth ?? null, !!p.baseUrl]
          );
        }
      } catch (err) {
        console.warn('Could not read data/payer_endpoints.json:', err);
      }
    }

    // No sample data is seeded. Providers and sync jobs come only from real loads and syncs.

    console.log('DuckDB initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize DuckDB:', err);
  }
}

initDatabase().then(resumeInterruptedJobs);

// ---------------------------------------------------------------------------
// Change tracking: every sync goes through applyProviderRecord, which upserts
// the record and logs what changed in provider_events.
// ---------------------------------------------------------------------------

// Columns compared when diffing an incoming record against current state.
// Status is handled separately (it produces deactivated/reactivated events).
// last_updated is stored but not logged as a change: it is source metadata.
const TRACKED_FIELDS = [
  'npi', 'entity_type', 'provider_name', 'first_name', 'last_name', 'credential',
  'organization_name', 'location_name', 'address_line1', 'address_line2', 'city', 'state',
  'postal_code', 'phone', 'taxonomy_code', 'taxonomy_desc',
] as const;

// Incoming record, keyed by the providers column names.
interface ProviderRecord {
  source: string;
  source_provider_id: string;
  status: string;            // 'Active' | 'Deactivated'
  active: boolean;
  last_updated: string | null;
  [field: string]: any;
}

// The duckdb connection is shared, so multi-statement transactions must not interleave.
let writeQueue: Promise<unknown> = Promise.resolve();
function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(async () => {
    await runDb('BEGIN TRANSACTION');
    try {
      const result = await fn();
      await runDb('COMMIT');
      return result;
    } catch (err) {
      await runDb('ROLLBACK');
      throw err;
    }
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

// Upsert one record and log each change. Returns the event types it produced.
// Must run inside withTransaction.
async function applyProviderRecord(jobId: string, rec: ProviderRecord, now: string): Promise<string[]> {
  type Event = { type: string; field: string | null; oldValue: unknown; newValue: unknown };
  const events: Event[] = [];
  const incomingDeact = rec.status === 'Deactivated';

  const existing = (await allDb(
    `SELECT * FROM providers WHERE source = ? AND source_provider_id = ?`,
    [rec.source, rec.source_provider_id]
  ))[0];

  if (!existing) {
    const columns = [...TRACKED_FIELDS, 'status', 'active', 'last_updated', 'first_seen', 'last_seen',
      'deactivated_at', 'is_new', 'is_deactivated'];
    const values = [
      ...TRACKED_FIELDS.map((f) => rec[f] ?? null),
      rec.status, rec.active, rec.last_updated ?? null, now, now,
      incomingDeact ? now : null, true, incomingDeact,
    ];
    await runDb(
      `INSERT INTO providers (source, source_provider_id, ${columns.join(', ')})
       VALUES (?, ?, ${columns.map(() => '?').join(', ')})`,
      [rec.source, rec.source_provider_id, ...values]
    );
    events.push({ type: 'added', field: null, oldValue: null, newValue: null });
    if (incomingDeact) events.push({ type: 'deactivated', field: 'status', oldValue: null, newValue: rec.status });
  } else {
    for (const f of TRACKED_FIELDS) {
      const oldV = existing[f] ?? null;
      const newV = rec[f] ?? null;
      if (String(oldV ?? '') !== String(newV ?? '')) {
        events.push({ type: 'updated', field: f, oldValue: oldV, newValue: newV });
      }
    }

    const wasDeact = existing.status === 'Deactivated';
    let deactivatedAt: string | null = existing.deactivated_at ?? null;
    if (incomingDeact && !wasDeact) {
      events.push({ type: 'deactivated', field: 'status', oldValue: existing.status, newValue: rec.status });
      deactivatedAt = now;
    } else if (!incomingDeact && wasDeact) {
      events.push({ type: 'reactivated', field: 'status', oldValue: existing.status, newValue: rec.status });
      deactivatedAt = null;
    }

    const setClause = [...TRACKED_FIELDS.map((f) => `${f} = ?`),
      'status = ?', 'active = ?', 'last_updated = ?', 'last_seen = ?', 'deactivated_at = ?', 'is_deactivated = ?'].join(', ');
    await runDb(
      `UPDATE providers SET ${setClause} WHERE source = ? AND source_provider_id = ?`,
      [
        ...TRACKED_FIELDS.map((f) => rec[f] ?? null),
        rec.status, rec.active, rec.last_updated ?? null, now, deactivatedAt, incomingDeact,
        rec.source, rec.source_provider_id,
      ]
    );
  }

  for (const e of events) {
    await runDb(
      `INSERT INTO provider_events (job_id, source, source_provider_id, event_type, field, old_value, new_value, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId, rec.source, rec.source_provider_id, e.type, e.field,
        e.oldValue == null ? null : String(e.oldValue),
        e.newValue == null ? null : String(e.newValue),
        now,
      ]
    );
  }
  return events.map((e) => e.type);
}

// API Endpoints

// 1. Get pipeline status & overview stats
app.get('/api/status', async (req, res) => {
  try {
    const totalRes = await allDb(`SELECT COUNT(*) as total FROM providers`);
    const activeRes = await allDb(`SELECT COUNT(*) as active FROM providers WHERE status = 'Active'`);
    const deactivatedRes = await allDb(`SELECT COUNT(*) as deactivated FROM providers WHERE status = 'Deactivated'`);
    const newRes = await allDb(`SELECT COUNT(*) as added FROM providers WHERE is_new = TRUE`);
    const jobs = await allDb(`SELECT * FROM sync_jobs ORDER BY timestamp DESC LIMIT 10`);
    const configRows = await allDb(`SELECT * FROM pipeline_config`);
    // Count distinct providers (an NPI in several plans counts once), grouped by taxonomy code. The label is the
    // most common one for that code with HTML entities decoded and any "Group; Specialty" prefix removed.
    const providerKey = `coalesce(npi, source || ':' || source_provider_id)`;
    const taxonomiesRes = await allDb(`
      SELECT mode(regexp_replace(replace(taxonomy_desc, '&amp;', '&'), '^.*; ', '')) AS name,
             COUNT(DISTINCT ${providerKey}) AS count
      FROM providers
      WHERE taxonomy_code IS NOT NULL AND lower(taxonomy_code) <> 'unknown'
        AND taxonomy_desc IS NOT NULL AND lower(taxonomy_desc) <> 'unknown'
      GROUP BY taxonomy_code ORDER BY count DESC LIMIT 10`);
    const cityDensityRes = await allDb(`
      SELECT upper(trim(city)) AS city, COUNT(DISTINCT ${providerKey}) AS count
      FROM providers WHERE city IS NOT NULL AND trim(city) <> ''
      GROUP BY 1 ORDER BY count DESC LIMIT 24`);
    const stateDensityRes = await allDb(`SELECT state, COUNT(DISTINCT ${providerKey}) as count FROM providers WHERE state IS NOT NULL GROUP BY state ORDER BY count DESC`);
    const sourcesRes = await allDb(
      `SELECT s.id, s.name, s.type, s.enabled, s.last_synced_at, COUNT(p.source_provider_id) AS providers
       FROM sources s LEFT JOIN providers p ON p.source = s.id
       GROUP BY s.id, s.name, s.type, s.enabled, s.last_synced_at
       ORDER BY s.id`
    );

    const config: Record<string, string> = {};
    configRows.forEach((r) => {
      config[r.key] = r.value;
    });

    res.json({
      stats: {
        totalProviders: totalRes[0].total,
        activeProviders: activeRes[0].active,
        deactivatedProviders: deactivatedRes[0].deactivated,
        newToday: newRes[0].added
      },
      config,
      recentJobs: jobs,
      topTaxonomies: taxonomiesRes,
      stateDensity: stateDensityRes,
      cityDensity: cityDensityRes,
      sources: sourcesRes
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Retired: the simulated sync wrote fake providers and jobs.
// Use POST /api/sources/:id/sync for payer directories, or the NPPES bulk loader.
app.post('/api/sync', (req, res) => {
  res.status(410).json({
    error: 'The simulated sync was removed. Use POST /api/sources/:id/sync for payer directories, or sources/nppes_bulk.ts for NPPES.'
  });
});

// 3. Search and filter providers
app.get('/api/providers', async (req, res) => {
  try {
    const { search = '', status = 'all', state = 'all', source = 'all', limit = '50', offset = '0' } = req.query;
    let query = `SELECT * FROM providers WHERE 1=1`;
    const params: any[] = [];

    if (search) {
      query += ` AND (npi LIKE ? OR provider_name LIKE ? OR organization_name LIKE ? OR city LIKE ? OR taxonomy_desc LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term, term, term);
    }

    if (source !== 'all') {
      query += ` AND source = ?`;
      params.push(source);
    }

    if (status !== 'all') {
      query += ` AND status = ?`;
      params.push(status);
    }

    if (state !== 'all') {
      query += ` AND state = ?`;
      params.push(state);
    }

    query += ` ORDER BY last_updated DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const providers = await allDb(query, params);
    res.json({ providers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3a. Pull a payer's FHIR provider directory in the background. Each page is written in its
// own transaction as it arrives, so progress is saved and a failure keeps the pages already loaded.
// Body (all optional): { state: 'CA' | 'ALL', maxPages: 0 (all) | 1..100000, pageSize: 1..100 }
// Returns 202 with a jobId. Follow progress in /api/status (recentJobs).
const runningSources = new Set<string>();

interface FhirJobParams {
  state: string;
  pageSize: number;
  maxPages: number | null;
  specialty: string | null;
  includesUsed: boolean;
  totals: { pages: number; pulled: number; kept: number; adds: number; updates: number; deacts: number; locationFailures: number };
}

// Runs (or resumes) a FHIR sync job. `cursor` is the saved next-page URL when resuming.
// Progress is saved in the same transaction as each page, so a restart repeats at most one page.
async function runFhirSync(jobId: string, sourceId: string, baseUrl: string, params: FhirJobParams,
  startTime: number, cursor: string | null = null) {
  const { state, pageSize, maxPages, specialty } = params;
  const totals = { ...params.totals };
  const stamp = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
  try {
    if (cursor === null) {
      await withTransaction(async () => {
        await runDb(`UPDATE providers SET is_new = FALSE WHERE source = ? AND is_new`, [sourceId]);
      });
    }

    const resume = cursor === null ? undefined : { url: cursor, includesUsed: params.includesUsed, pageOffset: totals.pages };
    for await (const page of pullPages(baseUrl, sourceId, { pageSize, maxPages, extra: specialty ? { specialty } : {}, resume })) {
      const now = stamp();
      const kept = state === 'ALL' ? page.records : page.records.filter((r) => (r.state ?? '').toUpperCase() === state);

      await withTransaction(async () => {
        // Previously stored payloads for this page's resources, to log field-level changes.
        const ids = [...new Set(page.raw.map((r) => r.id))];
        const previous = new Map<string, any>();
        if (ids.length > 0) {
          const rows = await allDb(
            `SELECT resource_type, resource_id, payload::VARCHAR AS payload FROM fhir_resources
             WHERE source = ? AND resource_id IN (${ids.map(() => '?').join(',')})`,
            [sourceId, ...ids]
          );
          for (const row of rows) previous.set(`${row.resource_type}/${row.resource_id}`, JSON.parse(row.payload));
        }

        let adds = 0, updates = 0, deacts = 0;
        for (const rec of kept) {
          const events = await applyProviderRecord(jobId, rec, now);
          if (events.includes('added')) adds++;
          if (events.includes('updated')) updates++;
          if (events.includes('deactivated')) deacts++;
        }

        for (const res of page.raw) {
          const before = previous.get(`${res.resourceType}/${res.id}`);
          if (before) {
            for (const c of diffPayloads(before, res.payload)) {
              await runDb(
                `INSERT INTO provider_events (job_id, source, source_provider_id, event_type, field, old_value, new_value, occurred_at)
                 VALUES (?, ?, ?, 'raw_changed', ?, ?, ?, ?)`,
                [jobId, sourceId, res.id, `${res.resourceType}.${c.field}`, c.oldValue, c.newValue, now]
              );
            }
          }
          await runDb(
            `INSERT OR REPLACE INTO fhir_resources (source, resource_type, resource_id, job_id, fetched_at, payload)
             VALUES (?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [sourceId, res.resourceType, res.id, jobId, now, JSON.stringify(res.payload)]
          );
        }

        for (const id of new Set(page.records.map((r) => r.source_provider_id))) {
          await runDb(`DELETE FROM provider_networks WHERE source = ? AND source_provider_id = ?`, [sourceId, id]);
        }
        for (const n of page.networks) {
          await runDb(
            `INSERT OR REPLACE INTO provider_networks (source, source_provider_id, network_ref, network_name, job_id, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [sourceId, n.source_provider_id, n.network_ref, n.network_name, jobId, now]
          );
        }

        totals.adds += adds;
        totals.updates += updates;
        totals.deacts += deacts;
        totals.pages = page.pageNo;
        totals.pulled += page.records.length;
        totals.kept += kept.length;
        totals.locationFailures += page.locationFailures;

        // Resume point, committed with the page it belongs to.
        const saved: FhirJobParams = { ...params, includesUsed: page.includesUsed, totals };
        await runDb(
          `UPDATE sync_jobs SET cursor_url = ?, params = ?, records_processed = ?, adds_count = ?,
             deactivations_count = ?, updates_count = ?, details = ? WHERE id = ?`,
          [page.nextUrl, JSON.stringify(saved), totals.kept, totals.adds, totals.deacts, totals.updates,
            `Running: page ${totals.pages}, pulled ${totals.pulled}, kept ${totals.kept} (state=${state}).`, jobId]
        );
      });
    }

    const now = stamp();
    const duration = Date.now() - startTime;
    const details = `Pulled ${totals.pulled} roles over ${totals.pages} pages (state=${state}); kept ${totals.kept}. ${totals.adds} added, ${totals.deacts} deactivated, ${totals.updates} updated.`;
    await runDb(
      `UPDATE sync_jobs SET status = 'success', cursor_url = NULL, records_processed = ?, adds_count = ?,
         deactivations_count = ?, updates_count = ?, duration_ms = ?, details = ? WHERE id = ?`,
      [totals.kept, totals.adds, totals.deacts, totals.updates, duration, details, jobId]
    );
    await runDb(`UPDATE sources SET last_synced_at = ? WHERE id = ?`, [now, sourceId]);
  } catch (err: any) {
    let message = err instanceof FhirError ? err.message : String(err?.message ?? err);
    if (cursor !== null && err instanceof FhirError && (err.status === 410 || err.status === 404)) {
      message = `The saved resume link expired, so the job could not continue. Rerun it. ${message}`;
    }
    // A failed job never resumes: clear its resume point.
    await runDb(
      `UPDATE sync_jobs SET status = 'failed', cursor_url = NULL, duration_ms = ?, details = ? WHERE id = ?`,
      [Date.now() - startTime, `Stopped after ${totals.pages} pages (${totals.kept} kept). ${message}`, jobId]
    ).catch(() => undefined);
  } finally {
    runningSources.delete(sourceId);
  }
}

// Called once at startup. Jobs left "running" by a restart continue from their saved page;
// jobs with no saved resume point are marked failed.
async function resumeInterruptedJobs() {
  try {
    const jobs = await allDb(`SELECT id, source, cursor_url, params FROM sync_jobs WHERE status = 'running'`);
    for (const job of jobs) {
      const [source] = await allDb(`SELECT base_url FROM sources WHERE id = ?`, [job.source]);
      if (!job.cursor_url || !job.params || !source?.base_url || runningSources.has(job.source)) {
        await runDb(
          `UPDATE sync_jobs SET status = 'failed', cursor_url = NULL, details = 'Interrupted by a restart; no resume point.' WHERE id = ?`,
          [job.id]
        );
        continue;
      }
      const params: FhirJobParams = JSON.parse(job.params);
      runningSources.add(job.source);
      console.log(`Resuming ${job.id} after page ${params.totals.pages}`);
      void runFhirSync(job.id, job.source, source.base_url, params, Date.now(), job.cursor_url);
    }
  } catch (err) {
    console.error('Could not resume interrupted jobs:', err);
  }
}

app.post('/api/sources/:id/sync', async (req, res) => {
  const sourceId = req.params.id;
  const state = String(req.body?.state ?? 'CA').toUpperCase();
  const requestedPages = Number(req.body?.maxPages ?? 5);
  const maxPages = requestedPages === 0 ? null : Math.min(Math.max(requestedPages, 1), 100000);
  const pageSize = Math.min(Math.max(Number(req.body?.pageSize ?? 100), 1), 100);
  const specialty = req.body?.specialty == null ? null : String(req.body.specialty);
  if (specialty !== null && !/^[A-Za-z0-9]{1,20}$/.test(specialty)) {
    return res.status(400).json({ error: 'specialty must be a taxonomy code' });
  }
  try {
    const [source] = await allDb(`SELECT id, name, type, base_url, enabled FROM sources WHERE id = ?`, [sourceId]);
    if (!source) return res.status(404).json({ error: `unknown source: ${sourceId}` });
    if (source.type !== 'fhir_provider_directory') return res.status(400).json({ error: 'source is not a FHIR provider directory' });
    if (!source.base_url) return res.status(400).json({ error: 'source has no public base URL' });
    if (!source.enabled) return res.status(400).json({ error: 'source is disabled' });
    if (runningSources.has(sourceId)) return res.status(409).json({ error: `a sync is already running for ${sourceId}` });

    const startTime = Date.now();
    const jobId = `fhir_${sourceId}_${startTime}`;
    const params: FhirJobParams = {
      state, pageSize, maxPages, specialty, includesUsed: true,
      totals: { pages: 0, pulled: 0, kept: 0, adds: 0, updates: 0, deacts: 0, locationFailures: 0 },
    };
    const startedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await runDb(
      `INSERT INTO sync_jobs (id, timestamp, type, status, records_processed, adds_count, deactivations_count, updates_count, duration_ms, details, source, params)
       VALUES (?, ?, 'fhir_provider_directory', 'running', 0, 0, 0, 0, 0, 'Starting', ?, ?)`,
      [jobId, startedAt, sourceId, JSON.stringify(params)]
    );
    runningSources.add(sourceId);
    void runFhirSync(jobId, sourceId, source.base_url, params, startTime);

    res.status(202).json({ success: true, status: 'running', jobId, source: sourceId, state, specialty, maxPages: maxPages ?? 'all', pageSize });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3b2. Pull plans and network organizations for a payer, and rebuild its plan/network tables.
// Networks are the Organization resources that provider memberships point to. Plans are InsurancePlan.
app.post('/api/sources/:id/plans', async (req, res) => {
  const sourceId = req.params.id;
  try {
    const [source] = await allDb(`SELECT id, type, base_url, enabled FROM sources WHERE id = ?`, [sourceId]);
    if (!source) return res.status(404).json({ error: `unknown source: ${sourceId}` });
    if (source.type !== 'fhir_provider_directory' || !source.base_url) return res.status(400).json({ error: 'source has no FHIR directory' });
    if (runningSources.has(sourceId)) return res.status(409).json({ error: `a sync is already running for ${sourceId}` });

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const refs = (await allDb(`SELECT DISTINCT network_ref FROM provider_networks WHERE source = ?`, [sourceId])).map((r) => r.network_ref);
    const networkPull = await fetchReferences(source.base_url, refs);

    const plans: RawResource[] = [];
    for await (const page of pullResourceType(source.base_url, 'InsurancePlan', 100)) plans.push(...page);

    const lobRows = await allDb(`SELECT plan_type_raw, lob FROM lob_map`);
    const lobOf = new Map<string, string>(lobRows.map((r) => [r.plan_type_raw, r.lob]));

    await withTransaction(async () => {
      for (const res of [...networkPull.raw, ...plans]) {
        await runDb(
          `INSERT OR REPLACE INTO fhir_resources (source, resource_type, resource_id, job_id, fetched_at, payload)
           VALUES (?, ?, ?, ?, ?, CAST(? AS JSON))`,
          [sourceId, res.resourceType, res.id, `plans_${sourceId}`, now, JSON.stringify(res.payload)]
        );
      }

      await runDb(`DELETE FROM payer_networks WHERE source = ?`, [sourceId]);
      for (const { id, payload } of networkPull.raw.map((r) => ({ id: r.id, payload: r.payload }))) {
        const type = (payload.type ?? []).map((t: any) => t.text ?? t.coding?.[0]?.display ?? t.coding?.[0]?.code).filter(Boolean).join(', ') || null;
        await runDb(`INSERT INTO payer_networks (source, network_id, name, network_type, fetched_at) VALUES (?, ?, ?, ?, ?)`,
          [sourceId, id, payload.name ?? null, type, now]);
      }

      await runDb(`DELETE FROM payer_plans WHERE source = ?`, [sourceId]);
      await runDb(`DELETE FROM plan_networks WHERE source = ?`, [sourceId]);
      for (const plan of plans) {
        const p = plan.payload;
        const typeRaw = (p.type ?? []).flatMap((t: any) => (t.coding ?? []).map((c: any) => c.display ?? c.code))
          .concat((p.type ?? []).map((t: any) => t.text).filter(Boolean))
          .filter(Boolean).join(', ') || null;
        const lob = (typeRaw && lobOf.get(typeRaw)) || 'unknown';
        await runDb(
          `INSERT INTO payer_plans (source, plan_id, name, plan_type_raw, lob, owner, status, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [sourceId, plan.id, p.name ?? p.alias?.[0] ?? null, typeRaw, lob, p.ownedBy?.display ?? null, p.status ?? null, now]
        );
        for (const n of p.network ?? []) {
          const netId = String(n.reference ?? '').replace(/^Organization\//, '');
          if (netId) await runDb(`INSERT OR IGNORE INTO plan_networks (source, plan_id, network_id) VALUES (?, ?, ?)`, [sourceId, plan.id, netId]);
        }
      }
    });

    const counts = await allDb(`SELECT
        (SELECT count(*) FROM payer_networks WHERE source = ?) AS networks,
        (SELECT count(*) FROM payer_plans WHERE source = ?) AS plans,
        (SELECT count(*) FROM plan_networks WHERE source = ?) AS plan_network_links`, [sourceId, sourceId, sourceId]);
    res.json({ source: sourceId, networkRefs: refs.length, networkFetchFailures: networkPull.failures, ...counts[0] });
  } catch (err: any) {
    res.status(err instanceof FhirError ? 502 : 500).json({ error: err.message });
  }
});

// 3c. Stored payer data for one provider: network memberships and the raw FHIR role.
app.get('/api/providers/:source/:id/fhir', async (req, res) => {
  try {
    const networks = await allDb(
      `SELECT network_ref, network_name, fetched_at FROM provider_networks
       WHERE source = ? AND source_provider_id = ? ORDER BY network_ref`,
      [req.params.source, req.params.id]
    );
    const roles = await allDb(
      `SELECT payload::VARCHAR AS payload, fetched_at FROM fhir_resources
       WHERE source = ? AND resource_type = 'PractitionerRole' AND resource_id = ?`,
      [req.params.source, req.params.id]
    );
    if (req.params.source === 'nppes') {
      const rows = await allDb(
        `SELECT payload::VARCHAR AS payload, fetched_at FROM nppes_records WHERE npi = ?`,
        [req.params.id]
      );
      return res.json({
        networks,
        nppesRecord: rows[0] ? JSON.parse(rows[0].payload) : null,
        fetchedAt: rows[0]?.fetched_at ?? null,
      });
    }
    res.json({ networks, role: roles[0] ? JSON.parse(roles[0].payload) : null, fetchedAt: roles[0]?.fetched_at ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3b. Change history for one provider record (newest first)
app.get('/api/providers/:source/:id/events', async (req, res) => {
  try {
    const events = await allDb(
      `SELECT id, job_id, event_type, field, old_value, new_value, occurred_at
       FROM provider_events
       WHERE source = ? AND source_provider_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT 500`,
      [req.params.source, req.params.id]
    );
    res.json({ events });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Update configuration
app.post('/api/config', async (req, res) => {
  try {
    const { cron_schedule, source_url, cron_enabled, batch_size, email_notifications, alert_email } = req.body;
    if (cron_schedule) await runDb(`INSERT OR REPLACE INTO pipeline_config VALUES ('cron_schedule', ?)`, [cron_schedule]);
    if (source_url) await runDb(`INSERT OR REPLACE INTO pipeline_config VALUES ('source_url', ?)`, [source_url]);
    if (cron_enabled !== undefined) await runDb(`INSERT OR REPLACE INTO pipeline_config VALUES ('cron_enabled', ?)`, [cron_enabled.toString()]);
    if (batch_size) await runDb(`INSERT OR REPLACE INTO pipeline_config VALUES ('batch_size', ?)`, [batch_size]);
    if (email_notifications !== undefined) await runDb(`INSERT OR REPLACE INTO pipeline_config VALUES ('email_notifications', ?)`, [email_notifications.toString()]);
    if (alert_email !== undefined) await runDb(`INSERT OR REPLACE INTO pipeline_config VALUES ('alert_email', ?)`, [alert_email]);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Execute custom SQL query on DuckDB
app.post('/api/sql', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    // Safety check: allow SELECT queries
    const trimmed = query.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('DESCRIBE') && !trimmed.startsWith('SHOW')) {
      return res.status(400).json({ error: 'Only SELECT, DESCRIBE, and SHOW queries are permitted for safety in playground.' });
    }

    const rows = await allDb(query);
    res.json({ rows });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 6. Get Docker & Python Worker Code Templates
app.get('/api/docker-artifacts', (req, res) => {
  const dockerfile = `FROM python:3.11-slim

WORKDIR /app

# Install system dependencies & build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    cron \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages including duckdb & requests
RUN pip install --no-cache-dir duckdb requests pandas

# Copy sync script and crontab
COPY sync_nppes.py /app/sync_nppes.py
COPY crontab /etc/cron.d/nppes-cron

# Give execution rights on the cron job & apply
RUN chmod 0644 /etc/cron.d/nppes-cron
RUN crontab /etc/cron.d/nppes-cron

# Create log file for cron
RUN touch /var/log/cron.log

CMD ["cron", "-f"]
`;

  const pythonWorker = `#!/usr/bin/env python3
"""
NPPES Weekly Dissemination & Delta Sync Worker
Scans CMS NPPES weekly zip file, loads into DuckDB, computes adds/deactivations,
and updates downstream analytical tables.
"""

import os
import zipfile
import requests
import duckdb
import pandas as pd
from datetime import datetime

DB_PATH = "/app/data/nppes_pipeline.duckdb"
CMS_URL = "https://download.cms.gov/nppes/NPPES_Data_Dissemination_Current_Weekly.zip"

def run_sync():
    print(f"[{datetime.now()}] Starting NPPES Delta Sync...")
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = duckdb.connect(DB_PATH)
    
    # Ensure table exists
    con.execute("""
        CREATE TABLE IF NOT EXISTS providers (
            npi VARCHAR PRIMARY KEY,
            entity_type VARCHAR,
            provider_name VARCHAR,
            status VARCHAR,
            last_updated VARCHAR
        )
    """)

    print(f"[{datetime.now()}] Fetching dissemination data from CMS...")
    # In production, stream download and unzip file
    # res = requests.get(CMS_URL, stream=True)
    
    print(f"[{datetime.now()}] Computing delta changes (Adds & Deactivations)...")
    # DuckDB fast delta merge & upsert
    print(f"[{datetime.now()}] NPPES Sync completed successfully.")
    con.close()

if __name__ == "__main__":
    run_sync()
`;

  const crontab = `# Run NPPES Delta Sync every night at 2:00 AM
0 2 * * * /usr/local/bin/python /app/sync_nppes.py >> /var/log/cron.log 2>&1
# Empty line required at end of crontab
`;

  const dockerCompose = `version: '3.8'

services:
  nppes-pipeline:
    build: .
    container_name: nppes-duckdb-sync
    restart: unless-stopped
    volumes:
      - ./data:/app/data
      - ./logs:/var/log
    environment:
      - BATCH_SIZE=50000
      - LOG_LEVEL=INFO
`;

  res.json({
    dockerfile,
    pythonWorker,
    crontab,
    dockerCompose
  });
});

// Vite middleware setup in development
if (process.env.NODE_ENV !== 'production') {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
