# Windows 7/10 大屏程序 display.exe 部署

> 更新说明（账号版）：服务端新增了**班级留言**（`type: "announcement"`，含 `title`、`body`、`author`、`priority`、`queued`）。新版 `display.exe` 会以独立版式显示留言（标题 + 正文 + 发布人，没有「收到」按钮），并在底部提示等待显示的条数。旧版 exe 收到留言快照会当作清屏处理，不会显示错误内容，但要显示留言必须替换为新版。`display.ini` 不需要改。
>
> 编译产物由 GitHub Actions 自动生成：推送到 `main` 会在 CI 的 Artifacts 里得到 `display.exe`；打 `v*` 标签会发布带 ZIP 和校验文件的 Release。

大屏端不再依赖浏览器，而是一个**完整的 32 位原生 Windows 程序** `display.exe`：单文件、静态链接、零运行时依赖（不需要 .NET、VC 运行库、Electron 或浏览器），在 32 位和 64 位的 Windows 7 SP1 / Windows 10 上都能直接运行。

**每台大屏机永久绑定一个班级**：`display.ini` 里的 `class_id=` 决定它连接哪个班的事件流，没有这一项程序拒绝启动，绝不会默认进入任何班级。`display.html?class=<班级id>` 仍然保留，可以在其他设备的浏览器里同时打开。

## 1. 它做什么

| 状态 | 行为 |
| --- | --- |
| 启动 | 读取旁边的 `display.ini`，以**最大化的普通窗口**打开（右上角有标准的最小化/最大化/关闭三个按钮），顶栏显示班级名与**班级编号**、时钟和连接状态，中央是大时钟、日期和班级名（方便巡检设备绑定是否正确，没有“等待点名”之类的文字）。`fullscreen=1` 或按 `F11` 可切换为无边框铺满屏幕。 |
| 连接 | 后台线程用 WinHTTP（强制 TLS 1.2，自动沿用当前用户的 IE/系统代理设置）长连 `https://域名/api/classes/<class_id>/public/stream?role=display`，断线后按服务端 `retry` 值（2 秒）自动重连；新连接会立即收到当前状态。每一帧快照都带 `classId`，与本机 `class_id` 不一致的帧一律丢弃并写日志，服务端异常也不会串班显示。 |
| 收到新通知 | 自动恢复（若被最小化）、置顶、抢前台，全屏显示姓名（自动选列数与字号，最多 20 人）和金色附加消息，播放两声提示音。 |
| 收到班级留言 | 同样前置并响铃，但改用留言版式：顶部「班级留言」（紧急广播为红色「紧急通知」）、居中大字标题、自动换行的正文、右下角发布人（如「数学老师 · 张老师」）。没有「收到」按钮，点击画面不会发出任何请求。 |
| 多条内容排队 | 服务端按优先级（紧急 → 定时提醒 → 手动点人 → 留言）逐条显示；快照里的 `queued` 大于 0 时底部提示「还有 N 条内容等待显示」。 |
| 「收到」按钮 | 姓名下方有一枚金色的「收到」按钮（鼠标悬停变手形，`Enter`/空格也可触发）。点击后后台线程 `POST /api/classes/<class_id>/public/ack`，成功后按钮变成绿色描边的「已收到」并禁用；直接点某个名字只确认这一个人，已确认的名字变灰、基线变绿并带对勾。确认状态由服务端通过 SSE 广播，所有大屏和教师端同步。 |
| 倒计时 | 按服务端下发的 `expiresAt` 在底部画金色进度条；到期服务端会推 `clear`，程序本地再兜底 1.5 秒，网络抖动也不会挂着旧名字。 |
| 班级绑定错误 | 服务器上没有 `class_id` 对应的班级（HTTP 404 `CLASS_NOT_FOUND`），或返回的 `classId` 与本机不符：顶栏和中央显示醒目的红色「班级绑定错误」，窗口标题变为“班级绑定错误 · 老师找人通知大屏”，**不显示任何通知**，直到改正 `display.ini` 并重启程序。 |
| 清屏 | 回到时钟待机；若 `always_topmost=0` 会退出置顶层，不影响老师继续用电脑。 |
| 老师操作 | 点右上角 **×** 或按 `Esc` 只是**最小化**（下次通知自动弹回），不会退出；真正退出用 `Ctrl+Q` 或**按住 Ctrl 点 ×**。窗口标题栏只显示程序名，没有任何操作提示文字。`F11` 切换全屏/窗口，`M` 切换提示音，`T` 切换常驻置顶。鼠标静止 2.6 秒自动隐藏。 |
| 再次运行 | 第二次执行 `display.exe` 不会开第二个窗口，只会把已有窗口拉到最前——可以当“唤醒”脚本用。 |

