# 从「班级共享密码」升级到「个人账号 + 班级授权」

适用于已经用 `deploy.sh` 部署在 `/opt/class-caller`、由 systemd 服务 `class-caller` 运行、Nginx 反代的服务器。升级过程中旧服务一直在跑，直到 `deploy.sh` 重启服务；大屏（浏览器和 `display.exe`）使用的公开接口保持不变，不会突然不可用。

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

```bash
npm test
rsync -av --delete --exclude node_modules --exclude .DS_Store --exclude data \
  ./ 用户名@服务器地址:~/class-caller/
```

## 1. 服务器上留一份可回退的现场

```bash
ssh 用户名@服务器地址
sudo cp -a /opt/class-caller /opt/class-caller.pre-accounts
```

## 2. 更新 Nginx

新版本多了教师端实时流 `/api/classes/<班级>/stream`（需要登录 Cookie），并且依赖 `X-Forwarded-Proto` 给 Cookie 加 `Secure`。把站点文件里的 SSE `location` 改成：

```nginx
location ~ ^/api/classes/[a-z0-9-]+/(public/)?stream$ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection '';
    proxy_buffering off; proxy_cache off; gzip off;
    chunked_transfer_encoding on;
    proxy_read_timeout 24h; proxy_send_timeout 24h;
}
```

原来针对 `/api/classes/[a-z0-9-]+/teacher/` 的 `location` 可以删除。确认每个 `location` 都有 `proxy_set_header X-Forwarded-Proto $scheme;`，然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

完整示例见 [`nginx.conf.example`](../nginx.conf.example)。

## 3. 运行部署脚本

```bash
cd ~/class-caller && sudo bash deploy.sh
```

脚本会：

1. 跑全部测试；
2. 若 `/var/lib/class-caller/db.json` 已存在，先用新代码试载入；
3. 安装代码到 `/opt/class-caller`（只读），数据目录 `/var/lib/class-caller`（属主 `classcaller`，0700）；
4. 注册新的 systemd unit（含 `StateDirectory=class-caller`）并重启。

首次以新版本启动时，服务会读取 `/opt/class-caller/students.json` 把班级与名单导入数据仓库，`password` 字段被丢弃，并写入一条 `class.import_legacy` 审计。导入只发生在数据仓库里还没有任何班级时；之后 `students.json` 不再被读取，可以删除。

## 4. 创建首个管理员

首个管理员不能使用公开默认密码。二选一：

```bash
# 交互式（推荐）：密码不会出现在命令历史或日志里
cd /opt/class-caller && sudo -u classcaller DATA_DIR=/var/lib/class-caller node scripts/init-admin.js
```

或在 `/etc/systemd/system/class-caller.service` 里临时加上 `Environment=ADMIN_USERNAME=...` 与 `Environment=ADMIN_PASSWORD=...`，`daemon-reload` 并重启一次；创建成功后**删掉这两行**再 `daemon-reload`。这两个变量只在数据仓库里没有管理员时被读取一次。

打开 `https://你的域名/admin.html` 登录确认。

## 5. 让教师迁移

1. 教师打开 `https://你的域名/teacher.html` → 「教师注册」；
2. 在个人工作台提交「申请管理班级」并写明理由（如「本班数学教师」）；
3. 管理员在管理端「待审批申请」里批准，权限立即生效；
4. 也可以由管理员在「教师与权限」里直接授权，或在创建账号时发初始密码。

旧的班级密码从这一刻起完全失效；教师端不再有「选班 + 密码」入口。

## 6. 检查全校作息

管理端「全校作息」默认已填入八个课间时段（周一至周五）。请与学校课表核对，特别是 `11:35–12:30` 是否视为连续可用时段、`13:00–13:10` 是否保留。保存后立即生效。

## 7. 更新大屏程序（可选，但推荐）

旧版 `display.exe` 继续可用：它只认 `call` 与 `clear` 两种快照，收到留言快照会当作清屏，不会显示错误内容。要在原生大屏上显示班级留言，请从 [Releases](https://github.com/xzygreen/class-caller/releases/latest) 下载新版 exe 替换 `D:\class-caller\display.exe`，`display.ini` 不需要改。

## 8. 验收清单

- 用旧班级密码在任何地方都无法登录；`POST /api/classes/<班级>/teacher/login` 返回 410；
- 未获批教师打开班级得到 `NO_CLASS_ACCESS`，看不到名单；
- 管理员批准后教师不用重新登录即可进入；撤销后当前会话立即失去访问；
- 08:45 可以点人，09:00 提示「当前正在上课，暂不能点人」并给出下次时间；周末不能点人；
- 留言不需要选学生，大屏留言版式没有「收到」按钮；
- 修改作息后不合法的定时任务出现在管理端「暂停的定时任务」里，原因为「作息已修改」；
- 管理端「操作记录」里每条都有操作者与时间。

## 回退

```bash
sudo systemctl stop class-caller
sudo rm -rf /opt/class-caller && sudo mv /opt/class-caller.pre-accounts /opt/class-caller
sudo cp /opt/class-caller.pre-accounts/../class-caller.service.bak /etc/systemd/system/class-caller.service 2>/dev/null || true
sudo systemctl daemon-reload && sudo systemctl start class-caller
```

回退后需把 Nginx 的 `teacher/` location 加回来。数据目录 `/var/lib/class-caller` 保留不动，再次升级时直接复用。
