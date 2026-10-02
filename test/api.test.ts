import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../dist/db.js';
import { createApp, listen } from '../dist/server.js';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

let server: Server;
let db: DatabaseSync;
let base: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'robots-api-'));
  db = openDatabase(join(dir, 'api.db'));
  server = createApp(db);
  const port = await listen(server, undefined);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

test('健康检查', async () => {
  const { status, json } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
});

test('即时检查：禁止目录与允许子路径', async () => {
  const content = 'User-agent: *\nDisallow: /p\nAllow: /p/a\n';
  const denied = await call('/api/check', {
    method: 'POST',
    body: { content, robot: 'bot', path: '/p/x' },
  });
  assert.equal(denied.json.allowed, false);
  const allowed = await call('/api/check', {
    method: 'POST',
    body: { content, robot: 'bot', path: '/p/a/x' },
  });
  assert.equal(allowed.json.allowed, true);
});

test('版本导入、重复冲突、批量检查与比较全流程', async () => {
  const v1 = 'User-agent: *\nDisallow: /x\n';
  const v2 = 'User-agent: *\nDisallow: /y\n';
  const first = await call('/api/versions', {
    method: 'POST',
    body: { name: 'api-v1', content: v1 },
  });
  assert.equal(first.status, 200);
  const dup = await call('/api/versions', {
    method: 'POST',
    body: { name: 'api-v1', content: v2 },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'VERSION_EXISTS');

  await call('/api/versions', {
    method: 'POST',
    body: { name: 'api-v2', content: v2 },
  });

  const batch = await call('/api/versions/api-v1/batch', {
    method: 'POST',
    body: {
      items: [
        { robot: 'bot', path: '/x/1' },
        { robot: 'bot', path: '/y/1' },
      ],
    },
  });
  assert.equal(batch.json.results?.[0]?.allowed, false);
  assert.equal(batch.json.results?.[1]?.allowed, true);

  const compare = await call('/api/compare', {
    method: 'POST',
    body: {
      versionA: 'api-v1',
      versionB: 'api-v2',
      items: [
        { robot: 'bot', path: '/x/1' },
        { robot: 'bot', path: '/y/1' },
      ],
    },
  });
  assert.equal(compare.status, 200);
  assert.equal(compare.json.changedCount, 2);

  const report = await call(`/api/reports/${compare.json.reportId as number}`);
  assert.equal(report.status, 200);
  assert.equal(report.json.changedCount, 2);
});

test('参数校验返回明确错误码', async () => {
  const badPath = await call('/api/check', {
    method: 'POST',
    body: { content: '', robot: 'bot', path: 'relative' },
  });
  assert.equal(badPath.status, 400);
  assert.equal(badPath.json.code, 'VALIDATION_ERROR');

  const missing = await call('/api/versions/999/check', {
    method: 'POST',
    body: { robot: 'bot', path: '/x' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'VERSION_NOT_FOUND');

  const badJson = await fetch(`${base}/api/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const body = (await badJson.json()) as Record<string, unknown>;
  assert.equal(badJson.status, 400);
  assert.equal(body.code, 'BAD_JSON');
});

test('不存在的路由与错误方法', async () => {
  assert.equal((await call('/nope')).status, 404);
  const res = await fetch(`${base}/api/health`, { method: 'POST' });
  assert.equal(res.status, 405);
});

