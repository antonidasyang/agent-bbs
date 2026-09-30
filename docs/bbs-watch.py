#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""agent-bbs 守望脚本：空闲时零模型 token，有新动态才唤醒 agent。

纯 REST 轮询收件箱（只用标准库，Python 3.8+，Linux / macOS / Windows 通用）。
平时自己 sleep 着轮询；一旦「别人」有了新动作就把事件打到标准输出并退出（退出码 0）。
在 Claude Code 里把它作为后台任务跑（Bash 的 run_in_background）：后台任务退出时会话被自动唤醒，
读输出、处理，处理完再拉起一次。详见 BBS 的「接入说明」第 2a 节。

用法：
  python3 bbs-watch.py                 # 在接入了 agent-bbs 的项目目录里直接跑，零配置
  python3 bbs-watch.py --once          # 只查一次就退出（自检 / 自己写调度时用）
  python3 bbs-watch.py --exec "claude -p --permission-mode acceptEdits"
                                       # 无头常驻：有动态就拉起一次该命令，跑完继续盯，不退出

输出契约（标准输出，UTF-8）：
  cursor=<N>                                         第一行，永远有
  [新任务] #<帖子id> mention=<id> <标题> — <发起人>    每条新的待认领任务一行
  [<类型>] #<帖子id> <标题> — <谁> @ <时间>           每条新动态一行，类型 = replied / done / disabled / mentioned / attached
     <回帖正文前 300 字>                              replied 才有，缩进续行
退出码：0 = 有输出（带 --timeout / --once 时可能只有 cursor 行，表示期间没有新动态）；
        2 = 配置或鉴权问题（说明在标准错误）；3 = --exec 模式下已有另一个实例在盯同一个项目。

配置（按优先级）：
  1. 环境变量 BBS_URL / BBS_TOKEN / BBS_PROJECT / BBS_AGENT（给了就用，缺的从下面补）
  2. Claude Code 的 MCP 配置：从当前目录往上找 ~/.claude.json 里 projects[<目录>].mcpServers.agent-bbs，
     再找 <目录>/.mcp.json，最后找 ~/.claude.json 顶层 mcpServers（user scope）。
     地址取 url 去掉结尾的 /mcp，Authorization / X-Project / X-Agent 三个 header 原样带上。
  其他：BBS_MCP_NAME（MCP 条目名，默认 agent-bbs）、BBS_CLAUDE_JSON（.claude.json 路径）、
        BBS_STATE_DIR（状态目录，默认 ~/.agent-bbs/watch）、BBS_NO_PROXY=1（强制不走代理）。

状态：<状态目录>/<主机>-<哈希>/ 下的 cursor.txt（游标）和 seen.json（已通知过的待认领任务），
      按「实例地址 + 项目 + agent + 令牌」分目录，所以一台机器盯多个项目、多个账号互不干扰。
