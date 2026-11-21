#!/usr/bin/env bash
# fshine 服务的 systemd 用户级单元：可重复安装 / 卸载（幂等；不碰系统级配置）。
#
# 为什么放在仓库里而不是直接写到机器上（owner 2026-11-21）：
#   部署形态由部署方决定，仓库只提供**可重复执行的安装件**——同一份脚本在任何机器上
#   install/uninstall 多次结果一致；模板随代码走，不依赖某台机器的 ~/.config 现状。
#
# 用法：
#   scripts/ops/fshine-systemd.sh print                      # 只打印单元内容（不写任何文件；CI 用它验形）
#   scripts/ops/fshine-systemd.sh install [选项]             # 写 ~/.config/systemd/user/<name>.service 并 enable --now
#   scripts/ops/fshine-systemd.sh uninstall [--name NAME]    # stop + disable + 删单元 + daemon-reload
#
# 选项：
#   --name NAME   单元名（缺省 fshine-live）
#   --dir  DIR    服务工作目录（缺省 = 本脚本所在仓库根）
#   --log  PATH   服务日志（缺省 <dir>/.runtime/server/service.log；append 模式）
#
# 说明：
#   · 单元是**用户级**（systemctl --user），不写 /etc、不用 root；
#   · 开机自启需要 `loginctl enable-linger $USER`（安装脚本只提示，不擅自改机器级设置）；
#   · 服务仍受单实例锁保护（apps/server/main.ts 启动即取锁），重复 install 不会起两个实例。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="fshine-live"
WORKDIR="$REPO_ROOT"
LOG_PATH=""

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    print|install|uninstall) CMD="$1"; shift ;;
    --name) NAME="${2:?--name 需要值}"; shift 2 ;;
    --dir) WORKDIR="${2:?--dir 需要值}"; shift 2 ;;
    --log) LOG_PATH="${2:?--log 需要值}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "${CMD:-}" ]; then usage >&2; exit 2; fi
LOG_PATH="${LOG_PATH:-$WORKDIR/.runtime/server/service.log}"

# 运行服务的 node/npm 所在目录（单元里显式给 PATH，避免 systemd 的极简 PATH 找不到 npm）。
NPM_BIN="$(command -v npm || true)"
if [ -z "$NPM_BIN" ]; then echo "找不到 npm（先确保 node/npm 在 PATH 里）" >&2; exit 2; fi
NPM_DIR="$(dirname "$NPM_BIN")"

render_unit() {
  cat <<EOF
[Unit]
Description=fshine-agent 渠道服务（$WORKDIR）
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORKDIR
Environment=TMPDIR=${TMPDIR:-$WORKDIR/.runtime/tmp}
Environment=PATH=$NPM_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/bash -lc 'exec npm start'
Restart=always
RestartSec=3
StandardOutput=append:$LOG_PATH
StandardError=append:$LOG_PATH

[Install]
WantedBy=default.target
EOF
}

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$NAME.service"

case "$CMD" in
  print)
    render_unit
    ;;
  install)
    if [ ! -d "$WORKDIR" ]; then echo "工作目录不存在：$WORKDIR" >&2; exit 2; fi
    mkdir -p "$UNIT_DIR" "$(dirname "$LOG_PATH")"
    render_unit > "$UNIT_PATH"
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME.service"
    echo "已安装并启动：$UNIT_PATH"
    echo "日志：$LOG_PATH（append）"
    if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
      echo "提示：开机自启还需要（一次即可，机器级设置，本脚本不代做）：sudo loginctl enable-linger $USER" >&2
    fi
    ;;
  uninstall)
    systemctl --user disable --now "$NAME.service" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl --user daemon-reload
    echo "已卸载：$UNIT_PATH"
    ;;
esac
