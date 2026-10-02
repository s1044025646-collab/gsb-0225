import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.js";
import {
  compareVersions,
  createVersion,
  getReport,
  runCheck,
} from "../src/service.js";
import { createApp, listen } from "../src/server.js";
import type { Server } from "node:http";

const V1 = `
User-agent: *
Disallow: /tmp
Disallow: /private/
`;

const V2 = `
User-agent: *
Disallow: /private/
Disallow: /*?print=1$
`;

describe("SQLite 持久化、版本比较与 API", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "robots-lab-"));
    dbPath = join(dir, "test.sqlite");
    db = openDb(dbPath);
    server = createApp(db);
    const port = await listen(server, 0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("坏输入不会覆盖已有版本（同名插入冲突报错）", () => {
    const created = createVersion(db, { name: "v1", robotsText: V1 });
    assert.throws(
      () => createVersion(db, { name: "v1", robotsText: V2 }),
      (err: { code?: string }) => err.code === "VERSION_EXISTS",
    );
    const again = createVersion(db, { name: "v2", robotsText: V2 });
    assert.ok(again.id !== created.id);
  });

  it("跨版本结论发生变化", () => {
    const v1 = createVersion(db, { name: "cmp-1", robotsText: V1 });
    const v2 = createVersion(db, { name: "cmp-2", robotsText: V2 });
    const diff = compareVersions(db, v1.id, v2.id, "freshbot", [
      "/tmp",
      "/page?print=1",
      "/private/x",
    ]);
    assert.equal(diff.summary.changed, 2);
    const tmp = diff.items.find((i) => i.path === "/tmp")!;
    assert.equal(tmp.from.allowed, false);
    assert.equal(tmp.to.allowed, true);
  });

  it("重新打开数据库（模拟重启）后可复查旧报告", () => {
    const v1 = createVersion(db, { name: "restart-1", robotsText: V1 });
    const checked = runCheck(db, v1.id, "freshbot", ["/tmp", "/ok"]);

    const reopened = openDb(dbPath);
    const report = getReport(reopened, checked.batchId);
    assert.equal(report.results.length, 2);
    assert.equal(report.results[0].allowed, false);
    assert.equal(report.results[1].defaultAllow, true);
    reopened.close();
  });

  it("HTTP 端到端：导入、检查、报告、错误码", async () => {
    const createRes = await fetch(`${baseUrl}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "api-v1", robotsText: V1 }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { id: number };

    const checkRes = await fetch(`${baseUrl}/api/versions/${created.id}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ robot: "freshbot", paths: ["/tmp/x", "/pub"] }),
    });
    assert.equal(checkRes.status, 200);
    const checked = (await checkRes.json()) as {
      batchId: number;
      results: Array<{ allowed: boolean }>;
    };
    assert.deepEqual(checked.results.map((r) => r.allowed), [false, true]);

    const reportRes = await fetch(`${baseUrl}/api/reports/${checked.batchId}`);
    assert.equal(reportRes.status, 200);

    const badRes = await fetch(`${baseUrl}/api/versions/${created.id}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ robot: "freshbot", paths: ["relative/no-slash"] }),
    });
    assert.equal(badRes.status, 400);
    const bad = (await badRes.json()) as { code: string };
    assert.equal(bad.code, "INVALID_PATH");

    const missing = await fetch(`${baseUrl}/api/versions/99999`, {
      method: "GET",
    });
    assert.equal(missing.status, 404);
  });
});
