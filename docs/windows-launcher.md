# Windows 7/10 大屏启动器部署

本项目把 Win7/Win7 风格程序启动在**运行 `/display` 的大屏机**上，而不是老师机。Linux 服务器只能推送事件，不能直接在远端 Windows 桌面执行程序。

可从 [Releases](https://github.com/xzygreen/class-caller/releases/latest) 下载 `ClassCallerLauncher-*-win7-x86.zip`（启动器、配置示例、注册/监听脚本及说明），或下载版本化单文件 EXE 供更新。它用于启动已有校内程序，不是完整大屏；完整大屏请选择 `ClassCallerDisplay-*-win7-x86.zip`。

源码树保留可审计的 Win32 C 源码和 x86 构建脚本，也可在受控 Windows 或 MinGW-w64 构建机自行生成 `win7-launcher.exe`。Linux/macOS 可交叉编译，但交叉编译与 PE 检查**不等于 Windows 7 实机运行验证**。

## 1. 生成严格的 32 位 EXE

### 方案 A：MSVC

打开 Visual Studio 的 **x86 Native Tools Command Prompt**，进入 `windows-launcher` 目录：

```bat
build-msvc-x86.cmd
```

脚本明确使用：

```text
/MACHINE:X86 /SUBSYSTEM:CONSOLE,6.01 /MT /D_WIN32_WINNT=0x0601
```

### 方案 B：i686 MinGW-w64

Windows：

```bat
build-mingw-x86.cmd
```

Linux 构建机：

```bash
CC=i686-w64-mingw32-gcc bash windows-launcher/build-mingw-x86.sh
```

产物位于：

```text
windows-launcher\build\win7-launcher.exe
```

### 验证确实是 x86/PE32

MSVC：

```bat
dumpbin /headers build\win7-launcher.exe | findstr /i "14C machine 32 bit subsystem"
certutil -hashfile build\win7-launcher.exe SHA256
```

MinGW：

```bat
i686-w64-mingw32-objdump -f -p build\win7-launcher.exe
certutil -hashfile build\win7-launcher.exe SHA256
```

必须看到机器类型 `0x014c` / `pei-i386` 和 **PE32**，不能是 `0x8664` 或 PE32+。MinGW 产物必须导入系统 `msvcrt.dll`，不得导入 `ucrtbase.dll` 或 `api-ms-win-crt-*`（原版 Win7 SP1 不自带 UCRT）。两份 MinGW 脚本在编译器支持时选用 `-mcrtdll=msvcrt-os`，并强制使用 `objdump` 检查导入；缺少检查工具、导入检查失败或发现 UCRT 时构建失败，不生成可发布的 `win7-launcher.exe`。旧工具链可使用 Debian 的 msvcrt 默认版本。

构建后还应在 Windows 7 SP1 x86 与 Windows 10 x64 实机各测试一次；仅看 PE 头和 CRT 导入不能证明所有导入 API 都兼容 Windows 7。

## 2. 把文件放到持久的 D 盘

使用 Release ZIP 时，把解压目录中的文件放到 `D:\tools`。包内只有 `win7-launcher.ini.example`；**首次安装先复制为同目录的 `win7-launcher.ini`，再配置下面的路径**。

**更新**：先退出启动器，只替换 `win7-launcher.exe`，保留原有 `win7-launcher.ini` 及其 `state_path` 指向的状态文件，不要用示例覆盖或删除去重状态。单独下载的版本化 EXE 需先重命名为 `win7-launcher.exe`。

若从源码构建，首次安装时在仓库根目录执行：

```bat
mkdir D:\tools
copy windows-launcher\build\win7-launcher.exe D:\tools\win7-launcher.exe
copy windows-launcher\win7-launcher.ini.example D:\tools\win7-launcher.ini
copy windows-launcher\register-protocol.cmd D:\tools\register-protocol.cmd
copy windows-launcher\unregister-protocol.cmd D:\tools\unregister-protocol.cmd
copy windows-launcher\start-native-watcher.cmd D:\tools\start-native-watcher.cmd
```

编辑 `D:\tools\win7-launcher.ini`：

```ini
[launcher]
target_path=D:\tools\school-win7-app\SchoolProgram.exe
working_directory=D:\tools\school-win7-app
state_path=D:\tools\win7-launcher.state
fresh_seconds=30
```

要求：

- `target_path` 必须是管理员预先配置的绝对 `.exe` 路径；网页和 SSE 无法更改它。
- `working_directory` 是目标程序的工作目录，不是浏览器目录，也不依赖当前命令提示符目录。
- `state_path` 必须在 D 盘。启动器会先原子写入已处理的 `deliveryId`，再启动目标，防止刷新、SSE 重连或 C 盘还原后重复弹出旧事件。
- `fresh_seconds` 允许 5–300 秒，并应与管理端里该班启动器设置的 `freshSeconds` 一致。

## 3. 目标程序收到的参数

启动器只调用 INI 中的固定程序，使用 Unicode `CreateProcessW`，不经过 `cmd.exe`、PowerShell、批处理插值或 `system()`：

```text
"D:\tools\school-win7-app\SchoolProgram.exe" --class-caller-v1 "<payload>"
```

目标程序工作目录为 INI 的 `working_directory`。`payload` 是**无填充 base64url**，解码后是 UTF-8 JSON：

```json
{
  "version": 1,
  "classId": "class-a",
  "deliveryId": "6dc5a0be-103c-4fc7-b3c1-f76375d55d21",
  "recordId": "f80e4631-7179-4f84-8c6c-859b7b80db54",
  "issuedAt": 1789000000000,
  "students": ["学生130", "学生131"],
  "message": "请到讲台"
}
```

其中：

- **七个字段全部必需且只允许出现一次**；未知字段仍拒绝。旧的六字段载荷（缺少 `classId`）不再接受，目标程序的适配层也应按此契约校验。
- `classId` 是班级内部标识，必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`：1–32 个 ASCII 字符、区分大小写，不接受空值、截断、大写或空白。原生 watcher 还核对外层 SSE 的 `classId` / `deliveryId` 与载荷一致；管理员仍须确保 `--watch` URL 指向本教室，不会凭班级名称自动选班。
- `version` 必须为整数 `1`；`deliveryId` / `recordId` 必须为 UUID v4；`issuedAt` 为正的 JavaScript 安全整数毫秒时间戳（≤ 9007199254740991）。直接调用检查本机时间新鲜度，watcher 检查 SSE 的 `serverTime` / `launchValidUntil`。
- 编码只接受规范的无填充 base64url（不得有 `=`、百分号转义或额外 URI 参数），UTF-8 / JSON 必须有效，拒绝 NUL、无效代理项和尾随内容。
- `students` 有 1–20 个不重复姓名，每个最多 20 个 UTF-16 代码单元，不得为空或含控制字符；它明确标识刚被叫到的学生。
- `message` 可为空，最多 60 个 UTF-16 代码单元，不得含控制字符。
- 原始发送和每次“再次通知”共用 `recordId`，但每次都有新的 `deliveryId`；因此重新发送会再次启动一次，刷新/重连不会。
- 目标程序必须实现 `--class-caller-v1` 参数。若现有程序不支持该参数，需要为该程序写适配层，不能把任意参数模板或命令行放进网页消息。

直接测试（从一次真实推送的 API/SSE 响应复制 `launchPayload`）：

```bat
cd /d D:\tools
win7-launcher.exe --config "D:\tools\win7-launcher.ini" --payload-v1 "粘贴launchPayload"
```

成功返回码为 `0`；输入、状态、启动、注册、网络错误分别返回非零值。过期 payload 会被拒绝。

## 4. 优先方案：浏览器调用自定义协议

### 注册协议

```bat
cd /d D:\tools
win7-launcher.exe --config "D:\tools\win7-launcher.ini" --register-protocol
rem 或直接运行封装脚本：register-protocol.cmd
reg query HKCU\Software\Classes\classcaller\shell\open\command /ve
```

注册后的命令等价于：

```text
"D:\tools\win7-launcher.exe" --config "D:\tools\win7-launcher.ini" --uri "%1"
```

页面收到新的、未处理且仍在有效期内的 SSE 事件后，会尝试：

```text
classcaller://v1/call?payload=<base64url>
```

服务器侧由管理员在管理端「班级与学生 → 编辑」把该班的启动器模式设为 `protocol`（有效期 `freshSeconds` 默认 30 秒），保存后立即生效，不需要重启。在大屏浏览器中允许校园通知站点弹窗，并在外部协议提示中选择始终允许（若浏览器和学校策略提供该选项）。

浏览器从 SSE 回调发起 `window.open` 时没有用户手势，不同浏览器/策略可能阻止它；网页也无法可靠判断外部协议是否真的启动成功。页面能明确检测到弹窗被拦截时会显示红色安装提示，但不能绕过浏览器沙箱直接运行 `D:\tools\win7-launcher.exe`。

自定义协议可被其他网页尝试调用，因此启动器只接受严格、短时有效的 v1 数据，只能启动 INI 中的固定 EXE，绝不接受 URI 里的程序路径或命令。仍应把大屏浏览器限制在受管理的校园通知站点；需要更强来源保证时应优先使用只连接指定 HTTPS 地址的原生 watcher。

## 5. 回退方案：32 位 EXE 原生监听 SSE

如果浏览器无法稳定、无确认框地调用协议，改用原生监听。服务器配置必须改为：

```json
"launcher": {
  "mode": "native",
  "freshSeconds": 30
}
```

这样 `/display` 不再尝试协议，避免同一事件启动两次。然后在**大屏机**执行：

```bat
cd /d D:\tools
start-native-watcher.cmd "https://校园域名.example/api/classes/class-23/public/stream?role=launcher"

多班级模式下每台机器只监听**本教室班级**的事件流：把 `class-23` 换成该教室的班级 id（`class-17`、`class-18`、`class-20`）。旧的 `/api/public/stream` 地址已停用（HTTP 410），watcher 会报 `expected HTTP 200 text/event-stream (got 410)`。
```

等价的明确命令为：

```bat
D:\tools\win7-launcher.exe --config "D:\tools\win7-launcher.ini" --watch "https://校园域名.example/api/classes/class-23/public/stream?role=launcher"
```

启动器通过 WinHTTP 连接公开 SSE，只读取当前被推送的姓名/消息，不获取完整名单；收到心跳时保持连接，断线后按 SSE `retry` 值重连。新连接会立即同步当前状态，但只有未处理且尚未过期的 `deliveryId` 才会启动目标程序。`clear` / `announcement` 仅忽略，不启动外部程序。

watcher 使用机器的 WinHTTP 默认代理（`netsh winhttp show proxy`），**不会读取 IE PAC/WPAD 或浏览器自动代理**；需要代理时由学校管理员配置受信任的静态 WinHTTP 代理。`display.exe` 的静态 IE 代理支持与此旧启动器不同，不能把浏览器可访问当作 watcher 网络配置已正确的证明。

HTTPS 监听明确要求 TLS 1.2。Windows 7 SP1 镜像必须安装 TLS 1.2/WinHTTP 相关更新和当前根证书；否则 WinHTTP 会连接失败。只在隔离、可信的校内网诊断时才考虑 HTTP，公网或跨网段必须使用 HTTPS。

## 6. 学校每次重启还原 C 盘

放在 D 盘可持久保存：

```text
D:\tools\win7-launcher.exe
D:\tools\win7-launcher.ini
D:\tools\win7-launcher.state
D:\tools\*.cmd
目标 Win7/Win7 风格程序（若也安装在 D 盘）
```

但以下内容通常在 C 盘/用户配置中，重启还原后可能消失：

- `HKCU\Software\Classes\classcaller` 自定义协议注册；
- 浏览器对弹窗和外部协议的“始终允许”设置；
- 启动文件夹快捷方式和本机计划任务。

因此每次登录必须采用一种恢复方式：

1. **学校 GPO/登录脚本（推荐）：**协议模式运行 `D:\tools\register-protocol.cmd`；原生模式启动 `D:\tools\start-native-watcher.cmd "https://.../api/classes/class-23/public/stream?role=launcher"`。
2. 把协议键、浏览器策略或启动项预置进每次恢复的 C 盘母盘。
3. 无集中管理时，老师开机后手动运行 D 盘对应脚本。

不要同时运行协议模式和原生监听模式。管理端里该班的启动器模式是唯一的部署模式开关。

## 7. 浏览器与安装检查

- IE11 不能运行当前页面：缺少原生 EventSource、fetch 和所需现代 JavaScript/CSS。
- Windows 7 可使用仍支持当前语法/SSE 的最终兼容浏览器版本（例如受控环境中的 Chromium 109）；这些版本在 2026 年均已过安全维护期，应限制互联网访问。
- Windows 10 应使用受管理、仍受支持的 Edge/Chromium，并通过组策略预先允许校园通知站点和协议（如学校政策允许）。

上课前按顺序检查：

1. 打开 `https://校园域名.example/display?class=class-a`（换成本教室的班级标识），确认连接状态为“已连接”。
2. 协议模式运行 `register-protocol.cmd`；原生模式确认 watcher 窗口显示 `watcher connected`。
3. 教师端手动选择一名测试学生并发送。
4. 确认大屏显示姓名，目标程序收到 `--class-caller-v1`，且老师点击“再次通知”时会再启动一次。
5. 刷新大屏、断网重连并重启还原 C 盘，确认旧 `deliveryId` 不会重复启动，且每次登录恢复步骤有效。

## 8. 常见故障

- **大屏显示“浏览器阻止了本地程序启动”：**检查协议注册和浏览器策略；无法预批准时切换到 `native` 并运行 watcher。
- **注册后找不到 EXE：**协议注册保存了绝对路径。确保文件仍在 `D:\tools\win7-launcher.exe`，再运行一次 `register-protocol.cmd`。
- **目标未启动：**检查 INI 的绝对路径和工作目录；直接运行 `--payload-v1` 查看退出码/控制台错误。
- **watcher 不在线：**确认 URL 包含 `?role=launcher`、Nginx SSE 缓冲已关闭、证书受 Windows 7 信任且 TLS 1.2 已启用。
- **没有再次弹出：**同一 `deliveryId` 会被 D 盘状态文件去重。要有意再启动，请在教师端使用“再次通知”，不要删除状态文件。
- **重复弹出：**确认服务器模式不是 `protocol` 的同时又运行 watcher；每台大屏只保留一个启动所有者。

卸载协议：

```bat
D:\tools\unregister-protocol.cmd
```

## 9. 自动化验证与未覆盖的实机验收

从仓库根目录运行（需要主机 C 编译器，以及 i686 MinGW 的 gcc / windres / objdump）：

```bash
CC_NATIVE_REQUIRE=1 node --test test/launcher.test.js test/display.test.js
# 可选：对主机上的 C 解析器开启 AddressSanitizer / UndefinedBehaviorSanitizer
CC_NATIVE_REQUIRE=1 NATIVE_SANITIZE=1 node --test test/launcher.test.js test/display.test.js
# macOS 上已有本地 cc-mingw Docker 镜像时，用 Debian msvcrt 默认工具链交叉构建
CC_NATIVE_REQUIRE=1 NATIVE_DOCKER_IMAGE=cc-mingw node --test test/launcher.test.js test/display.test.js
```

测试以 `CC_NATIVE_CONTRACT_TEST` 编译**生产 C 文件中的实际解析器**，消费真实 `DisplayQueue` 生成的载荷与快照，覆盖直接参数、URI、watch 校验器、班级标识边界、重复/缺失/未知字段、Base64、UTF-8、代理项、深度与长度错误。每次在临时目录从当前源码/资源重新构建两份 EXE，读取 PE 导入目录验证 i386 / PE32 / 子系统 6.01 / MSVCRT；不使用工作区里可能过期的 `build/*.exe`，不读写真实 ini、日志或发布包。`NATIVE_CC` 可指定主机编译器，`NATIVE_MINGW_CC` 可指定交叉编译器。

无工具时普通运行会明确标记 `skip`；`CC_NATIVE_REQUIRE=1` 则将缺少编译工具视为失败，适合 CI。**Windows 运行测试单独标记 skip**：便携测试不模拟 `CreateProcessW`、注册表、互斥体、磁盘事务、WinHTTP 或窗口管理。仍须在隔离的 Win7/Win10 环境使用合成目标程序与专用 D 盘状态文件，验证 URI/watch 同一 `deliveryId` 仅启动一次、重启去重、启动失败回滚、实际 SSE 断线重连和注册/卸载。不得把这些 skip 计为实机验证通过。
