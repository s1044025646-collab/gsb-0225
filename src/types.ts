export type DirectiveType = "allow" | "disallow";

export interface Rule {
  type: DirectiveType;
  pattern: string;
  line: number;
  raw: string;
}

export interface AgentGroup {
  agents: string[];
  rules: Rule[];
  startLine: number;
  endLine: number;
}

export interface Diagnostic {
  line: number;
  code:
    | "UNKNOWN_DIRECTIVE"
    | "MALFORMED_LINE"
    | "INVALID_PATH"
    | "EMPTY_USER_AGENT"
    | "RULE_WITHOUT_GROUP";
  message: string;
  raw?: string;
}

export interface SitemapMeta {
  url: string;
  line: number;
}

export interface ParseResult {
  groups: AgentGroup[];
  diagnostics: Diagnostic[];
  sitemaps: SitemapMeta[];
}

export interface SelectedGroup {
  agents: string[];
  rules: Rule[];
  matchedAgentToken: string | null;
  groupLines: Array<{ startLine: number; endLine: number }>;
}

export interface WinningRule {
  type: DirectiveType;
  pattern: string;
  line: number;
  score: number;
}

export interface CheckResult {
  robot: string;
  path: string;
  allowed: boolean;
  defaultAllow: boolean;
  matchedAgentToken: string | null;
  groupLines: Array<{ startLine: number; endLine: number }>;
  groupRuleCount: number;
  winningRule: WinningRule | null;
  reason: string;
}