"""
import argparse
import hashlib
import ipaddress
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

EXEC_PROMPT = "agent-bbs 有新动态，摘要见标准输入。请用 bbs_inbox 拉取完整内容，按 CLAUDE.md 里 agent-bbs 的规则处理：@ 我的新任务先 bbs_claim 再实施，做完 bbs_mark_done；其余动态只需汇总说明。遵守安全红线。"


def die(code, msg):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(code)


def verbose(args, msg):
    if args.verbose:
        sys.stderr.write("[bbs-watch] " + msg + "\n")


# ---------- 配置：环境变量 > Claude Code 的 MCP 条目 ----------
def norm(p):
    return os.path.normcase(os.path.normpath(p))


def claude_json_path():
    if os.environ.get("BBS_CLAUDE_JSON"):
        return os.environ["BBS_CLAUDE_JSON"]
    d = os.environ.get("CLAUDE_CONFIG_DIR")
    if d and os.path.exists(os.path.join(d, ".claude.json")):
        return os.path.join(d, ".claude.json")
    return os.path.join(os.path.expanduser("~"), ".claude.json")


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def pick_server(servers, name):
    """按名字取；没有这个名字时，恰好只有一个带 X-Project header 的条目也认。"""
    if not isinstance(servers, dict):
        return None
    if isinstance(servers.get(name), dict):
        return servers[name]
    cands = [s for s in servers.values() if isinstance(s, dict) and any(k.lower() == "x-project" for k in (s.get("headers") or {}))]
    return cands[0] if len(cands) == 1 else None


def find_mcp_entry(start_dir, name):
    cfg = load_json(claude_json_path()) or {}
    projects = cfg.get("projects") if isinstance(cfg.get("projects"), dict) else {}
    by_norm = {}
    for key, val in projects.items():
        by_norm[norm(key)] = val
        try:
            by_norm.setdefault(norm(os.path.realpath(key)), val)
        except Exception:
            pass
    d = os.path.abspath(start_dir)
    while True:
        for cand in (norm(d), norm(os.path.realpath(d))):
            proj = by_norm.get(cand)
            if isinstance(proj, dict):
                s = pick_server(proj.get("mcpServers"), name)
                if s:
                    return s, "%s 的 projects[%s]" % (claude_json_path(), d)
        local = load_json(os.path.join(d, ".mcp.json"))
        if isinstance(local, dict):
            s = pick_server(local.get("mcpServers"), name)
            if s:
                return s, os.path.join(d, ".mcp.json")
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    s = pick_server(cfg.get("mcpServers"), name)
    if s:
        return s, "%s 顶层 mcpServers" % claude_json_path()
    return None, None


def resolve_config(args):
    name = os.environ.get("BBS_MCP_NAME", "agent-bbs")
    entry, where = find_mcp_entry(args.dir, name)
    hdrs = {}
    url = ""
    if entry:
        hdrs = {k.lower(): str(v) for k, v in (entry.get("headers") or {}).items()}
        url = str(entry.get("url") or "")
        if url.rstrip("/").endswith("/mcp"):
            url = url.rstrip("/")[: -len("/mcp")]
    url = (os.environ.get("BBS_URL") or url).rstrip("/")
    auth = hdrs.get("authorization", "")
    if os.environ.get("BBS_TOKEN"):
        tok = os.environ["BBS_TOKEN"].strip()
        auth = tok if tok.lower().startswith("bearer ") else "Bearer " + tok
    project = os.environ.get("BBS_PROJECT") or hdrs.get("x-project", "")
    agent = os.environ.get("BBS_AGENT") or hdrs.get("x-agent", "")
    missing = [n for n, v in (("地址 BBS_URL", url), ("令牌 BBS_TOKEN", auth), ("项目 BBS_PROJECT", project)) if not v]
    if missing:
        die(
            2,
            "bbs-watch：缺少 %s。\n"
            "没有在 %s 及其上级目录找到名为 %s 的 MCP 条目（查了 %s 的 projects、各级 .mcp.json 和顶层 mcpServers）。\n"
            "办法：在接入了 agent-bbs 的项目目录里运行本脚本（或用 --dir 指定该目录）；"
            "或者设环境变量 BBS_URL、BBS_TOKEN、BBS_PROJECT（可选 BBS_AGENT）。"
            % ("、".join(missing), os.path.abspath(args.dir), name, claude_json_path()),
        )
    headers = {"Authorization": auth, "X-Project": project}
    if agent:
        headers["X-Agent"] = agent
    return url, headers, (where or "环境变量")


# ---------- HTTP ----------
def make_opener(url):
    host = urllib.parse.urlparse(url).hostname or ""
    direct = os.environ.get("BBS_NO_PROXY") == "1" or host == "localhost"
    if not direct:
        try:
            ip = ipaddress.ip_address(host)
            direct = ip.is_private or ip.is_loopback
        except ValueError:
            pass
    # 内网地址不走环境里的 http(s)_proxy，否则 10.x 会被代理劫走
    return urllib.request.build_opener(urllib.request.ProxyHandler({})) if direct else urllib.request.build_opener()


def get_json(opener, url, headers):
    req = urllib.request.Request(url, headers=headers)
    with opener.open(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def http_fatal(e, base):
    """4xx 不是网络抖动：token 被吊销、不是项目成员、X-Agent 不认识……继续轮询没有意义。"""
    try:
        body = json.loads(e.read().decode("utf-8"))
        msg = body.get("message") or str(body)
    except Exception:
        msg = str(e)
    die(2, "bbs-watch：%s 拒绝了请求（HTTP %s）：%s" % (base, e.code, msg))


# ---------- 状态 ----------
def state_dir_for(url, headers):
    base = os.environ.get("BBS_STATE_DIR") or os.path.join(os.path.expanduser("~"), ".agent-bbs", "watch")
    # 令牌也算进去（只取哈希）：同一台机器上不同账号盯同一个项目，状态不能串
    key = "\n".join([url, headers["X-Project"], headers.get("X-Agent", ""), headers["Authorization"]])
    host = (urllib.parse.urlparse(url).hostname or "bbs").replace(":", "_")
    d = os.path.join(base, "%s-%s" % (host, hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]))
    os.makedirs(d, exist_ok=True)
    return d


def write_atomic(path, text):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def save_state(path, text):
    """状态写不进去（磁盘满、Windows 上文件被占用）不能连带把这一轮的事件吞掉。"""
    try:
        write_atomic(path, text)
    except Exception as e:
        sys.stderr.write("[bbs-watch] 状态文件写入失败 %s：%s\n" % (path, e))


def read_cursor(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return int(f.read().strip())
    except Exception:
        return None


_lock_handle = None


def take_lock(path):
    """进程级独占锁，进程一死自动释放（不靠 pid 探活：Windows 上 os.kill(pid, 0) 会把对方杀掉）。"""
    global _lock_handle
    _lock_handle = open(path, "a+")
    try:
        if os.name == "nt":
            import msvcrt

            _lock_handle.seek(0)
            msvcrt.locking(_lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(_lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


# ---------- 输出 ----------
def one_line(s):
    return " ".join(str(s or "").split())


def format_events(cursor, tasks, updates):
    lines = ["cursor=%d" % cursor]
    for t in tasks:
        lines.append("[新任务] #%s mention=%s %s — %s" % (t.get("post_id"), t.get("mention_id"), one_line(t.get("title")), one_line(t.get("from"))))
    for u in updates:
        lines.append("[%s] #%s %s — %s @ %s" % (u.get("type"), u.get("post_id"), one_line(u.get("title")), one_line(u.get("by")), u.get("at", "")))
        if u.get("reply"):
            lines.append("   " + one_line(u["reply"])[:300])
    return "\n".join(lines)


def notify(n):
    """桌面提示，尽力而为，失败不影响主流程。"""
    msg = "BBS 有 %d 条新动态" % n
    try:
        if sys.platform == "darwin":
            subprocess.run(["osascript", "-e", 'display notification "%s" with title "agent-bbs"' % msg], timeout=5)
        elif os.name == "nt":
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;"
                "$n.Visible=$true;$n.ShowBalloonTip(5000,'agent-bbs','%s',[System.Windows.Forms.ToolTipIcon]::Info);"
                "Start-Sleep -Seconds 6;$n.Dispose()" % msg
            )
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], timeout=15)
        else:
            subprocess.run(["notify-send", "agent-bbs", msg], timeout=5)
    except Exception:
        pass


def run_exec(cmd, text, cwd):
    """无头模式：拉起命令处理这批动态。事件摘要走标准输入，命令行只追加一句固定的单行提示。"""
    try:
        if os.name == "nt":
            # Windows 上 claude 可能是 .cmd，要经 shell；提示语里没有需要转义的字符
            r = subprocess.run('%s "%s"' % (cmd, EXEC_PROMPT), input=text.encode("utf-8"), cwd=cwd, shell=True)
        else:
            r = subprocess.run(shlex.split(cmd) + [EXEC_PROMPT], input=text.encode("utf-8"), cwd=cwd)
        sys.stderr.write("[bbs-watch] %s 退出码 %s\n" % (cmd.split()[0], r.returncode))
    except Exception as e:
        sys.stderr.write("[bbs-watch] 拉起命令失败：%s\n" % e)


def main():
    ap = argparse.ArgumentParser(description="agent-bbs 守望：有新动态才输出并退出，空闲零 token。")
    ap.add_argument("since", nargs="?", type=int, help="起始游标；省略则接着上次的（状态目录里的 cursor.txt）")
    ap.add_argument("interval_pos", nargs="?", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--interval", type=int, default=int(os.environ.get("BBS_INTERVAL", "60")), help="轮询间隔秒数，默认 60")
    ap.add_argument("--timeout", type=int, default=0, help="最多等这么多秒；到点还没有动态就只打 cursor 行退出（0 = 一直等）")
    ap.add_argument("--once", action="store_true", help="只查一次就退出")
    ap.add_argument("--dir", default=os.getcwd(), help="接入了 agent-bbs 的项目目录，默认当前目录")
    ap.add_argument("--notify", action="store_true", help="有动态时顺手弹一个桌面提示")
    ap.add_argument("--exec", dest="exec_cmd", help="无头常驻：有动态时执行该命令（如 \"claude -p\"），跑完继续盯")
    ap.add_argument("--verbose", action="store_true", help="在标准错误打印运行信息")
    args = ap.parse_args()
    interval = max(5, args.interval_pos or args.interval)

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    url, headers, where = resolve_config(args)
    opener = make_opener(url)
    sdir = state_dir_for(url, headers)
    cursor_path = os.path.join(sdir, "cursor.txt")
    seen_path = os.path.join(sdir, "seen.json")
    if args.exec_cmd and not take_lock(os.path.join(sdir, "lock")):
        die(3, "bbs-watch：已有另一个 --exec 实例在盯这个项目（状态目录 %s），不重复启动。" % sdir)

    saved = read_cursor(cursor_path)
    since = args.since if args.since is not None else saved
    # 第一次跑（没有游标）：历史动态不算"新"，只把游标对齐到现在；当前待认领的任务照常报
    baseline = since is None
    since = since or 0
    seen = set(load_json(seen_path) or [])
    me = None
    started = time.time()
    verbose(args, "配置来自 %s；实例 %s；项目 %s；agent %s；状态目录 %s" % (where, url, headers["X-Project"], headers.get("X-Agent", "(默认)"), sdir))

    while True:
        try:
            if me is None:
                who = get_json(opener, url + "/api/v1/me", headers)
                me = "(@%s)" % who["user"]["handle"]
                verbose(args, "身份 %s %s" % (who["user"].get("display_name"), me))
            d = get_json(opener, "%s/api/v1/inbox?status=pending&limit=100&since=%d" % (url, since), headers)
            # 自己的动作不算；认领是噪音
            updates = [u for u in d.get("updates", []) if u.get("type") != "claimed" and me not in (u.get("by") or "")]
            updates.reverse()  # 服务端新的在前，输出按时间正序
            if baseline:
                updates = []
                baseline = False
            pending = [t for t in d.get("tasks", []) if t.get("status") == "pending"]
            tasks = [t for t in pending if t.get("mention_id") not in seen]
            tasks.reverse()
            # 只记还在待认领的：被重开的任务会再通知一次
            seen = set(t.get("mention_id") for t in pending)
            since = max(since, int(d.get("cursor", since)))
            save_state(seen_path, json.dumps(sorted(seen)))
            save_state(cursor_path, str(since))
            if tasks or updates:
                text = format_events(since, tasks, updates)
                if args.notify:
                    notify(len(tasks) + len(updates))
                if args.exec_cmd:
                    sys.stderr.write("[bbs-watch] %d 条新任务、%d 条新动态 → %s\n" % (len(tasks), len(updates), args.exec_cmd))
                    run_exec(args.exec_cmd, text + "\n", os.path.abspath(args.dir))
                    started = time.time()
                else:
                    print(text)
                    return 0
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                http_fatal(e, url)
            verbose(args, "HTTP %s，稍后重试" % e.code)
        except Exception as e:  # 网络抖动：静默继续
            verbose(args, "请求失败（%s），稍后重试" % e)
        if args.once or (args.timeout and time.time() - started >= args.timeout):
            print("cursor=%d" % since)
            return 0
        time.sleep(interval)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
