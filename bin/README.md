# SecNotes · 一键分享工具

`demo.bat` —— 双击即可把站点通过 **SSH 反向隧道（localhost.run）** 公网分享给熟人，
访问者无需安装任何软件，链接是 **HTTPS**。

## 怎么用

1. 双击 `bin\demo.bat`（若 `admin.py` 在跑，脚本会自动停掉它）
2. **约 10 秒**后控制台打印一个 `https://xxxxxx.lhr.life` 链接，**已自动复制到剪贴板**
3. 把链接发给熟人即可
4. 按任意键或关窗 = 停止分享

## 访问者须知（提示给熟人）

- 直接打开就行——**HTTPS 已由服务端终止**，无需任何额外操作
- **没有** "Click to Continue" 防滥用页，也**没有** tunnel password
- 子域名**每次运行都会变**，所以每次分享都要把新链接发出去
  （注册 localhost.run 免费账号并上传公钥可固定域名，见 `https://localhost.run/docs/forever-free/`）
- 链接有效期 = 本窗口开着的时间；关窗就断

## 安全要点

- 脚本启动时**自动停掉 `admin.py`**，避免 `/api/sync` / `/api/upload` / `/api/delete`
  这些写接口被公网访问到
- 只起一个**只读静态 HTTP 服务**（`python -m http.server --bind 127.0.0.1`），
  即使被隧道到公网，访问者也只能看不能改
- 关窗时自动停掉 ssh 隧道与静态服务

## 链路结构

```
[熟人浏览器]
    ↓ https://xxxxxx.lhr.life        （HTTPS，服务端 TLS 终止）
[localhost.run 网关]                  ← 公网
    ↓ SSH 反向隧道（本机主动连出 :22）
[本机 127.0.0.1:8090]                 ← python -m http.server，只读
    ↓ 文件
[D:\Work Buddy\个人博客\]              ← index.html / assets/ / data/
```

`notes/` `admin.py` `manage.html` `.trash/` `.workbuddy/` 等**不会**被暴露。

## 为什么不用 localtunnel（2026-09-12 实测结论）

最初用的是 localtunnel，在这台机器/这条网络上**完全不可用**：

| 目标 | 结果 |
| --- | --- |
| `localtunnel.me:443` | ❌ **TCP 超时**（6008 ms，无 RST） |
| `localtunnel.me:80` | ✅ 通（249 ms） |
| `bore.pub:7835` | ✅ 通（283 ms） |
| `serveo.net:22` | ✅ 通（236 ms） |
| **`localhost.run:22`** | ✅ **通（280 ms）** |

localtunnel 客户端默认连 `https://localtunnel.me`（443），连接被静默丢弃 →
**客户端不报错、不退出、一行输出都没有**，只能干等到超时。
即使显式改成 `--host http://localtunnel.me` 走 80 端口，控制通道仍然建不起来（实测 45 秒 0 字节输出）。

换到 `localhost.run` 的 SSH 反向隧道后：**3 秒建立连接，9 秒拿到链接**，且零 npm 依赖
（用 Windows 自带的 `ssh.exe`）。

## ⚠️ 网关在国内被阻断（2026-09-12 实测，务必先读）

**这一条比"用哪个隧道工具"更重要。** 本机实测多个隧道网关的可达性：

| 网关 | 结果 | 说明 |
| --- | --- | --- |
| `localtunnel.me` | ❌ 超时 | 443 静默丢包 |
| **`*.lhr.life`**（localhost.run） | ❌ **Connection reset** | TLS 阶段被重置 |
| `pinggy.io` | ❌ reset | |
| `bore.pub` | ❌ 超时 | |
| `ngrok-free.app` | ❌ reset | 数据面不通 |
| `chmlfrp.cn` | ❌ reset | |
| `serveo.net` | ✅ 200 | 但拒绝匿名绑定 80 端口 |
| `tunnel.pyjam.as` | ✅ 200 | 但要求 SSH 公钥 |
| **`cpolar.com`** | ✅ **200** | 国内 IP `36.250.79.185` |
| **`natapp.cn`** | ✅ **200** | 国内 IP `36.251.253.141` |
| **`natfrp.com`（SakuraFrp）** | ✅ **200** | 国内节点 |
| **`oray.com`（花生壳）** | ✅ **200** | 国内节点 |