它通过 `?role=display` 连接，因此教师端“状态”里的**大屏在线数**会把 exe 正常计入。

## 2. 构建严格的 32 位 EXE

仓库只交付可审计的 C 源码 `windows-display/src/display.c` 和构建脚本，不包含预编译产物；请在受控构建机生成。

### 方案 A：i686 MinGW-w64（推荐，Linux/macOS 也能交叉编译）

```bash
# macOS:  brew install mingw-w64
# Debian: sudo apt install gcc-mingw-w64-i686
bash windows-display/build-mingw-x86.sh
```

Windows 上有 MinGW-w64 时：

```bat
cd windows-display
build-mingw-x86.cmd
```

**C 运行库必须是系统自带的 `msvcrt.dll`。**Windows 7 SP1 原版镜像没有 Universal CRT（`ucrtbase.dll` / `api-ms-win-crt-*.dll`），而 mingw-w64 12 起（Homebrew 现版本，GCC 15+）默认改链 UCRT，直接编译出来的 exe 在没打过 KB2999226 的 Windows 7 上根本起不来。两个 MinGW 脚本会自动探测：编译器支持 `-mcrtdll` 就传 `-mcrtdll=msvcrt-os` 选回 msvcrt（老版本工具链如 Debian 的 GCC 12 本身默认 msvcrt，不需要该参数），并在产物导入了 UCRT 时直接报错退出。`npm test` 对编译产物也做同样检查。

### 方案 B：MSVC

打开 Visual Studio 的 **x86 Native Tools Command Prompt**：

```bat
cd windows-display
build-msvc-x86.cmd
```

脚本明确使用 `/MACHINE:X86 /SUBSYSTEM:WINDOWS,6.01 /MT`。

### 验证确实是 PE32 / i386

```bat
dumpbin /headers build\display.exe | findstr /i "machine subsystem"
```

或

```bash
i686-w64-mingw32-objdump -f build/display.exe
```

必须看到 `14C machine (x86)` / `pei-i386`，**不能**是 `8664` 或 PE32+。`npm test` 里的 `test/display.test.js` 在编译产物存在时也会检查 MZ/PE 头。

## 3. 放到持久的 D 盘

学校电脑每次重启会还原 C 盘，所以**程序、配置、日志都放 D 盘**：

```text
D:\class-caller\display.exe
D:\class-caller\display.ini
D:\class-caller\start-display.cmd
D:\class-caller\install-autostart.cmd
D:\class-caller\uninstall-autostart.cmd
D:\class-caller\display.log     ← 程序自动生成
```

在大屏机上：

```bat
mkdir D:\class-caller
copy windows-display\build\display.exe        D:\class-caller\display.exe
copy windows-display\display.ini.example      D:\class-caller\display.ini
copy windows-display\start-display.cmd        D:\class-caller\
copy windows-display\install-autostart.cmd    D:\class-caller\
copy windows-display\uninstall-autostart.cmd  D:\class-caller\
```

编辑 `D:\class-caller\display.ini`，至少改 `server=` 和 `class_id=`：

```ini
[display]
server=https://example.com
class_id=class-a
topmost_when_active=1
always_topmost=0
sound=1
start_minimized=0
fullscreen=0
hide_cursor=1
log=1
```

- `server` 只写域名入口，不带 `/api/...`，程序自己拼 `/api/classes/<class_id>/public/stream?role=display` 与 `/api/classes/<class_id>/public/config`。
- `class_id` 填本教室的班级标识，以管理端「班级与学生」里各班的标识为准（例如 `class-a`）。每台大屏机各填各的，**不要复制同一份 ini 到多个教室后忘记改这一行**。
- `always_topmost=1` 适合**专用**大屏机（永远盖在最上面）。大屏机平时还要上课用的话保持 `0`。
- `start_minimized=1` 让开机后先缩在任务栏，收到通知才弹出。
- `fullscreen=0`（默认）是带标题栏的最大化窗口；`1` 是无边框铺满。

双击 `start-display.cmd` 或直接运行 `display.exe` 即可。也可用命令行覆盖：

