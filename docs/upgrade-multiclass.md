# 从单班版升级到多班级版：VPS 更新步骤

适用于已经用 `deploy.sh` 部署在 `/opt/class-caller`、由 systemd 服务 `class-caller` 运行、Nginx 反代的服务器。整个过程中旧服务一直在跑，直到第 4 步重启。

## 0. 先在本机准备

1. **改密码**：编辑 `students.json`，把四个班的占位密码换成真实密码，四个必须互不相同：

   ```json
   "password": "chusan23-gai"   ← 改掉
   ```

2. 本机跑一遍测试确认配置合法：

   ```bash
   npm test
   ```

3. 把整个项目目录同步到服务器（不要传 `node_modules`、`.DS_Store`）：

   ```bash
   rsync -av --delete --exclude node_modules --exclude .DS_Store \
     ./ 用户名@服务器地址:~/class-caller/
   ```

## 1. 服务器上先留一份可回退的现场

```bash
ssh 用户名@服务器地址
sudo cp -a /opt/class-caller /opt/class-caller.pre-v2   # 旧代码 + 旧配置整体备份
```

## 2. 替换班级配置（这一步必须在 deploy.sh 之前做）

`deploy.sh` 不会覆盖服务器上已有的 `students.json`，而旧的单班格式会让新版本起不来，所以要手动换成四班文件：

```bash
sudo install -m 0640 -o root -g classcaller ~/class-caller/students.json /opt/class-caller/students.json
```

如果想在服务器上直接改而不是复制本机文件：`sudoedit /opt/class-caller/students.json`，按 README 的 `version: 2` 格式写。

可选：先用新代码校验一下（`deploy.sh` 也会自动做这一步）：

```bash
cd ~/class-caller && node -e '
const { normalize } = require("./lib/config");
const c = normalize(JSON.parse(require("fs").readFileSync("/opt/class-caller/students.json","utf8")));
console.log(c.classes.map(k => `${k.name}(${k.id}) ${k.students.length}人`).join("、"));'
```

期望输出：`示例班级1(class-a) 3人、示例班级2(class-b) 3人、示例班级3(class-c) 3人、示例班级4(class-d) 3人`。

## 3. 更新 Nginx（改两个 location，先改好再 reload）

打开站点文件（通常是 `/etc/nginx/sites-available/class-caller`），把原来的

```nginx
location = /api/public/stream { ... }
location /api/teacher/ { ... }
```

分别改成正则匹配（块内其他内容照旧，注意 SSE 块多了一行 `X-Real-IP`）：

```nginx
location ~ ^/api/classes/[a-z0-9-]+/public/stream$ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host       $host;
    proxy_set_header X-Real-IP  $remote_addr;
    proxy_set_header Connection '';
    proxy_buffering    off;
    proxy_cache        off;
    gzip               off;
    chunked_transfer_encoding on;
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
}

location ~ ^/api/classes/[a-z0-9-]+/teacher/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

完整示例见仓库 `nginx.conf.example`。然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`X-Real-IP` 是登录失败限速的依据，不要漏掉。

## 4. 运行部署脚本

```bash
cd ~/class-caller
sudo bash ./deploy.sh
```

脚本会依次：跑全部测试 → 用新代码校验线上 `students.json`（不合法就停下，不改动任何东西）→ 备份并安装代码 → 重启服务 → 用 `/api/public/classes` 做健康检查。看到 `OK，服务在 127.0.0.1:3000 正常响应` 即成功。

## 5. 从外部验证

```bash
D=https://你的域名

curl -s $D/api/public/classes                       # 四个班的 id/名称/编号/颜色
curl -s -o /dev/null -w '%{http_code}\n' $D/api/public/config   # 必须是 410（旧接口已停用）
curl -sN --max-time 3 "$D/api/classes/class-a/public/stream?role=display" | head -3
                                                    # retry: 2000 + 一帧 "type":"clear","classId":"class-a"
curl -s -X POST $D/api/classes/class-a/teacher/login \
  -H 'content-type: application/json' -d '{"password":"示例班级1的密码"}'
                                                    # 返回 token、expiresAt、class
```

服务日志：

```bash
sudo journalctl -u class-caller -f
```

启动行 `server_start` 里应列出四个班；之后如果不断出现 `legacy_endpoint`，说明还有大屏或脚本在用旧的无班级链接。

## 6. 更新四个教室的大屏

**浏览器大屏**：链接改为带班级参数，旧链接会显示"此设备尚未绑定班级"而不会进入任何班：

| 班级 | 链接 |
|---|---|
| 示例班级1 | `https://你的域名/display.html?class=class-a` |
| 示例班级2 | `https://你的域名/display.html?class=class-b` |
| 示例班级3 | `https://你的域名/display.html?class=class-c` |
| 示例班级4 | `https://你的域名/display.html?class=class-d` |

**Windows display.exe**（每台机器）：

1. 用新编译的 `windows-display/build/display.exe` 覆盖 `D:\class-caller\display.exe`（先 `Ctrl+Q` 退出旧程序）。
2. 编辑 `D:\class-caller\display.ini`，在 `server=` 下加一行本教室的班级，四台各不相同：
   ```ini
   class_id=class-a
   ```
3. 重新运行 `start-display.cmd`。核对：窗口标题为"示例班级1 · 老师找人通知大屏"，顶栏有班名和编号，待机画面中央也有班名，右上角绿点"已连接"。
4. 如果中央显示红色"班级绑定错误"，是 `class_id` 拼错了（例如写成 `class23`、`23` 或有大写）。

**旧的 win7-launcher 原生监听**（如果还在用）：`--watch` 地址改为 `https://你的域名/api/classes/class-a/public/stream?role=launcher`，并把该班 `students.json` 里的 `launcher.mode` 改回 `protocol` 或 `native`。

## 7. 教师端试运行

按方案建议先只让一个班用：打开 `https://你的域名/teacher.html`，选班、输该班密码，发一名测试学生，确认只有该班大屏弹出、其他三块屏毫无反应；再登录另一个班发送一次，反向确认。都正常后再通知四个班启用。

## 回退

```bash
sudo systemctl stop class-caller
sudo rm -rf /opt/class-caller
sudo mv /opt/class-caller.pre-v2 /opt/class-caller
# Nginx 两个 location 改回 location = /api/public/stream 与 location /api/teacher/
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl start class-caller
```

## 常见问题

- **deploy.sh 在"校验线上 students.json"处停下**：第 2 步没做或格式不对，按提示改成 `version: 2` 格式后重跑。
- **健康检查失败**：`sudo journalctl -u class-caller -n 50`，多半是 `students.json` 里 `password` 重复或 `id` 不合法（只能小写字母、数字、连字符）。
- **大屏"未连接 · 错误 404"**：Nginx 还是旧的 `location = /api/public/stream`（第 3 步没生效），或 `class_id` 不存在。
- **老师登录提示"密码错误次数过多"**：同一来源对同一班连续错 5 次锁 60 秒，等一分钟再试；如果 Nginx 没传 `X-Real-IP`，所有老师会共用一个计数，务必检查第 3 步。
