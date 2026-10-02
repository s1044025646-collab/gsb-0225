import type {
  AgentGroup,
  CheckResult,
  ParseResult,
  Rule,
  SelectedGroup,
} from "./types.js";

/**
 * 判断一个 User-agent 令牌是否适用于给定机器人。
 * 比较不区分大小写；* 为通配组；其余按 RFC 9309 的“令牌是机器人名称
 * 子串”规则判定（例如 googlebot-image 可匹配 googlebot）。
 */
export function tokenMatches(token: string, robotLower: string): boolean {
  if (token === "*") return true;
  return robotLower.includes(token);
}

/**
 * 选择最具体的适用规则组，并合并同一批“获胜令牌”对应的多个组。
 *
 * 选择口径：
 * - 在所有匹配的非 * 令牌中，取令牌字符串长度最大者（长度越长越具体）；
 * - 若存在多个同样最长、且都能匹配的令牌，这些令牌名下的组全部合并
 *   （罕见边界，确定性处理，README 有说明）；
 * - 不存在任何具体匹配时，才回退到 * 组，并合并全部 * 组；
 * - 连 * 组都没有时，返回空组（默认放行）。
 */
export function selectGroups(parsed: ParseResult, robot: string): SelectedGroup {
  const robotLower = robot.toLowerCase();

  const matchedTokens = new Set<string>();
  for (const group of parsed.groups) {
    for (const token of group.agents) {
      if (token !== "*" && tokenMatches(token, robotLower)) {
        matchedTokens.add(token);
      }
    }
  }

  let selectedGroups: AgentGroup[] = [];
  let matchedToken: string | null = null;

  if (matchedTokens.size > 0) {
    let bestLen = -1;
    for (const token of matchedTokens) {
      if (token.length > bestLen) bestLen = token.length;
    }
    const winners = [...matchedTokens].filter((t) => t.length === bestLen);
    matchedToken = winners.join("|");
    selectedGroups = parsed.groups.filter((g) =>
      g.agents.some(
        (t) => t !== "*" && winners.includes(t) && tokenMatches(t, robotLower),
      ),
    );
  } else {
    const starGroups = parsed.groups.filter((g) => g.agents.includes("*"));
    if (starGroups.length > 0) {
      selectedGroups = starGroups;
      matchedToken = "*";
    }
  }

  return {
    agents: selectedGroups.flatMap((g) => g.agents),
    rules: selectedGroups.flatMap((g) => g.rules),
    matchedAgentToken: matchedToken,
    groupLines: selectedGroups.map((g) => ({
      startLine: g.startLine,
      endLine: g.endLine,
    })),
  };
}

/**
 * 将 robots 路径模式转换为锚定开头的正则表达式。
 * - * 匹配任意数量（含 0 个）任意字符；
 * - 仅出现在模式末尾的 $ 表示“必须在路径结尾匹配”；
 * - 其他位置的 $ 视为普通字符；
 * - 除 * / 末尾 $ 外的字符一律按字面量转义，匹配区分大小写。
 */
export function patternToRegExp(pattern: string): RegExp {
  let body = "";
  const endAnchor = pattern.endsWith("$");
  const core = endAnchor ? pattern.slice(0, -1) : pattern;
  for (const ch of core) {
    if (ch === "*") {
      body += ".*";
    } else {
      body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${body}${endAnchor ? "$" : ""}`, "s");
}

/**
 * 有效路径长度（命中长度）：模式中除 * 和结尾 $ 之外的字面字符个数。
 * 这是本项目判定“哪条规则更具体”的唯一口径，在 README 中说明。
 */
export function effectiveLength(pattern: string): number {
  let length = pattern.length;
  if (pattern.endsWith("$")) length -= 1;
  length -= (pattern.match(/\*/g) ?? []).length;
  return length;
}

export interface RuleMatch {
  rule: Rule;
  score: number;
}

/** 在选中的组规则中找出全部命中路径的规则（按得分降序）。 */
export function matchingRules(rules: Rule[], pathWithQuery: string): RuleMatch[] {
  const hits: RuleMatch[] = [];
  for (const rule of rules) {
    if (patternToRegExp(rule.pattern).test(pathWithQuery)) {
      hits.push({ rule, score: effectiveLength(rule.pattern) });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.rule.line - b.rule.line);
}

/**
 * 对单条路径给出抓取准入结论。
 * 规则优先级：最长有效路径长度获胜；长度相同时 Allow 优先于 Disallow；
 * 没有任何规则命中时默认放行。
 */
export function checkPath(
  parsed: ParseResult,
  robot: string,
  pathWithQuery: string,
): CheckResult {
  const group = selectGroups(parsed, robot);
  const hits = matchingRules(group.rules, pathWithQuery);

  if (hits.length === 0) {
    return {
      robot,
      path: pathWithQuery,
      allowed: true,
      defaultAllow: true,
      matchedAgentToken: group.matchedAgentToken,
      groupLines: group.groupLines,
      groupRuleCount: group.rules.length,
      winningRule: null,
      reason:
        group.matchedAgentToken === null
          ? "不存在适用于该机器人的规则组（含 * 组）：无规则命中即默认允许。"
          : `已选用 ${group.matchedAgentToken} 规则组，但组内没有任何规则命中该路径：无规则命中即默认允许。`,
    };
  }

  const topScore = hits[0].score;
  const top = hits.filter((h) => h.score === topScore);
  const allowWin = top.find((h) => h.rule.type === "allow");
  const winner = allowWin ?? top[0];
  const allowed = winner.rule.type === "allow";

  return {
    robot,
    path: pathWithQuery,
    allowed,
    defaultAllow: false,
    matchedAgentToken: group.matchedAgentToken,
    groupLines: group.groupLines,
    groupRuleCount: group.rules.length,
    winningRule: {
      type: winner.rule.type,
      pattern: winner.rule.pattern,
      line: winner.rule.line,
      score: winner.score,
    },
    reason: allowWin
      ? `命中 ${top.length} 条有效长度同为 ${topScore} 的规则，同长度时 Allow 优先，故允许。`
      : `规则 ${winner.rule.pattern} 以最长有效路径长度 ${topScore} 命中，故禁止。`,
  };
}
