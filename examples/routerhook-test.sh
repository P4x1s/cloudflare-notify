#!/usr/bin/env bash
# RouterHook 接入自测脚本（v1.8）
# 用法：
#   ROUTERHOOK_URL="https://ntfy.example.com" SEND_KEY="<你的轮换密钥>" bash examples/routerhook-test.sh
# 可选环境变量：
#   DEVICE=RAX50            设备标识（默认 RAX50）
#   VERBOSE=1               打印完整响应体（默认只打印状态和 success）
set -u

BASE="${ROUTERHOOK_URL:-https://ntfy.example.com}"
KEY="${SEND_KEY:-<YOUR_KEY>}"
DEVICE="${DEVICE:-RAX50}"
endpoint="$BASE/api/routerhook"

if [ "$KEY" = "<YOUR_KEY>" ]; then
  echo "请先设置 SEND_KEY 环境变量（当前轮换推送密钥）" >&2
  exit 1
fi

pass=0
fail=0

# 发送一条事件并校验响应
send() {
  local name="$1" event="$2" body="$3"
  local url="$endpoint/$event?device=$DEVICE"
  local resp http
  resp=$(curl -s -m 20 -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "X-Token: $KEY" \
    -d "$body" 2>&1)
  http=$(curl -s -m 20 -o /dev/null -w "%{http_code}" -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "X-Token: $KEY" \
    -d "$body" 2>/dev/null)
  # 真实判定：响应体含 success 且 HTTP 200
  if [ "$http" = "200" ] && echo "$resp" | grep -q '"success"'; then
    printf '  ✓ %-24s HTTP %s\n' "$name" "$http"
    pass=$((pass + 1))
  else
    printf '  ✗ %-24s HTTP %s\n' "$name" "$http"
    echo "     响应: $resp" >&2
    fail=$((fail + 1))
  fi
  [ "${VERBOSE:-0}" = "1" ] && echo "     完整响应: $resp"
}

echo "目标: $BASE"
echo "设备: $DEVICE"
echo ""

echo "=== 普通事件（应立即在通知中心看到中文摘要 + 完整 JSON）==="
send "manuINFO 手动推送" "manuINFO" '{"msgTYPE":"manuINFO","sysINFO":{"routerNAME":"'"$DEVICE"'","routerTIME":"2026年11月21日 12点00分00秒","routerFIRMWARE":"384.14","routerMODE":"无线路由器","routerUPTIME":"2天6小时","routerAVGLOAD":[1.2,0.9,0.7],"routerMEM":{"unit":"MB","all":429.99,"free":140.42},"routerSWAP":{"free":0,"total":0}},"tempINFO":{"unit":"°C","CPU":65,"24G":42,"5G1":48},"netINFO":{"WAN":[{"proto":"pppoe","pubIPv4":"1.2.3.4","wanDNS":["8.8.8.8"],"wanRX":"5.3 GiB","wanTX":"483 MiB"}],"routerLANIP":"192.168.50.1"},"cliINFO":[{"ip":"192.168.50.10","name":"Laptop"}]}'

send "cronINFO 定时推送" "cronINFO" '{"msgTYPE":"cronINFO","sysINFO":{"routerNAME":"'"$DEVICE"'","routerFIRMWARE":"384.14"},"tempINFO":{"unit":"°C","CPU":61}}'

send "ifUP 网络重拨" "ifUP" '{"msgTYPE":"ifUP","upTIME":"0天 8小时","rebootTIME":"2026年11月21日 11点45分","netSTATE":[{"proto":"pppoe","pubIPv4":"1.2.3.4","wanDNS":["8.8.8.8"],"wanRX":"9.6 GiB","wanTX":"1.0 GiB"}],"value1":"0天 8小时","value2":"1.2.3.4"}'

send "newDHCP 设备上线" "newDHCP" '{"msgTYPE":"newDHCP","cliNAME":"MI5C","cliIP":"192.168.50.20","cliMAC":"aa:bb:cc:00:11:22","upTIME":"2026年11月21日 12点01分","expTIME":"2026年11月22日 12点01分","cliLISTS":[{"ip":"192.168.50.20","name":"MI5C"}]}'

echo ""
echo "=== 虚拟传感器（不会逐条通知，等 60 秒窗口到期后聚合为一条汇总）==="
send "rh_cpu_temp" "rh_cpu_temp" '{"state":65,"value1":65,"value2":"°C","value3":"Router CPU Temperature","attributes":{"unit_of_measurement":"°C","friendly_name":"Router CPU Temperature"}}'
send "rh_load" "rh_load" '{"state":1.5,"value1":1.5,"value2":"1min","value3":"Router SystemLoad","attributes":{"unit_of_measurement":"1min","friendly_name":"Router SystemLoad"}}'
send "rh_mem_free" "rh_mem_free" '{"state":130.5,"value1":130.5,"value2":"MB","value3":"Router Memory Available","attributes":{"unit_of_measurement":"MB","friendly_name":"Router Memory Available"}}'
send "rh_dev 聚合在线状态" "rh_dev" '{"state":"ON","value1":"ON","value2":"OL","value3":"Router Device Union","attributes":{"unit_of_measurement":"OL","friendly_name":"Router Device Union"}}'
send "rh_dev_aabbccddeeff" "rh_dev_aabbccddeeff" '{"state":"OFF","value1":"OFF","value2":"OL","value3":"Router Device aa:bb:cc:dd:ee:ff","attributes":{"unit_of_measurement":"OL","friendly_name":"Router Device aa:bb:cc:dd:ee:ff"}}'
send "rh_unknown 通用解析" "rh_unknown" '{"state":42,"value1":42,"value2":"unit","value3":"My Sensor"}'

echo ""
echo "=== 鉴权与异常（预期失败，用于验证安全行为）==="
# 错误密钥 → 401
bad_resp=$(curl -s -m 20 -o /dev/null -w "%{http_code}" -X POST "$endpoint/manuINFO?device=$DEVICE" \
  -H "Content-Type: application/json" -H "X-Token: wrong-key" -d '{"msgTYPE":"manuINFO"}' 2>/dev/null)
if [ "$bad_resp" = "401" ]; then
  echo "  ✓ 错误密钥返回 401"
  pass=$((pass + 1))
else
  echo "  ✗ 错误密钥应返回 401，实际 $bad_resp"
  fail=$((fail + 1))
fi
# 非法 JSON → 400
bad_json=$(curl -s -m 20 -o /dev/null -w "%{http_code}" -X POST "$endpoint/manuINFO?device=$DEVICE" \
  -H "Content-Type: application/json" -H "X-Token: $KEY" -d '{broken' 2>/dev/null)
if [ "$bad_json" = "400" ]; then
  echo "  ✓ 非法 JSON 返回 400"
  pass=$((pass + 1))
else
  echo "  ✗ 非法 JSON 应返回 400，实际 $bad_json"
  fail=$((fail + 1))
fi

echo ""
echo "========================================"
echo "通过 $pass / 失败 $fail"
echo "========================================"
echo ""
echo "提示：普通事件现在应已出现在通知中心；传感器请在约 60 秒后查看是否生成了一条"
echo "      「$DEVICE · 传感器状态汇总」，而不是多条独立通知。"
[ "$fail" -gt 0 ] && exit 1
exit 0
