# Class Caller｜老师找人通知大屏

一个面向学校场景的多班级实时通知系统。教师用**个人账号**登录，在获授权的班级里点人、发布班级留言、创建每日定时提醒；教室大屏实时显示找人老师、学生姓名和说明，学生可在大屏上确认「收到」。管理员统一维护班级、名单、全校作息，审批教师的班级管理申请，并可查看全部操作审计。

服务端零第三方运行时依赖（原生 Node.js），另有兼容 Windows 7/10 的 32 位原生大屏程序 `display.exe`。

> [!IMPORTANT]
> 公开仓库不包含真实学生名单、账号或部署地址。账号、名单、作息、记录都保存在服务器的数据目录（默认 `data/`，生产为 `/var/lib/class-caller`），已被 Git 忽略。请勿把数据文件、日志或凭据提交到公开仓库。

## 核心原则

- **登录身份属于个人**：教师自主注册，密码以 `scrypt` 加盐摘要保存；会话是 `HttpOnly` + `SameSite=Strict` 的 Cookie，浏览器脚本拿不到令牌。
- **班级权限由管理员授权**：教师提交申请，管理员批准后才能操作该班；撤销立即生效，不等会话过期。
- **共享班级密码已彻底移除**：旧的 `teacher/login` 接口返回 410，任何班级密码都不再是凭据。
- **点人必须在允许时段**：全校作息按 `Asia/Shanghai` 由服务端判断，绕过网页直接调接口也会得到 `CALL_WINDOW_CLOSED`。
- **每个请求都重新校验**：会话有效 → 账号启用 → 角色 → 班级权限 → 作息 → 学生在册。

## 功能概览

| 角色 | 能做什么 |
| --- | --- |
| 管理员 | 班级新增/修改/归档、名单维护、全校作息、教师账号启停与密码重置、审批/授权/撤销班级权限、管理全部定时任务与留言、清理任意大屏、紧急广播、查看在线设备与操作审计、创建其他管理员 |
| 教师 | 注册、登录、申请管理班级；获批后点人、发布班级留言、创建每日定时提醒、查看本班统一记录 |
| 大屏 | 点人版式（姓名、老师、说明、收到确认）与留言版式（标题、正文、发布人）；多条内容按优先级排队，教师端能看到「正在显示」与「等待显示」 |

内容优先级：管理员紧急通知 → 已到点的定时提醒 → 手动点人 → 普通班级留言。持续显示的留言作为底色，任何点人都能盖过它，点完后自动回来。

## 快速开始

### 环境要求

- Node.js 18 或更高（生产推荐 22）
- 无需安装 npm 依赖

### 本地运行

```bash
git clone https://github.com/xzygreen/class-caller.git
cd class-caller
npm test
# 创建首个管理员（交互式，密码不会被记录）
npm run init-admin
npm start
```

服务默认只监听 `127.0.0.1:3000`：

- 教师端：<http://127.0.0.1:3000/teacher.html>
- 管理端：<http://127.0.0.1:3000/admin.html>
- 浏览器大屏：<http://127.0.0.1:3000/display.html?class=class-a>
- 健康检查：<http://127.0.0.1:3000/api/public/status>

