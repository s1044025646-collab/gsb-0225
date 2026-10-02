#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { decide } from './matcher.js';
import { parseRobots } from './parser.js';
import {
  compareVersions,
  loadReport,
  runBatch,
  validateContent,
  validateItem,
  validateVersionName,
} from './service.js';
import { createVersion, listVersions, requireVersion } from './db.js';
import { AppError } from './types.js';
import { createApp, listen } from './server.js';

/**
 * 命令行入口：
 *   serve [--port N] [--db path]
 *   import --name NAME --file robots.txt [--db path]
 *   parse  --file robots.txt
 *   groups --file robots.txt --robot NAME
 *   check  --file robots.txt | --version NAME --robot NAME --path /p
 *   batch  --version NAME --items items.json [--out report.json]
 *   compare --a NAME --b NAME --items paths.json [--out diff.json]
 *   report --id N
 *   versions
 */

interface CliArgs {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, 'true');
      } else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function dbPath(flags: Map<string, string>): string {
  return resolve(flags.get('db') ?? 'data/robots-lab.db');
}

function readTextFile(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readItems(path: string): Array<{ robot: string; path: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readTextFile(path));
  } catch (error) {
    throw new AppError(
      'VALIDATION_ERROR',
      `items 文件不是合法 JSON: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'items 文件必须是非空数组');
  }
  return parsed.map((item) => validateItem(item));
}

function decisionSummary(decision: ReturnType<typeof decide>) {
  return {
    robot: decision.robot,
    path: decision.path,
    allowed: decision.allowed,
    matchedGroup: decision.groupMatch.matchedName,
    groupMatchType: decision.groupMatch.matchType,
    winningRule: decision.winningRule
      ? {
          kind: decision.winningRule.kind,
          pattern: decision.winningRule.pattern,
          line: decision.winningRule.line,
          allowAll: decision.winningRule.allowAll ?? false,
        }
      : null,
    reason: decision.reason,
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  const args = parseArgs(process.argv.slice(3));

  switch (command) {
    case 'serve': {
      const db = openDatabase(dbPath(args.flags));
      const server = createApp(db);
      const portArg = args.flags.get('port');
      const preferred = portArg && portArg !== 'true' ? Number(portArg) : undefined;
      if (preferred !== undefined && (!Number.isInteger(preferred) || preferred < 0 || preferred > 65535)) {
        throw new AppError('VALIDATION_ERROR', '--port 必须是 0-65535 的整数（0 表示自选空闲端口）');
      }
      const port = await listen(server, preferred);
      process.stdout.write(
        `robots-lab API 已启动: http://127.0.0.1:${port}  (数据文件 ${dbPath(args.flags)})\n` +
          '按 Ctrl+C 停止。\n',
      );
      break;
    }

    case 'import': {
      const name = validateVersionName(args.flags.get('name'));
      const file = args.flags.get('file');
      if (!file) throw new AppError('VALIDATION_ERROR', '需要 --file robots.txt');
      const content = validateContent(readTextFile(file));
      const parsed = parseRobots(content); // 先验证可解析
      const db = openDatabase(dbPath(args.flags));
      const version = createVersion(db, name, content);
      print({
        imported: true,
        version: { id: version.id, name: version.name, created_at: version.created_at },
        groups: parsed.groups.length,
        unknownDirectives: parsed.unknown.length,
        sitemaps: parsed.sitemaps,
      });
      break;
    }

    case 'parse': {
      const file = args.flags.get('file');
      if (!file) throw new AppError('VALIDATION_ERROR', '需要 --file robots.txt');
      const parsed = parseRobots(validateContent(readTextFile(file)));
      print({
        groups: parsed.groups.map((group) => ({
          name: group.name,
          lines: group.lines,
          rules: group.rules.map((rule) => ({
            kind: rule.kind,
            pattern: rule.pattern,
            line: rule.line,
            ...(rule.allowAll ? { allowAll: true } : {}),
          })),
        })),
        sitemaps: parsed.sitemaps,
        unknown: parsed.unknown,
      });
      break;
    }

    case 'groups': {
      const file = args.flags.get('file');
      const robot = args.flags.get('robot');
      if (!file || !robot) {
        throw new AppError('VALIDATION_ERROR', '需要 --file robots.txt --robot NAME');
      }
      const parsed = parseRobots(validateContent(readTextFile(file)));
      const decision = decide(robot, '/', parsed);
      print({
        robot,
        matchedGroup: decision.groupMatch.matchedName,
        matchType: decision.groupMatch.matchType,
        groupRules: decision.groupMatch.group?.rules ?? [],
      });
      break;
    }

    case 'check': {
      const robot = args.flags.get('robot');
      const path = args.flags.get('path');
      if (!robot || !path) {
        throw new AppError('VALIDATION_ERROR', '需要 --robot NAME --path /path');
      }
      validateItem({ robot, path });
      const versionRef = args.flags.get('version');
      let content: string;
      if (versionRef) {
        const db = openDatabase(dbPath(args.flags));
        content = requireVersion(db, versionRef).content;
      } else {
        const file = args.flags.get('file');
        if (!file) throw new AppError('VALIDATION_ERROR', '需要 --file 或 --version');
        content = validateContent(readTextFile(file));
      }
      const parsed = parseRobots(content);
      print(decisionSummary(decide(robot, path, parsed)));
      break;
    }

    case 'batch': {
      const versionRef = args.flags.get('version');
      const itemsPath = args.flags.get('items');
      if (!versionRef || !itemsPath) {
        throw new AppError('VALIDATION_ERROR', '需要 --version NAME --items items.json');
      }
      const db = openDatabase(dbPath(args.flags));
      const version = requireVersion(db, versionRef);
      const items = readItems(itemsPath);
      const output = runBatch(db, version.id, version.content, items, true);
      const payload = {
        batchId: output.batchId,
        version: { id: version.id, name: version.name },
        results: output.results.map(decisionSummary),
      };
      if (args.flags.get('out')) writeFileSync(resolve(args.flags.get('out')!), JSON.stringify(payload, null, 2));
      print(payload);
      break;
    }

    case 'compare': {
      const a = args.flags.get('a');
      const b = args.flags.get('b');
      const itemsPath = args.flags.get('items');
      if (!a || !b || !itemsPath) {
        throw new AppError('VALIDATION_ERROR', '需要 --a NAME --b NAME --items paths.json');
      }
      const db = openDatabase(dbPath(args.flags));
      const items = readItems(itemsPath);
      const result = compareVersions(db, a, b, items);
      const payload = {
        reportId: result.reportId,
        versionA: result.versionA,
        versionB: result.versionB,
        total: result.total,
        changedCount: result.changedCount,
        changes: result.changes.map((entry) => ({
          robot: entry.robot,
          path: entry.path,
          allowedA: entry.allowedA,
          allowedB: entry.allowedB,
          changed: entry.changed,
          reasonA: entry.decisionA.reason,
          reasonB: entry.decisionB.reason,
        })),
      };
      if (args.flags.get('out')) writeFileSync(resolve(args.flags.get('out')!), JSON.stringify(payload, null, 2));
      print(payload);
      break;
    }

    case 'report': {
      const id = args.flags.get('id');
      if (!id) throw new AppError('VALIDATION_ERROR', '需要 --id N');
      const db = openDatabase(dbPath(args.flags));
      print(loadReport(db, Number(id)));
      break;
    }

    case 'versions': {
      const db = openDatabase(dbPath(args.flags));
      print({
        versions: listVersions(db).map((version) => ({
          id: version.id,
          name: version.name,
          created_at: version.created_at,
          length: version.content.length,
        })),
      });
      break;
    }

    default:
      process.stdout.write(
        [
          'robots-lab 用法（纯本地，不访问网络）：',
          '  serve [--port 0] [--db data/robots-lab.db]',
          '  import  --name NAME --file robots.txt',
          '  parse   --file robots.txt',
          '  groups  --file robots.txt --robot NAME',
          '  check   (--file robots.txt | --version NAME) --robot NAME --path /p?x=1',
          '  batch   --version NAME --items items.json [--out report.json]',
          '  compare --a NAME --b NAME --items paths.json [--out diff.json]',
          '  report  --id N',
          '  versions',
        ].join('\n') + '\n',
      );
  }
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    process.stderr.write(`错误 [${error.code}] ${error.message}\n`);
    if (error.details !== undefined) {
      process.stderr.write(`${JSON.stringify(error.details)}\n`);
    }
  } else {
    process.stderr.write(`错误 [INTERNAL_ERROR] ${(error as Error).stack ?? error}\n`);
  }
  process.exitCode = 1;
});
