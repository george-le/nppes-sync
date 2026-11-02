// NPPES bulk loader: applies a CMS NPPES dissemination CSV to the providers table.
//
// Input: the extracted main CSV (npidata_pfile_*.csv) from the monthly full replacement
// file or a weekly incremental file. Column names follow the CMS header file
// (NPIDataDisseminationFileHeader.csv). Dates are MM/DD/YYYY.
//
// Uses DuckDB's native CSV reader and set-based SQL, so a ~9M row file is loaded in
// bulk instead of one row at a time. Changes are logged to provider_events exactly
// as applyProviderRecord does for the simulated sync. Deactivation dates come from
// the file (NPI Deactivation Date), not from when this loader ran.
//
// IMPORTANT: DuckDB allows one writer per database file. Stop the app before running
// this against the same DB file (docker compose stop nppes-sync).
//
// Usage:
//   DB_FILE=/path/nppes_pipeline.duckdb npx tsx sources/nppes_bulk.ts <npidata_pfile.csv> [--state CA|all]

import duckdb from 'duckdb';
import fs from 'fs';

const args = process.argv.slice(2);
const csvPath: string = args.find((a) => !a.startsWith('--')) ?? '';
const stateFlag = args.find((a) => a.startsWith('--state=')) ?? '--state=CA';
const stateArg = (stateFlag.split('=')[1] ?? 'CA').toUpperCase();
const dbFile = process.env.DB_FILE || '/mnt/data/provider-data/nppes_pipeline.duckdb';

if (!csvPath) {
  console.error('usage: nppes_bulk.ts <npidata_pfile.csv> [--state=CA|all]');
  process.exit(2);
}
if (!fs.existsSync(csvPath)) {
  console.error(`file not found: ${csvPath}`);
  process.exit(2);
}

const db = new duckdb.Database(dbFile);
const run = (sql: string): Promise<void> =>
  new Promise((resolve, reject) => db.run(sql, (err: any) => (err ? reject(err) : resolve())));
const all = (sql: string): Promise<any[]> =>
  new Promise((resolve, reject) =>
    db.all(sql, (err: any, rows: any[]) => (err ? reject(err) : resolve(rows.map(toPlain))))
  );
function toPlain(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(row)) out[k] = typeof row[k] === 'bigint' ? Number(row[k]) : row[k];
  return out;
}

// Quote an identifier for SQL (NPPES column names contain spaces and parentheses).
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Fields compared for 'updated' events. Mirrors TRACKED_FIELDS in server.ts.
const TRACKED_FIELDS = [
  'entity_type', 'provider_name', 'first_name', 'last_name', 'credential',
  'organization_name', 'location_name', 'address_line1', 'address_line2', 'city', 'state',
  'postal_code', 'phone', 'taxonomy_code', 'taxonomy_desc',
];

// Source column -> normalized expression. Empty strings become NULL.
const txt = (col: string) => `nullif(trim(r.${q(col)}), '')`;
const isoDate = (col: string) =>
  `strftime(try_strptime(nullif(trim(r.${q(col)}), ''), '%m/%d/%Y'), '%Y-%m-%d')`;

