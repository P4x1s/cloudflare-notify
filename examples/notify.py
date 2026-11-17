#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用通知发送脚本 —— 供任意软件 / 脚本 / CI 调用。
零依赖，仅用 Python 标准库，Python 3.6+ 可用。

配置（两种方式任选其一）：
  1) 环境变量 NOTIFY_URL = 完整发送地址（含 token），例如：
       https://你的域名/send?token=你的SEND_TOKEN
  2) 环境变量 NOTIFY_BASE = https://你的域名/send
     环境变量 NOTIFY_TOKEN = 你的SEND_TOKEN

用法示例：
  python notify.py "构建完成" "耗时 23 秒"
  python notify.py --title "构建完成" --content "耗时 23 秒" --source "ci"
  echo "任务完成" | python notify.py --title "定时任务"
  type report.txt | python notify.py --title "日报" --stdin

成功退出码 0，失败退出码 1，便于在 CI / 脚本里判断。
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

DEFAULT_TIMEOUT = 15


def build_url(base, token, title, content, source, msg_type):
    """构造最终的 GET 发送 URL，正确处理中文与特殊字符。"""
    if not base:
        raise ValueError("缺少地址：请设置环境变量 NOTIFY_URL 或 NOTIFY_BASE")

    parts = urllib.parse.urlsplit(base)
    params = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))

    if token and not (params.get("token") or params.get("sendkey")):
        params["token"] = token
    if title:
        params["title"] = title
    if content:
        params["content"] = content
    if source:
        params["source"] = source
    if msg_type and msg_type != "text":
        params["type"] = msg_type

    if not (params.get("title") or params.get("content")):
        raise ValueError("至少需要提供标题或正文")

    if not (params.get("token") or params.get("sendkey")):
        raise ValueError("缺少发送密钥：请在 NOTIFY_URL 中带上 token，或设置 NOTIFY_TOKEN")

    query = urllib.parse.urlencode(params)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def send(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "cf-notify-cli/1.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
        status = resp.status
    try:
        data = json.loads(raw)
    except ValueError:
        data = {"ok": status < 400, "raw": raw}
    return status, data


def main():
    parser = argparse.ArgumentParser(description="向 Cloudflare Notify 发送一条通知")
    parser.add_argument("title_pos", nargs="?", default="", help="位置参数：标题")
    parser.add_argument("content_pos", nargs="?", default="", help="位置参数：正文")
    parser.add_argument("--title", default="", help="标题")
    parser.add_argument("--content", default="", help="正文")
    parser.add_argument("--source", default="", help="来源标记，如 ci / backup / server")
    parser.add_argument("--type", default="text", help="消息类型，默认 text")
    parser.add_argument("--stdin", action="store_true", help="从标准输入读取正文")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="超时秒数，默认 15")
    args = parser.parse_args()

    title = args.title or args.title_pos
    content = args.content or args.content_pos

    if args.stdin or (sys.stdin is not None and not sys.stdin.isatty() and not content):
        content = sys.stdin.read().strip()

    base = os.environ.get("NOTIFY_URL", "").strip()
    token = os.environ.get("NOTIFY_TOKEN", "").strip()
    if not base:
        base = os.environ.get("NOTIFY_BASE", "").strip()

    try:
        url = build_url(base, token, title, content, args.source, args.type)
        status, data = send(url, args.timeout)
    except Exception as exc:  # urllib.error / ValueError / socket 等统一处理
        print("发送失败：%s" % exc, file=sys.stderr)
        return 1

    if not data.get("ok"):
        print("发送失败（HTTP %s）：%s" % (status, data.get("error", data)), file=sys.stderr)
        return 1

    wecom = data.get("wecom") or {}
    if wecom.get("configured"):
        push = "企业微信已推送" if wecom.get("ok") else "企业微信推送失败：%s" % wecom.get("error", "")
        print("发送成功 · " + push)
    else:
        print("发送成功 · 企业微信未配置，仅存入网页收件箱")
    return 0


if __name__ == "__main__":
    sys.exit(main())
