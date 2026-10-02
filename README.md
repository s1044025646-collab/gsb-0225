# robots-lab：本地 robots.txt 规则解释与抓取准入实验服务

一个只跑在 Windows 本地的 **robots.txt 文本规则实验后端**（API + CLI）。导入虚构站点的规则文本，输入机器人名称和路径，返回**允许 / 禁止**结论以及完整匹配依据（用了哪个规则组、哪条规则获胜、或为何默认放行），并支持规则版本保存、同批路径跨版本比较、检查报告持久化。

**本服务只分析文本，不访问网站、不发送抓取请求、不实现 HTTP 缓存、不解析 Sitemap 内容。** 不依赖 Docker、WSL、付费服务或任何在线 API；SQLite 使用 Node.js 内置的 `node:sqlite`，无需原生编译。

## 环境要求

- Windows + Node.js **22.5+**（开发与实测于 Node v25.5；`node:sqlite` 需要 `--experimental-sqlite`，脚本已带）
- npm（随 Node 安装）

## 安装、构建、测试、启动

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # node:test 单元 + 集成测试（20 个用例）
npm run dev        # 直接以 tsx 启动 API（开发用）
npm start          # 以编译产物启动 API
npm run demo       # 一键跑完整 CLI 演示（见下文）
```

启动后输出实际监听地址。默认 `PORT=0`，由操作系统分配**空闲端口**（仅监听 `127.0.0.1`）。固定端口：

```powershell
$env:PORT = "8080"; npm start
```

数据目录固定在项目内 `data/`，数据库默认 `data/robots-lab.sqlite`；API 可用环境变量 `ROBOTS_DB_PATH` 覆盖，CLI 可用全局参数 `--db <路径>` 覆盖。

## 规则语义（本项目支持的公开子集）

### User-agent 组选择

- 机器人名称匹配**不区分大小写**，路径匹配**区分大小写**。
- 选择最具体的适用组：在所有能匹配机器人名称的非 `*` 令牌中，取**令牌字符串长度最长**者；例如机器人 `super-bot/1.0` 同时命中令牌 `bot` 与 `super-bot` 时，选 `super-bot`。
- 普通令牌按 RFC 9309 的子串规则匹配：令牌是机器人名称的子串即适用（`googlebot-image` 可匹配 `googlebot`）。
- **只有不存在任何具体匹配时**才回退到 `*` 组。
- 同名机器人分散在多个规则组时，这些组的 Allow/Disallow 规则在选择阶段**合并**后一起参与决胜（`explain` 会返回被合并组的行号区间）。

### 路径匹配与优先级

- 规则模式锚定路径开头匹配；`*` 匹配任意数量（含 0 个）任意字符；仅当 `$` 出现在模式**末尾**时表示必须在路径结尾命中，其他位置的 `$` 按普通字符处理。
- 命中的多条规则中，**有效路径长度最长者获胜**。
- **有效路径长度（命中长度）口径**：模式字符总数，减去 `*` 的个数，再减去 1 个结尾 `$`（若有）。例如 `/*.tmp$` 的有效长度为 5（`/`,`.`,`t`,`m`,`p`），`/private/` 为 9。该口径刻意不计算 `*` 所“展开”的字符，只比较规则字面量的具体程度，确定且可复现。
- 有效长度相同且一条 Allow 一条 Disallow 时，**Allow 优先**。
- `Disallow:`（空值）表示“不限制任何路径”，**绝不表示禁止全部**，空规则不参与决胜。
- 没有任何规则命中（或根本没有适用组）时：**默认允许抓取**，结果中 `defaultAllow: true` 并给出中文原因。

### 解析约定与输入限制

- 支持空行、整行/行内 `#` 注释、字段冒号两侧的空白；字段名大小写不敏感。
- 路径输入限定为**已规范化的 ASCII 路径，可带查询串**：必须以 `/` 开头，不含空白、不含 `#` 片段。**不做** URL 解码、百分号归一化、国际化域名/Unicode 归一化。查询串参与模式匹配（因此 `/*?print=1$` 可命中 `/p?print=1`）。
- `Sitemap:` 仅保存为版本元数据返回，不抓取。
- 不认识的指令（如 `Crawl-delay`）不参与判定，但以诊断记录保留（`UNKNOWN_DIRECTIVE`）；畸形行、无效路径等同样给出带行号的诊断码。
- 本项目只实现上述公开子集，**不宣称支持任何爬虫厂商的私有扩展指令**。

## API

所有错误返回 `{ "code": "...", "message": "..." }`，主要错误码：`BAD_JSON`、`INVALID_NAME`、`INVALID_ROBOTS_TEXT`、`INVALID_ROBOT`、`INVALID_PATH`、`INVALID_BATCH`、`INVALID_VERSION_ID`、`VERSION_EXISTS`(409)、`VERSION_NOT_FOUND`(404)、`CHECK_NOT_FOUND`(404)、`VERSION_SAME`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/versions` | 导入版本：`{name, robotsText}`，返回解析诊断与 sitemap 元数据 |
| GET | `/api/versions` | 版本列表 |
| GET | `/api/versions/{id}` | 版本详情（含原文、诊断、sitemap） |
| POST | `/api/versions/{id}/explain` | `{robot}` 返回选中/合并的规则组与行号 |
| POST | `/api/versions/{id}/check` | `{robot, paths:[...]}`（1–100 条），持久化批次并返回逐条结论 |
| GET | `/api/reports/{batchId}` | 复查历史检查报告（重启后仍可读取） |
| POST | `/api/compare` | `{fromVersionId, toVersionId, robot, paths}` 返回逐条差异与变化计数 |

PowerShell 调用示例：

```powershell
$base = "http://127.0.0.1:<实际端口>"
$body = @{ name = "v1"; robotsText = Get-Content -Raw examples/robots-v1.txt } | ConvertTo-Json
$v = Invoke-RestMethod -Method Post "$base/api/versions" -ContentType 'application/json' -Body $body
$check = @{ robot = "freshbot"; paths = @("/index.html","/private/public/a.txt","/x.tmp","/page?print=1") } | ConvertTo-Json
Invoke-RestMethod -Method Post "$base/api/versions/$($v.id)/check" -ContentType 'application/json' -Body $check
```

单条结果字段：`allowed`（结论）、`defaultAllow`（是否因无规则命中而放行）、`matchedAgentToken`（命中的机器人令牌，`*` 或 `null`）、`groupLines`（所用规则组原文行号）、`winningRule`（获胜规则及 `score` 有效长度；无命中为 `null`）、`reason`（中文判定依据）。

## CLI

```powershell
node --experimental-sqlite dist/src/cli.js import  --name v1 --file examples/robots-v1.txt
node --experimental-sqlite dist/src/cli.js list
node --experimental-sqlite dist/src/cli.js get     --version 1
node --experimental-sqlite dist/src/cli.js explain --version 1 --robot archiver-bot
node --experimental-sqlite dist/src/cli.js check   --version 1 --robot freshbot --paths /index.html,/private/public/a.txt,/x.tmp,/page?print=1
node --experimental-sqlite dist/src/cli.js check   --version 1 --robot archiver-bot --paths-file paths.txt
node --experimental-sqlite dist/src/cli.js report  --batch 1 --out data/report.json
node --experimental-sqlite dist/src/cli.js compare --from 1 --to 2 --robot freshbot --paths /tmp,/page?print=1,/private/x --out data/cmp.json
```

- 导入规则可用 `--text "..."` 或 `--file <文件>`；路径可用 `--paths /a,/b`（逗号分隔）或 `--paths-file`（每行一条、`#` 开头忽略）。
- 任何命令后加 `--out <文件>` 可导出 JSON 报告；加全局 `--db <路径>` 可换数据库。
- 坏输入（重名、非法路径等）返回非零退出码与错误 JSON，**不会覆盖已有版本**（版本按名称唯一）。

## 一键演示

`examples/robots-v1.txt` 与 `examples/robots-v2.txt` 覆盖：公共目录默认放行、禁止目录下用更长 Allow 放行子路径、`*` 与结尾 `$`（含查询串 `?print=1`）匹配、`archiver-bot` 专用组及其同名多组合并。

```powershell
npm run demo
```

演示使用独立数据库 `data/demo.sqlite`（每次自动重建），依次执行导入、列表、组解释、单批检查、专用机器人检查、跨版本比较，比较报告写入 `data/demo-compare.json`。

## 可复制的规则文本

```text
# robots.txt（虚构站点 example.invalid，仅作文本实验）
User-agent: *
Disallow: /private/
Allow: /private/public/
Disallow: /tmp
Disallow: /*.tmp$

# 同名机器人分散在两个组，选择阶段必须合并
User-agent: archiver-bot
Disallow: /archive/

User-agent: archiver-bot
Allow: /archive/open/

Sitemap: https://example.invalid/sitemap.xml
```

预期结论（v1，`freshbot`）：

| 路径 | 结论 | 依据 |
| --- | --- | --- |
| `/index.html` | 允许 | `*` 组无规则命中，默认放行 |
| `/private/public/a.txt` | 允许 | Allow `/private/public/` 有效长度 16 > Disallow `/private/` 的 9 |
| `/x.tmp` | 禁止 | `/*.tmp$` 结尾命中，有效长度 5 |
| `/page?print=1` | 允许（v1）→ 禁止（v2） | v2 新增 `/*?print=1$` |

`archiver-bot` 访问 `/archive/open/x`：两个同名组合并后，Allow `/archive/open/`（长度 14）胜过 Disallow `/archive/`（长度 9），允许；访问 `/archive/x` 则禁止。

## 项目结构

```text
src/parser.ts      文本解析（记录模型、诊断、sitemap 元数据）
src/matcher.ts     组选择、模式匹配、有效长度、Allow 决胜、默认放行
src/validation.ts  输入校验与错误码
src/db.ts          node:sqlite 建表与连接（versions / check_batches / check_results）
src/service.ts     版本、检查、报告、跨版本比较
src/server.ts      node:http JSON API（127.0.0.1，默认空闲端口）
src/cli.ts         命令行入口
tests/             node:test 单元 + 集成测试（含重启后复查报告、HTTP 端到端）
examples/          两个虚构规则版本
```

## 明确的范围限制

- 仅支持 `User-agent` / `Allow` / `Disallow` / `Sitemap`；`Crawl-delay` 等私有/未支持指令只做诊断，不影响结论。
- 输入路径假定已规范化，不做 URL 解码、百分号/大小写/IDN 归一化，不接受片段。
- 不抓取 sitemap、不发起任何网络请求、不实现缓存协商。
- `node:sqlite` 当前为 Node 的实验性模块（启动有 ExperimentalWarning，属正常）。
