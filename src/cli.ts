#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "./db.js";
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
  parseId,
  validateName,
  validatePath,
  validateRobot,
  validateRobotsText,
} from "./validation.js";

const DEFAULT_DB = resolve("data/robots-lab.sqlite");

interface GlobalOptions {
  db: string;
}

function parseGlobal(argv: string[]): { options: GlobalOptions; rest: string[] } {
  const rest: string[] = [];
  let db = DEFAULT_DB;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") {
      db = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  return { options: { db }, rest };
}

function option(rest: string[], flag: string): string | undefined {
  const index = rest.indexOf(flag);
  return index === -1 ? undefined : rest[index + 1];
}

function readText(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("需要 --text \"...\" 或 --file <路径>");
  }
  return value;
}

function readPayload(rest: string[]): string {
  const file = option(rest, "--file");
  if (file !== undefined) return readFileSync(resolve(file), "utf-8");
  return readText(option(rest, "--text"));
}

function readPaths(rest: string[]): string[] {
  const inline = option(rest, "--paths");
  let values: string[];
  if (inline !== undefined) {
    values = inline
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  } else {
    const file = option(rest, "--paths-file");
    if (file === undefined) {
      throw new Error("需要 --paths /a,/b 或 --paths-file <每行一条路径>");
    }
    values = readFileSync(resolve(file), "utf-8")
      .split(/\r\n|\r|\n/)
      .map((item) => item.trim())
      .filter((item) => item !== "" && !item.startsWith("#"));
  }
  if (values.length === 0 || values.length > 100) {
    throw new Error("路径数量必须在 1..100 之间");
  }
  return values.map((path) => validatePath(path));
}

function writeOutput(rest: string[], payload: unknown): void {
  const out = option(rest, "--out");
  const text = JSON.stringify(payload, null, 2);
  if (out !== undefined) {
    writeFileSync(resolve(out), text + "\n", "utf-8");
    console.error(`报告已写入 ${out}`);
  } else {
    console.log(text);
  }
}

const USAGE = `robots-lab CLI（仅本地文本实验，不发起任何网络请求）

用法:
  robots-lab import --name <名称> (--text "<规则文本>" | --file <robots.txt>) [--out report.json]
  robots-lab list
  robots-lab get --version <id>
  robots-lab explain --version <id> --robot <机器人名称>
  robots-lab check --version <id> --robot <名称> (--paths /a,/b | --paths-file p.txt) [--out r.json]
  robots-lab report --batch <id> [--out r.json]
  robots-lab compare --from <id> --to <id> --robot <名称> (--paths ... | --paths-file ...) [--out r.json]

全局选项:
  --db <sqlite 文件路径>   默认 ${DEFAULT_DB}
`;

async function main(): Promise<void> {
  const { options, rest } = parseGlobal(process.argv.slice(2));
  const db = getDb(options.db);
  const command = rest[0];

  switch (command) {
    case "import": {
      const name = validateName(option(rest, "--name"));
      const robotsText = validateRobotsText(readPayload(rest.slice(1)));
      writeOutput(rest, createVersion(db, { name, robotsText }));
      break;
    }
    case "list":
      writeOutput(rest, { versions: listVersions(db) });
      break;
    case "get":
      writeOutput(rest, getVersion(db, parseId(option(rest, "--version"))));
      break;
    case "explain":
      writeOutput(
        rest,
        explainVersion(
          db,
          parseId(option(rest, "--version")),
          validateRobot(option(rest, "--robot")),
        ),
      );
      break;
    case "check": {
      const paths = readPaths(rest);
      writeOutput(
        rest,
        runCheck(
          db,
          parseId(option(rest, "--version")),
          validateRobot(option(rest, "--robot")),
          paths,
        ),
      );
      break;
    }
    case "report":
      writeOutput(rest, getReport(db, parseId(option(rest, "--batch"))));
      break;
    case "compare": {
      const paths = readPaths(rest);
      writeOutput(
        rest,
        compareVersions(
          db,
          parseId(option(rest, "--from")),
          parseId(option(rest, "--to")),
          validateRobot(option(rest, "--robot")),
          paths,
        ),
      );
      break;
    }
    default:
      console.log(USAGE);
      if (command !== undefined) process.exitCode = 1;
  }
}

main().catch((err: Error & { code?: string }) => {
  console.error(
        JSON.stringify(
          { code: err.code ?? "CLI_ERROR", message: err.message },
          null,
          2,
        ),
  );
  process.exit(1);
});
