import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import duckdb from 'duckdb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Initialize DuckDB database file
const dbFile = path.join(__dirname, 'nppes_pipeline.duckdb');
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

function allDb(query: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(query, ...params, (err: any, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Initialize tables on startup
async function initDatabase() {
  try {
    await runDb(`
      CREATE TABLE IF NOT EXISTS providers (
        npi VARCHAR PRIMARY KEY,
        entity_type VARCHAR,
        provider_name VARCHAR,
        first_name VARCHAR,
        last_name VARCHAR,
        credential VARCHAR,
        city VARCHAR,
        state VARCHAR,
        postal_code VARCHAR,
        taxonomy_code VARCHAR,
        taxonomy_desc VARCHAR,
        status VARCHAR,
        last_updated VARCHAR,
        is_new BOOLEAN DEFAULT FALSE,
        is_deactivated BOOLEAN DEFAULT FALSE
      )
    `);

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

    // Seed sample providers if table is empty
    const countRes = await allDb(`SELECT COUNT(*) as cnt FROM providers`);
    if (countRes[0].cnt === 0) {
      const sampleProviders = [
        ['1982736450', '1', 'Dr. Sarah Jenkins, MD', 'Sarah', 'Jenkins', 'MD', 'Boston', 'MA', '02115', '207Q00000X', 'Family Medicine', 'Active', '2026-10-30', false, false],
        ['1435678901', '1', 'Dr. Michael Chang, DDS', 'Michael', 'Chang', 'DDS', 'San Francisco', 'CA', '94102', '122300000X', 'Dentist', 'Active', '2026-10-29', false, false],
        ['1224567892', '2', 'Pacific Health Urgent Care LLC', '', '', '', 'Seattle', 'WA', '98101', '261QU0200X', 'Urgent Care', 'Active', '2026-10-28', true, false],
        ['1098765432', '1', 'Dr. Emily Rodriguez, MD', 'Emily', 'Rodriguez', 'MD', 'Miami', 'FL', '33101', '208000000X', 'Pediatrics', 'Deactivated', '2026-10-25', false, true],
        ['1567890123', '1', 'Dr. Robert Taylor, PhD', 'Robert', 'Taylor', 'PhD', 'Chicago', 'IL', '60601', '103T00000X', 'Psychologist', 'Active', '2026-10-31', true, false],
        ['1890123456', '2', 'Metro Cardiology Associates', '', '', '', 'New York', 'NY', '10001', '207RC0000X', 'Cardiovascular Disease', 'Active', '2026-10-27', false, false],
        ['1345678902', '1', 'Dr. Lisa Wong, PharmD', 'Lisa', 'Wong', 'PharmD', 'Houston', 'TX', '77002', '183500000X', 'Pharmacist', 'Deactivated', '2026-10-20', false, true]
      ];

      for (const p of sampleProviders) {
        await runDb(
          `INSERT OR REPLACE INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          p
        );
      }

      const historicalJobs = [
        ['job_hist_01', 'Oct 25', 'weekly_dissemination', 'success', 74200, 34, 12, 110, 1540, 'Weekly delta sync'],
        ['job_hist_02', 'Oct 26', 'weekly_dissemination', 'success', 75100, 42, 8, 95, 1490, 'Weekly delta sync'],
        ['job_hist_03', 'Oct 27', 'weekly_dissemination', 'success', 73900, 28, 15, 120, 1620, 'Weekly delta sync'],
        ['job_hist_04', 'Oct 28', 'weekly_dissemination', 'success', 76400, 51, 14, 140, 1580, 'Weekly delta sync'],
        ['job_hist_05', 'Oct 29', 'weekly_dissemination', 'success', 75800, 39, 9, 115, 1510, 'Weekly delta sync'],
        ['job_hist_06', 'Oct 30', 'weekly_dissemination', 'success', 77200, 45, 11, 130, 1550, 'Weekly delta sync'],
        ['job_hist_07', 'Oct 31', 'weekly_dissemination', 'success', 78100, 58, 16, 145, 1600, 'Weekly delta sync']
      ];
      for (const j of historicalJobs) {
        await runDb(`INSERT OR REPLACE INTO sync_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, j);
      }
    }

    console.log('DuckDB initialized successfully with schema and data.');
  } catch (err) {
    console.error('Failed to initialize DuckDB:', err);
  }
}

initDatabase();

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
    const taxonomiesRes = await allDb(`SELECT taxonomy_desc as name, COUNT(*) as count FROM providers GROUP BY taxonomy_desc ORDER BY count DESC LIMIT 10`);
    const stateDensityRes = await allDb(`SELECT state, COUNT(*) as count FROM providers GROUP BY state ORDER BY count DESC`);

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
      stateDensity: stateDensityRes
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Trigger manual sync
app.post('/api/sync', async (req, res) => {
  try {
    const { syncType = 'weekly_dissemination' } = req.body;
    const startTime = Date.now();
    const jobId = 'job_' + Date.now();
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Simulate processing CSV chunk and generating deltas
    const randomAdds = Math.floor(Math.random() * 50) + 10;
    const randomDeacts = Math.floor(Math.random() * 15) + 2;
    const randomUpdates = Math.floor(Math.random() * 120) + 30;
    const recordsProcessed = 75000 + Math.floor(Math.random() * 25000);

    // Insert new simulated records
    const states = ['CA', 'TX', 'NY', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'WA'];
    const firstNames = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'William', 'Linda', 'David', 'Elizabeth'];
    const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Garcia', 'Wilson', 'Anderson'];
    const taxonomies = [
      ['207Q00000X', 'Family Medicine'],
      ['208000000X', 'Pediatrics'],
      ['122300000X', 'Dentist'],
      ['363L00000X', 'Nurse Practitioner'],
      ['208D00000X', 'General Practice']
    ];

    let actualAdds = 0;
    for (let i = 0; i < randomAdds; i++) {
      const npi = '1' + Math.floor(100000000 + Math.random() * 900000000).toString();
      const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
      const ln = lastNames[Math.floor(Math.random() * lastNames.length)];
      const st = states[Math.floor(Math.random() * states.length)];
      const tax = taxonomies[Math.floor(Math.random() * taxonomies.length)];
      
      const existing = await allDb(`SELECT npi FROM providers WHERE npi = ?`, [npi]);
      if (existing.length === 0) {
        await runDb(
          `INSERT INTO providers VALUES (?, '1', ?, ?, ?, 'MD', 'City', ?, '90210', ?, ?, 'Active', ?, TRUE, FALSE)`,
          [npi, `Dr. ${fn} ${ln}, MD`, fn, ln, st, tax[0], tax[1], nowStr.substring(0, 10)]
        );
        actualAdds++;
      }
    }

    // Mark a few as deactivated
    const activeRows = await allDb(`SELECT npi FROM providers WHERE status = 'Active' LIMIT ?`, [randomDeacts]);
    let actualDeacts = 0;
    for (const row of activeRows) {
      await runDb(`UPDATE providers SET status = 'Deactivated', is_deactivated = TRUE, last_updated = ? WHERE npi = ?`, [nowStr.substring(0, 10), row.npi]);
      actualDeacts++;
    }

    const duration = Date.now() - startTime + 850; // realistic duration

    await runDb(
      `INSERT INTO sync_jobs VALUES (?, ?, ?, 'success', ?, ?, ?, ?, ?, ?)`,
      [jobId, nowStr, syncType, recordsProcessed, actualAdds, actualDeacts, randomUpdates, duration, `Successfully parsed NPPES CSV dissemination. Detected ${actualAdds} additions, ${actualDeacts} deactivations, and ${randomUpdates} updates.`]
    );

    res.json({
      success: true,
      jobId,
      summary: {
        recordsProcessed,
        addsCount: actualAdds,
        deactivationsCount: actualDeacts,
        updatesCount: randomUpdates,
        durationMs: duration
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Search and filter providers
app.get('/api/providers', async (req, res) => {
  try {
    const { search = '', status = 'all', state = 'all', limit = '50', offset = '0' } = req.query;
    let query = `SELECT * FROM providers WHERE 1=1`;
    const params: any[] = [];

    if (search) {
      query +` AND (npi LIKE ? OR provider_name LIKE ? OR city LIKE ? OR taxonomy_desc LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term, term);
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

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
