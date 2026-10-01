# 从单班版升级：历史多班级指南的当前替代步骤

> 本仓库已经采用**个人账号 + 班级授权**。旧多班级版的共享密码、`/teacher/login`、`X-Teacher-Token` 及旧 Nginx 教师路径不再适用；旧接口返回 `410`。不要按旧教程重新设置班级共享密码，或运行已经移除的 `lib/config.normalize()`。

正式部署、备份、Nginx、停服初始化及回退以 [账号版升级指南](upgrade-accounts.md) 为准。本页只补充“仅有单班 `students.json`”时的转换与验收。安排维护窗口，不承诺升级期间服务持续可用。

## 1. 先确认数据来源并备份

- 如果已有 `/var/lib/class-caller/db.json`，它才是主库：先按账号版指南停服务并备份，不要用旧 `students.json` 覆盖主库，也不要删除主库触发重新导入。
- 如果只有旧单班配置，先停旧服务，受限备份原文件、代码、systemd unit 和 Nginx 配置。旧文件可能含姓名和明文密码，不得提交到 Git 或公开工单。
- 本机和 CI 测试使用合成名单。传输新源码使用干净的 Git 归档，不镜像本机数据或用 `rsync --delete` 清空服务器目录。

## 2. 将旧单班文件转换为可导入的 version 2 格式

当前首次导入只接受 `{ "version": 2, "classes": [...] }`，不会自动猜测旧单班结构。由管理员在受限位置编辑一份转换后的文件；保留姓名，给每个班级确定唯一且长期不变的标识，**不再填写 password 字段**。例如（全为合成数据）：

```json
{
  "version": 2,
  "classes": [
    {
      "id": "class-a",
      "name": "示例班级",
      "code": "01",
      "color": "blue",
      "autoClearSeconds": 30,
      "students": ["测试学生甲", "测试学生乙"],
      "launcher": { "mode": "off", "freshSeconds": 30 }
    }
  ]
}
```

班级标识限 1–32 位小写字母、数字和连字符，首位为字母或数字。每班最多 200 人、姓名最多 20 字；同名会去重，不能用姓名区分两位同名学生。不要为了与示例一致而把实际班级强制拆成四个。

可用**新源码**进行只读导入校验（只输出班级数量，不输出真实名单）：

```bash
cd ~/class-caller
node -e '
const { importLegacyConfig } = require("./lib/config");
const classes = importLegacyConfig(process.argv[1]);
console.log("可导入班级数：" + classes.length);
' /受限路径/students-converted.json
```

校验失败先修正转换副本，不更改唯一的原始名单。通过后，在旧服务仍停止、已有受限备份的前提下，把确认过的文件放到 `/opt/class-caller/students.json`：

```bash
sudo install -m 0640 -o root -g classcaller \
  /受限路径/students-converted.json /opt/class-caller/students.json
```

随后按 [账号版指南第 2–4 节](upgrade-accounts.md#2-更新-nginx) 更新 Nginx、运行部署脚本、初始化首个管理员。导入只在主库没有班级时发生；导入成功后在管理端维护名单。原文件及副本不会被自动安全擦除，按 [隐私政策](../PRIVACY.md) 管理留存。

## 3. 首个管理员必须停服初始化

部署脚本即使刚启动了服务，也要按以下顺序执行；已有可用管理员时走管理端创建账号。不要启动两个进程写同一 `db.json`，不要删活动锁。

```bash
sudo systemctl stop class-caller && \
  sudo -u classcaller env DATA_DIR=/var/lib/class-caller \
    node /opt/class-caller/scripts/init-admin.js && \
  sudo systemctl start class-caller
```

确认 `setupRequired` 为 `false`，管理员可以登录，之后新教师注册不会影响管理员。教师改用个人账号，再由管理员批准班级授权；没有共享班级密码登录入口。

## 4. 更新绑定并做小范围验收

- 浏览器地址为 `https://你的域名/display?class=class-a`，替换为实际班级标识。公开配置/流路径为 `/api/classes/<班级>/public/config`、`/api/classes/<班级>/public/stream`；教师流为 `/api/classes/<班级>/stream`。
- Nginx 同时匹配公开与教师 SSE，关闭缓冲/缓存/gzip，透传 `X-Real-IP` 和 `X-Forwarded-Proto`，移除旧 Basic Auth；使用当前 [`nginx.conf.example`](../nginx.conf.example)，不要重新添加旧 `/teacher/` 认证路径。
- Windows 大屏及启动器分别按 [大屏指南](windows-display.md) 和 [启动器指南](windows-launcher.md) 配置；核对 Release 的校验文件、标签提交和现有限制，不假定旧程序能解析所有新版内容。
- 先用一个合成班级测试点人、留言、清屏、收到确认和权限撤销，再核对不同班级间隔离。按学校实际课表检查全校作息，不在课间时点人应被拒绝。

只读健康检查：

```bash
curl --fail http://127.0.0.1:3000/api/public/status
curl --fail https://你的域名/api/public/status
```

响应应为应用 JSON，而不是 Cloudflare 挑战页面或 Basic Auth 登录框。公开班级目录可能含班级名称，故障报告中也应谨慎披露。

## 5. 回退和隐私留存

回退必须停服，使用已保存的**匹配代码、配置和数据**，保留失败现场；具体命令见 [账号版回退流程](upgrade-accounts.md#回退)。不要 `rm -rf` 唯一副本，也不要用一个未经兼容性验证的旧程序读取新主库。

通知、账号、会话和审计会持久化，重启或清屏不等于删除。恢复旧快照可能恢复已删除信息、旧权限和仍有效的会话；重新落实删除/撤权/改密决定后再开放访问。自动备份按最近 14 **份**而非 14 **天**轮转；旧配置、升级现场、清理前和异地备份需要单独保留期限。按班级/日期的离线清理预览与确认命令见 [隐私政策第 8 节](../PRIVACY.md#8-查询更正与删除)。
