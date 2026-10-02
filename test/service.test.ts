import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../dist/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { compareVersions, runBatch } from '../dist/service.js';
import { createVersion, getBatch, getVersion } from '../dist/db.js';
import { AppError } from '../dist/types.js';

const v1 = `User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.json$
`;

const v2 = `User-agent: *
Disallow: /private
Disallow: /tmp
`;

const items = [
  { robot: 'bot', path: '/private/secret' },
  { robot: 'bot', path: '/private/public/a' },
  { robot: 'bot', path: '/data/list.json' },
];

let dir: string;
let dbFile: string;
let db: DatabaseSync;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'robots-lab-'));
  dbFile = join(dir, 'test.db');
  db = openDatabase(dbFile);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('重名版本不能覆盖已有版本', () => {
  const first = createVersion(db, 'rules-v1', v1);
  assert.ok(first.id > 0);
  assert.throws(
    () => createVersion(db, 'rules-v1', v2),
    (error: unknown) => error instanceof AppError && error.code === 'VERSION_EXISTS',
  );
  assert.equal(getVersion(db, first.id)!.content, v1);
});

test('批量检查落库并可按 batchId 复查', () => {
  const version = createVersion(db, 'rules-v1-b', v1);
  const output = runBatch(db, version.id, v1, items, true);
  assert.equal(output.results.length, 3);
  const rows = getBatch(db, output.batchId);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.allowed, 0);
  assert.equal(rows[1]!.allowed, 1);
  assert.equal(rows[2]!.allowed, 0);
});

test('跨版本比较能识别变化并保存报告', () => {
  const a = createVersion(db, 'cmp-a', v1);
  const b = createVersion(db, 'cmp-b', v2);
  const result = compareVersions(db, String(a.id), String(b.id), items);
  // /private/public/a: v1 允许 -> v2 禁止
  // /data/list.json: v1 禁止 -> v2 允许
  assert.equal(result.changedCount, 2);
  assert.ok(result.reportId > 0);
  const changedPaths = result.changes
    .filter((entry) => entry.changed)
    .map((entry) => entry.path);
  assert.deepEqual(changedPaths.sort(), ['/data/list.json', '/private/public/a']);
});

test('重启后（重新打开同一数据文件）旧批次与版本仍可复查', () => {
  const version = createVersion(db, 'persist-v', v1);
  const output = runBatch(db, version.id, v1, items, true);
  // 模拟进程重启：用全新连接重新打开同一个数据文件
  const reopened = openDatabase(dbFile);
  const rows = getBatch(reopened, output.batchId);
  assert.equal(rows.length, 3);
  const restored = getVersion(reopened, version.id);
  assert.equal(restored?.content, v1);
  assert.ok(existsSync(dbFile));
  assert.ok(readFileSync(dbFile).length > 0);
  reopened.close();
});

test('比较两个相同版本报错', () => {
  const version = createVersion(db, 'same-x', v1);
  assert.throws(
    () => compareVersions(db, String(version.id), String(version.id), items),
    (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
  );
});