```bat
D:\class-caller\display.exe --server https://example.com --class class-a
D:\class-caller\display.exe --preview 学生130,学生131 --msg 请到办公室   rem 离线预览点人排版（含「收到」按钮），不联网
D:\class-caller\display.exe --preview-notice "班级通知|明天统一穿校服，请带好实验报告。"   rem 离线预览留言版式
D:\class-caller\display.exe --minimized
D:\class-caller\display.exe --install-autostart                     rem 写入当前用户的开机自启（见第 4 节）
D:\class-caller\display.exe --uninstall-autostart
```

## 4. 开机自启

Windows 的“开机自启”登记（任务计划、`HKCU\...\Run`、启动文件夹）**都存在 C 盘/注册表里**，会随 C 盘还原而消失；D 盘只能保证程序和配置本身不丢。所以要从下面三种方式里选一种，把“指向 D 盘的那一条登记”固定下来：

### 4.1 推荐：写进 C 盘母盘 / 还原快照

在制作或更新还原点前，以将来上课要登录的账号执行一次（二选一）：

```bat
D:\class-caller\display.exe --install-autostart
rem 或
D:\class-caller\install-autostart.cmd
```

前者由 exe 自己写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ClassCallerDisplay`（值为 `"D:\class-caller\display.exe" --minimized`，登录后先缩在任务栏，收到通知才弹出）；后者额外再建一个登录时运行的计划任务 `ClassCallerDisplay`（`schtasks /SC ONLOGON /RL LIMITED`），两处都指向 D 盘的 exe。之后把这份 C 盘状态固化为还原快照，每次还原后自启仍然有效。取消：`display.exe --uninstall-autostart` 或 `uninstall-autostart.cmd`。

### 4.2 域环境：GPO 登录脚本

把 `D:\class-caller\start-display.cmd` 配成用户登录脚本（用户配置 → Windows 设置 → 脚本 → 登录），或者用 GPO 首选项下发上面那条 `Run` 键。

### 4.3 无集中管理

让老师开机后双击 `D:\class-caller\start-display.cmd`，或在桌面（如果桌面也在 D 盘）放一个快捷方式。也可以在每次登录时手动执行一次 `install-autostart.cmd`（一次就够，直到下次 C 盘还原）。

卸载自启：`D:\class-caller\uninstall-autostart.cmd`。

## 5. 教师端发送后，大屏 exe 是怎么被通知并弹出的

整条链路只依赖已有的 SSE，服务端不需要新增“唤醒接口”：

1. 老师用个人账号登录 `teacher.html`，进入已获授权的班级后点“通知 N 人到示例班级1大屏”，`POST /api/classes/class-a/calls`（登录 Cookie 鉴权，服务端再核对该老师对这个班的权限、当前是否允许点人、学生是否在册）。
2. 服务端把新的快照 `{type:"call", classId, id, names, message, caller, createdAt, expiresAt, serverTime, queued, ...}` 广播给**该班**的所有 SSE 连接（Nginx 对各班 stream 路径关闭了缓冲和 gzip，所以是即时推送）；其他班的连接收不到。留言的快照是 `{type:"announcement", title, body, author, priority, ...}`。
3. `display.exe` 的网络线程读到这一帧，核对 `classId` 与本机 `class_id` 一致后 `PostMessage` 给 UI 线程（不一致直接丢弃）。
4. UI 线程比较 `id` 与上次记录的 `id`：更大才算**新**事件（重连时收到的同一快照只重绘，不重复弹出和响铃）。
5. 新事件触发 `bring_to_front()`：
   - `ShowWindow(SW_RESTORE)` 恢复最小化；
   - `SetWindowPos(HWND_TOPMOST)` + `SetForegroundWindow`；
   - 若系统仍拒绝（Windows 7/10 都限制后台进程抢前台），临时 `AttachThreadInput` 到当前前台线程并模拟一次空的 Alt 键，再 `SetForegroundWindow`——这是 Win7/Win10 上公认可行的办法；
   - 仍失败则 `FlashWindowEx` 闪烁任务栏，并在 `display.log` 记录。
6. 随后重绘为姓名大屏并 `Beep` 两声。
7. 同学点「收到」：exe 在工作线程 `POST /api/classes/<class_id>/public/ack`，请求体 `{"eventId":<id>}`（点单个名字则带 `"names":["张三"]`）。服务端记录 `acks` 并广播新快照（id 不变，所以不会再次弹出/响铃）；exe 收到后把已确认的名字标灰打勾，全部确认后按钮变「已收到」并禁用。教师端「大屏正在通知」同步显示每个人 已收到/未收到。
8. `autoClearSeconds` 到期后服务端推 `clear`，大屏回到时钟。

浏览器方案之所以“无法自动弹出”，是因为网页没有权限操作其他窗口；而 exe 自己就是窗口的拥有者，所以不存在这个限制。教师端「撤回」（`/api/classes/<class_id>/notices/<id>/withdraw`）如果撤的正是当前显示的内容，服务端会推下一条排队内容或 `clear`；“再次发送”会产生新的 `id`，大屏会再次弹出并响铃。

同一台机器上想从脚本“强制唤醒”：再执行一次 `D:\class-caller\display.exe` 即可（单实例，只会把已有窗口拉前）。

## 6. 服务端 / Nginx / systemd 需要改什么

exe 只使用公开接口，不需要密码：

- `GET /api/classes/<class_id>/public/config` —— 取 `classId`、`className`、`code`（该接口本来就不返回名单）；404 `CLASS_NOT_FOUND` 或 `classId` 不符即进入「班级绑定错误」；
- `GET /api/classes/<class_id>/public/stream?role=display` —— 与浏览器大屏完全相同的本班 SSE（快照中含 `classId` 与 `acks`）；
- `POST /api/classes/<class_id>/public/ack` —— 「收到」确认，只对本班当前通知中的姓名有效。

建议在管理端「班级与学生 → 编辑」里把旧的启动器模式设为 `off`，避免 `display.html` 再去尝试 `classcaller://` 协议。

