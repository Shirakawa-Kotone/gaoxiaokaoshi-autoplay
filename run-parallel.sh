#!/usr/bin/env bash
# 备用方案:单机多进程并发(每个进程一个浏览器,各自 GX_TABS 个标签页)。
# 主推方案见 README:单进程 GX_TABS=N(同一个浏览器开 N 个窗口,最贴近学长说的用法)。
# 用法:
#   GX_USER=账号 GX_PASS=密码 ./run-parallel.sh 4        # 4 个进程,每进程 1 个标签页
#   GX_TABS=2 GX_USER=.. GX_PASS=.. ./run-parallel.sh 2  # 2 个进程,每进程 2 个标签页(=4 路)
# 可选: GX_STAGGER=秒数(默认 8,错峰启动)
set -u
N="${1:-2}"
STAGGER="${GX_STAGGER:-8}"
TABS="${GX_TABS:-1}"
cd "$(dirname "$0")"
if [ -z "${GX_USER:-}" ] || [ -z "${GX_PASS:-}" ]; then
  echo "需要 GX_USER 和 GX_PASS 环境变量"
  exit 1
fi
echo "启动 ${N} 个进程 × ${TABS} 标签页 = $((N * TABS)) 路并发(间隔 ${STAGGER}s),日志写入 run.log"
PIDS=()
for ((i=0; i<N; i++)); do
  echo "[launcher] 启动进程 ${i}/${N}(设备ID=${i})"
  GX_USER="$GX_USER" GX_PASS="$GX_PASS" GX_TABS="$TABS" GX_DEVICES="$N" GX_DEVICE_ID="$i" \
    nohup node autoplay.mjs >> run.log 2>&1 &
  PIDS+=($!)
  sleep "$STAGGER"
done
echo "[launcher] 已启动 PIDs: ${PIDS[*]}"
echo "[launcher] 全部跑完后可重跑本脚本继续未完成课程(已达标课程自动跳过)"