**结论**：免费境外隧道在国内基本走不通。访客在国内时，`*.lhr.life` 这类境外网关会被
主动重置 —— **隧道建得起来，链接却打不开**。

**因此 `demo.ps1` 加了公网可达性自检**：拿到 URL 后会真的去 HEAD 请求一次，成功才报
`OK (HTTP 200)`，否则明确报 `FAILED` 并提示换用国内网关。
**看到 `FAILED` 就不要把链接发给别人。**

### 在国内可用的方案（按推荐度）

| 方案 | 成本 | 访客要求 | 说明 |
| --- | --- | --- | --- |
| **国内穿透服务**（cpolar / natapp / SakuraFrp / 花生壳） | 免费版够用 | 无 | 网关在国内，访客直连。需注册账号拿 token；免费版带宽/流量有限，但看静态页足够 |
| **国内轻量云 + frp** | ~¥60-100/年 | 无 | 最稳最快。非 80/443 端口不需要备案 |
| **Tailscale（熟人装客户端）** | 0 | 需装客户端 | 国内可达，直连速度最好，但只能给"愿意装软件"的人看 |
| **备案 + 对象存储** | 域名钱 | 无 | 长期方案，见项目根 README |

## 出问题怎么办

| 现象 | 解决 |
| --- | --- |
| `[ERROR] ssh.exe not found` | 启用 Windows 可选功能：设置 → 系统 → 可选功能 → 添加 → **OpenSSH 客户端** |
| `[ERROR] Cannot reach localhost.run port 22` | 出网 22 端口被防火墙/代理拦了。放行 22，或改用 frp + 自备 VPS |
| `port 8090 is busy - looking for leftovers...` | **正常提示**，脚本会自己清掉上一轮的残留，然后继续。看到 `cleaned: ...` 就是清掉了 |
| `[ERROR] Port 8090 is still in use by another program` | 被**别的**程序占了（不是本工具）。脚本会打印 pid / 进程名 / 命令行，照它给的 `taskkill /PID x /F` 处理 |
| `[ERROR] Static server failed to start` | 看它打印的 `output:`；多半是项目根识别错 |
| `[FAILED] No public URL within 60 s` | 看 `.workbuddy\memory\demo-tunnel.log` 里 ssh 的原始输出 |
| **`Checking the URL is reachable ... FAILED`** | **网关被你的网络阻断，链接对访客也不可用**（见上一节）。别发出去，换国内穿透服务或自建 frp |
| 控制台出现 `'xxx' 不是内部或外部命令` | `.bat` 里混入了非 ASCII 字符（见下方"编码红线"） |
| 链接能生成但访问者打不开 | 你的出口防火墙拦了回程；考虑 frp + 自备 VPS |

### 关于残留进程（已自愈，但值得知道原因）

**用右上角 × 关窗会跳过清理代码**（PowerShell 被强杀），于是 `http.server` 与 ssh 隧道会变成
孤儿进程继续跑——旧隧道甚至还在对外提供服务。

现在不用你管：**下次运行 `demo.bat` 会自动识别并清掉它们**，日志里会显示：

```
    port 8090 is busy - looking for leftovers from a previous run...
    cleaned: stale http.server (pid 2972)
    cleaned: stale ssh tunnel (pid 3984)
```

清理范围是严格限定的，**只认这两种**：
- `python.exe` 且命令行含 `http.server` 且端口号匹配
- `ssh.exe` 且命令行含 `localhost.run`

其他程序占用端口时不会被动，只会**报告** pid / 名称 / 命令行让你自己决定。

