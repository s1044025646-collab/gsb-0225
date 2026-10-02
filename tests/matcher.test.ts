import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRobots } from "../src/parser.js";
import { checkPath, effectiveLength, selectGroups } from "../src/matcher.js";

const sample = `
User-agent: *
Disallow: /private/
Allow: /private/public/
Disallow:

User-agent: archiver-bot
Disallow: /archive/

User-agent: archiver-bot
Allow: /archive/open/
`;

describe("最长匹配与 Allow 优先", () => {
  const parsed = parseRobots(sample);

  it("父规则禁止，更长的 Allow 子路径放行", () => {
    const denied = checkPath(parsed, "freshbot", "/private/secret");
    assert.equal(denied.allowed, false);
    assert.equal(denied.winningRule?.pattern, "/private/");

    const allowed = checkPath(parsed, "freshbot", "/private/public/x");
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.winningRule?.pattern, "/private/public/");
    assert.ok(allowed.winningRule!.score > denied.winningRule!.score);
  });

  it("同有效长度时 Allow 胜出", () => {
    const tie = parseRobots(`
User-agent: *
Disallow: /a
Allow: /a
`);
    const result = checkPath(tie, "bot", "/a");
    assert.equal(result.allowed, true);
    assert.match(result.reason, /Allow 优先/);
  });

  it("空 Disallow 不表示禁止全部", () => {
    const result = checkPath(parsed, "freshbot", "/anything");
    assert.equal(result.allowed, true);
    assert.equal(result.defaultAllow, true);
  });

  it("无匹配默认放行并给出原因", () => {
    const result = checkPath(parsed, "freshbot", "/public/index.html");
    assert.equal(result.allowed, true);
    assert.equal(result.winningRule, null);
    assert.match(result.reason, /默认允许/);
  });
});

describe("用户代理组选择", () => {
  const parsed = parseRobots(sample);

  it("具体组优先于星号组", () => {
    const selected = selectGroups(parsed, "Archiver-Bot/2.0");
    assert.equal(selected.matchedAgentToken, "archiver-bot");
  });

  it("同名多个组被合并", () => {
    const selected = selectGroups(parsed, "archiver-bot");
    assert.equal(selected.groupLines.length, 2);
    assert.equal(selected.rules.length, 2);
  });

  it("无具体匹配才回退星号组", () => {
    const selected = selectGroups(parsed, "other-bot");
    assert.equal(selected.matchedAgentToken, "*");
  });

  it("取最具体（最长）的匹配令牌", () => {
    const multi = parseRobots(`
User-agent: bot
Disallow: /short/
User-agent: super-bot
Disallow: /long/
`);
    const selected = selectGroups(multi, "super-bot");
    assert.equal(selected.matchedAgentToken, "super-bot");
    assert.deepEqual(selected.rules[0].pattern, "/long/");
  });

  it("机器人名称匹配不区分大小写", () => {
    const result = checkPath(parsed, "ARCHIVER-BOT", "/archive/x");
    assert.equal(result.allowed, false);
    assert.equal(result.matchedAgentToken, "archiver-bot");
  });
});

describe("大小写与通配 / 美元符", () => {
  const parsed = parseRobots(`
User-agent: *
Disallow: /Private/
Disallow: /*.tmp$
Allow: /*/open$
`);

  it("路径匹配区分大小写", () => {
    assert.equal(checkPath(parsed, "b", "/private/x").allowed, true);
    assert.equal(checkPath(parsed, "b", "/Private/x").allowed, false);
  });

  it("星号跨目录，美元符锚定结尾", () => {
    const tmp = checkPath(parsed, "b", "/a/b/c.tmp");
    assert.equal(tmp.allowed, false);
    assert.equal(checkPath(parsed, "b", "/a/b/c.tmp/extra").allowed, true);
  });

  it("有效长度剔除星号与结尾美元符", () => {
    assert.equal(effectiveLength("/*.tmp$"), 5);
    assert.equal(effectiveLength("/private/"), 9);
  });
});

describe("查询串与空规则文件", () => {
  it("查询串参与结尾美元符匹配", () => {
    const parsed = parseRobots(`
User-agent: *
Disallow: /*?print=1$
`);
    assert.equal(checkPath(parsed, "b", "/page?print=1").allowed, false);
    assert.equal(checkPath(parsed, "b", "/page?print=1&x=2").allowed, true);
  });

  it("空规则（只有注释/空行）全部默认放行", () => {
    const parsed = parseRobots("# only a comment\n\n");
    const result = checkPath(parsed, "b", "/");
    assert.equal(result.allowed, true);
    assert.equal(result.matchedAgentToken, null);
  });
});

describe("诊断", () => {
  it("保留未知指令、畸形行与无效路径", () => {
    const parsed = parseRobots(`
User-agent: *
Crawl-delay: 5
Disallow: relative
this line has no colon meaning
Disallow: /ok
`);
    const codes = parsed.diagnostics.map((d) => d.code);
    assert.ok(codes.includes("UNKNOWN_DIRECTIVE"));
    assert.ok(codes.includes("MALFORMED_LINE"));
    assert.ok(codes.includes("INVALID_PATH"));
  });

  it("Sitemap 作为元数据保存", () => {
    const parsed = parseRobots(`Sitemap: https://x/sitemap.xml`);
    assert.equal(parsed.sitemaps[0].url, "https://x/sitemap.xml");
  });
});
