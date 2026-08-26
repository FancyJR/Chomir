#!/usr/bin/env bash
# 麒麟 / 通用 Linux：免 FUSE 启动未封装目录（electron-builder --dir 产物）
# 用法：把本脚本与 linux-unpacked 放在同级，或传入 unpacked 目录路径
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
UNPACKED="${1:-$ROOT/linux-unpacked}"
BIN="$UNPACKED/aifront"
if [[ ! -x "$BIN" ]]; then
  BIN="$UNPACKED/AIFront"
fi
if [[ ! -x "$BIN" ]]; then
  echo "找不到可执行文件: $UNPACKED/{aifront,AIFront}" >&2
  exit 1
fi
# 麒麟部分机型 GPU 沙箱不稳定
exec "$BIN" --disable-gpu --disable-gpu-sandbox "$@"