`nginx.conf.example` 已经满足要求（同时匹配公开与教师 SSE、`proxy_buffering off`、`gzip off`、24 小时超时、`auth_basic off`）。如果域名经过 Cloudflare，必须让 `/api/*` 跳过 Managed Challenge、Under Attack Mode 和 Access 登录；WinHTTP 不会执行挑战页里的 JavaScript，拿到 `403 Just a moment...` 时大屏必然离线。另一个要注意的是 **Windows 7 的 TLS**：

- exe 强制 TLS 1.2。Windows 7 SP1 必须装有 TLS 1.2 相关更新（KB3140245 + 注册表启用，或已打全补丁），并信任证书链的根证书（Let's Encrypt 的 ISRG Root X1 需要系统根证书更新到 2021 年后）。
- Nginx 侧确认 `ssl_protocols` 包含 `TLSv1.2`，并且证书链（`fullchain.pem`）完整。
- 校内诊断时可先在大屏机浏览器打开 `https://域名/api/classes/class-a/public/stream?role=display`，能看到 `retry: 2000` 和 `data: {...}` 即证明证书与网络没问题。

`class-caller.service` 不需要改。

## 7. 上线前检查清单

1. `dumpbin`/`objdump` 确认 `display.exe` 是 PE32 i386。
2. 在 Windows 7 SP1 x86 和 Windows 10 x64 各实机启动一次：顶栏出现**本教室的**班级名和编号（待机画面中央也有），窗口标题为“示例班级1 · 老师找人通知大屏”，右上角绿点“已连接”。
   把 `class_id` 故意改成不存在的值再启动一次：必须显示「班级绑定错误」，此时从教师端发送任何班的通知都不能出现在这块屏上。
3. 在教师端登录**本班**发送一名测试学生：大屏 1 秒内弹出、响铃；再登录**另一个班**发送：这块屏必须毫无反应；点「收到」后按钮变「已收到」，教师端该姓名显示“已收到”；倒计时结束自动清屏。
4. 把大屏最小化（Esc）后再发送：窗口自动恢复到最前。
5. 大屏机断网 10 秒再恢复：顶栏红点“未连接”→ 绿点“已连接”，期间发送的通知在重连后立即显示（不重复响铃）。
6. 重启还原 C 盘后登录：自启仍生效（验证第 4 节所选方式）。
7. 查看 `D:\class-caller\display.log`：只应有连接状态、`class_id=…` 和 `call id=… names=N`，不含附加消息内容。

## 8. 常见故障

### 8.1 教师端发送了，大屏没反应——先看右上角

大屏右上角的连接状态和顶部的红色提示条会直接给出原因，按下面对号入座：

