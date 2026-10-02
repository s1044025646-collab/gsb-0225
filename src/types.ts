/**
 * 核心领域类型定义。
 * 本服务只处理 robots.txt 文本本身，不发起任何网络访问。
 */

/** 一条 Allow / Disallow 规则（空 Disallow 会被解析为 allowAll）。 */
export interface Rule {
  /** 规则类型 */
  kind: 'allow' | 'disallow';
  /** 规则路径模式，例如 /tmp、/assets/*.css$；空字符串表示空规则 */
  pattern: string;
  /** 来源行号（从 1 开始） */
  line: number;
  /** 空 Disallow: 被解释为“允许全部” */
  allowAll?: boolean;
}

/** 一个 User-agent 规则组；同名组在解析阶段已合并。 */
export interface Group {
  /** 声明的名称，保留原样用于展示 */
  name: string;
  /** 小写名称，用于匹配 */
  nameLower: string;
  rules: Rule[];
  /** 该组（合并后）覆盖的行号 */
  lines: number[];
}

/** 不认识或不支持的指令，保留为诊断。 */
export interface UnknownDirective {
  line: number;
  field: string;
  value: string;
  reason: string;
}

/** 解析 robots.txt 文本后的完整结果。 */
export interface ParseResult {
  groups: Group[];
  /** 名称小写 -> 合并后的组，方便选择 */
  byName: Map<string, Group>;
  /** 星号兜底组，不存在则为 null */
  wildcardGroup: Group | null;
  /** Sitemap 仅作为元数据保存，绝不抓取 */
  sitemaps: string[];
  unknown: UnknownDirective[];
  /** 纯注释 / 空行行数（信息性统计） */
  blankOrCommentLines: number;
}

/** 组选择命中信息。 */
export interface GroupMatch {
  group: Group | null;
  /** exact = 精确名称命中；prefix = 名称前缀命中（取最长）；wildcard = 使用 * 组；none = 无任何组 */
  matchType: 'exact' | 'prefix' | 'wildcard' | 'none';
  /** 命中的声明名称（用于说明依据） */
  matchedName: string | null;
}

/** 单条路径的判定结果。 */
export interface Decision {
  robot: string;
  path: string;
  /** 最终结论 */
  allowed: boolean;
  groupMatch: GroupMatch;
  /** 获胜规则；null 表示无规则命中（默认放行）或使用空 Disallow 放行 */
  winningRule: Rule | null;
  /** 所有命中规则的比较依据，便于解释 */
  candidates: Array<{
    rule: Rule;
    effectiveLength: number;
    /** 模式在输入路径中实际消耗的字符跨度（含 * 展开部分） */
    matchedSpan: number;
  }>;
  /** 人类可读的判定依据（中文） */
  reason: string;
}

/** 批量检查中的单条记录。 */
export interface CheckItem {
  robot: string;
  path: string;
}

/** 持久化的版本记录。 */
export interface VersionRow {
  id: number;
  name: string;
  content: string;
  created_at: string;
}

/** API 统一错误结构。 */
export interface ApiError {
  error: string;
  code: ErrorCode;
  details?: unknown;
}

/** 明确的错误码集合。 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'VERSION_EXISTS'
  | 'VERSION_NOT_FOUND'
  | 'REPORT_NOT_FOUND'
  | 'BAD_JSON'
  | 'METHOD_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
