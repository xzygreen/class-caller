# 隐私说明

本公开仓库不包含真实学生名单、真实密码或实际部署网址。首次运行前，请复制 `students.example.json` 为 `students.json`，并在本地填写配置；不要提交 `students.json`。

# 老师找人通知大屏（多班级版）

这是一个供老师在办公室、手机或电脑上发送“找人通知”，并实时显示到对应班级教室大屏的系统。老师从本班名单中选择学生，可附加“请到办公室”等说明；班级大屏会显示找人老师、学生姓名和附加消息，学生看到后可以点击「收到」。

示例配置同时服务示例班级1、示例班级2、示例班级3和示例班级4。四个班的名单、通知、记录、登录状态、大屏连接和自动清屏计时互相隔离。

## 直接使用

教师端统一入口：<https://example.com/teacher.html>

### 班级与密码

以下为公开示例密码，按项目的 `students.json` 明文列出，方便老师直接查阅。修改 `students.json` 中的密码后，也要同步更新本表。

| 班级 | 班级 ID | 教师密码 | 教师端快捷入口 | 浏览器大屏入口 |
|---|---|---:|---|---|
| 示例班级1 | `class-a` | `change-me-01` | [打开教师端](https://example.com/teacher.html?class=class-a) | [打开大屏](https://example.com/display.html?class=class-a) |
| 示例班级2 | `class-b` | `change-me-02` | [打开教师端](https://example.com/teacher.html?class=class-b) | [打开大屏](https://example.com/display.html?class=class-b) |
| 示例班级3 | `class-c` | `change-me-03` | [打开教师端](https://example.com/teacher.html?class=class-c) | [打开大屏](https://example.com/display.html?class=class-c) |
| 示例班级4 | `class-d` | `change-me-04` | [打开教师端](https://example.com/teacher.html?class=class-d) | [打开大屏](https://example.com/display.html?class=class-d) |

### 老师发送通知

1. 打开教师端，选择要通知的班级，输入上表中的该班密码，然后点「登录并进入该班」。
2. 先看页面顶部的大屏状态。显示「本班大屏在线」才表示教室大屏已连上；显示「本班大屏未连接」时，通知仍可发送，但教室暂时看不到。
3. 在名单中直接点选学生，也可以先在搜索框输入姓名再选择。再次点击可取消选择；一次最多选择 20 人。
4. 在页面底部选择找人身份：班主任、语文老师、数学老师、英语老师、物理老师、化学老师或历史老师。
5. 按需填写附加说明，例如“请到办公室”。此项可以留空，最多 60 个字。
6. 检查当前班级、已选姓名和找人身份，点击「通知到大屏」。也可以按 `Ctrl + Enter`（macOS 为 `Command + Enter`）发送。
7. 发送成功后，本班大屏会立即显示通知，并在 30 秒后自动清屏。教师端会实时显示每位学生的「已收到 / 未收到」状态。

页面会清楚显示“当前班级”。要操作另一个班，必须点右上角「退出并切换班级」，重新选择班级并输入目标班密码。切班时，当前已选学生、搜索文字和未发送的附加说明都会清空。

### 通知发出后的操作

- 「清空大屏」只清掉当前班正在显示的通知，不会删除找人记录。
- 「再次通知上一条」会把上一条通知重新发送到大屏，并生成新的通知编号；所有「收到」状态会重新开始计算。
- 找人记录中的「再次通知」可重发指定的历史记录，并沿用当时的找人身份和附加说明。
- 「撤销最后一条记录」删除最近一条找人记录；如果大屏当前显示的正是这一条，也会同时清屏。
- 「清空找人记录」只清除本班的历史记录，不改变大屏当前正在显示的内容。
- 记录只保存在服务器内存中，每班最多 500 条；服务重启或重新部署后会清空。

### 教室大屏的操作

大屏收到通知后会显示“哪位老师正在找”、学生姓名和附加说明：

- 点底部「收到」可一次确认当前通知里的所有学生。
- 直接点击某个学生姓名，只确认这一名学生。
- 已确认的姓名会显示绿色标记，确认结果会实时同步到教师端和本班其他大屏。
- 鼠标移动后会显示大屏上的辅助按钮；平时鼠标指针自动隐藏。
- 大屏断线后会自动重连，重新连接时自动恢复本班当前仍在展示的通知。

### 登录与密码错误

浏览器不会保存原始密码，只保存服务端签发的临时登录令牌。令牌在 12 小时后失效，服务重启后也会失效。同一来源对同一班级连续输错 5 次密码，会被锁定 60 秒；等待一分钟后再试即可。每个班的登录令牌分别保存，因此同一浏览器可以在不同标签页中同时登录不同班级。

## 大屏绑定

每块大屏必须永久绑定到一个班级。浏览器大屏通过网址里的 `class` 参数绑定，Windows 原生大屏通过 `display.ini` 的 `class_id=` 绑定：

| 班级 | 编号 | 辅助色 | 浏览器大屏 | `display.ini` |
|---|---:|---|---|---|
| 示例班级1 | 01 | 蓝 | `display.html?class=class-a` | `class_id=class-a` |
| 示例班级2 | 02 | 绿 | `display.html?class=class-b` | `class_id=class-b` |
| 示例班级3 | 03 | 橙 | `display.html?class=class-c` | `class_id=class-c` |
| 示例班级4 | 04 | 紫 | `display.html?class=class-d` | `class_id=class-d` |

没有 `class` 参数时，大屏显示“此设备尚未绑定班级”，不会默认进入任何班。班级不存在或服务端返回的班级与绑定不符时，大屏显示醒目的“班级绑定错误”，并拒绝展示通知。左上角和待机画面都会显示班级名称与编号，巡检时应以名称和编号为准，颜色只作辅助识别。

Windows 原生大屏 `display.exe` 缺少 `class_id=` 时会拒绝启动；窗口标题会显示当前班级。完整安装步骤见 [docs/windows-display.md](docs/windows-display.md)。找人身份由通知事件下发；最新程序会显示“数学老师正在找”等文字。部署时应使用最新的 `windows-display/build/display.exe`。旧版 EXE 可能把所有身份显示成“班主任”，或无法响应老师手动清屏，必须替换。旧 `win7-launcher.exe` 的启动载荷格式未变，不需要因此更新。

## 配置：`students.json`（version 2）

```json
{
  "version": 2,
  "classes": [
    {
      "id": "class-a",
      "name": "示例班级1",
      "code": "01",
      "color": "blue",
      "password": "该班独立密码",
      "autoClearSeconds": 30,
      "launcher": { "mode": "off", "freshSeconds": 30 },
      "students": ["学生001", "学生002", "…"]
    }
  ]
}
```

- `id` 是系统内部固定标识（小写字母、数字、连字符，1–32 位），用于大屏绑定和接口路径，**不要改**；`name` 可以随时改，不影响设备绑定。
- `code`（1–4 字符，默认按顺序 01、02…）和 `color`（blue / green / orange / purple / teal / red，默认按顺序分配）只用于界面识别。
- 每个班有独立的 `password`、`students`、`autoClearSeconds` 和 `launcher`。**不同班的密码不能相同**（否则一个班的老师天然拿到另一个班的权限，配置会被拒绝）。
- 同一班内学生姓名去重；不同班允许出现同名学生，记录不会串。
- 旧的单班格式（顶层 `className` / `students`）会被拒绝并提示升级；重载失败时继续使用上一份完整有效的配置，不会只更新一半。

## Linux 部署与启动

生产部署面向 Ubuntu / Debian，要求 root 权限。`deploy.sh` 会检查部署文件和 Node.js（最低 03，缺失时安装 22），创建低权限的 `classcaller` 系统用户/组，把应用安装到 `/opt/class-caller`，运行全部测试，然后校验并重启 systemd 服务。

```bash
cd /path/to/class-caller
sudo bash ./deploy.sh
```

部署脚本会保留服务器上已有的 `/opt/class-caller/students.json`，并在每次升级前创建带 UTC 时间戳的备份。**从单班版本升级时，服务器上保留下来的旧格式 `students.json` 会让服务启动失败**，`deploy.sh` 会在改动线上目录之前校验并停下；完整的升级步骤（配置替换、Nginx 改动、大屏更新、回退）见 [docs/upgrade-multiclass.md](docs/upgrade-multiclass.md)。按上面的 version 2 格式改写后再重启：

```bash
sudoedit /opt/class-caller/students.json
sudo systemctl restart class-caller
```

常用服务命令：

```bash
sudo systemctl start class-caller
sudo systemctl restart class-caller
sudo systemctl status class-caller
sudo journalctl -u class-caller -f
```

服务只监听 `127.0.0.1:3000`。公网访问必须使用反向代理；可从 `nginx.conf.example` 建立 Nginx 站点并配置 HTTPS。示例为各班 SSE 路径关闭了缓冲、缓存和 gzip，并设置 24 小时读写超时；教师端登录限速依赖 Nginx 传入的 `X-Real-IP`。

仅在服务器本机做开发或诊断时，也可从源码启动：

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

## URL 与接口

当前线上域名是 `https://example.com`。以下示例使用 `class-a`，调用其他班级时替换为对应的班级 ID：

- 教师端：`https://example.com/teacher.html`（也可带 `?class=class-a` 直接预选班级，仍需输入该班密码）
- 大屏端：`https://example.com/display.html?class=class-a`
- 班级列表（只有 id / 名称 / 编号 / 颜色）：`GET /api/public/classes`
- 本机健康检查：`http://127.0.0.1:3000/api/public/classes`
- 班级公开配置：`GET /api/classes/class-a/public/config`
- 班级 SSE 事件流：`GET /api/classes/class-a/public/stream?role=display`
- 班级「收到」确认：`POST /api/classes/class-a/public/ack`
- 登录：`POST /api/classes/class-a/teacher/login` `{ "password": "…" }` → `{ token, expiresAt, class }`
- 发送通知：`POST /api/classes/class-a/teacher/call` `{ "names": ["张三"], "message": "请到办公室", "caller": "数学老师" }`；`caller` 只能取教师端提供的七个身份，旧客户端未传时记为通用的“老师”。
- 教师接口：`/api/classes/class-a/teacher/{students,status,history,call,clear,history/undo,history/clear,history/resend,reload,logout}`，一律携带 `X-Teacher-Token`

关键规则：

- 班级只以接口路径和登录会话为准，请求体里的 `classId` 不作依据。
- 令牌与班级绑定：一班的令牌访问二班接口返回 403 `CLASS_MISMATCH`，一班的密码不能登录二班。
- 每条通知快照与启动载荷都附带 `classId`；浏览器大屏、教师端和 `display.exe` 收到不属于本班的消息时，即使服务端异常也拒绝显示。事件 id 在整个服务内唯一，拿一个班的通知 id 到另一个班确认必然是 `ACK_STALE`。
- 清空、撤销、再次通知、清空历史、「收到」确认都只作用于路径所指的班；大屏在线数按班分别统计。
- 升级前的旧接口 `/api/public/*`、`/api/teacher/*` 返回 410 `LEGACY_ENDPOINT`，旧的无班级大屏链接不会默认进入任何班。
- 日志记录班级 id、操作类型、记录/投递编号、人数和连接数，不记录密码、附加消息和完整名单。

可同时在多块设备上打开同一个班的大屏链接；新连接会立即收到该班当前展示状态，断线时自动重连。

## 名单、鉴权与隐私边界

- **名单只读：**生产部署把 `students.json` 设为 `root:classcaller`、权限 `0640`。systemd 服务使用独立低权限账号运行，并通过只读文件系统加固读取应用目录；应用不会写回或在线修改名单。
- **教师接口鉴权：**选班 + 该班密码换取短期登录令牌（内存保存，12 小时或服务重启后失效）；所有 `/api/classes/:id/teacher/*` 接口校验令牌且令牌必须属于该班。密码缺失、非字符串、为空或与其他班重复会让配置启动/重载失败。生产环境应设置强密码，并只通过 HTTPS 使用。
- **公开接口不泄露完整名单：**班级列表与公开配置都不返回学生数组，完整名单只由鉴权后的本班接口返回。公开大屏和 SSE 必然能看到当前被推送的姓名与消息，但不会收到完整花名册，也收不到别班的通知。
- **SSE 传输保证：**新连接立即同步当前状态；服务发送心跳并支持浏览器自动重连。配套 Nginx 按正则匹配各班 stream 路径，关闭代理缓冲、缓存和 gzip，并保留长连接超时。

教师端 HTML 本身是公开静态文件；受保护的是名单和控制 API。共享密码不是独立用户账号或审计系统，不应代替网络访问控制、HTTPS 和妥善的服务器权限管理。

## 「收到」确认

大屏（`display.html` 与 `display.exe`）在显示通知时都有一个醒目的「收到」按钮；也可以直接点某个名字只确认这一个人。点击后大屏向本班的 `POST /api/classes/:id/public/ack` 发送 `{ "eventId": <当前通知 id>, "names": ["张三"] }`（`names` 省略表示当前显示的所有人）。服务端把确认写进该班当前通知的 `acks: [{ name, at }]`，通过该班 SSE 广播给本班所有大屏和教师端；全部确认后按钮变为「已收到」并禁用。教师端“示例班级1大屏正在通知”区域按姓名实时显示 已收到 / 未收到。

`ack` 是公开接口但只能对**本班当前正在显示**的那条通知、且只对**通知里已有的姓名**打勾：`eventId` 不匹配返回 409 `ACK_STALE`，姓名不在本条通知中返回 400 `ACK_UNKNOWN_NAME`。重复确认幂等且不再广播；「再次通知」会得到新的 id，确认状态从零开始；撤销/清空/到期后确认失效。确认不落盘，随服务重启归零。

## 状态与历史

服务器把每个班的“找人记录”分别保存在内存中，每班最多保留最近 500 条。它会在教师页面刷新、重新打开或换另一台已登录设备后继续可见；清空大屏和自动到期不会删除记录。撤销、清空找人记录和再次通知均由鉴权后的本班接口处理，只影响本班。

记录不会写入数据库或文件。Node 服务重启或重新部署后，所有班的大屏状态、找人记录和登录会话都会归零；这与 systemd 的只读、低权限运行方式保持一致。通过受保护的 `teacher/reload` 接口重载配置时会刷新全部班级的名单：仍然存在的班级保留当前通知和记录，被移出的班级连接关闭、会话作废，新增的班级立即可用。

每个班的 `launcher` 单独选择大屏机的启动方式：`protocol` 让大屏浏览器尝试 `classcaller://`；`native` 由 D 盘的 32 位 launcher 监听该班的 SSE；`off` 完全关闭本地程序启动。不要同时启用浏览器协议和原生 watcher。

## 上线前必须验证

`npm test` 里的 `test/isolation.test.js` 覆盖以下全部项目，部署脚本会先跑一遍：

- 两个班能同时发送不同通知，互不覆盖。
- 一班令牌不能查看二班名单、历史和状态，也不能操作二班；一班密码不能登录二班。
- 一班大屏收不到二班消息。
- 跨班「收到」确认被拒绝。
- 清空一班大屏不影响其他班。
- 撤销、重发、清空历史只影响本班。
- 各班的自动清屏计时器互不影响。
- 不同班级存在同名学生时不会串记录。
- 同一浏览器同时持有两个班的登录不会串。
- 大屏缺少班级参数或班级不存在时不会加入任何班；旧链接返回 410。
- 服务重启后各班均恢复为空闲状态，不残留旧通知。

实机上再确认：Windows 大屏 `class_id` 配错时显示“班级绑定错误”且不显示通知；先让一个班试运行，再同时启用四个班。

## Windows 大屏程序（display.exe）

大屏端可以不用浏览器，改用 `windows-display/` 里的 **32 位原生 Win32 程序** `display.exe`：单文件、静态链接、零运行时依赖，在 32/64 位 Windows 7 SP1 与 Windows 10 上都能运行。它按 `display.ini` 里的 `class_id` 连接本班的 `/api/classes/<class_id>/public/stream?role=display`，收到通知时自动恢复/置顶/前置并全屏显示姓名与附加消息，按该班 `autoClearSeconds` 倒计时清屏，待机显示时钟与班级。程序放在 `D:\class-caller\display.exe`（C 盘会被还原）。

构建、D 盘部署、开机自启、班级绑定和故障排查见 [docs/windows-display.md](docs/windows-display.md)。使用 exe 时把该班的 `launcher.mode` 设为 `off`。

## Windows 启动器（旧方案）

Windows 启动器的 x86 构建、`D:\tools` 放置、自定义协议、原生监听回退、命令行参数和 C 盘重置恢复步骤见 [docs/windows-launcher.md](docs/windows-launcher.md)。原生监听模式的 `--watch` 地址现在必须是**某个班**的流，例如：`https://example.com/api/classes/class-a/public/stream?role=launcher`。

Linux 的 `deploy.sh` 只会在源码存在时把 Windows 启动器源码和说明归档到 `/opt/class-caller`；它不会构建或安装 Windows 成品。Windows assets must be built/copied separately to `D:\tools`.

## 常见问题

### 打开教师端后看不到班级列表

先刷新页面；仍然为空时，打开 `https://example.com/api/public/classes`。正常情况下会返回四个班级的 JSON。打不开或显示服务器错误时，管理员应检查 `class-caller` 服务和 Nginx。

### 密码正确却提示错误次数过多

同一网络来源对同一个班连续输错 5 次会锁定 60 秒。停止尝试并等待一分钟，再确认班级和密码是否对应。对其他班的登录不受影响。

### 教师端显示“大屏未连接”

确认教室电脑已经启动浏览器大屏或 `display.exe`，并核对大屏左上角的班级名称。若使用原生程序，检查 `D:\class-caller\display.ini` 中的 `server=https://example.com` 和该教室对应的 `class_id`。更详细的错误码与排查方法见 [docs/windows-display.md](docs/windows-display.md)。

### 通知已经发出，但很快消失

这是正常的自动清屏行为。当前四个班的 `autoClearSeconds` 都是 30 秒。需要延长时修改服务器上的 `students.json`，然后重启服务或在教师端执行名单重载。

### 改了名单或密码但页面没有变化

开发环境修改根目录的 `students.json`；生产环境要修改 `/opt/class-caller/students.json`。保存后执行 `sudo systemctl restart class-caller`。也可以由管理员携带有效教师令牌调用受保护的 `teacher/reload` 接口热重载。重载整份配置时会同时校验所有班级，任一班配置有误都会拒绝更新，并继续使用上一份有效配置。

### 服务重启后记录和登录都没了

这是预期行为。登录会话、当前大屏通知、「收到」状态和找人记录只保存在内存中，不写入数据库；服务重启后全部归零，班级配置和学生名单不会丢失。
