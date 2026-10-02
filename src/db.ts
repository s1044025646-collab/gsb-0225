import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let dbInstance: DatabaseSync | null = null;

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      raw_text TEXT NOT NULL,
      sitemaps_json TEXT NOT NULL DEFAULT '[]',
      diagnostics_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS check_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL REFERENCES versions(id),
      robot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS check_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES check_batches(id),
      path TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
  `);
  return db;
}

export function getDb(dbPath: string): DatabaseSync {
  if (dbInstance === null) {
    dbInstance = openDb(dbPath);
  }
  return dbInstance;
}

export interface VersionRow {
  id: number;
  name: string;
  raw_text: string;
  sitemaps_json: string;
  diagnostics_json: string;
  created_at: string;
}

export interface BatchRow {
  id: number;
  version_id: number;
  robot: string;
  created_at: string;
}
