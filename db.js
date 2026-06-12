import sqlite3 from 'sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_FILE || join(__dirname, 'queue.db');

// Connect to SQLite database
const dbRaw = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err.message);
  } else {
    console.log('Connected to the SQLite database at:', dbPath);
  }
});

// Helper wrappers for Promisified SQLite operations
export const db = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbRaw.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbRaw.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbRaw.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },
  // Execute a set of operations inside a transaction
  async transaction(callback) {
    await this.run('BEGIN TRANSACTION');
    try {
      const result = await callback();
      await this.run('COMMIT');
      return result;
    } catch (err) {
      await this.run('ROLLBACK');
      throw err;
    }
  }
};

// Initialize schema
export async function initDatabase() {
  // Enable Write-Ahead Logging (WAL) mode for concurrency
  try {
    await db.run('PRAGMA journal_mode=WAL');
    console.log('Database WAL mode enabled');
  } catch (err) {
    console.error('Failed to set WAL mode:', err.message);
  }

  // Create settings table
  await db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      average_consultation_time INTEGER NOT NULL DEFAULT 5
    )
  `);

  // Create patients table
  await db.run(`
    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_number INTEGER NOT NULL,
      patient_name TEXT NOT NULL,
      phone_number TEXT,
      status TEXT NOT NULL CHECK(status IN ('WAITING', 'IN_CONSULTATION', 'COMPLETED', 'SKIPPED')),
      consultation_start DATETIME,
      consultation_end DATETIME,
      consultation_duration INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Run migrations safely for existing databases
  try {
    await db.run(`ALTER TABLE patients ADD COLUMN consultation_start DATETIME`);
    console.log('Migration: Added consultation_start column');
  } catch (e) {
    // Column already exists, ignore
  }

  try {
    await db.run(`ALTER TABLE patients ADD COLUMN consultation_end DATETIME`);
    console.log('Migration: Added consultation_end column');
  } catch (e) {
    // Column already exists, ignore
  }

  try {
    await db.run(`ALTER TABLE patients ADD COLUMN consultation_duration INTEGER`);
    console.log('Migration: Added consultation_duration column');
  } catch (e) {
    // Column already exists, ignore
  }

  // Create indexes for performance on larger datasets
  await db.run(`CREATE INDEX IF NOT EXISTS idx_patients_status ON patients(status)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_patients_created_at ON patients(created_at)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_patients_consult_end ON patients(consultation_end)`);

  // Insert default settings if empty
  const settingsCount = await db.get(`SELECT COUNT(*) as count FROM settings`);
  if (settingsCount.count === 0) {
    await db.run(`INSERT INTO settings (id, average_consultation_time) VALUES (1, 5)`);
    console.log('Inserted default average consultation time (5 minutes).');
  }
}

// Generate the next token number, resetting to 1 if it's a new day
export async function generateNextToken() {
  const row = await db.get(`
    SELECT MAX(token_number) as max_token 
    FROM patients 
    WHERE date(created_at, 'localtime') = date('now', 'localtime')
  `);
  return (row && row.max_token ? row.max_token : 0) + 1;
}
