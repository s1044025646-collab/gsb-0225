import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import {
  compareVersions,
  createVersion,
  explainVersion,
  getReport,
  getVersion,
  listVersions,
  runCheck,
} from "./service.js";
import {
  AppError,
  parseId,
  validateName,
  validatePath,
  validateRobot,
  validateRobotsText,
} from "./validation.js";

interface ParsedRequest {
  pathname: string;
  query: URLSearchParams;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 200_000) {
        reject(new AppError("BAD_JSON", "请求体过大（上限 200KB）", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("BAD_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError("BAD_JSON", "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function requirePaths(value: unknown, max = 100): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new AppError("INVALID_BATCH", `paths 必须是 1..${max} 个元素的数组`);
  }
  return value.map((item) => validatePath(item));
}

export function createApp(db: DatabaseSync): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route: ParsedRequest = { pathname: url.pathname, query: url.searchParams };

      if (req.method === "GET" && route.pathname === "/health") {
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && route.pathname === "/api/versions") {
        const body = requireObject(await readJson(req));
        const version = createVersion(db, {
          name: validateName(body.name),
          robotsText: validateRobotsText(body.robotsText),
        });
        send(res, 201, version);
        return;
      }

      if (req.method === "GET" && route.pathname === "/api/versions") {
        send(res, 200, { versions: listVersions(db) });
        return;
      }

      const versionMatch = /^\/api\/versions\/(\d+)$/.exec(route.pathname);
      if (versionMatch && req.method === "GET") {
        send(res, 200, getVersion(db, parseId(versionMatch[1])));
        return;
      }

      const explainMatch = /^\/api\/versions\/(\d+)\/explain$/.exec(route.pathname);
      if (explainMatch && req.method === "POST") {
        const body = requireObject(await readJson(req));
        send(
          res,
          200,
          explainVersion(db, parseId(explainMatch[1]), validateRobot(body.robot)),
        );
        return;
      }

      const checkMatch = /^\/api\/versions\/(\d+)\/check$/.exec(route.pathname);
      if (checkMatch && req.method === "POST") {
        const body = requireObject(await readJson(req));
        const robot = validateRobot(body.robot);
        const paths = requirePaths(body.paths);
        send(res, 200, runCheck(db, parseId(checkMatch[1]), robot, paths));
        return;
      }

      const reportMatch = /^\/api\/reports\/(\d+)$/.exec(route.pathname);
      if (reportMatch && req.method === "GET") {
        send(res, 200, getReport(db, parseId(reportMatch[1])));
        return;
      }

      if (req.method === "POST" && route.pathname === "/api/compare") {
        const body = requireObject(await readJson(req));
        send(
          res,
          200,
          compareVersions(
            db,
            parseId(body.fromVersionId),
            parseId(body.toVersionId),
            validateRobot(body.robot),
            requirePaths(body.paths),
          ),
        );
        return;
      }

      send(res, 404, { code: "NOT_FOUND", message: "路由不存在" });
    } catch (err) {
      if (err instanceof AppError) {
        send(res, err.status, { code: err.code, message: err.message });
        return;
      }
      send(res, 500, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message,
      });
    }
  });
  return server;
}

/** 端口 0 表示让操作系统分配空闲端口。 */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
