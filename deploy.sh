#!/usr/bin/env bash
# 服务器端一键部署 / 升级（Ubuntu / Debian）
# 用法： sudo bash deploy.sh
set -Eeuo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
APP_DIR=/opt/class-caller
APP_USER=classcaller
APP_GROUP=classcaller
PORT=3000

fail() {
  echo "    !! $*" >&2
  exit 1
}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  fail "请以 root 运行：sudo bash '$SOURCE_DIR/deploy.sh'"
fi

required_files=(server.js package.json students.json class-caller.service)
required_dirs=(lib public test)
for item in "${required_files[@]}"; do
  [ -f "$SOURCE_DIR/$item" ] || fail "缺少部署文件：$SOURCE_DIR/$item"
done
for item in "${required_dirs[@]}"; do
  [ -d "$SOURCE_DIR/$item" ] || fail "缺少部署目录：$SOURCE_DIR/$item"
done
compgen -G "$SOURCE_DIR/test/*.test.js" >/dev/null \
  || fail "没有找到测试文件：$SOURCE_DIR/test/*.test.js"

echo "==> 源目录：$SOURCE_DIR"
echo "==> 检查 Node.js"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
fi
if [ "$NODE_MAJOR" -lt 18 ]; then
  command -v apt-get >/dev/null 2>&1 || fail "只能在 Ubuntu / Debian 上自动安装 Node.js"
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl
  fi
  echo "    安装 Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi
[ "$NODE_MAJOR" -ge 18 ] || fail "需要 Node.js 18 或更高版本"
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] && [ "${NODE_BIN#/}" != "$NODE_BIN" ] \
  || fail "找不到可供 systemd 使用的 Node.js 绝对路径"
node -v
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "    提示：Node ${NODE_MAJOR}.x 已停止安全维护，建议升级到 22。本程序最低支持 18。"
fi