async function main() {
  const started = Date.now();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const jobId = 'nppes_bulk_' + Date.now();
  const stateFilter = stateArg === 'ALL' ? '' : `AND upper(trim(r."Provider Business Practice Location Address State Name")) = ${sqlString(stateArg)}`;

  // Confirm the schema exists (start the app once on a new database to create it).
  const tables = await all(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('providers','provider_events','sources','sync_jobs')`);
  if (tables.length < 4) {
    throw new Error('Schema missing. Start the app once against this DB file so it creates the tables, then rerun.');
  }

  await run('BEGIN TRANSACTION');
  try {
    // 1. Stage the file. all_varchar keeps the CMS formatting; we normalize below.
    await run(`CREATE OR REPLACE TEMP TABLE nppes_raw AS SELECT * FROM read_csv(${sqlString(csvPath)}, header = true, all_varchar = true)`);
    const rawCount = (await all(`SELECT count(*) AS n FROM nppes_raw`))[0].n;

    // 2. Map to the providers shape. One row per NPI (QUALIFY guards against duplicates).
    await run(`
      CREATE OR REPLACE TEMP TABLE incoming AS
      WITH mapped AS (
        SELECT
          'nppes' AS source,
          trim(r."NPI") AS source_provider_id,
          trim(r."NPI") AS npi,
          ${txt('Entity Type Code')} AS entity_type,
          CASE WHEN trim(r."Entity Type Code") = '2'
            THEN ${txt('Provider Organization Name (Legal Business Name)')}
            ELSE nullif(trim(concat_ws(' ', ${txt('Provider First Name')}, ${txt('Provider Middle Name')}, ${txt('Provider Last Name (Legal Name)')}, ${txt('Provider Name Suffix Text')})), '')
          END AS provider_name,
          CASE WHEN trim(r."Entity Type Code") = '2' THEN NULL ELSE ${txt('Provider First Name')} END AS first_name,
          CASE WHEN trim(r."Entity Type Code") = '2' THEN NULL ELSE ${txt('Provider Last Name (Legal Name)')} END AS last_name,
          ${txt('Provider Credential Text')} AS credential,
          CASE WHEN trim(r."Entity Type Code") = '2' THEN ${txt('Provider Organization Name (Legal Business Name)')} END AS organization_name,
          CAST(NULL AS VARCHAR) AS location_name,
          ${txt('Provider First Line Business Practice Location Address')} AS address_line1,
          ${txt('Provider Second Line Business Practice Location Address')} AS address_line2,
          ${txt('Provider Business Practice Location Address City Name')} AS city,
          ${txt('Provider Business Practice Location Address State Name')} AS state,
          left(${txt('Provider Business Practice Location Address Postal Code')}, 5) AS postal_code,
          ${txt('Provider Business Practice Location Address Telephone Number')} AS phone,
          ${txt('Healthcare Provider Taxonomy Code_1')} AS taxonomy_code,
          CAST(NULL AS VARCHAR) AS taxonomy_desc,
          ${isoDate('Last Update Date')} AS last_updated,
          ${isoDate('NPI Deactivation Date')} AS deact_date,
          try_strptime(nullif(trim(r."NPI Deactivation Date"), ''), '%m/%d/%Y') AS deact_ts,
          try_strptime(nullif(trim(r."NPI Reactivation Date"), ''), '%m/%d/%Y') AS react_ts
        FROM nppes_raw r
        WHERE trim(r."NPI") <> '' ${stateFilter}
      )
      SELECT
        m.*,
        CASE WHEN m.deact_ts IS NOT NULL AND (m.react_ts IS NULL OR m.react_ts < m.deact_ts)
          THEN 'Deactivated' ELSE 'Active' END AS status,
        CASE WHEN m.deact_ts IS NOT NULL AND (m.react_ts IS NULL OR m.react_ts < m.deact_ts)
          THEN strftime(m.deact_ts, '%Y-%m-%d') END AS deactivated_at
      FROM mapped m
      QUALIFY row_number() OVER (PARTITION BY m.npi) = 1
    `);
    const incomingCount = (await all(`SELECT count(*) AS n FROM incoming`))[0].n;

    // 2b. Keep every CSV column for each kept record, as JSON. Same rows and state filter as above.
    await run(`
      CREATE TABLE IF NOT EXISTS nppes_records (
        npi VARCHAR PRIMARY KEY,
        job_id VARCHAR,
        fetched_at VARCHAR,
        payload JSON NOT NULL
      )
    `);
    await run(`
      CREATE OR REPLACE TEMP TABLE incoming_raw AS
      SELECT trim(r."NPI") AS npi, to_json(r) AS payload
      FROM nppes_raw r
      WHERE trim(r."NPI") <> '' ${stateFilter}
    `);

    // 2c. Field-level diff against the stored raw record, across every CMS column.
    // Each changed column is one 'raw_changed' event. Runs before the upsert below.
    await run(`
      INSERT INTO provider_events (job_id, source, source_provider_id, event_type, field, old_value, new_value, occurred_at)
      SELECT ${sqlString(jobId)}, 'nppes', n.npi, 'raw_changed', k.key,
             json_extract_string(o.payload, '$."' || k.key || '"'),
             json_extract_string(n.payload, '$."' || k.key || '"'),
             ${sqlString(now)}
      FROM incoming_raw n
      JOIN nppes_records o ON o.npi = n.npi,
           UNNEST(json_keys(n.payload)) AS k(key)
      WHERE json_extract_string(o.payload, '$."' || k.key || '"') IS DISTINCT FROM
            json_extract_string(n.payload, '$."' || k.key || '"')
    `);

    await run(`
      INSERT OR REPLACE INTO nppes_records (npi, job_id, fetched_at, payload)
      SELECT npi, ${sqlString(jobId)}, ${sqlString(now)}, payload FROM incoming_raw
    `);

    // 3. Log changes against current nppes state. Events first, while providers is still the old state.
    await run(`UPDATE providers SET is_new = FALSE WHERE source = 'nppes' AND is_new`);

    await run(`
      INSERT INTO provider_events (job_id, source, source_provider_id, event_type, field, old_value, new_value, occurred_at)
      SELECT ${sqlString(jobId)}, 'nppes', i.source_provider_id, 'added', NULL, NULL, NULL, ${sqlString(now)}
      FROM incoming i
      WHERE NOT EXISTS (SELECT 1 FROM providers p WHERE p.source = 'nppes' AND p.source_provider_id = i.source_provider_id)
    `);
    // New records that arrive already deactivated also log a deactivation, as applyProviderRecord does.
    await run(`
      INSERT INTO provider_events (job_id, source, source_provider_id, event_type, field, old_value, new_value, occurred_at)
      SELECT ${sqlString(jobId)}, 'nppes', i.source_provider_id, 'deactivated', 'status', NULL, i.status, ${sqlString(now)}
      FROM incoming i
      WHERE i.status = 'Deactivated'
        AND NOT EXISTS (SELECT 1 FROM providers p WHERE p.source = 'nppes' AND p.source_provider_id = i.source_provider_id)
    `);

    for (const f of TRACKED_FIELDS) {
      await run(`
        INSERT INTO provider_events (job_id, source, source_provider_id, event_type, field, old_value, new_value, occurred_at)
        SELECT ${sqlString(jobId)}, 'nppes', p.source_provider_id, 'updated', ${sqlString(f)},
               CAST(p.${f} AS VARCHAR), CAST(i.${f} AS VARCHAR), ${sqlString(now)}
        FROM providers p JOIN incoming i ON i.source_provider_id = p.source_provider_id
        WHERE p.source = 'nppes' AND p.${f} IS DISTINCT FROM i.${f}
      `);
    }

    await run(`
      INSERT INTO provider_events (job_id, source, source_provider_id, event_type, field, old_value, new_value, occurred_at)
      SELECT ${sqlString(jobId)}, 'nppes', p.source_provider_id, 'deactivated', 'status', p.status, i.status, ${sqlString(now)}
      FROM providers p JOIN incoming i ON i.source_provider_id = p.source_provider_id
      WHERE p.source = 'nppes' AND p.status IS DISTINCT FROM 'Deactivated' AND i.status = 'Deactivated'
    `);
    await run(`
      INSERT INTO provider_events (job_id, source, source_provider_id, event_type, field, old_value, new_value, occurred_at)
      SELECT ${sqlString(jobId)}, 'nppes', p.source_provider_id, 'reactivated', 'status', p.status, i.status, ${sqlString(now)}
      FROM providers p JOIN incoming i ON i.source_provider_id = p.source_provider_id
      WHERE p.source = 'nppes' AND p.status = 'Deactivated' AND i.status = 'Active'
    `);

    // 4. Insert new providers.
    await run(`
      INSERT INTO providers (source, source_provider_id, npi, entity_type, provider_name, first_name, last_name, credential,
        organization_name, location_name, address_line1, address_line2, city, state, postal_code, phone,
        taxonomy_code, taxonomy_desc, status, active, last_updated, first_seen, last_seen, deactivated_at, is_new, is_deactivated)
      SELECT i.source, i.source_provider_id, i.npi, i.entity_type, i.provider_name, i.first_name, i.last_name, i.credential,
        i.organization_name, i.location_name, i.address_line1, i.address_line2, i.city, i.state, i.postal_code, i.phone,
        i.taxonomy_code, i.taxonomy_desc, i.status, i.status = 'Active', i.last_updated, ${sqlString(now)}, ${sqlString(now)},
        i.deactivated_at, TRUE, i.status = 'Deactivated'
      FROM incoming i
      WHERE NOT EXISTS (SELECT 1 FROM providers p WHERE p.source = 'nppes' AND p.source_provider_id = i.source_provider_id)
    `);

    // 5. Update existing providers. deactivated_at keeps the first value and comes from the file.
    const setCols = TRACKED_FIELDS.map((f) => `${f} = i.${f}`).join(', ');
    await run(`
      UPDATE providers SET ${setCols},
        status = i.status,
        active = (i.status = 'Active'),
        last_updated = i.last_updated,
        last_seen = ${sqlString(now)},
        deactivated_at = CASE WHEN i.status = 'Deactivated' THEN COALESCE(providers.deactivated_at, i.deactivated_at) ELSE NULL END,
        is_deactivated = (i.status = 'Deactivated')
      FROM incoming i
      WHERE providers.source = 'nppes' AND providers.source_provider_id = i.source_provider_id
    `);

    // 6. Count what this run logged, record the job, and mark the source synced.
    const counts = await all(`SELECT event_type, count(*) AS n FROM provider_events WHERE job_id = ${sqlString(jobId)} GROUP BY event_type`);
    const byType = Object.fromEntries(counts.map((c) => [c.event_type, c.n]));
    const adds = byType.added ?? 0;
    const deacts = byType.deactivated ?? 0;
    const updates = counts.filter((c) => c.event_type === 'updated').reduce((a, c) => a + c.n, 0);
    const seconds = Math.round((Date.now() - started) / 1000);
    await run(`
      INSERT INTO sync_jobs (id, timestamp, type, status, records_processed, adds_count, deactivations_count, updates_count, duration_ms, details, source)
      VALUES (${sqlString(jobId)}, ${sqlString(now)}, 'nppes_bulk', 'success', ${incomingCount}, ${adds}, ${deacts}, ${updates},
        ${seconds * 1000}, ${sqlString(`Loaded ${csvPath} (state=${stateArg}). Read ${rawCount} rows, kept ${incomingCount}. ${adds} added, ${deacts} deactivated, ${updates} field updates.`)}, 'nppes')
    `);
    await run(`UPDATE sources SET last_synced_at = ${sqlString(now)} WHERE id = 'nppes'`);

    await run('COMMIT');
    console.log(JSON.stringify({ jobId, file: csvPath, state: stateArg, rowsRead: rawCount, rowsKept: incomingCount,
      added: adds, deactivated: deacts, reactivated: byType.reactivated ?? 0, fieldUpdates: updates, seconds }, null, 2));
  } catch (err) {
    await run('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

main()
  .then(() => db.close(() => process.exit(0)))
  .catch((err) => {
    console.error('NPPES load failed; transaction rolled back:', err);
    db.close(() => process.exit(1));
  });