也可以用环境变量创建首个管理员（只在数据仓库里还没有管理员时读取一次）：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='强密码' npm start
```

之后新的管理员只能由现有管理员在管理端创建。

### 从旧版 students.json 导入班级

数据仓库里还没有班级、且项目根目录存在旧版 `students.json`（`version: 2`）时，首次启动会自动导入班级与名单，其中的 `password` 字段被丢弃。之后班级和名单在管理端维护，不再读取该文件。参见 [`students.example.json`](students.example.json) 与[账号版升级指南](docs/upgrade-accounts.md)。

## 使用流程

### 教师

1. 在教师端注册（登录名、姓名、密码、可选职务），登录后进入**个人工作台**。
2. 提交「申请管理班级」，等待管理员批准；被拒绝会看到理由。
3. 进入班级后有四个标签：
   - **点人**：显示当前是否处于课间与下一可用时间；搜索选人（最多 20 人）、附加说明、发送；右侧是大屏当前内容、每人的收到状态和等待队列。
   - **班级留言**：标题、正文、立即或定时显示、自动下屏时间，带大屏预览。留言不选学生，也没有「收到」流程。
   - **定时提醒**：每周一至周五某时刻自动点人（时间必须在允许时段内），可启用/暂停/改时间/删除，能看到最近执行结果和自动暂停原因。
   - **记录**：点人、留言、定时执行的统一时间线，按类型、教师、日期筛选。
4. 发起人署名来自登录账号（如「数学老师 · 张老师」），不能自选身份。

### 管理员

`/admin.html` 首页优先展示待处理事项：待审批申请、被暂停的定时任务、离线的大屏、当前是否允许点人以及下一次窗口。其余页面：申请审批、班级与学生、教师与权限、全校作息、定时任务、大屏与设备（含紧急广播）、操作记录、系统设置。

管理员发起密码重置时只会得到一次性临时密码，看不到教师原密码；教师用临时密码登录后必须先改密码。

### 全校作息

默认允许点人时段（周一至周五，开始包含、结束不包含）：

| 时段 | 说明 |
| --- | --- |
| 08:45–09:00 | 课间 |
| 09:45–10:15 | 课间 |
| 11:00–11:15 | 课间 |
| 11:35–12:30 | 午餐、过渡时间、午自习 |
| 13:00–13:10 | 午休结束后的课间 |
| 13:55–14:15 | 课间 |
| 15:00–15:15 | 课间 |
| 16:00–16:15 | 课间 |

管理员可在网页编辑；修改后不再符合作息的定时任务自动暂停，教师端显示原因，操作写入审计。

### 定时提醒的可靠性

- 以「任务 ID + 日期」为唯一执行标识，服务重启或重复扫描不会一天发两次；
- 重启后两分钟内可补发，超过则记「已错过」，不在上课途中补发；
- 执行前重新校验作息、班级、创建教师的权限和学生是否在册；
- 教师失去班级权限、学生被移出名单、班级归档时任务自动暂停。

### 教室大屏

浏览器大屏必须通过 `class` 参数绑定班级：`https://你的域名/display.html?class=class-a`。没有参数、班级不存在或服务端返回的班级不匹配时不显示任何内容。

- 点人：点「收到」确认全部，点姓名只确认该学生；
- 留言：只有标题、正文和发布人，没有确认按钮；
- 有多条内容时底部提示「还有 N 条内容等待显示」；
- 断线重连后恢复当前内容；到期自动回到待机。

## 生产部署

面向 Ubuntu/Debian，需要 root：

```bash
sudo bash ./deploy.sh
```

脚本会检查 Node.js、运行全部测试、校验线上数据仓库能否被新版本载入、创建低权限 `classcaller` 用户、安装到 `/opt/class-caller`（只读）、把数据目录设为 `/var/lib/class-caller`（0700）、注册并重启 systemd 服务，最后做健康检查。若还没有管理员，脚本会提示创建命令。

请参考 [`nginx.conf.example`](nginx.conf.example) 配置 HTTPS 反向代理：SSE 路径关闭缓冲和 gzip；务必透传 `X-Real-IP`（登录限速）与 `X-Forwarded-Proto`（Cookie 加 `Secure`）。

常用命令：

```bash
sudo systemctl status class-caller
sudo journalctl -u class-caller -f
cd /opt/class-caller && sudo -u classcaller DATA_DIR=/var/lib/class-caller node scripts/init-admin.js
```

## Windows 大屏方案

| 方案 | 适用场景 | 配置方式 | 文档 |
| --- | --- | --- | --- |
| 浏览器大屏 | 现代浏览器、无需安装 | URL 中设置 `?class=<班级 ID>` | 本文「教室大屏」 |
| 原生 `display.exe` | Windows 7/10，需要自动前置、全屏和提示音 | `display.ini` 中设置 `server` 与 `class_id` | [原生大屏部署](docs/windows-display.md) |
| 旧版启动器 | 需要拉起既有 Windows 程序 | 自定义协议或原生 SSE watcher | [启动器部署](docs/windows-launcher.md) |