| 右上角显示 | 含义 | 处理 |
| --- | --- | --- |
| 绿点 **已连接** 但没显示姓名 | 连接正常，事件没到或被丢弃 | 教师端“状态”里大屏在线数应 ≥1；看 `display.log` 是否有 `call id=…`；若有 `ignored malformed SSE frame` 请把日志发给开发者。 |
| **连接中** 一直不变 | 网络线程还没拿到结果 | 等 15 秒；仍不变说明 DNS/连接卡住，检查网络。 |
| **未连接 · 错误 12007** | 域名解析失败 | `server=` 拼写、DNS。 |
| **未连接 · 错误 12029 / 12002** | 连不上服务器 / 超时 | 防火墙、机房出口、服务器 443 端口；若学校用代理，请在 IE“Internet 选项 → 连接 → 局域网设置”里配置代理，程序会自动沿用。 |
| **未连接 · 错误 12175 / 12044 / 12045** | TLS 或证书不受信任 | Windows 7：安装 TLS 1.2 支持（KB3140245 并启用 DefaultSecureProtocols，或已打全 2016 年后补丁）和根证书更新（Let's Encrypt 需 ISRG Root X1）。看 `display.log` 是否有 `enable TLS 1.2 failed`。 |
| **未连接 · 错误 12037** | 证书日期无效 | 大屏机系统时间不对。 |
| **未连接 · 错误 404** | 班级不存在或 Nginx 没有反代该路径 | 先看中央是否显示「班级绑定错误」：是则 `class_id=` 写错；否则确认 `server=` 只有域名、没有多余路径，Nginx 有 `location ~ ^/api/classes/[a-z0-9-]+/public/stream$`。 |
| **未连接 · 错误 401/403** | Nginx Basic Auth 或 Cloudflare 挑战拦截了公开接口 | Nginx 明确设置 `auth_basic off`；Cloudflare 让 `/api/*` 跳过 Managed Challenge、Under Attack Mode 与 Access。 |
| **未连接 · 错误 502/503/504** | Node 服务没起 | 服务器上 `systemctl status class-caller`。 |
| **未连接 · 错误 1** | 返回的不是 SSE 流 | `server=` 指向了别的站点或被强制门户劫持。 |

最快的交叉验证：在**同一台大屏机**的浏览器打开 `https://域名/api/classes/class-a/public/stream?role=display`，如果浏览器也打不开或报证书错误，问题在网络/证书，与 exe 无关；如果浏览器能看到 `retry: 2000` 和 `data: {...}` 而 exe 连不上，几乎一定是 Win7 TLS 1.2 或代理问题。

- **启动即弹“没有配置服务器地址”**：`display.ini` 不在 exe 旁边，或 `server=` 为空。
- **启动即弹“此设备尚未绑定班级”**：`display.ini` 缺少 `class_id=`。这是有意为之：没有绑定的大屏不会默认进入任何班。
- **中央显示红色「班级绑定错误」**：`class_id=` 填了服务器上不存在的班级（例如写成 `class23`、`23`、大写字母），或服务器已把该班移除。改正 ini 后重启程序；期间任何通知都不会显示。
- **通知发到了别的教室**：不可能由 exe 造成——它只连本班的流并核对每帧 `classId`。请检查教师端顶栏“当前班级”是否选错了班。
- **收到通知但没弹到最前，只是任务栏闪**：日志有 `foreground denied by system`。通常是有全屏游戏/受保护窗口在前；改用 `always_topmost=1`，或确认没有其他程序也在抢前台。
- **字体发虚 / 窗口没铺满**：Win10 高 DPI 缩放下程序已声明 DPI 感知；如仍异常，检查显示设置里主显示器是否是大屏。
- **中文显示为方块**：系统缺“微软雅黑”，GDI 会自动回退到宋体/黑体；确保系统安装了中文字体包。
- **没有声音**：`Beep` 走声卡，大屏机静音或无音频设备时无声；不影响显示。
- **两个窗口**：不可能——单实例互斥体保证第二次启动只是唤醒。若确实看到两个，说明运行的是两份不同名的旧版本。

## 9. 与旧的 win7-launcher 的关系

`windows-launcher/win7-launcher.exe` 是“收到事件就启动另一个 exe”的启动器，适用于学校已有自己的大屏程序。现在 `display.exe` 本身就是完整大屏，两者**不要同时运行**；不需要旧启动器的话在管理端把该班的启动器模式设为 `off` 即可。
