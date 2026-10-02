import type {
  Decision,
  Group,
  GroupMatch,
  ParseResult,
  Rule,
} from './types.js';

/**
 * 组选择与路径匹配器。
 *
 * 口径说明（与 README 一致）：
 * 1. 机器人名称匹配大小写不敏感；路径匹配大小写敏感。
 * 2. 名称选择顺序：精确同名 -> 最长前缀声明名（如请求 GooglebotNewsImage，
 *    声明 Googlebot 命中） -> 星号组 * -> 无组。
 *    星号只作“兜底组名”，不参与名称通配。
 * 3. 同一路径可能命中多条规则。比较依据为“有效路径长度”：
 *    - 普通前缀匹配：模式中的字面字符数（即模式长度）。
 *    - 含 * 的通配匹配：模式中字面字符数（* 展开匹配到的字符不计入）。
 *    - 结尾 $ 是锚点，不是字符，不计入长度。
 *    有效长度相同（含同为 0）时 Allow 优先；空 Disallow 视为 Allow-all。
 * 4. 无任何规则命中时默认放行（robots.txt 的默认立场是允许抓取）。
 */

export function selectGroup(robot: string, parsed: ParseResult): GroupMatch {
  const wanted = robot.toLowerCase();

  const exact = parsed.byName.get(wanted);
  if (exact) {
    return { group: exact, matchType: 'exact', matchedName: exact.name };
  }

  let best: Group | null = null;
  for (const group of parsed.groups) {
    if (group.nameLower === '*') continue;
    if (wanted.startsWith(group.nameLower)) {
      if (!best || group.nameLower.length > best.nameLower.length) {
        best = group;
      }
    }
  }
  if (best) {
    return { group: best, matchType: 'prefix', matchedName: best.name };
  }

  if (parsed.wildcardGroup) {
    return {
      group: parsed.wildcardGroup,
      matchType: 'wildcard',
      matchedName: '*',
    };
  }

  return { group: null, matchType: 'none', matchedName: null };
}

/**
 * 判断模式是否在路径开头匹配。
 * 支持 *（匹配任意长度任意字符序列）与结尾 $（必须匹配到路径末尾）。
 * 返回 null 表示不命中；否则返回匹配信息。
 */
export function matchPattern(
  pattern: string,
  path: string,
): { matchedSpan: number } | null {
  let anchoredEnd = false;
  let body = pattern;
  if (body.endsWith('$')) {
    anchoredEnd = true;
    body = body.slice(0, -1);
  }

  const segments = body.split('*');

  // 没有 *：必须是路径前缀；带 $ 时必须恰好相等。
  if (segments.length === 1) {
    const literal = segments[0]!;
    if (!path.startsWith(literal)) return null;
    if (anchoredEnd && path.length !== literal.length) return null;
    return { matchedSpan: literal.length };
  }

  // 含 *：逐段贪心匹配。首段必须锚定路径起点，末段在带 $ 时必须贴尾。
  const first = segments[0]!;
  if (!path.startsWith(first)) return null;

  let cursor = first.length;
  const middle = segments.slice(1, -1);
  for (const segment of middle) {
    const idx = path.indexOf(segment, cursor);
    if (idx < 0) return null;
    cursor = idx + segment.length;
  }

  const last = segments[segments.length - 1]!;
  if (anchoredEnd) {
    if (!path.endsWith(last)) return null;
    // 末段不得与已消费区域重叠
    const start = path.length - last.length;
    if (start < cursor) {
      // 允许 * 匹配零字符但字面段不可重叠
      if (start !== cursor) return null;
    }
    cursor = path.length;
  } else {
    const idx = path.indexOf(last, cursor);
    if (idx < 0) return null;
    cursor = idx + last.length;
  }

  return { matchedSpan: cursor };
}

/** 计算规则的有效路径长度（仅字面字符，$ 与 * 不计）。 */
export function effectiveLength(pattern: string): number {
  let body = pattern;
  if (body.endsWith('$')) body = body.slice(0, -1);
  let count = 0;
  for (const char of body) {
    if (char !== '*') count += 1;
  }
  return count;
}

