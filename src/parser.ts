import type {
  Group,
  ParseResult,
  Rule,
  UnknownDirective,
} from './types.js';

/**
 * robots.txt 文本解析器（自研，仅实现本项目公开子集）。
 *
 * 支持的子集：
 * - 空行、整行注释（# 开头）与基本字段空白（冒号两侧空格、行内 # 注释）
 * - User-agent / Allow / Disallow，字段名不区分大小写
 * - 同一名称（大小写不敏感）的多个组合并为一个组
 * - 空 Disallow（Disallow: 后为空）表示“不禁止任何内容”，即允许全部
 * - Sitemap 仅收集为元数据
 * - 其他指令保留在 unknown 诊断中
 */

interface PendingGroup {
  nameLower: string;
  name: string;
  rules: Rule[];
  lines: number[];
}

export function parseRobots(text: string): ParseResult {
  if (typeof text !== 'string') {
    throw new TypeError('parseRobots: text 必须是字符串');
  }

  const lines = text.split(/\r\n|\r|\n/);
  const merged = new Map<string, PendingGroup>();
  const sitemaps: string[] = [];
  const unknown: UnknownDirective[] = [];
  let blankOrCommentLines = 0;

  // 当前记录中声明的组；recordHasRules 标记规则是否已开始。
  // 规则开始后再遇到 User-agent 表示新记录开始（空行不是必需边界）。
  let current: PendingGroup[] | null = null;
  let recordHasRules = false;

  const ensureGroup = (name: string): PendingGroup => {
    const nameLower = name.toLowerCase();
    let group = merged.get(nameLower);
    if (!group) {
      group = { nameLower, name, rules: [], lines: [] };
      merged.set(nameLower, group);
    }
    return group;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i] ?? '';

    // 去掉行内注释：# 之前的内容为有效内容
    const hashIdx = rawLine.indexOf('#');
    const body = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();

    if (body === '') {
      blankOrCommentLines += 1;
      // 空行结束当前记录；同名的多个组合并由 Map 保证。
      current = null;
      recordHasRules = false;
      continue;
    }

    const colonIdx = body.indexOf(':');
    if (colonIdx < 0) {
      unknown.push({
        line: lineNo,
        field: body,
        value: '',
        reason: '缺少冒号，无法识别为 字段: 值 形式',
      });
      current = null;
      continue;
    }

    const field = body.slice(0, colonIdx).trim().toLowerCase();
    const value = body.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      if (value === '') {
        unknown.push({
          line: lineNo,
          field: 'user-agent',
          value: '',
          reason: 'User-agent 名称为空，已忽略',
        });
        current = null;
        continue;
      }
      // 新的 User-agent 行：若 current 已存在（连续多个 User-agent 行），
      // 这些名称共享同一批后续规则，直到出现规则行；我们以“规则行出现时
      // 把规则写入所有被列出的名称”实现，这里先收集名称。
      if (recordHasRules) {
        current = null;
        recordHasRules = false;
      }
      const group = ensureGroup(value);
      group.lines.push(lineNo);
      if (!current) current = [];
      if (!current.some((item) => item.nameLower === group.nameLower)) {
        current.push(group);
      }
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      if (!current || current.length === 0) {
        unknown.push({
          line: lineNo,
          field,
          value,
          reason: `${field} 出现在任何 User-agent 组之前，已忽略`,
        });
        continue;
      }
      const rule: Rule = {
        kind: field === 'allow' ? 'allow' : 'disallow',
        pattern: value,
        line: lineNo,
      };
      if (field === 'disallow' && value === '') {
        // 空 Disallow = 明确允许全部
        rule.allowAll = true;
        rule.kind = 'allow';
      }
      for (const group of current) {
        group.rules.push(rule);
        if (!group.lines.includes(lineNo)) group.lines.push(lineNo);
      }
      recordHasRules = true;
      continue;
    }

    if (field === 'sitemap') {
      if (value !== '') sitemaps.push(value);
      continue;
    }

    unknown.push({
      line: lineNo,
      field,
      value,
      reason: '非本项目支持的指令，已保留为诊断且不影响判定',
    });
  }

  const groups: Group[] = [];
  const byName = new Map<string, Group>();
  for (const pending of merged.values()) {
    const group: Group = {
      name: pending.name,
      nameLower: pending.nameLower,
      rules: pending.rules,
      lines: pending.lines.sort((a, b) => a - b),
    };
    groups.push(group);
    byName.set(group.nameLower, group);
  }

  const wildcardGroup = byName.get('*') ?? null;

  return { groups, byName, wildcardGroup, sitemaps, unknown, blankOrCommentLines };
}
