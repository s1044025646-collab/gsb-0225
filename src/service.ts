import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseRobots } from "./parser.js";
import { checkPath, selectGroups } from "./matcher.js";
import { AppError, parseId } from "./validation.js";
import type { CheckResult, ParseResult } from "./types.js";

export interface CreateVersionInput {
  name: string;
  robotsText: string;
}

interface VersionRecord {
  id: number;
  name: string;
  raw_text: string;
  sitemaps_json: string;
  diagnostics_json: string;
  created_at: string;
}

function hydrate(row: VersionRecord) {
  return {
    id: row.id,
    name: row.name,
    rawText: row.raw_text,
    sitemaps: JSON.parse(row.sitemaps_json),
    diagnostics: JSON.parse(row.diagnostics_json),
    createdAt: row.created_at,
  };
}

export function createVersion(db: DatabaseSync, input: CreateVersionInput) {
  const parsed = parseRobots(input.robotsText);
  const stmt = db.prepare(
    `INSERT INTO versions (name, raw_text, sitemaps_json, diagnostics_json)
     VALUES (?, ?, ?, ?)`,
  );
  let id: number;
  try {
    const info = stmt.run(
      input.name,
      input.robotsText,
      JSON.stringify(parsed.sitemaps),
      JSON.stringify(parsed.diagnostics),
    );
    id = Number(info.lastInsertRowid);
  } catch (err) {
    const sqliteError = err as { code?: string; message?: string };
    if (
      sqliteError.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      sqliteError.message?.includes("UNIQUE constraint failed")
    ) {
      throw new AppError("VERSION_EXISTS", `同名版本已存在: ${input.name}`, 409);
    }
    throw err;
  }
  return getVersion(db, id);
}

export function listVersions(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT id, name, length(raw_text) AS text_length, created_at
       FROM versions ORDER BY id`,
    )
    .all() as Array<{
      id: number;
      name: string;
      text_length: number;
      created_at: string;
    }>;
}

export function getVersion(db: DatabaseSync, idOrName: number | string) {
  const id = typeof idOrName === "number" ? idOrName : parseId(idOrName);
  const row = db.prepare(`SELECT * FROM versions WHERE id = ?`).get(id) as
    | VersionRecord
    | undefined;
  if (!row) {
    throw new AppError("VERSION_NOT_FOUND", `版本不存在: ${id}`, 404);
  }
  return hydrate(row);
}

export function explainVersion(db: DatabaseSync, id: number, robot: string) {
  const version = getVersion(db, id);
  const parsed = parseRobots(version.rawText);
  const selected = selectGroups(parsed, robot);
  return {
    version: { id: version.id, name: version.name },
    robot,
    matchedAgentToken: selected.matchedAgentToken,
    groupLines: selected.groupLines,
    mergedGroups: selected.groupLines.length,
    rules: selected.rules.map((rule) => ({
      type: rule.type,
      pattern: rule.pattern,
      line: rule.line,
    })),
  };
}

export function runCheck(
  db: DatabaseSync,
  id: number,
  robot: string,
  paths: string[],
) {
  const version = getVersion(db, id);
  const parsed: ParseResult = parseRobots(version.rawText);
  const results: CheckResult[] = paths.map((path) =>
    checkPath(parsed, robot, path),
  );

  const batchInfo = db
    .prepare(`INSERT INTO check_batches (version_id, robot) VALUES (?, ?)`)
    .run(version.id, robot);
  const batchId = Number(batchInfo.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO check_results (batch_id, path, result_json) VALUES (?, ?, ?)`,
  );
  for (const path of paths) {
    const result = results.find((item) => item.path === path)!;
    insert.run(batchId, path, JSON.stringify(result));
  }

  return {
    batchId,
    version: { id: version.id, name: version.name },
    robot,
    checkedAt: new Date().toISOString(),
    results,
  };
}

export function getReport(db: DatabaseSync, batchId: number) {
  const batch = db
    .prepare(`SELECT * FROM check_batches WHERE id = ?`)
    .get(batchId) as
    | { id: number; version_id: number; robot: string; created_at: string }
    | undefined;
  if (!batch) {
    throw new AppError("CHECK_NOT_FOUND", `检查批次不存在: ${batchId}`, 404);
  }
  const version = getVersion(db, batch.version_id);
  const rows = db
    .prepare(
      `SELECT result_json FROM check_results WHERE batch_id = ? ORDER BY id`,
    )
    .all(batchId) as Array<{ result_json: string }>;
  return {
    batchId: batch.id,
    version: { id: version.id, name: version.name },
    robot: batch.robot,
    checkedAt: batch.created_at,
    results: rows.map((row) => JSON.parse(row.result_json) as CheckResult),
  };
}

export interface ComparisonItem {
  path: string;
  from: CheckResult;
  to: CheckResult;
  changed: boolean;
}

export function compareVersions(
  db: DatabaseSync,
  fromId: number,
  toId: number,
  robot: string,
  paths: string[],
) {
  if (fromId === toId) {
    throw new AppError("VERSION_SAME", "比较的两个版本必须不同");
  }
  const from = getVersion(db, fromId);
  const to = getVersion(db, toId);
  const parsedFrom = parseRobots(from.rawText);
  const parsedTo = parseRobots(to.rawText);

  const items: ComparisonItem[] = paths.map((path) => {
    const left = checkPath(parsedFrom, robot, path);
    const right = checkPath(parsedTo, robot, path);
    return {
      path,
      from: left,
      to: right,
      changed: left.allowed !== right.allowed,
    };
  });

  const changed = items.filter((item) => item.changed).length;
  return {
    comparisonId: randomUUID(),
    robot,
    fromVersion: { id: from.id, name: from.name },
    toVersion: { id: to.id, name: to.name },
    comparedAt: new Date().toISOString(),
    summary: {
      total: items.length,
      changed,
      unchanged: items.length - changed,
    },
    items,
  };
}
