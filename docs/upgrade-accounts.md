# 从「班级共享密码」升级到「个人账号 + 班级授权」

适用于已经用 `deploy.sh` 部署在 `/opt/class-caller`、由 systemd 服务 `class-caller` 运行、Nginx 反代的服务器。**安排维护窗口，不承诺无中断升级。** 数据备份、管理员初始化和人工恢复必须停服；公开大屏 URL 延续不代表所有旧客户端支持新增的留言/协议字段，按后面的验收清单验证。

## 这次升级改变了什么

| 旧 | 新 |
| --- | --- |
| 教师先选班、再输该班共享密码 | 教师用个人账号登录，班级权限由管理员授权 |
| `students.json` 里写班级密码和名单 | 名单在管理端维护，保存在数据仓库；密码字段被丢弃 |
| 令牌放 `localStorage`，请求头 `X-Teacher-Token` | `HttpOnly` + `SameSite=Strict` Cookie，修改类请求校验 `Origin` |
| 只有找人 | 点人、班级留言、每日定时提醒，按优先级排队显示 |
| 任何时间都能点人 | 全校作息统一由服务端判断，上课期间返回 `CALL_WINDOW_CLOSED` |
| 无审计 | 管理员的所有修改都有操作者、时间、来源 |

旧接口 `/api/classes/:id/teacher/*` 一律 `410`，没有兼容后门。

## 0. 本机准备

从经过测试的提交制作只含 Git 跟踪源码的包，不要把本机数据、`.claude/`、日志或真实 `students.json` 同步到服务器；不要用 `rsync --delete` 对线上代码/数据目录盲目镜像。

```bash
npm test
git archive --format=tar.gz --output=/tmp/class-caller-source.tar.gz HEAD
scp /tmp/class-caller-source.tar.gz 用户名@服务器地址:~/
```

在服务器解压到一个新的空目录作为后续的 `~/class-caller`（若已存在，另选名字），避免混入旧测试或编译产物。记录所用提交；未提交的本地改动不会进入 `git archive HEAD`。

## 1. 服务器上留一份可回退的现场

确认 Nginx 站点文件的实际路径，下例使用 `/etc/nginx/sites-available/class-caller`。在同一个服务器终端中执行并记下输出的快照路径：

```bash
ssh 用户名@服务器地址
sudo systemctl stop class-caller
snapshot="/root/class-caller-pre-accounts-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 "$snapshot"
sudo cp -a /opt/class-caller "$snapshot/app"
sudo cp -a /etc/systemd/system/class-caller.service "$snapshot/class-caller.service"
sudo cp -a /etc/nginx/sites-available/class-caller "$snapshot/nginx-site"
if sudo test -d /var/lib/class-caller; then
  sudo cp -a /var/lib/class-caller "$snapshot/data"
fi
printf '保留此快照路径：%s\n' "$snapshot"
```

任一复制失败都先处理，不继续部署；不要恢复快照中的旧锁文件。现场可能包含旧明文班级密码、姓名、会话及日志，必须受限保存并单独设定到期日。

## 2. 更新 Nginx

新版本多了教师端实时流 `/api/classes/<班级>/stream`（需要登录 Cookie），并且依赖 `X-Forwarded-Proto` 给 Cookie 加 `Secure`。优先使用完整的当前 [`nginx.conf.example`](../nginx.conf.example)。下面的 `limit_conn_zone` 必须放在 `http` 上下文、`server` 块之外，`location` 放在对应站点 `server` 内；同名 zone 只声明一次。共享出口 IP 的学校应按规模评估限额，不能只把连接数无限调大。

```nginx
# http 上下文
limit_conn_zone $binary_remote_addr zone=caller_stream_ip:10m;
limit_conn_zone $server_name zone=caller_stream_server:1m;

# 对应站点的 server 上下文
location ~ ^/api/classes/[a-z0-9-]+/(public/)?stream$ {
    limit_conn caller_stream_ip 64;
    limit_conn caller_stream_server 1024;
    limit_conn_status 429;
    send_timeout 30s;
    auth_basic off;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection '';
    proxy_hide_header WWW-Authenticate;
    proxy_buffering off; proxy_request_buffering off; proxy_cache off; gzip off;
    chunked_transfer_encoding on;
    proxy_read_timeout 24h; proxy_send_timeout 24h;
}
```

原来针对 `/api/classes/[a-z0-9-]+/teacher/` 的 `location` 必须删除。HTTPS `server` 和普通 `location /` 也应写明 `auth_basic off;`；否则旧配置或上层配置会让浏览器弹出原生 Username / Password 对话框。确认每个 `location` 都有 `proxy_set_header X-Forwarded-Proto $scheme;`，然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

完整示例见 [`nginx.conf.example`](../nginx.conf.example)。

如果域名接入 Cloudflare，不得对 `/api/*` 使用 Managed Challenge、Under Attack Mode 或 Access 登录。浏览器 `EventSource`、WinHTTP 大屏和 JSON 请求无法把挑战页面当作接口响应。请创建 URI Path 以 `/api/` 开头的 WAF 跳过规则，并关闭该路径的缓存；网页路径仍可保留其它防护。以下响应必须是应用 JSON，而不是 `403 Just a moment...`：

```bash
curl -i https://你的域名/api/public/status
```

## 3. 运行部署脚本

```bash
cd ~/class-caller && sudo bash deploy.sh
```

脚本会：

1. 跑全部测试；
2. 若 `/var/lib/class-caller/db.json` 已存在，先用新代码试载入；
3. 安装代码到 `/opt/class-caller`（只读），数据目录 `/var/lib/class-caller`（属主 `classcaller`，0700）；
4. 注册新的 systemd unit（含 `StateDirectory=class-caller`）并重启。

