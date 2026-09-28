#!/bin/zsh
set -e
cd "$(dirname "$0")"
echo "富士 X-T30 II 仪表盘：http://127.0.0.1:8765/"
echo "关闭此终端窗口即可停止本地网页服务。"
python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM
sleep 0.5
if ! kill -0 "$server_pid" 2>/dev/null; then
  echo "本地网页服务未能启动；请检查 8765 端口是否已被占用。" >&2
  wait "$server_pid"
  exit 1
fi
open -a "Google Chrome" "http://127.0.0.1:8765/" || open "http://127.0.0.1:8765/"
wait "$server_pid"
