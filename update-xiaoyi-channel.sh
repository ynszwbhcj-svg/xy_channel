#!/usr/bin/env bash
# 重新安装 xiaoyi-channel 插件。
# 用法：bash update-xiaoyi-channel.sh xxxxx.tgz
# 注意：xxxxx.tgz 必须与本脚本位于同一目录。

set -euo pipefail

PLUGIN_NAME="xiaoyi-channel"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
PLUGIN_DIR="$HOME/.openclaw/extensions/$PLUGIN_NAME"
PLUGIN_LOAD_PATH="/home/sandbox/.openclaw/extensions/$PLUGIN_NAME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
    echo "[INFO] $*"
}

die() {
    echo "[ERROR] $*" >&2
    exit 1
}

if [ "$#" -ne 1 ]; then
    die "用法：bash $(basename "$0") xxxxx.tgz（安装包必须与脚本位于同一目录）"
fi

TGZ_NAME="$1"
TGZ_PATH="$SCRIPT_DIR/$TGZ_NAME"
CONFIG_BACKUP="$CONFIG_FILE.bak.$(date +%Y%m%d_%H%M%S)"

# 前置检查，避免修改配置后才发现安装条件不满足。
command -v python3 >/dev/null 2>&1 || die "未找到 python3"
command -v openclaw >/dev/null 2>&1 || die "未找到 openclaw 命令"
[ -f "$CONFIG_FILE" ] || die "配置文件不存在：$CONFIG_FILE"
[ -f "$TGZ_PATH" ] || die "安装包不存在：$TGZ_PATH"

# 1. 读取配置；2～4. 删除指定配置；5. 原子保存配置。
log "读取并更新配置：$CONFIG_FILE"
cp -a "$CONFIG_FILE" "$CONFIG_BACKUP"
log "原配置已备份到：$CONFIG_BACKUP"

python3 - "$CONFIG_FILE" "$PLUGIN_NAME" "$PLUGIN_LOAD_PATH" <<'PY'
import json
import os
import stat
import sys
import tempfile

config_path, plugin_name, plugin_load_path = sys.argv[1:4]

with open(config_path, "r", encoding="utf-8") as file:
    config = json.load(file)

plugins = config.get("plugins", {})

entries = plugins.get("entries", {})
if plugin_name in entries:
    del entries[plugin_name]
    print(f"[INFO] 已删除 plugins.entries.{plugin_name}")
else:
    print(f"[INFO] plugins.entries.{plugin_name} 不存在，跳过")

load = plugins.get("load", {})
paths = load.get("paths", [])
new_paths = [path for path in paths if path != plugin_load_path]
if len(new_paths) != len(paths):
    load["paths"] = new_paths
    print(f"[INFO] 已从 plugins.load.paths 删除：{plugin_load_path}")
else:
    print(f"[INFO] plugins.load.paths 中不存在目标路径，跳过")

installs = plugins.get("installs", {})
if plugin_name in installs:
    del installs[plugin_name]
    print(f"[INFO] 已删除 plugins.installs.{plugin_name}")
else:
    print(f"[INFO] plugins.installs.{plugin_name} 不存在，跳过")

# 先写同目录临时文件，再替换原文件，避免写入中断损坏配置。
config_dir = os.path.dirname(config_path) or "."
original_mode = stat.S_IMODE(os.stat(config_path).st_mode)
fd, temp_path = tempfile.mkstemp(prefix=".openclaw.json.", suffix=".tmp", dir=config_dir)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        json.dump(config, file, ensure_ascii=False, indent=2)
        file.write("\n")
        file.flush()
        os.fsync(file.fileno())
    os.chmod(temp_path, original_mode)
    os.replace(temp_path, config_path)
finally:
    if os.path.exists(temp_path):
        os.remove(temp_path)

# 回读并校验保存后的 JSON。
with open(config_path, "r", encoding="utf-8") as file:
    json.load(file)
print("[INFO] openclaw.json 已保存并通过 JSON 校验")
PY

# 6. 删除旧插件目录。
if [ -e "$PLUGIN_DIR" ] || [ -L "$PLUGIN_DIR" ]; then
    rm -rf -- "$PLUGIN_DIR"
    log "已删除插件目录：$PLUGIN_DIR"
else
    log "插件目录不存在，跳过：$PLUGIN_DIR"
fi

# 7. 安装脚本同目录下的新插件包。
log "开始安装插件包：$TGZ_NAME"
(
    cd "$SCRIPT_DIR"
    openclaw plugins installs "$TGZ_NAME"
)

# 8. 重启 openclaw-gateway。
log "正在重启 openclaw-gateway"
python3 -m supervisor.supervisorctl restart openclaw-gateway

# 9. 结束。
log "xiaoyi-channel 插件更新完成"
