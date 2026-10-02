# robots.txt 规则解释与抓取准入实验服务（本地后端）

一个只运行在本机 Windows 上的 robots.txt 规则实验室：导入虚构站点的规则文本，
输入机器人名称与 URL 路径，返回 **允许 / 禁止抓取** 的判定及匹配依据；
支持保存规则版本、用同一批路径比较两个版本的差异。

- 只分析文本：**不访问网站、不发送抓取请求、不实现 HTTP 缓存**
- 技术栈：TypeScript + Node.js（内置 `node:http` / `node:sqlite`，零运行时第三方依赖）
- 仅 API + CLI，无前端页面；不依赖 Docker、WSL、付费服务或外部在线 API
- 数据保存在项目内 `data/` 目录的 SQLite 文件中

## 环境要求

- Node.js ≥ 22（开发与验证使用 Node v25.5.0；使用内置 `node:sqlite`，可能在 stderr 输出实验性警告，不影响功能）
- Windows PowerShell（命令同样适用 cmd）

## 构建、测试、启动

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # tsc 编译到 dist/
npm test           # 编译 + 运行 node:test 全部测试
npm start          # 启动 API（默认自选空闲端口）
```

指定端口与数据文件：

```powershell
node dist/cli.js serve --port 8080 --db data/robots-lab.db
# --port 0 或不传 --port：操作系统分配空闲端口，启动后打印实际地址
```

## 规则优先级与命中长度口径（实现依据）

1. **机器人名称匹配不区分大小写；路径匹配区分大小写。**
2. **User-agent 组选择顺序**（先具体后兜底）：
   1. 名称**精确相同**（大小写不敏感），如请求 `archiver` 命中 `User-agent: archiver`；
   2. 否则选**最长前缀**声明名，如请求 `googlebot-news-image` 命中 `googlebot-news`，
      请求 `googlebot-image` 命中 `googlebot`；
   3. 否则使用星号组 `User-agent: *`（星号只是“兜底组名”，不做名称通配）；
   4. 都没有：无适用组，**默认放行**。
3. **同名的多个组合并**：同一名称（大小写不敏感）无论出现几次、是否被空行隔开，
   其 Allow / Disallow 规则合并为一个组；连续多个 `User-agent:` 行共享其后的规则。
4. **路径匹配**：路径必须从开头匹配规则模式。
   - `*` 匹配任意长度（含零长度）的任意字符序列；
   - 结尾 `$` 是结束锚点，要求匹配恰好延伸到整条路径（含查询串）的末尾；
   - 查询串是路径输入的一部分，例如 `/*.json$` 不命中 `/a.json?x=1`；
   - 其余字符按字面、区分大小写匹配。
5. **获胜规则（有效路径长度口径）**：
   - 有效长度 = 模式中**字面字符的个数**；`*` 展开所匹配到的字符不计入，`$` 不计入；
   - 有效长度更大的规则获胜；
   - **有效长度相同（含同为 0）时 Allow 优先于 Disallow**；
   - **空 `Disallow:`（值为空）不表示禁止全部**，而是明确的“允许全部”
     （有效长度 0 的 Allow）。
6. 没有任何规则命中时，按 robots.txt 的默认立场**放行**。

输入范围（有意收窄）：路径必须是**已规范化的 ASCII 绝对路径**（以 `/` 开头，
可带 `?` 查询串）；不做 URL 解码、IDN、百分号大小写归一化；不接受空白、`#` 片段、
非 ASCII 或控制字符。支持空行、整行/行内 `#` 注释、字段名大小写及冒号两侧空白。
不认识的指令（如 `Crawl-delay`）保留在 `unknown` 诊断中、不影响判定；
`Sitemap` 只作为元数据保存，**绝不抓取**。

## 演示（可直接复制）

仓库自带虚构站点规则 `samples/robots-v1.txt` 与 `samples/robots-v2.txt`：

```text
User-agent: *
Disallow: /private
Disallow: /tmp
Allow: /private/public

User-agent: archiver
Disallow:

User-agent: *
Disallow: /*.json$

Sitemap: https://example.invalid/sitemap.xml
```

CLI 演示（公共目录 / 禁止目录下允许的子路径 / 查询串结尾匹配 / 专用机器人组）：

```powershell
npm run build
node dist/cli.js import  --name v1 --file samples/robots-v1.txt
node dist/cli.js import  --name v2 --file samples/robots-v2.txt
node dist/cli.js versions

# 公共目录默认放行
node dist/cli.js check --version v1 --robot genericbot --path "/"
# /private 下禁止
node dist/cli.js check --version v1 --robot genericbot --path "/private/secret.txt"
# 但允许更具体的子路径 /private/public（最长匹配）
node dist/cli.js check --version v1 --robot genericbot --path "/private/public/logo.png"
# 查询串导致不再以 .json 结尾，故 $ 规则不命中，默认放行
node dist/cli.js check --version v1 --robot genericbot --path "/data/list.json?format=raw"
# 不带查询串则被 *.json$ 禁止
node dist/cli.js check --version v1 --robot genericbot --path "/data/list.json"
# 专用机器人组 archiver 的空 Disallow = 允许全部（名称大小写不敏感）
node dist/cli.js check --version v1 --robot ARCHIVER --path "/private/secret.txt"

# 批量检查（结果落库，返回 batchId，可导出 JSON 报告）
node dist/cli.js batch --version v1 --items samples/paths.json --out data/batch-v1.json

# 用同一批路径比较两个版本（差异报告落库，返回 reportId）
node dist/cli.js compare --a v1 --b v2 --items samples/paths.json --out data/diff.json

# 重启后按报告 id 复查旧比较报告；按 batchId 复查旧批次可走 HTTP API
node dist/cli.js report --id 1

# 不入库的纯文本分析（解析结构 / 适用组 / 单条检查）
node dist/cli.js parse  --file samples/robots-v1.txt
node dist/cli.js groups --file samples/robots-v1.txt --robot googlebot-news
node dist/cli.js check  --file samples/robots-v1.txt --robot bot --path "/tmp/a"
```

所有 `check/compare/batch` 输出都包含所用规则组、组匹配方式（exact/prefix/wildcard/none）、
获胜规则（类型、模式、行号）、候选规则有效长度及中文 `reason`；
默认放行时会注明是“无适用组”还是“组内无规则命中”。

## HTTP API（JSON）

启动后基址为 `http://127.0.0.1:<port>`，仅监听本机回环地址。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/parse` | 仅解析文本，返回合并后的组、Sitemap、未知指令诊断 |
| POST | `/api/check` | 传 `content/robot/path`，不入库即时判定 |
| POST | `/api/versions` | 保存版本（`name` 唯一；重名返回 409，不覆盖） |
| GET | `/api/versions` | 版本列表（不含全文） |
| GET | `/api/versions/:idOrName` | 版本元信息 + 解析结构 |
| POST | `/api/versions/:idOrName/check` | 对已保存版本做单条判定 |
| POST | `/api/versions/:idOrName/batch` | 批量判定（`items`，默认落库；`persist:false` 不落库） |
| POST | `/api/compare` | 比较两个版本对同一批 `items` 的结果，保存报告 |
| GET | `/api/reports/:id` | 复查历史比较报告（重启后仍可） |
| GET | `/api/checks` | 批次 id 列表；`?batchId=...` 复查旧批次 |

PowerShell 调用示例：

```powershell
$body = @{ name = "v1"; content = Get-Content -Raw samples/robots-v1.txt } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/versions -Body $Body -ContentType "application/json"
```

### 错误码

所有错误返回 `{ "error", "code", "details?" }`：

| HTTP | code | 触发场景 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 名称/路径/请求体内容不合法、批次数超限（≤500）、比较同一版本 |
| 400 | `BAD_JSON` | 请求体不是合法 JSON |
| 404 | `VERSION_NOT_FOUND` / `REPORT_NOT_FOUND` / `NOT_FOUND` | 版本或报告不存在、路由不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 路由存在但方法不对 |
| 409 | `VERSION_EXISTS` | 版本名重复；**坏输入或重名绝不覆盖已有版本** |
| 500 | `INTERNAL_ERROR` | 未预期的服务端错误 |

## 目录结构

```
src/
  types.ts    # 领域类型与错误码
  parser.ts   # robots.txt 文本解析（组合并、空 Disallow、诊断、Sitemap 元数据）
  matcher.ts  # 组选择、* / $ 匹配、有效长度与 Allow 同长优先、输入校验
  db.ts       # SQLite：versions / check_records / reports
  service.ts  # 批量检查、跨版本比较、报告
  server.ts   # HTTP API（默认 127.0.0.1 + 空闲端口）
  cli.ts      # 命令行入口
samples/     # 可复制的虚构规则与路径清单
test/        # node:test 测试（匹配、合并、大小写、版本差异、重启复查、API）
data/        # 运行后自动创建，存放 SQLite 数据与导出的报告
```

## 明确不支持的范围（限制）

- 不是通用爬虫：不发任何网络请求，不抓取 Sitemap，不实现 HTTP 缓存 / 重验；
- 只实现上述公开子集，**不宣称支持各家爬虫的私有扩展**（如 `noindex`、`Crawl-delay`
  语义等），未知指令仅作为诊断保留；
- 不做 URL 解码、百分号大小写归一化、IDN/国际化域名、路径 `.`/`..` 规范化——
  调用方需自行完成规范化后再传入；
- 单条 robots 文本上限 1,000,000 字符，单批最多 500 条路径，请求体上限 2MB。
