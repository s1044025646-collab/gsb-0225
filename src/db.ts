import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VersionRow } from './types.js';
import { AppError } from './types.js';

/**
 * SQLite 持久层：规则原文、版本、检查记录、比较报告。
 * 数据文件位于项目内 data/ 目录。
 */

export interface CheckRecordRow {
  id: number;
  version_id: number;
  batch_id: string;
  robot: string;
  path: string;
  allowed: number;
  decision_json: string;
  created_at: string;
}

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS check_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL REFERENCES versions(id),
      batch_id TEXT NOT NULL,
      robot TEXT NOT NULL,
      path TEXT NOT NULL,
      allowed INTEGER NOT NULL,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_checks_batch ON check_records(batch_id);
    CREATE INDEX IF NOT EXISTS idx_checks_version ON check_records(version_id);
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      version_a_id INTEGER NOT NULL REFERENCES versions(id),
      version_b_id INTEGER NOT NULL REFERENCES versions(id),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function createVersion(
  db: DatabaseSync,
  name: string,
  content: string,
): VersionRow {
  const existing = db
    .prepare('SELECT id FROM versions WHERE name = ?')
    .get(name) as { id: number } | undefined;
  if (existing) {
    // 坏输入或重名绝不能覆盖已有版本
    throw new AppError(
      'VERSION_EXISTS',
      `版本名称「${name}」已存在，版本不可覆盖；请使用新名称`,
    );
  }
  const info = db
    .prepare('INSERT INTO versions (name, content) VALUES (?, ?)')
    .run(name, content);
  return getVersion(db, Number(info.lastInsertRowid))!;
}

export function getVersion(
  db: DatabaseSync,
  id: number,
): VersionRow | null {
  const row = db
    .prepare('SELECT id, name, content, created_at FROM versions WHERE id = ?')
    .get(id) as VersionRow | undefined;
  return row ?? null;
}

export function findVersion(
  db: DatabaseSync,
  idOrName: string,
): VersionRow | null {
  if (/^\d+$/.test(idOrName)) {
    const byId = getVersion(db, Number(idOrName));
    if (byId) return byId;
  }
  const row = db
    .prepare('SELECT id, name, content, created_at FROM versions WHERE name = ?')
    .get(idOrName) as VersionRow | undefined;
  return row ?? null;
}

export function listVersions(db: DatabaseSync): VersionRow[] {
  return db
    .prepare('SELECT id, name, content, created_at FROM versions ORDER BY id')
    .all() as unknown as VersionRow[];
}

export function requireVersion(
  db: DatabaseSync,
  idOrName: string,
): VersionRow {
  const version = findVersion(db, idOrName);
  if (!version) {
    throw new AppError(
      'VERSION_NOT_FOUND',
      `版本「${idOrName}」不存在`,
    );
  }
  return version;
}

export function saveCheckBatch(
  db: DatabaseSync,
  versionId: number,
  batchId: string,
  decisions: Array<{
    robot: string;
    path: string;
    allowed: boolean;
    decision: unknown;
  }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO check_records
       (version_id, batch_id, robot, path, allowed, decision_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const item of decisions) {
    stmt.run(
      versionId,
      batchId,
      item.robot,
      item.path,
      item.allowed ? 1 : 0,
      JSON.stringify(item.decision),
    );
  }
}

export function listBatchIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT batch_id AS batch_id FROM check_records
       ORDER BY batch_id DESC`,
    )
    .all() as Array<{ batch_id: string }>;
  return rows.map((row) => row.batch_id);
}

export function getBatch(
  db: DatabaseSync,
  batchId: string,
): CheckRecordRow[] {
  return db
    .prepare('SELECT * FROM check_records WHERE batch_id = ? ORDER BY id')
    .all(batchId) as unknown as CheckRecordRow[];
}

export function saveReport(
  db: DatabaseSync,
  kind: string,
  versionAId: number,
  versionBId: number,
  payload: unknown,
): number {
  const info = db
    .prepare(
      `INSERT INTO reports (kind, version_a_id, version_b_id, payload_json)
       VALUES (?, ?, ?, ?)`,
    )
    .run(kind, versionAId, versionBId, JSON.stringify(payload));
  return Number(info.lastInsertRowid);
}

export function getReport(
  db: DatabaseSync,
  id: number,
): { id: number; payload_json: string; created_at: string } | null {
  const row = db
    .prepare('SELECT id, payload_json, created_at FROM reports WHERE id = ?')
    .get(id) as
    | { id: number; payload_json: string; created_at: string }
    | undefined;
  return row ?? null;
}
