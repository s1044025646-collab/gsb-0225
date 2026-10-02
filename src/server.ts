import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  createVersion,
  getBatch,
  listBatchIds,
  listVersions,
  requireVersion,
} from './db.js';
import { decide } from './matcher.js';
import { parseRobots } from './parser.js';
import {
  checkText,
  compareVersions,
  loadReport,
  runBatch,
  validateContent,
  validateItem,
  validateVersionName,
} from './service.js';
import { AppError } from './types.js';
import type { ApiError, ErrorCode } from './types.js';

/** 纯后端 HTTP API（JSON over HTTP），不提供任何页面。 */

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    db: DatabaseSync,
    match: RegExpExecArray,
    body: unknown,
    query: URLSearchParams,
  ) => unknown;
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: () => ({ status: 'ok', scope: 'robots-txt-local-lab' }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/parse$/,
    handler: (_db, _match, body) => {
      const content = validateContent((body as { content?: unknown })?.content);
      return summarizeParse(parseRobots(content));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/check$/,
    handler: (_db, _match, body) => {
      const record = body as { content?: unknown; robot?: unknown; path?: unknown };
      const content = validateContent(record.content);
      const item = validateItem({ robot: record.robot, path: record.path });
      return checkText(content, item.robot, item.path).decision;
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/versions$/,
    handler: (db, _match, body) => {
      const record = body as { name?: unknown; content?: unknown };
      const name = validateVersionName(record.name);
      const content = validateContent(record.content);
      // 先解析验证，再落库；解析抛错不会触碰已有数据
      const parsed = summarizeParse(parseRobots(content));
      const version = createVersion(db, name, content);
      return { version, parse: parsed };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/versions$/,
    handler: (db) => ({ versions: listVersions(db).map(stripContent) }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/versions\/([^/]+)$/,
    handler: (db, match) => {
      const version = requireVersion(db, decodeURIComponent(match[1]!));
      return {
        version: stripContent(version),
        parse: summarizeParse(parseRobots(version.content)),
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/versions\/([^/]+)\/check$/,
    handler: (db, match, body) => {
      const version = requireVersion(db, decodeURIComponent(match[1]!));
      const record = body as { robot?: unknown; path?: unknown };
      const item = validateItem({ robot: record.robot, path: record.path });
      return {
        version: stripContent(version),
        decision: decide(item.robot, item.path, parseRobots(version.content)),
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/versions\/([^/]+)\/batch$/,
    handler: (db, match, body) => {
      const version = requireVersion(db, decodeURIComponent(match[1]!));
      const items = validateItems((body as { items?: unknown })?.items);
      const persist = (body as { persist?: unknown }).persist !== false;
      const output = runBatch(db, version.id, version.content, items, persist);
      return { ...output, version: stripContent(version) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/compare$/,
    handler: (db, _match, body) => {
      const record = body as {
        versionA?: unknown;
        versionB?: unknown;
        items?: unknown;
      };
      if (typeof record.versionA !== 'string' || typeof record.versionB !== 'string') {
        throw new AppError(
          'VALIDATION_ERROR',
          'versionA 与 versionB 必须是版本 id 或名称字符串',
        );
      }
      const items = validateItems(record.items);
      return compareVersions(db, record.versionA, record.versionB, items);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/(\d+)$/,
    handler: (db, match) => loadReport(db, Number(match[1])),
  },
  {
    method: 'GET',
    pattern: /^\/api\/checks$/,
    handler: (db, _match, _body, query) => {
      const batchId = query.get('batchId');
      if (batchId) {
        return {
          batchId,
          records: getBatch(db, batchId).map((row) => ({
            ...row,
            allowed: row.allowed === 1,
            decision: JSON.parse(row.decision_json),
            decision_json: undefined,
          })),
        };
      }
      return { batchIds: listBatchIds(db) };
    },
  },
];

function stripContent(version: {
  id: number;
  name: string;
  content: string;
  created_at: string;
}) {
  return {
    id: version.id,
    name: version.name,
    created_at: version.created_at,
    length: version.content.length,
  };
}

function validateItems(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'items 必须是非空数组');
  }
  if (raw.length > 500) {
    throw new AppError('VALIDATION_ERROR', '单批最多 500 条路径');
  }
  return raw.map((item) => validateItem(item));
}

function summarizeParse(parsed: ReturnType<typeof parseRobots>) {
  return {
    groups: parsed.groups.map((group) => ({
      name: group.name,
      lines: group.lines,
      ruleCount: group.rules.length,
      rules: group.rules.map((rule) => ({
        kind: rule.kind,
        pattern: rule.pattern,
        line: rule.line,
        ...(rule.allowAll ? { allowAll: true } : {}),
      })),
    })),
    sitemaps: parsed.sitemaps,
    unknown: parsed.unknown,
    blankOrCommentLines: parsed.blankOrCommentLines,
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) {
      throw new AppError('VALIDATION_ERROR', '请求体超过 2MB 上限');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AppError('BAD_JSON', '请求体不是合法 JSON');
  }
}

function errorBody(code: ErrorCode, message: string, details?: unknown): ApiError {
  return { error: message, code, ...(details === undefined ? {} : { details }) };
}

export function createApp(db: DatabaseSync): Server {
  return createServer((req, res) => {
    const handle = async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const allowedMethods = new Set<string>();
      for (const route of routes) {
        if (route.pattern.test(url.pathname)) allowedMethods.add(route.method);
      }
      const route = routes.find(
        (item) =>
          item.method === req.method && item.pattern.test(url.pathname),
      );
      if (!route) {
        const code: ErrorCode = allowedMethods.size > 0
          ? 'METHOD_NOT_ALLOWED'
          : 'NOT_FOUND';
        sendJson(
          res,
          allowedMethods.size > 0 ? 405 : 404,
          errorBody(code, code === 'NOT_FOUND' ? '接口不存在' : 'HTTP 方法不允许', {
            allow: [...allowedMethods],
          }),
        );
        return;
      }

      const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '')
        ? await readJson(req)
        : {};
      const match = route.pattern.exec(url.pathname)!;
      const result = route.handler(db, match, body, url.searchParams);
      sendJson(res, 200, result);
    };

    handle().catch((error: unknown) => {
      if (error instanceof AppError) {
        const status =
          error.code === 'VERSION_NOT_FOUND' || error.code === 'REPORT_NOT_FOUND'
            ? 404
            : error.code === 'VERSION_EXISTS'
              ? 409
              : error.code === 'METHOD_NOT_ALLOWED'
                ? 405
                : error.code === 'NOT_FOUND'
                  ? 404
                  : 400;
        sendJson(res, status, errorBody(error.code, error.message, error.details));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, errorBody('INTERNAL_ERROR', message));
    });
  });
}

function sendJson(res: Parameters<Parameters<Server['on']>[1]>[1], status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

export interface ListenResult {
  port: number;
  close: () => Promise<void>;
}

export function listen(
  server: Server,
  preferredPort: number | undefined,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 端口 0 或未指定 => 由操作系统分配空闲端口
    server.listen(preferredPort ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('无法获取监听端口'));
      }
    });
  });
}
