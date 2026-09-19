# Class Caller｜老师找人通知大屏

一个面向学校场景的多班级实时通知系统。老师在手机或电脑上选择学生并发送通知，指定班级的大屏会立即显示找人老师、学生姓名和附加说明；学生可在大屏上确认「收到」，教师端会同步更新确认状态。

项目采用原生 Node.js 与浏览器 API 实现，服务端零第三方运行时依赖，同时提供兼容 Windows 7/10 的原生大屏程序。

> [!IMPORTANT]
> 公开仓库不包含真实学生名单、教师密码或部署地址。首次运行时请从 `students.example.json` 创建本地配置；`students.json` 已被 Git 忽略，请勿将真实配置、日志或访问令牌提交到公开仓库。

## 功能概览

- **多班级隔离：**名单、密码、通知、历史、登录会话、大屏连接和自动清屏计时均按班级隔离。
- **实时同步：**基于 Server-Sent Events（SSE）推送通知、清屏、在线状态和确认结果，断线后自动重连。
- **教师端操作：**支持学生搜索与多选、教师身份、附加说明、历史记录、撤销、重发和手动清屏。
- **大屏确认：**可确认全部学生，也可逐个点击姓名确认；结果实时回传教师端。
- **安全边界：**教师接口需要班级密码换取的短期令牌，公开接口不返回完整学生名单。
- **多种大屏：**支持浏览器大屏，以及兼容 Windows 7/10 的 32 位原生 `display.exe`。
- **易于部署：**自带 systemd、Nginx 示例和 Ubuntu/Debian 一键部署脚本。

## 快速开始

### 环境要求

- Node.js 18 或更高版本（生产环境推荐 Node.js 22）
- 无需安装 npm 依赖

### 本地运行

```bash
git clone https://github.com/xzygreen/class-caller.git
cd class-caller
cp students.example.json students.json
# 编辑 students.json，替换示例班级、密码和名单
npm test
npm start
```

服务默认只监听 `127.0.0.1:3000`。启动后打开：

- 教师端：<http://127.0.0.1:3000/teacher.html>
- 浏览器大屏：<http://127.0.0.1:3000/display.html?class=class-a>
- 健康检查：<http://127.0.0.1:3000/api/public/classes>

如需在局域网内直接测试，可显式修改监听地址：

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

生产环境不建议直接暴露 Node.js 端口，请使用 HTTPS 反向代理。

## 配置班级

`students.json` 使用 version 2 多班级格式。最小示例如下：

