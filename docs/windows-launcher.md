# Windows 7/10 大屏启动器部署

本项目把 Win7/Win7 风格程序启动在**运行 `display.html` 的大屏机**上，而不是老师机。Linux 服务器只能推送事件，不能直接在远端 Windows 桌面执行程序。

仓库交付的是可审计的 Win32 C 源码和 x86 构建脚本。当前 macOS 开发机没有 Windows/i686 工具链，因此仓库**不包含伪造或未经验证的预编译 EXE**；请在受控 Windows 或 MinGW-w64 构建机生成 `win7-launcher.exe`。

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

必须看到机器类型 `0x014c` / `pei-i386` 和 **PE32**，不能是 `0x8664` 或 PE32+。构建后还应在 Windows 7 SP1 x86 与 Windows 10 x64 实机各测试一次；仅看 PE 头不能证明所有导入 API 都兼容 Windows 7。

## 2. 把文件放到持久的 D 盘

在大屏机执行：

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
- `fresh_seconds` 允许 5–300 秒，并应与服务器 `students.json` 中的 `launcher.freshSeconds` 一致。

## 3. 目标程序收到的参数

启动器只调用 INI 中的固定程序，使用 Unicode `CreateProcessW`，不经过 `cmd.exe`、PowerShell、批处理插值或 `system()`：

```text
"D:\tools\school-win7-app\SchoolProgram.exe" --class-caller-v1 "<payload>"
```

目标程序工作目录为 INI 的 `working_directory`。`payload` 是**无填充 base64url**，解码后是 UTF-8 JSON：

```json
{
  "version": 1,
  "deliveryId": "6dc5a0be-103c-4fc7-b3c1-f76375d55d21",
  "recordId": "f80e4631-7179-4f84-8c6c-859b7b80db54",
  "issuedAt": 1789000000000,
  "students": ["学生130", "学生131"],
  "message": "请到讲台"
}
```

其中：

- `students` 有 1–20 个姓名，每个最多 20 个 UTF-16 代码单元；它明确标识刚被叫到的学生。
- `message` 可为空，最多 60 个代码单元。
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

服务器 `/opt/class-caller/students.json` 配置：

```json
"launcher": {
  "mode": "protocol",
  "freshSeconds": 30
}
```

修改后重启服务，或由已登录的任一班老师调用 `/api/classes/<班级id>/teacher/reload`（重载全部班级的名单）。在大屏浏览器中允许校园通知站点弹窗，并在外部协议提示中选择始终允许（若浏览器和学校策略提供该选项）。

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

这样 `display.html` 不再尝试协议，避免同一事件启动两次。然后在**大屏机**执行：

```bat
cd /d D:\tools
start-native-watcher.cmd "https://校园域名.example/api/classes/class-a/public/stream?role=launcher"

多班级模式下每台机器只监听**本教室班级**的事件流：把 `class-a` 换成该教室的班级 id（`class-b`、`class-c`、`class-d`）。旧的 `/api/public/stream` 地址已停用（HTTP 410），watcher 会报 `expected HTTP 200 text/event-stream (got 410)`。
```

等价的明确命令为：

```bat
D:\tools\win7-launcher.exe --config "D:\tools\win7-launcher.ini" --watch "https://校园域名.example/api/classes/class-a/public/stream?role=launcher"
```

启动器通过 WinHTTP 连接公开 SSE，只读取当前被推送的姓名/消息，不获取完整名单；收到心跳时保持连接，断线后按 SSE `retry` 值重连。新连接会立即同步当前状态，但只有未处理且尚未过期的 `deliveryId` 才会启动目标程序。

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

1. **学校 GPO/登录脚本（推荐）：**协议模式运行 `D:\tools\register-protocol.cmd`；原生模式启动 `D:\tools\start-native-watcher.cmd "https://.../api/classes/class-a/public/stream?role=launcher"`。
2. 把协议键、浏览器策略或启动项预置进每次恢复的 C 盘母盘。
3. 无集中管理时，老师开机后手动运行 D 盘对应脚本。

不要同时运行协议模式和原生监听模式。`students.json` 的 `launcher.mode` 是唯一的部署模式开关。

## 7. 浏览器与安装检查

- IE11 不能运行当前页面：缺少原生 EventSource、fetch 和所需现代 JavaScript/CSS。
- Windows 7 可使用仍支持当前语法/SSE 的最终兼容浏览器版本（例如受控环境中的 Chromium 109）；这些版本在 2026 年均已过安全维护期，应限制互联网访问。
- Windows 10 应使用受管理、仍受支持的 Edge/Chromium，并通过组策略预先允许校园通知站点和协议（如学校政策允许）。

上课前按顺序检查：

1. 打开 `https://校园域名.example/display.html`，确认连接状态为“已连接”。
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