echo "==> 在源目录跑一遍全部自测"
TEST_LOG="$(mktemp /tmp/class-caller-test.XXXXXX.log)"
trap 'rm -f "$TEST_LOG"' EXIT
if ! (
  cd "$SOURCE_DIR"
  if command -v timeout >/dev/null 2>&1; then
    timeout 180 "$NODE_BIN" --test test/*.test.js
  else
    "$NODE_BIN" --test test/*.test.js
  fi
) >"$TEST_LOG" 2>&1; then
  trap - EXIT
  echo "    !! 自测未通过，尚未改动线上目录。日志：$TEST_LOG" >&2
  tail -n 40 "$TEST_LOG" >&2
  exit 1
fi
grep -E '^# (tests|pass|fail)' "$TEST_LOG" | sed 's/^/    /' || true
rm -f "$TEST_LOG"
trap - EXIT

# 服务器上保留的旧 students.json 若还是单班格式，新版本起不来。先用新代码校验，
# 不通过就在改动线上目录之前停下，让旧服务继续跑。
if [ -f "$APP_DIR/students.json" ]; then
  echo "==> 校验线上 $APP_DIR/students.json 是否为 version 2 多班级格式"
  if ! CHECK_MSG="$(cd "$SOURCE_DIR" && "$NODE_BIN" -e '
    const { normalize } = require("./lib/config");
    const raw = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const c = normalize(raw);
    console.log(c.classes.map((k) => `${k.name}(${k.id}) ${k.students.length} 人`).join("、"));
  ' "$APP_DIR/students.json" 2>&1)"; then
    echo "    !! 线上 students.json 无法通过新版本校验，尚未改动线上目录：" >&2
    echo "       $CHECK_MSG" >&2
    echo "       请先按 README 把它改成 { \"version\": 2, \"classes\": [ ... ] } 格式，再重新运行 deploy.sh" >&2
    exit 1
  fi
  echo "    OK：$CHECK_MSG"
fi

echo "==> 准备低权限账号 $APP_USER:$APP_GROUP"
if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
  groupadd --system "$APP_GROUP"
  echo "    已创建系统组 $APP_GROUP"
else
  echo "    系统组 $APP_GROUP 已存在"
fi
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --gid "$APP_GROUP" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  echo "    已创建系统用户 $APP_USER"
else
  echo "    系统用户 $APP_USER 已存在"
fi

echo "==> 安装到 $APP_DIR"
mkdir -p "$APP_DIR"

# 已有名单先备份且不覆盖：升级不应改动服务器上的班级配置。
if [ -f "$APP_DIR/students.json" ]; then
  backup="$APP_DIR/students.json.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  if [ -e "$backup" ]; then
    backup="$backup.$$"
  fi
  cp -a -- "$APP_DIR/students.json" "$backup"
  echo "    已备份原有 students.json：$backup"
fi

rm -rf -- "$APP_DIR/lib" "$APP_DIR/public" "$APP_DIR/test"
cp -a -- "$SOURCE_DIR/lib" "$SOURCE_DIR/public" "$SOURCE_DIR/test" "$APP_DIR/"
install -m 0644 "$SOURCE_DIR/server.js" "$APP_DIR/server.js"
install -m 0644 "$SOURCE_DIR/package.json" "$APP_DIR/package.json"
if [ ! -f "$APP_DIR/students.json" ]; then
  install -m 0640 "$SOURCE_DIR/students.json" "$APP_DIR/students.json"
  echo "    已安装初始 students.json"
fi

# 部署包中有这些说明或 Windows 启动器源码时一并归档；Linux 部署不会构建 Windows 成品。
if [ -f "$SOURCE_DIR/README.md" ]; then
  install -m 0644 "$SOURCE_DIR/README.md" "$APP_DIR/README.md"
fi
if [ -f "$SOURCE_DIR/docs/windows-launcher.md" ]; then
  mkdir -p "$APP_DIR/docs"
  install -m 0644 "$SOURCE_DIR/docs/windows-launcher.md" "$APP_DIR/docs/windows-launcher.md"
fi
if [ -d "$SOURCE_DIR/windows-launcher" ]; then
  rm -rf -- "$APP_DIR/windows-launcher"
  cp -a -- "$SOURCE_DIR/windows-launcher" "$APP_DIR/windows-launcher"
fi
if [ -f "$SOURCE_DIR/docs/upgrade-multiclass.md" ]; then
  mkdir -p "$APP_DIR/docs"
  install -m 0644 "$SOURCE_DIR/docs/upgrade-multiclass.md" "$APP_DIR/docs/upgrade-multiclass.md"
fi
if [ -f "$SOURCE_DIR/docs/windows-display.md" ]; then
  mkdir -p "$APP_DIR/docs"
  install -m 0644 "$SOURCE_DIR/docs/windows-display.md" "$APP_DIR/docs/windows-display.md"
fi
if [ -d "$SOURCE_DIR/windows-display" ]; then
  rm -rf -- "$APP_DIR/windows-display"
  cp -a -- "$SOURCE_DIR/windows-display" "$APP_DIR/windows-display"
fi

# 服务以只读方式运行；名单归 root 所有，服务账号只有读取权限。
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
chmod 0640 "$APP_DIR/students.json"
chown root:"$APP_GROUP" "$APP_DIR/students.json"

echo "==> 校验并注册 systemd 服务"
UNIT_FILE="$(mktemp /tmp/class-caller-service.XXXXXX.service)"
sed "s#^ExecStart=.*#ExecStart=$NODE_BIN /opt/class-caller/server.js#" \
  "$SOURCE_DIR/class-caller.service" >"$UNIT_FILE"
trap 'rm -f "$UNIT_FILE"' EXIT
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$UNIT_FILE"
else
  echo "    systemd-analyze 不可用，跳过 unit 校验"
fi
install -m 0644 "$UNIT_FILE" /etc/systemd/system/class-caller.service
rm -f "$UNIT_FILE"
trap - EXIT
systemctl daemon-reload
systemctl enable class-caller
systemctl restart class-caller

echo "==> 回环地址联通性自检"
healthy=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/api/public/classes" | grep -q '"ok":true'; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -eq 1 ]; then
  echo "    OK，服务在 127.0.0.1:$PORT 正常响应"
else
  echo "    !! 启动失败，看日志：journalctl -u class-caller -n 50" >&2
  exit 1
fi

systemctl --no-pager --lines=5 status class-caller
echo
echo "完成。接下来："
echo "  1. 改班级配置（version 2 多班格式，见 README）：sudoedit $APP_DIR/students.json && systemctl restart class-caller"
echo "  2. 配 Nginx：参考 $SOURCE_DIR/nginx.conf.example（Node 只听 127.0.0.1，必须走反代）"
echo "  3. 看日志：journalctl -u class-caller -f"
printf '%s\n' '  4. Windows assets are not built or installed by this script; build/copy them separately to D:\tools.'
