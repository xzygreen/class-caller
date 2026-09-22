# Class Caller｜老师找人通知大屏

老师在手机或电脑上点几下，教室大屏立刻显示「某某老师正在找：张三、李四」，学生在大屏上点一下「收到」，老师那边马上看到。也能发班级留言、设每天固定时间的提醒。

一台服务器可以同时服务全校所有班级，每个班一块大屏。管理员统一管理班级、名单和作息，老师用自己的账号登录，只能操作被授权的班级。

- 服务端：纯 Node.js，**不需要安装任何 npm 依赖**
- 大屏：浏览器打开即可，或使用兼容 Windows 7/10 的原生程序 `display.exe`
- 仓库不包含任何真实名单、账号或部署地址

> [!IMPORTANT]
> 名单、账号、记录都保存在服务器的数据目录里（默认 `data/`，生产环境为 `/var/lib/class-caller`），已被 Git 忽略。不要把数据文件、日志或密码提交到公开仓库。

---

## 目录

1. [系统是怎么工作的](#1-系统是怎么工作的)
2. [十分钟本地试用](#2-十分钟本地试用)
3. [部署到正式服务器](#3-部署到正式服务器)
4. [管理员日常操作](#4-管理员日常操作)
5. [老师日常操作](#5-老师日常操作)
6. [教室大屏](#6-教室大屏)
7. [全校作息与定时提醒](#7-全校作息与定时提醒)
8. [常见问题排查](#8-常见问题排查)
9. [升级与备份](#9-升级与备份)
10. [安全与隐私](#10-安全与隐私)
11. [参考：接口、配置、项目结构](#11-参考接口配置项目结构)
12. [文档与许可](#12-文档与许可)

---

## 1. 系统是怎么工作的

### 三种角色

| 角色 | 登录方式 | 能做什么 |
| --- | --- | --- |
| **管理员** | 账号密码，进入 `/admin.html` | 建班级、维护名单、设全校作息、审批老师申请、管理老师账号、看所有记录 |
| **老师** | 自己注册的账号密码，进入 `/teacher.html` | 申请管理某个班；获批后点人、发留言、设定时提醒、看本班记录 |
| **大屏** | 不用登录，打开 `/display.html?class=班级标识` | 显示当前通知；学生点「收到」 |

核心原则：**登录身份属于个人，班级权限由管理员授权**。没有任何共享的班级密码。

### 一次点人的完整过程

1. 老师在教师端选中学生，可加一句说明（如「带作业本来办公室」），点发送。
2. 服务端检查：登录有效 → 账号启用 → 有该班权限 → 现在是课间 → 学生在名单里。
3. 通过后推送到该班大屏（实时长连接，一般不到一秒）。
4. 大屏显示老师姓名、学生姓名、说明。学生点「收到」，老师端立刻看到确认。
5. 到了自动清屏时间（默认 30 秒）大屏回到待机；也可以由老师手动清屏。

### 大屏上同时有多条内容怎么办

按优先级排队显示，高优先级的插到前面，被挤掉的稍后自动回来：

1. 管理员紧急通知
2. 到点的定时提醒
3. 老师手动点人
4. 普通班级留言

设为「持续显示」的留言相当于底色：任何点人都能盖过它，点完自动回来。教师端能看到「正在显示」和「等待显示」的队列。

---

## 2. 十分钟本地试用

### 需要什么

- Node.js 18 或更高（推荐 22）。检查：`node --version`
- 不需要 `npm install`

### 步骤

```bash
git clone https://github.com/xzygreen/class-caller.git
cd class-caller

# 1. 跑一遍测试，确认环境正常
npm test

# 2. 创建第一个管理员（交互式，密码不会显示、也不会写进日志）
npm run init-admin

# 3. 启动
npm start
```

启动后只监听本机 `127.0.0.1:3000`，用浏览器打开：

| 页面 | 地址 |
| --- | --- |
| 管理端 | <http://127.0.0.1:3000/admin.html> |
| 教师端 | <http://127.0.0.1:3000/teacher.html> |
| 浏览器大屏 | <http://127.0.0.1:3000/display.html?class=class-a>（`class-a` 换成你建的班级标识） |
| 健康检查 | <http://127.0.0.1:3000/api/public/status> |

### 第一次要做的事

1. 用管理员账号登录管理端。
2. 「班级与学生」→ 新增班级（填一个标识如 `class-1`、班级名称、短编号）。**新增后页面会自动滚到这个班的名单框**，把学生名字粘贴进去（每行一个，或用逗号、空格分隔），点「保存名单」。
3. 打开一个浏览器标签当大屏：`display.html?class=class-1`。
4. 再开一个标签打开教师端，注册一个老师账号，点「申请管理班级」。
5. 回到管理端「待审批申请」批准它。
6. 老师端进入班级，点一个学生发送，大屏应立刻显示。

试用时如果不在课间，点人会被拒绝（提示「当前正在上课」）。可以先在管理端「全校作息」里临时把时段改宽。

### 用环境变量创建首个管理员

不想交互式输入时：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='一个强密码' ADMIN_NAME='管理员' npm start
```

只在数据库里还没有管理员时生效一次。之后的管理员只能由现有管理员在管理端创建。

---

## 3. 部署到正式服务器

适用于 Ubuntu / Debian，需要 root。整体分四步：跑部署脚本 → 配 Nginx 和 HTTPS → 创建管理员 → 布置大屏。

### 3.1 运行部署脚本

把仓库复制到服务器任意目录（例如 `/tmp/class-caller`），然后：

```bash
cd /tmp/class-caller
sudo bash ./deploy.sh
```

脚本会自动完成：

- 检查或安装 Node.js
- 在源目录跑一遍全部测试（不通过就中止，不碰线上）
- 校验线上数据能被新版本正确读取
- 创建低权限系统用户 `classcaller`
- 安装到 `/opt/class-caller`（只读），数据目录 `/var/lib/class-caller`（权限 0700）
- 注册并重启 systemd 服务 `class-caller`
- 健康检查

脚本可以反复运行，升级时也是同一条命令。

### 3.2 配置 Nginx 与 HTTPS

服务只监听 `127.0.0.1:3000`，公网必须经 Nginx 反向代理。示例配置在 [`nginx.conf.example`](nginx.conf.example)，复制到 `/etc/nginx/sites-available/class-caller`，把域名改成你的，然后：

```bash
sudo ln -sf /etc/nginx/sites-available/class-caller /etc/nginx/sites-enabled/class-caller
sudo certbot --nginx -d 你的域名     # 申请证书
sudo nginx -t && sudo systemctl reload nginx
```

示例配置里有三点**不能省**，否则会出现本文第 8 节的典型故障：

| 配置 | 作用 |
| --- | --- |
| `auth_basic off;` | 系统自带登录，不能再套 Nginx 的 Basic Auth，否则浏览器会弹原生登录框 |
| 大屏和教师端的 SSE 路径 `location ~ ^/api/classes/[a-z0-9-]+/(public/)?stream$` 关闭 `proxy_buffering`、`gzip`，超时 24 小时 | 通知才能实时推送，大屏不会每隔几十秒断一次 |
| 透传 `X-Real-IP` 和 `X-Forwarded-Proto` | 登录限速按真实 IP；HTTPS 下 Cookie 加 `Secure` |

> 如果域名接入了 **Cloudflare**：必须为路径 `/api/*` 创建 WAF 跳过规则，关闭 Managed Challenge、Under Attack Mode 和 Access 登录，并关闭该路径的缓存。否则大屏程序和教师端拿到的是「Just a moment...」验证页而不是接口数据。

### 3.3 创建首个管理员

```bash
cd /opt/class-caller && sudo -u classcaller DATA_DIR=/var/lib/class-caller node scripts/init-admin.js
```

### 3.4 常用运维命令

```bash
sudo systemctl status class-caller        # 服务状态
sudo journalctl -u class-caller -f        # 实时日志（JSON 每行一条）
sudo systemctl restart class-caller       # 重启
ls /var/lib/class-caller/backups          # 每日自动备份
```

---

## 4. 管理员日常操作

打开 `https://你的域名/admin.html`。首页「概览」优先显示需要处理的事：待审批申请、被自动暂停的定时任务、离线的大屏、现在是否允许点人。

### 班级与学生

- **新增班级**：填班级标识（小写字母、数字、连字符，创建后不可改，大屏绑定用）、名称、短编号（大屏角落显示）、辅助色、自动清屏秒数（0 为常驻）。
- **录入名单**：每个班级卡片下面有名单框，每行一个姓名，也可直接粘贴用逗号、顿号、空格分隔的名单。点「保存名单」。同名会自动去重，单班最多 200 人。
- **修改名单**：直接改名单框再保存。被移出名单的学生若出现在某个定时提醒里，该提醒会自动暂停并标明原因。
- **编辑**：改名称、编号、颜色、自动清屏时间、启动器模式。
- **归档**：该班大屏连接关闭、老师不能再操作、定时任务暂停；可随时恢复。

### 待审批申请

老师申请管理某个班后会出现在这里。批准即授权；拒绝可填理由，老师端能看到。

### 教师与权限

- **创建账号**：可以直接替老师建账号（也可建其他管理员）。初始密码告知本人，首次登录必须修改。
- **授权 / 撤销**：在账号行里选择班级即授权；点班级标签上的「撤销」立即收回，不等会话过期。
- **停用 / 启用**：停用后该账号所有登录立即失效，其定时提醒暂停。
- **重置密码**：生成一次性临时密码，只显示一次；管理员看不到原密码。
- **删除**：连同其班级授权、申请和定时提醒一起删除；已发出的通知记录保留。不能删除自己，也不能删除最后一名管理员。
- **编辑**：改姓名、职务。职务会出现在大屏上（如「数学老师 · 张老师」）。

### 全校作息

编辑允许点人的时段和星期。改完后，不再落在时段内的定时提醒会自动暂停。详见第 7 节。

### 定时任务

查看全校所有老师的定时提醒，可以启用、暂停、改时间、删除。

### 大屏与设备

每个班的大屏在线数量、当前显示内容、等待队列。可以清空任意班级的大屏，也可以发**紧急广播**（最高优先级，仅管理员）。

### 操作记录

所有管理操作和老师的点人、留言都带操作者、时间、来源 IP。可按操作类型筛选。

### 系统设置

- **留言策略**：`立即显示` 或 `下一课间显示`（老师在上课期间发的普通留言推迟到下一次课间；紧急广播不受影响）。
- **强制全员重新登录**：升级或怀疑泄露时使用。

---

## 5. 老师日常操作

打开 `https://你的域名/teacher.html`。

### 第一次使用

1. 点「注册」，填登录名、姓名、密码（至少 8 位）、职务（可选，如「班主任」）。
2. 登录后在个人工作台点「申请管理班级」，选班级，可写一句说明。
3. 等管理员批准。被拒绝会显示理由，可以重新申请。

管理员替你建的账号：用初始密码登录后必须先改密码。

### 进入班级后的四个标签

**点人**
- 顶部显示现在是否课间、下一个可用时段。
- 搜索或点选学生（一次最多 20 人），可加一句说明（最多 60 字），点发送。
- 右侧是大屏当前内容、每个学生的「收到」状态、等待队列。
- 可以「再次发送」或「撤回」之前的通知，也可以清屏。

**班级留言**
- 标题（≤30 字）、正文（≤300 字）、立即显示或定时显示、自动下屏时间（0 为持续显示）。
- 留言不选学生，大屏上没有「收到」按钮。
- 有大屏预览。

**定时提醒**
- 选学生、时间、星期，之后每到那个时间自动点人（例如每天 11:40 提醒值日生）。
- 时间必须落在允许点人的时段内。
- 可以启用、暂停、改时间、删除，能看到最近一次执行结果和自动暂停原因。

**记录**
- 点人、留言、定时执行的统一时间线，按类型、老师、日期筛选。

署名来自登录账号，不能自选身份。

---

## 6. 教室大屏

### 方案一：浏览器大屏（推荐）

任何现代浏览器打开：

```
https://你的域名/display.html?class=班级标识
```

- 必须带 `class` 参数。没有参数、班级不存在或不匹配时**不显示任何内容**，只显示绑定错误，不会串班。
- 点一下画面进入全屏并解锁提示音。
- 学生点「收到」确认全部；点某个姓名只确认这一个人。
- 断线自动重连，重连后恢复当前内容；服务器暂时不可达时会显示原因并自动重试。
- 建议浏览器设为开机自启并打开这个地址。

### 方案二：Windows 原生程序 `display.exe`

适合 Windows 7/10 的教室电脑，需要自动前置、全屏、提示音。

- 从 [Releases](https://github.com/xzygreen/class-caller/releases/latest) 下载 ZIP。
- 在同目录的 `display.ini` 里填 `server=你的域名` 和 `class_id=班级标识`。
- 32 位程序，只依赖系统自带的 `msvcrt.dll`。Windows 7 需要 TLS 1.2 支持和较新的根证书。

详细步骤和故障对照表见 [Windows 原生大屏部署](docs/windows-display.md)。

### 方案三：旧版启动器

需要在收到通知时拉起既有 Windows 程序时使用，见 [Windows 启动器部署](docs/windows-launcher.md)。

---

## 7. 全校作息与定时提醒

### 允许点人的时段

服务端按 `Asia/Shanghai` 时区判断，不依赖网页按钮；直接调接口也会被拒绝。默认时段（周一至周五，开始时刻包含，结束时刻不包含）：

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

管理员在「全校作息」里按学校实际情况修改，包括周末是否允许。

### 定时提醒为什么可靠

- 以「任务 + 日期」为唯一执行标识，服务重启或重复扫描不会一天发两次。
- 服务重启后两分钟内会补发错过的任务，超过就记为「已错过」，不在上课途中补发。
- 每次执行前重新检查：时段是否允许、班级是否有效、创建老师是否仍有权限、学生是否还在名单。
- 老师失去权限、学生被移出名单、班级归档、作息改动导致时间不再合法时，任务自动暂停并显示原因；管理员和老师都能看到。

---

## 8. 常见问题排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 打开教师端弹出**浏览器自带的**用户名密码框（不是页面里的登录表单） | Nginx 里还留着旧版的 `auth_basic` | 用 `nginx.conf.example` 替换配置，确认每个 `location` 都有 `auth_basic off;`，`nginx -t && systemctl reload nginx` |
| 老师发送成功，大屏不显示，或大屏每隔几十秒断一次 | Nginx 的 SSE 路径没关缓冲，或路径写错（旧版是 `/api/stream`，新版是 `/api/classes/<班级>/public/stream`） | 用示例配置里的 `location ~ ^/api/classes/[a-z0-9-]+/(public/)?stream$` |
| 大屏或教师端显示「请求被 Cloudflare 人机验证拦截」 | Cloudflare 对 `/api/*` 开了 Managed Challenge | Cloudflare 后台加 WAF 跳过规则：URI 路径以 `/api/` 开头则跳过验证 |
| 大屏显示「班级绑定错误」 | 地址里没有 `class=` 或标识写错 | 对照管理端「班级与学生」里的班级标识 |
| 点人提示「当前正在上课，暂不能点人」 | 不在允许时段 | 等课间，或让管理员调整全校作息 |
| 点人提示「该姓名不在本班名单中」 | 名单被改过 | 管理端更新名单后老师端刷新 |
| 定时提醒显示「已暂停」 | 见暂停原因：作息变动 / 权限撤销 / 学生移出 / 班级归档 | 解决原因后点「恢复」 |
| 登录提示「尝试次数过多」 | 同一 IP 对同一用户名连续错 5 次 | 等 60 秒 |
| 部署脚本报「检测到旧版本残留测试文件」 | 新版覆盖解压到了旧目录 | 按提示删除列出的文件，或换一个干净目录重新解压 |
| `display.exe` 显示「未连接 · 错误 401/403」 | Basic Auth 或 Cloudflare 拦截了公开接口 | 同前两条 |

看服务端日志：`sudo journalctl -u class-caller -f`。每行是一条 JSON，`event` 字段说明发生了什么，不会记录密码、令牌或完整名单。

---

## 9. 升级与备份

### 升级

把新版本解压到一个**干净的目录**，再运行 `sudo bash ./deploy.sh`。脚本会先跑测试、再校验线上数据能被新版本读取，都通过才替换 `/opt/class-caller` 并重启。数据目录不会被覆盖。

从旧的「共享班级密码」版本升级，请先阅读 [账号版升级指南](docs/upgrade-accounts.md)：Nginx 配置必须更新，旧的 `students.json` 会在首次启动时自动导入班级和名单（密码字段丢弃）。

### 备份

- 数据只有一个文件：`/var/lib/class-caller/db.json`。
- 每天自动备份到 `/var/lib/class-caller/backups/`，保留 14 份；部署脚本升级前也会备份一份。
- 异地备份只需定期复制这个目录。恢复时停服务、放回文件、起服务。

---

## 10. 安全与隐私

- 密码只保存 scrypt 加盐摘要；日志不记录密码、令牌、完整名单或留言正文。
- 会话是 `HttpOnly` + `SameSite=Strict` 的 Cookie，12 小时过期；HTTPS 下自动加 `Secure`。
- 修改密码、停用账号、撤销权限、重置密码、删除账号后相关会话立即失效。
- 登录按 IP + 用户名限速（5 次错误锁 60 秒），注册按 IP 限速，修改类接口校验 `Origin`。
- 每个请求都重新校验：会话 → 账号状态 → 角色 → 班级权限 → 作息 → 学生在册。
- 大屏用的公开接口只返回当前通知，从不返回完整名单。
- 所有管理操作写入审计，带操作者、时间、来源 IP。
- 数据文件权限 0600，服务以低权限用户运行，代码目录只读。

涉及未成年人信息，上线前请阅读 [隐私政策](PRIVACY.md)。

---

## 11. 参考：接口、配置、项目结构

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；公网请保持回环并走 Nginx |
| `DATA_DIR` | `./data` | 数据目录（生产为 `/var/lib/class-caller`） |
| `LEGACY_CONFIG` | `./students.json` | 旧版名单文件，只在数据库里没有班级时导入一次 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | 无 | 首个管理员，只在没有管理员时读取一次 |

### 主要限制

| 项目 | 限制 |
| --- | --- |
| 一次点人 | 最多 20 人，说明最多 60 字 |
| 留言 | 标题 30 字，正文 300 字，最长显示 7 天 |
| 名单 | 每班 200 人，姓名 20 字 |
| 等待队列 | 每班 20 条 |
| 记录 | 每班保留 500 条，审计保留 5000 条 |

### API 一览

所有修改类请求需要登录 Cookie 并校验 `Origin`。

| 组 | 路径 |
| --- | --- |
| 公开 | `GET /api/public/classes`、`GET /api/public/status` |
| 大屏 | `GET /api/classes/:id/public/config`、`GET /api/classes/:id/public/stream?role=display`、`POST /api/classes/:id/public/ack` |
| 账号 | `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/me`、`POST /api/me/password`、`GET /api/me/classes`、`POST /api/me/class-requests`、`DELETE /api/me/class-requests/:id` |
| 教师班级 | `GET /api/classes/:id/workspace`、`GET /api/classes/:id/stream`、`GET /api/classes/:id/status`、`POST /api/classes/:id/calls`、`POST /api/classes/:id/announcements`、`GET /api/classes/:id/notices`、`POST /api/classes/:id/notices/:nid/{resend,withdraw}`、`GET/POST /api/classes/:id/schedules`、`PATCH/DELETE /api/classes/:id/schedules/:sid`、`GET /api/classes/:id/activity`、`POST /api/classes/:id/display/clear` |
| 管理员 | `GET /api/admin/overview`、`GET /api/admin/requests`、`POST /api/admin/requests/:id/{approve,reject}`、`GET/POST /api/admin/users`、`PATCH/DELETE /api/admin/users/:id`、`POST /api/admin/memberships`、`POST /api/admin/memberships/revoke`、`GET/POST /api/admin/classes`、`PATCH /api/admin/classes/:id`、`PUT /api/admin/classes/:id/students`、`GET/PUT /api/admin/call-windows`、`GET /api/admin/schedules`、`PATCH/DELETE /api/admin/schedules/:id`、`POST /api/admin/classes/:id/display/clear`、`GET /api/admin/audit`、`GET/PATCH /api/admin/settings`、`POST /api/admin/sessions/revoke-all` |

旧接口 `/api/classes/:id/teacher/*` 与 `/api/teacher/*` 返回 `410`。

### 数据存储

单个带版本号的 JSON 文件：串行写入、写临时文件后原子替换、每日备份、写入失败保留上一份有效数据。业务层只通过存储接口读写，未来可切换到 SQLite。

### 测试

```bash
npm test
```

覆盖账号与会话、申请审批与权限隔离、作息规则、定时任务的去重与补偿与自动暂停、点人与留言、显示队列、数据仓库、前端页面约束、Windows 程序源码与编译产物检查。

### `display.exe` 的构建

由 GitHub Actions 自动构建：推送到 `main` 会用 `gcc-mingw-w64-i686` 编译并上传产物（Actions → CI → Artifacts）；打 `v*` 标签生成带 ZIP 与校验文件的 Release。本地构建见 [Windows 原生大屏部署](docs/windows-display.md)。

### 项目结构

```text
class-caller/
├── server.js                 # 服务入口
├── scripts/init-admin.js     # 创建首个管理员
├── lib/                      # 存储、账号、权限、作息、调度、通知队列、路由
├── public/                   # 教师端、管理端、浏览器大屏
├── test/                     # 测试套件
├── docs/                     # 升级与 Windows 部署文档
├── windows-display/          # 原生大屏源码与构建脚本
├── windows-launcher/         # 旧版启动器源码与构建脚本
├── .github/workflows/        # CI 与 display.exe 发布
├── students.example.json     # 旧版名单示例（仅用于首次导入）
├── nginx.conf.example        # Nginx 反向代理示例
├── class-caller.service      # systemd 服务定义
└── deploy.sh                 # Ubuntu/Debian 部署脚本
```

---

## 12. 文档与许可

- [账号版升级指南](docs/upgrade-accounts.md)
- [多班级升级指南（历史）](docs/upgrade-multiclass.md)
- [Windows 原生大屏部署](docs/windows-display.md)
- [Windows 启动器部署](docs/windows-launcher.md)
- [隐私政策](PRIVACY.md)
- [保留权利与署名说明](NOTICE.md)

源代码、构建文件、示例配置和技术文档采用 [MIT License](LICENSE)。项目名称、商标、品牌素材及明确标记的非代码材料之保留权利见 [NOTICE.md](NOTICE.md)。