`display.exe` 由 GitHub Actions 自动构建：每次推送到 `main` 都会在 CI 里用 Debian 的 `gcc-mingw-w64-i686` 编译并上传产物（Actions → CI → Artifacts）；打 `v*` 标签则生成带 ZIP 与校验文件的 [Release](https://github.com/xzygreen/class-caller/releases/latest)。产物是 PE32 i386、只依赖 `msvcrt.dll`，`npm test` 会对编译产物做头部检查。新版 exe 支持留言版式；旧版 exe 收到留言快照会当作清屏处理，不会显示错误内容。

## API 概览

所有修改类请求需要登录 Cookie，并校验 `Origin`。

| 组 | 路径 |
| --- | --- |
| 公开 | `GET /api/public/classes`、`GET /api/public/status` |
| 大屏 | `GET /api/classes/:id/public/config`、`GET /api/classes/:id/public/stream?role=display`、`POST /api/classes/:id/public/ack` |
| 账号 | `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/me`、`POST /api/me/password`、`GET /api/me/classes`、`POST /api/me/class-requests`、`DELETE /api/me/class-requests/:id` |
| 教师班级 | `GET /api/classes/:id/workspace`、`GET /api/classes/:id/stream`、`GET /api/classes/:id/status`、`POST /api/classes/:id/calls`、`POST /api/classes/:id/announcements`、`GET /api/classes/:id/notices`、`POST /api/classes/:id/notices/:nid/{resend,withdraw}`、`GET/POST /api/classes/:id/schedules`、`PATCH/DELETE /api/classes/:id/schedules/:sid`、`GET /api/classes/:id/activity`、`POST /api/classes/:id/display/clear` |
| 管理员 | `GET /api/admin/overview`、`GET /api/admin/requests`、`POST /api/admin/requests/:id/{approve,reject}`、`GET/POST /api/admin/users`、`PATCH /api/admin/users/:id`、`POST /api/admin/memberships`、`POST /api/admin/memberships/revoke`、`GET/POST /api/admin/classes`、`PATCH /api/admin/classes/:id`、`PUT /api/admin/classes/:id/students`、`GET/PUT /api/admin/call-windows`、`GET /api/admin/schedules`、`PATCH/DELETE /api/admin/schedules/:id`、`POST /api/admin/classes/:id/display/clear`、`GET /api/admin/audit`、`GET/PATCH /api/admin/settings`、`POST /api/admin/sessions/revoke-all` |

旧接口 `/api/classes/:id/teacher/*` 与 `/api/teacher/*` 返回 `410`。

## 数据、安全与隐私

- 数据仓库是带版本号的 JSON 文件：串行写入、临时文件写完后原子替换、每日自动备份（保留 14 份）、写入失败保留上一份有效数据、文件权限 0600。业务层只通过存储接口读写，未来可切换 SQLite。
- 密码只保存 scrypt 加盐摘要；日志不记录密码、令牌、完整名单或留言正文。
- 登录按 IP + 用户名限速（5 次后锁 60 秒）；注册按 IP 限速。
- 密码修改、账号停用、权限撤销、密码重置后相关会话立即失效；管理员可强制全员重新登录。
- 教师实时流需要登录与班级权限；公开流只服务大屏，不返回完整名单。
- 所有管理员修改都带操作者、时间、来源 IP 写入审计。

涉及未成年人信息时，请在上线前阅读[隐私政策](PRIVACY.md)。

## 测试

```bash
npm test
```

覆盖：账号与会话、申请审批与权限隔离、作息规则（08:45 可点人、09:00 不能、周末与 16:15–17:00 禁止）、定时任务的去重/补偿/自动暂停、点人与留言、显示队列、数据仓库、前端页面约束、Windows 程序源码与编译产物检查。

## 项目结构

```text
class-caller/
├── server.js                 # 服务入口
├── scripts/init-admin.js     # 创建首个管理员
├── lib/                      # 存储、账号、权限、作息、调度、通知队列、路由
├── public/                   # 教师端、管理端、浏览器大屏
├── test/                     # Node.js 测试套件
├── docs/                     # 升级与 Windows 部署文档
├── windows-display/          # 原生大屏源码与构建脚本
├── windows-launcher/         # 旧版启动器源码与构建脚本
├── .github/workflows/        # CI 与 display.exe 发布
├── students.example.json     # 旧版名单示例（仅用于首次导入）
├── nginx.conf.example        # Nginx 反向代理示例
├── class-caller.service      # systemd 服务定义
└── deploy.sh                 # Ubuntu/Debian 部署脚本
```

## 文档与许可

- [账号版升级指南](docs/upgrade-accounts.md)
- [多班级升级指南（历史）](docs/upgrade-multiclass.md)
- [Windows 原生大屏部署](docs/windows-display.md)
- [Windows 启动器部署](docs/windows-launcher.md)
- [隐私政策](PRIVACY.md)
- [保留权利与署名说明](NOTICE.md)

源代码、构建文件、示例配置和技术文档采用 [MIT License](LICENSE)。项目名称、商标、品牌素材及明确标记的非代码材料之保留权利见 [NOTICE.md](NOTICE.md)。