首次以新版本启动时，服务会读取 `/opt/class-caller/students.json` 把班级与名单导入数据仓库，`password` 字段被丢弃，并写入一条 `class.import_legacy` 审计。导入只发生在数据仓库里还没有任何班级时；之后日常修改以 `db.json` 为准。核对班级/名单数量和一份受限备份后，按学校留存策略移走或删除旧导入文件及副本，避免原文件里的旧密码一直留在服务器。不要删除主库来“重新导入”，那会丢失账号、权限和历史。

## 4. 创建首个管理员

首个管理员不能使用公开默认密码。**部署脚本若已启动服务，也必须再次停止后运行离线初始化。** 只在初始化成功后启动；不要运行中另起维护进程，也不要删活动锁绕过检查。

```bash
# 交互式（推荐）：密码不会出现在命令历史或日志里
sudo systemctl stop class-caller && \
  sudo -u classcaller env DATA_DIR=/var/lib/class-caller \
    node /opt/class-caller/scripts/init-admin.js && \
  sudo systemctl start class-caller
```

已有可用管理员时，通过管理端增加账号，不必再次初始化。也可在受限的 systemd 配置中临时设置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，由**唯一服务进程启动时**创建首个管理员；确认后删除变量并 `daemon-reload`，不要把密码写入公开 unit、命令历史或仓库。这不是在线 CLI 初始化方式。

打开 `https://你的域名/admin` 登录，核对 `/api/public/status` 的 `setupRequired` 为 `false`，再注册一个合成测试教师并确认管理员仍存在。

## 5. 让教师迁移

1. 教师打开 `https://你的域名/teacher` → 「教师注册」；
2. 在个人工作台提交「申请管理班级」并写明理由（如「本班数学教师」）；
3. 管理员在管理端「待审批申请」里批准，权限立即生效；
4. 也可以由管理员在「教师与权限」里直接授权，或在创建账号时发初始密码。

旧的班级密码从这一刻起完全失效；教师端不再有「选班 + 密码」入口。

## 6. 检查全校作息

管理端「全校作息」默认已填入八个课间时段（周一至周五）。请与学校课表核对，特别是 `11:35–12:30` 是否视为连续可用时段、`13:00–13:10` 是否保留。保存后立即生效。

## 7. 更新大屏程序（可选，但推荐）

不要假定任意旧版 `display.exe` / 启动器支持当前所有快照字段。按 [Windows 大屏指南](windows-display.md) 与 [启动器指南](windows-launcher.md) 更新，并核对 Release 的 `release-manifest.json`、源码提交和 `.sha256`；保留原设备配置，不从公开包获取真实服务地址。用合成点人、留言、清屏和收到确认做端到端验收，原生启动器还需验证目标程序确实被唤起。解析器测试或交叉编译不能替代目标 Windows 设备验证。

## 8. 验收清单

- 用旧班级密码在任何地方都无法登录；`POST /api/classes/<班级>/teacher/login` 返回 410；
- 未获批教师打开班级得到 `NO_CLASS_ACCESS`，看不到名单；
- 管理员批准后教师不用重新登录即可进入；撤销后当前会话立即失去访问；
- 08:45 可以点人，09:00 提示「当前正在上课，暂不能点人」并给出下次时间；周末不能点人；
- 留言不需要选学生，大屏留言版式没有「收到」按钮；
- 修改作息后不合法的定时任务出现在管理端「暂停的定时任务」里，原因为「作息已修改」；
- 管理端「操作记录」里每条都有操作者与时间；
- 合成账号在改密/停用/撤权后不能用旧身份继续写入，未来公告不应绕过撤权或「下一课间」策略；
- 作息勾选星期后增删时段，保存并刷新仍保持；长留言完整可读，模态表单失败时在框内保留错误和输入；
- 服务重启后名单、账号、通知与审计仍存在；只当前显示/确认状态属于内存，不用重启清除历史；
- 在隔离数据目录演练备份恢复，核对隐私清理范围与备份仍含旧数据的边界，见 [隐私政策](../PRIVACY.md)。

## 回退

先决定回退的是**代码**还是**代码和数据的同一时间点**。旧代码可能不理解新主库；恢复旧数据会丢掉快照之后的更改、恢复被删除的信息或被撤销的账号权限。先在隔离副本验证，记录并重放期间的删除/停用/撤权决定，再恢复对外访问。

以下是代码与配置回退示例，`snapshot` 必须替换为第 1 步实际保存的目录。保留失败现场，不直接 `rm -rf` 唯一代码/数据：

```bash
snapshot='/root/class-caller-pre-accounts-替换为实际时间'
sudo test -d "$snapshot/app" && \
  sudo test -f "$snapshot/class-caller.service" && \
  sudo test -f "$snapshot/nginx-site" && \
  sudo systemctl stop class-caller && \
  sudo mv /opt/class-caller "/opt/class-caller.failed-$(date -u +%Y%m%dT%H%M%SZ)" && \
  sudo cp -a "$snapshot/app" /opt/class-caller && \
  sudo cp -a "$snapshot/class-caller.service" /etc/systemd/system/class-caller.service && \
  sudo cp -a "$snapshot/nginx-site" /etc/nginx/sites-available/class-caller
```

仅在确认上述命令成功、代码兼容当前主库或已按 [README 恢复步骤](../README.md#备份与恢复)完成数据恢复后，才执行：

```bash
sudo nginx -t && sudo systemctl reload nginx && \
  sudo systemctl daemon-reload && sudo systemctl start class-caller
```

核对本地健康接口、管理员登录、班级名单和一条合成通知；回退到共享密码旧版还会恢复其旧鉴权模型，不能继续声称具有新版个人账号权限保护。快照和失败现场不受自动备份轮转控制，按批准的留存期限管理。
