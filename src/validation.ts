export interface ValidationError {
  code: ErrorCode;
  message: string;
}

export type ErrorCode =
  | "INVALID_VERSION_ID"
  | "INVALID_NAME"
  | "INVALID_ROBOTS_TEXT"
  | "INVALID_ROBOT"
  | "INVALID_PATH"
  | "VERSION_NOT_FOUND"
  | "CHECK_NOT_FOUND"
  | "VERSION_EXISTS"
  | "INVALID_BATCH"
  | "VERSION_SAME"
  | "BAD_JSON";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MAX_TEXT = 100_000;
const MAX_NAME = 200;
const MAX_ROBOT = 255;
const MAX_PATH = 2_048;

const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s);

export function validateName(name: unknown): string {
  if (typeof name !== "string") {
    throw new AppError("INVALID_NAME", "name 必须是字符串");
  }
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > MAX_NAME) {
    throw new AppError(
      "INVALID_NAME",
      `name 长度必须在 1..${MAX_NAME} 之间`,
    );
  }
  if (/[\u0000-\u001f]/.test(trimmed)) {
    throw new AppError("INVALID_NAME", "name 不得包含控制字符");
  }
  return trimmed;
}

export function validateRobotsText(text: unknown): string {
  if (typeof text !== "string") {
    throw new AppError("INVALID_ROBOTS_TEXT", "robotsText 必须是字符串");
  }
  if (text.length === 0 || text.length > MAX_TEXT) {
    throw new AppError(
      "INVALID_ROBOTS_TEXT",
      `robotsText 长度必须在 1..${MAX_TEXT} 字符之间`,
    );
  }
  return text;
}

export function validateRobot(robot: unknown): string {
  if (typeof robot !== "string") {
    throw new AppError("INVALID_ROBOT", "robot 必须是字符串");
  }
  const trimmed = robot.trim();
  if (trimmed === "" || trimmed.length > MAX_ROBOT) {
    throw new AppError("INVALID_ROBOT", `robot 长度必须在 1..${MAX_ROBOT}`);
  }
  if (/\s/.test(trimmed) || !isAscii(trimmed)) {
    throw new AppError(
      "INVALID_ROBOT",
      "robot 必须为不含空白的 ASCII 名称（本实验子集不做国际化归一化）",
    );
  }
  return trimmed;
}

/**
 * 路径必须已经规范化：以 / 开头的 ASCII 路径，可带查询串（?），
 * 不接受片段（#），不做 URL 解码或百分号归一化。
 */
export function validatePath(path: unknown): string {
  if (typeof path !== "string") {
    throw new AppError("INVALID_PATH", "path 必须是字符串");
  }
  if (!path.startsWith("/") || path.length > MAX_PATH) {
    throw new AppError(
      "INVALID_PATH",
      `path 必须以 / 开头且长度不超过 ${MAX_PATH}`,
    );
  }
  if (!isAscii(path) || /\s/.test(path) || path.includes("#")) {
    throw new AppError(
      "INVALID_PATH",
      "path 必须是无空白、无 # 片段的 ASCII 路径（可选查询串）；本服务不做 URL 解码",
    );
  }
  return path;
}

export function parseId(value: unknown): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError("INVALID_VERSION_ID", "版本 ID 必须是正整数");
  }
  return id;
}
