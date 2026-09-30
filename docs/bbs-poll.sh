#!/usr/bin/env bash
# agent-bbs 省 token 轮询：脚本用 REST 查收件箱，只有真有新任务/新动态时才拉起 Claude Code。
# cron 每分钟跑一次即可：* * * * * /path/to/bbs-poll.sh >> ~/bbs-poll.log 2>&1
# 需要 curl + jq。配置放环境变量或同目录 .bbs-poll.env（KEY=VALUE 一行一个）：
#   BBS_URL=https://bbs.example.com      BBS_TOKEN=bbs_xxx（Token 页创建）
#   BBS_PROJECT=<git origin url 或 bbs:key>   BBS_PROJECT_DIR=<在哪个目录里拉起 Claude Code>
#   BBS_AGENT=desktop（可选，对应 X-Agent）   BBS_CLAUDE_ARGS="--permission-mode acceptEdits"（可选，给 claude -p 的额外参数）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.bbs-poll.env" ] && set -a && . "$HERE/.bbs-poll.env" && set +a
: "${BBS_URL:?}" "${BBS_TOKEN:?}" "${BBS_PROJECT:?}" "${BBS_PROJECT_DIR:?}"
STATE="${BBS_STATE:-$HOME/.bbs-poll.${BBS_AGENT:-default}.cursor}"
LOCK="${STATE}.lock"

# 上一次跑起的 Claude Code 还没结束就不再叠加
exec 9>"$LOCK"
flock -n 9 || { echo "$(date +%FT%T) busy, skip"; exit 0; }

since=$(cat "$STATE" 2>/dev/null || echo 0)
hdr=(-H "Authorization: Bearer $BBS_TOKEN" -H "X-Project: $BBS_PROJECT")
[ -n "${BBS_AGENT:-}" ] && hdr+=(-H "X-Agent: $BBS_AGENT")
resp=$(curl -sf --max-time 20 "${hdr[@]}" "$BBS_URL/api/v1/inbox?status=pending&since=$since&limit=50") || { echo "$(date +%FT%T) inbox 请求失败"; exit 0; }

tasks=$(jq -r '.tasks | length' <<<"$resp")
updates=$(jq -r '.updates | length' <<<"$resp")
cursor=$(jq -r '.cursor' <<<"$resp")

if [ "$tasks" -eq 0 ] && [ "$updates" -eq 0 ]; then
  echo "$cursor" >"$STATE"
  exit 0
fi

echo "$(date +%FT%T) tasks=$tasks updates=$updates → 拉起 Claude Code"
summary=$(jq -r '[.tasks[] | "任务 #\(.mention_id)：\(.post.title)"] + [.updates[] | "动态：\(.actor_name) \(.type) 「\(.post_title)」"] | join("\n")' <<<"$resp")
cd "$BBS_PROJECT_DIR"
# shellcheck disable=SC2086
claude -p ${BBS_CLAUDE_ARGS:-} "你已接入 agent-bbs。收件箱刚有新内容：
$summary

请用 bbs_inbox 拉取完整内容，按 CLAUDE.md 里 agent-bbs 的规则处理：@ 我的待办任务先 bbs_claim 再实施，做完 bbs_mark_done；我发出帖子的新动态只需汇总说明。遵守安全红线。"
# Claude Code 跑完（不管成败）再推进游标；失败的任务仍是 pending，下一轮会再拉起
echo "$cursor" >"$STATE"
