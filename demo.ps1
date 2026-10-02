# robots-lab 本地演示：仅做文本规则实验，不发起任何网络访问。
$ErrorActionPreference = "Stop"

$demoDb = Join-Path $PSScriptRoot "data\demo.sqlite"
Remove-Item -Force -ErrorAction SilentlyContinue $demoDb, "$demoDb-wal", "$demoDb-shm"
$cli = "node --experimental-sqlite $PSScriptRoot\dist\src\cli.js --db $demoDb"

Write-Host "== 1. 导入两个规则版本 ==" -ForegroundColor Cyan
Invoke-Expression "$cli import --name v1 --file $PSScriptRoot\examples\robots-v1.txt"
Invoke-Expression "$cli import --name v2 --file $PSScriptRoot\examples\robots-v2.txt"

Write-Host "`n== 2. 列出版本 ==" -ForegroundColor Cyan
Invoke-Expression "$cli list"

Write-Host "`n== 3. 解释 archiver-bot 适用的组合并结果 ==" -ForegroundColor Cyan
Invoke-Expression "$cli explain --version 1 --robot archiver-bot"

Write-Host "`n== 4. 公共目录 / 禁止目录下放行的子路径 / 查询串结尾匹配（v1） ==" -ForegroundColor Cyan
Invoke-Expression "$cli check --version 1 --robot freshbot --paths /index.html,/private/public/a.txt,/x.tmp,/page?print=1,/archive/open/x"

Write-Host "`n== 5. 专用机器人 archiver-bot ==" -ForegroundColor Cyan
Invoke-Expression "$cli check --version 1 --robot archiver-bot --paths /archive/x,/archive/open/x"

Write-Host "`n== 6. 比较 v1 与 v2（/tmp 放开、?print=1 收紧） ==" -ForegroundColor Cyan
Invoke-Expression "$cli compare --from 1 --to 2 --robot freshbot --paths /tmp,/page?print=1,/private/x --out $PSScriptRoot\data\demo-compare.json"

Write-Host "`n演示完成，比较报告: data\demo-compare.json，数据库: data\demo.sqlite" -ForegroundColor Green