想手工彻底清一遍：

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*http.server*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
  Where-Object { $_.CommandLine -like '*localhost.run*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**建议：演示完用「按任意键」退出，而不是点 ×**，这样正常清理会走一遍（也更干净）。

## 编码红线（改这两个文件前必读）

踩过的坑都是**改完就闪退**级别的：

1. **`demo.bat` 必须纯 ASCII**
   cmd.exe 按系统 OEM 代码页（中文系统为 GBK）逐行读取 `.bat`。一旦出现 UTF-8 的中文
   （**即使是 `REM` 注释**），多字节序列会吃掉行边界，`REM` 前缀被冲掉，整行变成非法命令，
   `if errorlevel 1 ( ... )` 这类多行块也报"命令语法不正确"，于是窗口**一闪就关**
   （退出码 255，用户看不到任何原因）。失败分支一定要 `pause`。

2. **`demo.ps1` 必须纯 ASCII**
   PowerShell 5.1 读无 BOM 的 `.ps1` 用系统 OEM 代码页，非 ASCII 字节会被错误解码。
   项目根路径含中文，所以脚本里**不写死路径**，改为从自身位置推导：
   `$ROOT = Split-Path -Parent $PSScriptRoot`（脚本在 `bin\` 里，父目录即项目根）。

3. **两个文件都用 CRLF 行尾**（`.bat` 在 LF 下解析多行括号块容易出错）。

改完跑一遍复核：

```python
d = open(path, 'rb').read()
assert d.count(b'\n') == d.count(b'\r\n')     # 全 CRLF
d.replace(b'\r\n', b'').decode('ascii')        # 纯 ASCII，不抛异常即通过
```

## 为什么不用 Start-Process（重要）

`demo.ps1` 里所有子进程都通过 `System.Diagnostics.Process` 启动，**刻意避开 `Start-Process`**。

PowerShell 5.1 的 `Start-Process` 在带 `-RedirectStandardOutput` / `-RedirectStandardError`
时会重建子进程环境块，把它塞进一个**大小写不敏感的字典**。只要进程环境里同时存在仅大小写不同的
变量名（`Path`/`PATH`、`HTTP_PROXY`/`http_proxy`——绝大多数 Windows 机器都有），就会抛：

```
已添加项。字典中的关键字:"Path"所添加的关键字:"PATH"
```

实测对照：`Start-Process` **不重定向**可用；**带重定向必抛异常**；
`System.Diagnostics.Process`（含重定向）**完全正常**。

因此：静态服务与 ssh 都用它启动，输出用 `BeginOutputReadLine` / `BeginErrorReadLine`
+ 事件回调收集到 `ConcurrentQueue`（既避免管道缓冲区写满阻塞子进程，也便于解析 URL）。
`RedirectStandardInput = $true` 且从不写入，保证子进程读不到 EOF（否则 ssh 会话会断）。

## 参数细节（别乱改）

ssh 命令实际是：

```
ssh -T
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL
    -o ServerAliveInterval=20 -o ServerAliveCountMax=3
    -o ExitOnForwardFailure=yes
    -R 80:localhost:8090
    nokey@localhost.run
```

- **不能加 `-N`**：实测加了之后**不再打印 URL**（`-N` 表示不执行远程命令）
- `-T` 是安全的，实测 3 秒出 URL 且会话存活
- `UserKnownHostsFile=NUL` 避免往用户的 `known_hosts` 里写东西
- `ServerAliveInterval/CountMax` 让空闲隧道不断线
- URL 正则：`https://[a-z0-9-]+\.lhr\.life`；匹配前**要先剥掉 ANSI 颜色码**
  （输出里有 `\x1b[7m` 反显码，用于绘制二维码）

## 端口与文件

- 端口：**8090**（只读静态服务）。如冲突改 `demo.ps1` 里的 `$PORT`
- 日志：`.workbuddy\memory\demo-tunnel.log`（ssh 输出）、`demo-server.log`（静态服务输出，仅失败时写）
- 不写任何文件到 `notes/` / `data/` / `.trash/`

## 想换工具？

| 想换为 | 改哪 |
| --- | --- |
| `serveo.net` | 把 `$TUN_HOST`/`$TUN_USERHOST`/`$URL_RE` 换成 `serveo.net` / `serveo.net` / `https://[a-z0-9-]+\.serveo\.net`（实测 :22 可达） |
| `bore` | 实测 `bore.pub:7835` 可达；命令是 `npx bore local 8090 --to bore.pub`，但只给 HTTP 且端口随机 |
| `frp` | 需要一台公网 VPS + frps，长期稳定场景首选；详见项目根 README 的方案对比 |
