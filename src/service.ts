import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  getReport,
  requireVersion,
  saveCheckBatch,
  saveReport,
} from './db.js';
import { decide } from './matcher.js';
import { parseRobots } from './parser.js';
import { AppError } from './types.js';
import type { CheckItem, Decision, ParseResult } from './types.js';
import { validatePath, validateRobot } from './matcher.js';

/** 应用服务层：解析、校验、单条/批量检查、版本比较、报告存取。 */

export interface CheckOutput {
  decision: Decision;
}

export interface BatchOutput {
  batchId: string;
  versionId: number;
  results: Decision[];
}

export interface DiffEntry {
  robot: string;
  path: string;
  allowedA: boolean;
  allowedB: boolean;
  changed: boolean;
  decisionA: Decision;
  decisionB: Decision;
}

export interface CompareOutput {
  reportId: number;
  versionA: { id: number; name: string };
  versionB: { id: number; name: string };
  total: number;
  changedCount: number;
  changes: DiffEntry[];
}

export function validateItem(item: unknown): CheckItem {
  if (typeof item !== 'object' || item === null) {
    throw new AppError('VALIDATION_ERROR', '每条检查项必须是对象', item);
  }
  const record = item as Record<string, unknown>;
  const robot = record.robot;
  const path = record.path;
  if (typeof robot !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'robot 必须是字符串');
  }
  if (typeof path !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'path 必须是字符串');
  }
  const robotError = validateRobot(robot);
  if (robotError) throw new AppError('VALIDATION_ERROR', robotError);
  const pathError = validatePath(path);
  if (pathError) throw new AppError('VALIDATION_ERROR', pathError);
  return { robot, path };
}

export function validateVersionName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', '版本名称 name 必须是非空字符串');
  }
  if (name.length > 100) {
    throw new AppError('VALIDATION_ERROR', '版本名称上限 100 字符');
  }
  if (/[\\/]/.test(name)) {
    throw new AppError('VALIDATION_ERROR', '版本名称不得包含路径分隔符');
  }
  return name.trim();
}

export function validateContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'content 必须是 robots.txt 文本字符串');
  }
  if (content.length > 1_000_000) {
    throw new AppError('VALIDATION_ERROR', 'robots.txt 文本上限 1,000,000 字符');
  }
  return content;
}

export function checkText(
  content: string,
  robot: string,
  path: string,
): { parsed: ParseResult; decision: Decision } {
  const parsed = parseRobots(content);
  const decision = decide(robot, path, parsed);
  return { parsed, decision };
}

export function runBatch(
  db: DatabaseSync,
  versionId: number,
  content: string,
  items: CheckItem[],
  persist: boolean,
): BatchOutput {
  const parsed = parseRobots(content);
  const results = items.map((item) => decide(item.robot, item.path, parsed));
  const batchId = randomUUID();
  if (persist) {
    saveCheckBatch(
      db,
      versionId,
      batchId,
      results.map((decision) => ({
        robot: decision.robot,
        path: decision.path,
        allowed: decision.allowed,
        decision,
      })),
    );
  }
  return { batchId: persist ? batchId : '', versionId, results };
}

export function compareVersions(
  db: DatabaseSync,
  aRef: string,
  bRef: string,
  items: CheckItem[],
): CompareOutput {
  const versionA = requireVersion(db, aRef);
  const versionB = requireVersion(db, bRef);
  if (versionA.id === versionB.id) {
    throw new AppError('VALIDATION_ERROR', '比较的两个版本必须不同');
  }
  const parsedA = parseRobots(versionA.content);
  const parsedB = parseRobots(versionB.content);

  const changes: DiffEntry[] = items.map((item) => {
    const decisionA = decide(item.robot, item.path, parsedA);
    const decisionB = decide(item.robot, item.path, parsedB);
    return {
      robot: item.robot,
      path: item.path,
      allowedA: decisionA.allowed,
      allowedB: decisionB.allowed,
      changed: decisionA.allowed !== decisionB.allowed,
      decisionA,
      decisionB,
    };
  });

  const changed = changes.filter((entry) => entry.changed);
  const payload = {
    versionA: { id: versionA.id, name: versionA.name },
    versionB: { id: versionB.id, name: versionB.name },
    total: changes.length,
    changedCount: changed.length,
    changes,
  };
  const reportId = saveReport(
    db,
    'compare',
    versionA.id,
    versionB.id,
    payload,
  );

  return { reportId, ...payload };
}

export function loadReport(db: DatabaseSync, id: number): unknown {
  const row = getReport(db, id);
  if (!row) {
    throw new AppError('REPORT_NOT_FOUND', `报告 #${id} 不存在`);
  }
  return JSON.parse(row.payload_json) as unknown;
}