```json
{
  "version": 2,
  "classes": [
    {
      "id": "class-a",
      "name": "示例班级1",
      "code": "01",
      "color": "blue",
      "password": "请替换为独立强密码",
      "autoClearSeconds": 30,
      "launcher": {
        "mode": "off",
        "freshSeconds": 30
      },
      "students": ["示例学生1A", "示例学生1B"]
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 班级固定标识，支持小写字母、数字和连字符，长度 1–32；配置大屏后不要随意修改。 |
| `name` | 班级显示名称，最长 32 个字符。 |
| `code` | 界面使用的班级短编号，最长 4 个字符。 |
| `color` | 辅助色：`blue`、`green`、`orange`、`purple`、`teal` 或 `red`。 |
| `password` | 该班教师共享密码；每个班必须使用不同密码。 |
| `autoClearSeconds` | 通知自动清屏时间，单位为秒，最大 3600。 |
| `launcher.mode` | `off`、`protocol` 或 `native`；使用 `display.exe` 时保持 `off`。 |
| `launcher.freshSeconds` | 旧启动器接受通知的有效窗口，范围 5–300 秒。 |
| `students` | 本班学生姓名数组；同一班内不得重名。 |

完整的四班示例见 [`students.example.json`](students.example.json)。配置重载采用整份校验：任何班级存在错误时都会拒绝更新，并继续使用上一份有效配置。

## 使用流程

### 教师端

1. 选择班级，输入该班密码登录。
2. 确认页面顶部显示「本班大屏在线」。
3. 搜索并选择学生；单次最多选择 20 人。
4. 选择找人身份，按需填写不超过 60 个字符的附加说明。
5. 点击「通知到大屏」，或使用 `Ctrl + Enter`（macOS 为 `Command + Enter`）。
6. 在当前通知区域查看每位学生的「已收到 / 未收到」状态。

教师端还可清空当前大屏、重发上一条或指定历史通知、撤销最后一条记录，以及清空本班历史。切换班级时必须退出并重新登录，未发送的选择和说明会被清空。

### 教室大屏

浏览器大屏必须通过 `class` 查询参数绑定班级：

```text
https://你的域名/display.html?class=class-a
```

没有 `class`、班级不存在或服务端返回的班级不匹配时，大屏会拒绝展示通知。收到通知后：

- 点击底部「收到」可确认全部学生；
- 点击某个学生姓名可只确认该学生；
- 确认结果会同步到本班所有大屏和教师端；
- 断线重连后会恢复当前仍在展示的通知；
- 到达 `autoClearSeconds` 后自动回到待机界面。

## 生产部署

生产部署面向 Ubuntu/Debian，并需要 root 权限。准备好本机 `students.json` 后运行：

```bash
sudo bash ./deploy.sh
```

部署脚本会：

1. 检查 Node.js 版本，必要时安装 Node.js 22；
2. 运行完整测试并校验多班级配置；
3. 创建低权限的 `classcaller` 系统用户；
4. 安装应用到 `/opt/class-caller`；
5. 备份服务器已有的 `students.json`；
6. 安装、启用并重启 systemd 服务；
7. 检查本机健康接口。

服务只监听 `127.0.0.1:3000`。请参考 [`nginx.conf.example`](nginx.conf.example) 配置 HTTPS 反向代理；示例已针对 SSE 关闭缓冲、缓存和 gzip，并设置长连接超时。

常用维护命令：

```bash
sudo systemctl status class-caller
sudo systemctl restart class-caller
sudo journalctl -u class-caller -f
```

从旧的单班版本升级前，请先阅读[多班级升级指南](docs/upgrade-multiclass.md)。

## Windows 大屏方案

| 方案 | 适用场景 | 配置方式 | 文档 |
| --- | --- | --- | --- |
| 浏览器大屏 | 现代浏览器、无需安装 | URL 中设置 `?class=<班级 ID>` | 本文「教室大屏」章节 |
| 原生 `display.exe` | Windows 7/10，需要自动前置、全屏和提示音 | `display.ini` 中设置 `server` 与 `class_id` | [原生大屏部署](docs/windows-display.md) |
| 旧版启动器 | 需要拉起既有 Windows 程序 | 自定义协议或原生 SSE watcher | [启动器部署](docs/windows-launcher.md) |

推荐使用原生 `display.exe`。它是 32 位 Win32 程序，可在 Windows 7 SP1 x86 和 Windows 10 x64 上运行；程序、配置与日志可放在不会被系统还原的 D 盘。可从 [GitHub Releases](https://github.com/xzygreen/class-caller/releases/latest) 下载带校验文件的 ZIP，也可按文档自行构建并完成实机验证。

## API 概览

以下示例使用 `class-a`。教师接口除登录外均需携带 `X-Teacher-Token` 请求头。

| 方法 | 路径 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| `GET` | `/api/public/classes` | 获取可选班级的公开信息 | 否 |
| `GET` | `/api/classes/class-a/public/config` | 获取大屏所需公开配置 | 否 |
| `GET` | `/api/classes/class-a/public/stream?role=display` | 订阅本班 SSE 事件流 | 否 |
| `POST` | `/api/classes/class-a/public/ack` | 确认当前通知 | 否 |
| `POST` | `/api/classes/class-a/teacher/login` | 用班级密码换取临时令牌 | 班级密码 |
| `GET` | `/api/classes/class-a/teacher/students` | 获取本班名单 | 令牌 |
| `GET` | `/api/classes/class-a/teacher/status` | 获取当前大屏状态 | 令牌 |
| `GET` | `/api/classes/class-a/teacher/history` | 获取本班历史记录 | 令牌 |
| `POST` | `/api/classes/class-a/teacher/call` | 发送通知 | 令牌 |
| `POST` | `/api/classes/class-a/teacher/clear` | 清空当前大屏 | 令牌 |
| `POST` | `/api/classes/class-a/teacher/history/{undo,clear,resend}` | 管理本班历史 | 令牌 |
| `POST` | `/api/classes/class-a/teacher/reload` | 校验并重载全部班级配置 | 令牌 |
| `POST` | `/api/classes/class-a/teacher/logout` | 注销当前令牌 | 令牌 |

接口路径和登录会话共同决定班级，请求体中的 `classId` 不作为权限依据。旧的无班级接口 `/api/public/*` 和 `/api/teacher/*` 会返回 `410 LEGACY_ENDPOINT`。

## 数据、安全与隐私

- `students.json` 由部署者维护，应用只读；生产部署将其权限设为 `0640`。
- 教师令牌在内存中保存，最长有效 12 小时，注销或服务重启后失效。
- 同一来源对同一班级连续输错 5 次密码，会被锁定 60 秒。
- 班级公开接口不会返回完整学生名单，但大屏事件流会包含当前通知所需的姓名和说明。
- 当前通知、确认状态和历史记录只保存在服务器内存中；每班最多 500 条历史，服务重启后清空。
- 默认日志不记录原始密码、登录令牌、完整名单或附加消息正文。
- 生产环境必须使用 HTTPS，并限制配置文件、服务器日志和大屏设备的访问权限。

部署者是其运行实例的数据管理者。涉及未成年人信息时，请在上线前阅读[隐私政策](PRIVACY.md)，并根据实际使用地区、学校制度和授权关系履行相应义务。

## 测试

```bash
npm test
```

测试覆盖配置校验、班级隔离、鉴权、SSE、通知确认、历史操作、自动清屏、浏览器端行为，以及 Windows 程序构建产物的基本兼容性检查。部署脚本会在修改线上目录前自动运行测试。

## 项目结构

```text
class-caller/
├── server.js                 # 服务入口
├── lib/                      # 配置、鉴权、路由、状态与 SSE
├── public/                   # 教师端与浏览器大屏
├── test/                     # Node.js 测试套件
├── docs/                     # 升级和 Windows 部署文档
├── windows-display/          # 原生大屏源码与构建脚本
├── windows-launcher/         # 旧版启动器源码与构建脚本
├── students.example.json     # 脱敏配置示例
├── nginx.conf.example        # Nginx 反向代理示例
├── class-caller.service      # systemd 服务定义
└── deploy.sh                 # Ubuntu/Debian 部署脚本
```

## 常见问题

### 教师端看不到班级列表

先访问 `/api/public/classes`。若接口不可用，请检查 `class-caller` 服务状态和 Nginx 反向代理配置。

### 密码正确但提示错误次数过多

同一来源连续输错 5 次会锁定 60 秒。等待一分钟后，重新确认所选班级和对应密码。

### 教师端显示“大屏未连接”

确认大屏页面或 `display.exe` 已启动，并核对 URL 的 `class` 或 `display.ini` 的 `class_id`。原生程序的连接错误码和 TLS 排查方法见[原生大屏部署文档](docs/windows-display.md)。

### 修改名单后没有生效

开发环境修改项目根目录的 `students.json`；生产环境修改 `/opt/class-caller/students.json`，然后重启服务。也可通过受保护的 `teacher/reload` 接口热重载整份配置。

### 服务重启后记录和登录消失

这是预期行为。登录会话、当前通知、确认状态和历史记录均为内存数据，不会写入数据库。

## 文档与许可

- [多班级升级指南](docs/upgrade-multiclass.md)
- [Windows 原生大屏部署](docs/windows-display.md)
- [Windows 启动器部署](docs/windows-launcher.md)
- [隐私政策](PRIVACY.md)
- [保留权利与署名说明](NOTICE.md)

源代码、构建文件、示例配置和技术文档采用 [MIT License](LICENSE)。项目名称、商标、品牌素材及明确标记的非代码材料之保留权利见 [NOTICE.md](NOTICE.md)。