/** 对单条路径做完整判定。 */
export function decide(
  robot: string,
  path: string,
  parsed: ParseResult,
): Decision {
  const groupMatch = selectGroup(robot, parsed);
  const candidates: Decision['candidates'] = [];

  let winner: Rule | null = null;
  let winnerLength = -1;

  if (groupMatch.group) {
    for (const rule of groupMatch.group.rules) {
      if (rule.allowAll) {
        // 空 Disallow：允许全部，有效长度视为 0（同长度时 allow 已占优）
        candidates.push({ rule, effectiveLength: 0, matchedSpan: 0 });
        if (0 > winnerLength || (0 === winnerLength && winner && winner.kind === 'disallow')) {
          winner = rule;
          winnerLength = 0;
        }
        continue;
      }
      const hit = matchPattern(rule.pattern, path);
      if (!hit) continue;
      const length = effectiveLength(rule.pattern);
      candidates.push({
        rule,
        effectiveLength: length,
        matchedSpan: hit.matchedSpan,
      });
      if (
        length > winnerLength ||
        (length === winnerLength &&
          winner &&
          rule.kind === 'allow' &&
          winner.kind === 'disallow')
      ) {
        winner = rule;
        winnerLength = length;
      }
    }
  }

  const allowed = winner ? winner.kind === 'allow' : true;

  let reason: string;
  if (!groupMatch.group) {
    reason =
      '未找到与该机器人名称匹配的 User-agent 组（也无 * 兜底组），无规则适用，默认放行';
  } else if (!winner) {
    reason = `命中规则组「${groupMatch.matchedName}」，但该组没有规则匹配此路径，默认放行`;
  } else if (winner.allowAll) {
    reason = `命中规则组「${groupMatch.matchedName}」，空 Disallow 表示不禁止任何路径，故放行`;
  } else {
    const verb = winner.kind === 'allow' ? 'Allow' : 'Disallow';
    const resultText = allowed ? '放行' : '禁止';
    reason =
      `命中规则组「${groupMatch.matchedName}」（${groupTypeText(groupMatch.matchType)}）；` +
      `获胜规则为第 ${winner.line} 行 ${verb}: ${winner.pattern}，` +
      `有效路径长度 ${winnerLength}` +
      tieText(winner, candidates) +
      `，判定${resultText}`;
  }

  return {
    robot,
    path,
    allowed,
    groupMatch: {
      group: groupMatch.group
        ? {
            name: groupMatch.group.name,
            nameLower: groupMatch.group.nameLower,
            rules: groupMatch.group.rules,
            lines: groupMatch.group.lines,
          }
        : null,
      matchType: groupMatch.matchType,
      matchedName: groupMatch.matchedName,
    },
    winningRule: winner,
    candidates,
    reason,
  };
}

function groupTypeText(type: GroupMatch['matchType']): string {
  switch (type) {
    case 'exact':
      return '名称精确匹配';
    case 'prefix':
      return '名称前缀匹配，取最长声明名';
    case 'wildcard':
      return '无具体名称，使用星号兜底组';
    default:
      return '';
  }
}

function tieText(
  winner: Rule,
  candidates: Decision['candidates'],
): string {
  if (winner.kind !== 'allow') return '';
  const winnerLen = effectiveLength(winner.allowAll ? '' : winner.pattern);
  const tiedDisallow = candidates.some(
    (item) =>
      item.rule.kind === 'disallow' &&
      !item.rule.allowAll &&
      item.effectiveLength === winnerLen &&
      item.rule.line !== winner.line,
  );
  return tiedDisallow ? '，与 Disallow 同长，Allow 优先' : '';
}

/** 校验路径：已规范化的 ASCII 路径，可带查询串。 */
export function validatePath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) {
    return 'path 必须是非空字符串';
  }
  if (!path.startsWith('/')) {
    return 'path 必须以 / 开头（本服务只接受已规范化的绝对路径）';
  }
  // 排除非 ASCII 与控制字符；# 不接受（片段不应出现在抓取路径中）
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(path)) {
    return 'path 只能包含可打印 ASCII 字符（不做 IDN/百分号/解码归一化）';
  }
  if (path.includes('#')) {
    return 'path 不应包含 # 片段';
  }
  if (/\s/.test(path)) {
    return 'path 不应包含空白字符';
  }
  return null;
}

/** 校验机器人名称。 */
export function validateRobot(robot: string): string | null {
  if (typeof robot !== 'string' || robot.trim().length === 0) {
    return 'robot 必须是非空字符串';
  }
  if (robot.length > 200) {
    return 'robot 名称过长（上限 200 字符）';
  }
  return null;
}
