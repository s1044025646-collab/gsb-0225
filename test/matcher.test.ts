import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots } from '../dist/parser.js';
import {
  decide,
  effectiveLength,
  matchPattern,
  selectGroup,
  validatePath,
} from '../dist/matcher.js';

const sample = `
User-agent: *
Disallow: /private
Disallow: /tmp
Allow: /private/public

User-agent: archiver
Disallow:

User-agent: *
Disallow: /*.json$

Sitemap: https://example.invalid/sitemap.xml
`;

test('公共目录默认可抓', () => {
  const parsed = parseRobots(sample);
  assert.equal(decide('genericbot', '/', parsed).allowed, true);
});

test('禁止目录下更具体的 Allow 子路径胜出（最长匹配）', () => {
  const parsed = parseRobots(sample);
  const denied = decide('genericbot', '/private/secret.txt', parsed);
  assert.equal(denied.allowed, false);
  assert.equal(denied.winningRule?.pattern, '/private');

  const allowed = decide('genericbot', '/private/public/logo.png', parsed);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.winningRule?.pattern, '/private/public');
});

test('查询串参与结尾美元符号匹配，路径大小写敏感', () => {
  const parsed = parseRobots(sample);
  // 以 .json 结尾（含查询串时不是“结尾”）
  assert.equal(decide('genericbot', '/data/list.json', parsed).allowed, false);
  assert.equal(decide('genericbot', '/data/list.json?format=raw', parsed).allowed, true);
  // 大小写敏感：/PRIVATE 不命中 /private
  assert.equal(decide('genericbot', '/PRIVATE/a', parsed).allowed, true);
});

test('空 Disallow 表示允许全部，专用组优先于星号组', () => {
  const parsed = parseRobots(sample);
  const decision = decide('archiver', '/private/secret.txt', parsed);
  assert.equal(decision.allowed, true);
  assert.equal(decision.groupMatch.matchType, 'exact');
  assert.equal(decision.winningRule?.allowAll, true);
});

test('机器人名称不区分大小写', () => {
  const parsed = parseRobots(sample);
  const decision = decide('ArChIvEr', '/tmp/x', parsed);
  assert.equal(decision.groupMatch.matchedName, 'archiver');
  assert.equal(decision.allowed, true);
});

test('同名的多个星号组被合并', () => {
  const parsed = parseRobots(sample);
  const star = parsed.byName.get('*')!;
  const patterns = star.rules.map((rule) => rule.pattern);
  assert.ok(patterns.includes('/private'));
  assert.ok(patterns.includes('/*.json$'));
});

test('名称前缀匹配取最长声明名，且优先于星号组', () => {
  const text = `
User-agent: googlebot
Disallow: /g
User-agent: googlebot-news
Disallow: /gn
User-agent: *
Disallow: /star
`;
  const parsed = parseRobots(text);
  assert.equal(
    selectGroup('googlebot-news-image', parsed).matchedName,
    'googlebot-news',
  );
  assert.equal(selectGroup('googlebot-image', parsed).matchedName, 'googlebot');
  assert.equal(selectGroup('otherbot', parsed).matchedName, '*');
  assert.equal(decide('googlebot-image', '/g/x', parsed).allowed, false);
  assert.equal(decide('googlebot-image', '/star/x', parsed).allowed, true);
});

test('同有效长度时 Allow 优先', () => {
  const text = `
User-agent: *
Disallow: /x
Allow: /x
`;
  const parsed = parseRobots(text);
  assert.equal(decide('bot', '/x', parsed).allowed, true);
});

test('通配符有效长度只计字面字符', () => {
  assert.equal(effectiveLength('/a/*.css$'), '/a/.css'.length);
  assert.deepEqual(matchPattern('/a/*.css', '/a/x/y.css'), { matchedSpan: '/a/x/y.css'.length });
  assert.equal(matchPattern('/a/*.css$', '/a/x/y.css?x=1'), null);
  assert.deepEqual(matchPattern('/*.json$', '/d/list.json'), { matchedSpan: 12 });
});

test('空规则文本：无组，默认放行并给出原因', () => {
  const parsed = parseRobots('# 只有注释\n\n');
  const decision = decide('bot', '/anything', parsed);
  assert.equal(decision.allowed, true);
  assert.equal(decision.groupMatch.matchType, 'none');
  assert.match(decision.reason, /默认放行/);
});

test('组存在但无规则命中：默认放行', () => {
  const parsed = parseRobots('User-agent: *\nDisallow: /tmp\n');
  const decision = decide('bot', '/ok', parsed);
  assert.equal(decision.allowed, true);
  assert.match(decision.reason, /没有规则匹配/);
});

test('不认识的指令进入诊断，Sitemap 仅存元数据', () => {
  const text = `
User-agent: *
Disallow: /a
Crawl-delay: 5
Sitemap: https://x/sitemap.xml
`;
  const parsed = parseRobots(text);
  assert.equal(parsed.unknown[0]?.field, 'crawl-delay');
  assert.deepEqual(parsed.sitemaps, ['https://x/sitemap.xml']);
});

test('连续多个 User-agent 共享后续规则', () => {
  const text = `
User-agent: a
User-agent: b
Disallow: /shared
`;
  const parsed = parseRobots(text);
  assert.equal(decide('a', '/shared/1', parsed).allowed, false);
  assert.equal(decide('b', '/shared/1', parsed).allowed, false);
});

test('规则行之后的新 User-agent 开启新记录', () => {
  const text = `
User-agent: a
Disallow: /a
User-agent: b
Disallow: /b
`;
  const parsed = parseRobots(text);
  assert.equal(decide('a', '/b/x', parsed).allowed, true);
  assert.equal(decide('b', '/a/x', parsed).allowed, true);
});

test('行内注释与字段空白被容忍', () => {
  const text = 'User-agent:  *   # tail comment\n  Disallow :  /x # nope\n';
  const parsed = parseRobots(text);
  assert.equal(decide('bot', '/x/y', parsed).allowed, false);
});

test('路径校验拒绝非绝对路径与非 ASCII', () => {
  assert.ok(validatePath('relative'));
  assert.ok(validatePath('/caf\u00e9'));
  assert.equal(validatePath('/ok?x=1'), null);
});

