import type {
  AgentGroup,
  Diagnostic,
  ParseResult,
  Rule,
  SitemapMeta,
} from "./types.js";

interface GroupBuilder {
  agents: string[];
  rules: Rule[];
  startLine: number;
  endLine: number;
  ruleAttached: boolean;
}

/**
 * 解析 robots.txt 文本（仅文本分析，不发生任何网络访问）。
 *
 * 结构规则（RFC 9309 风格的记录模型，裁剪到本项目支持的子集）：
 * - 以 # 开头的注释行会被忽略，行内 # 之后的内容也按注释剥离；
 * - 空行仅用于分隔视觉段落，不影响规则组成员关系；
 * - 连续的 User-agent 行开启一个规则组，其后的 Allow/Disallow 归属该组；
 * - 规则之后再次出现 User-agent 会开启新组；同名机器人的多个组保留为
 *   独立组，在选择阶段合并；
 * - Allow/Disallow 的值为空表示“无任何限制”，不作为禁止规则；
 * - 非空路径必须以 / 开头，否则给出 INVALID_PATH 诊断并忽略；
 * - Sitemap 保存为元数据；其他不认识的指令保留 UNKNOWN_DIRECTIVE 诊断。
 */
export function parseRobots(text: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const sitemaps: SitemapMeta[] = [];
  const groups: GroupBuilder[] = [];

  let current: GroupBuilder | null = null;

  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);

  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const withoutComment = rawLine.replace(/#.*$/u, "").trim();
    if (withoutComment === "") return;

    const colonIdx = withoutComment.indexOf(":");
    if (colonIdx === -1) {
      diagnostics.push({
        line,
        code: "MALFORMED_LINE",
        message: "该行不包含冒号，无法解析为 字段:值 形式",
        raw: rawLine.trim(),
      });
      return;
    }

    const field = withoutComment.slice(0, colonIdx).trim().toLowerCase();
    const value = withoutComment.slice(colonIdx + 1).trim();

    if (field === "") {
      diagnostics.push({
        line,
        code: "MALFORMED_LINE",
        message: "字段名为空",
        raw: rawLine.trim(),
      });
      return;
    }

    if (field === "user-agent") {
      if (value === "") {
        diagnostics.push({
          line,
          code: "EMPTY_USER_AGENT",
          message: "User-agent 的值为空",
          raw: rawLine.trim(),
        });
        return;
      }
      if (current === null || current.ruleAttached) {
        current = {
          agents: [],
          rules: [],
          startLine: line,
          endLine: line,
          ruleAttached: false,
        };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      current.endLine = line;
      return;
    }

    if (field === "sitemap") {
      sitemaps.push({ url: value, line });
      return;
    }

    if (field === "allow" || field === "disallow") {
      if (current === null) {
        diagnostics.push({
          line,
          code: "RULE_WITHOUT_GROUP",
          message: `${field} 出现在任何 User-agent 组之前，已忽略`,
          raw: rawLine.trim(),
        });
        return;
      }
      current.endLine = line;
      if (value === "") {
        // 空值 = 不限制任何路径，绝不表示“禁止全部”，直接忽略。
        return;
      }
      if (!value.startsWith("/")) {
        diagnostics.push({
          line,
          code: "INVALID_PATH",
          message: `${field} 的值必须以 / 开头，已忽略: ${value}`,
          raw: rawLine.trim(),
        });
        return;
      }
      const rule: Rule = {
        type: field,
        pattern: value,
        line,
        raw: rawLine.trim(),
      };
      current.rules.push(rule);
      current.ruleAttached = true;
      return;
    }

    diagnostics.push({
      line,
      code: "UNKNOWN_DIRECTIVE",
      message: `不认识或本实验子集不支持的指令: ${field}`,
      raw: rawLine.trim(),
    });
  });

  const resultGroups: AgentGroup[] = groups
    .filter((g) => g.agents.length > 0)
    .map((g) => ({
      agents: g.agents,
      rules: g.rules,
      startLine: g.startLine,
      endLine: g.endLine,
    }));

  return { groups: resultGroups, diagnostics, sitemaps };
}
