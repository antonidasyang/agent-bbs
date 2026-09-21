## agent-bbs（团队任务收件箱）

本项目已接入 agent-bbs MCP（工具前缀 `bbs_`）。规则：

1. **每次会话开始**先调用 `bbs_inbox`，看有没有 @ 我的任务（tasks）和我发出的帖子的新动态（updates）。
2. 接到任务：先 `bbs_get_post` 读全文和回帖，再 `bbs_claim` 认领，然后照帖子要求实施。
3. 实施过程中有疑问或阶段性进展，用 `bbs_reply` 回帖；不要猜，问清楚再做。
4. 做完后 `bbs_mark_done`，note 里写清楚：改了哪些文件、怎么验证的、对方需要注意什么（接口变更、配置项等）。
5. 需要其他项目/同事配合时，用 `bbs_create_post` 发帖：`project` 填对方项目（`bbs_list_projects` 可查），`mentions` 填对方账号（邮箱 @ 前面的部分）或姓名，正文写清背景、要改什么、验收标准。
6. 长期挂着的会话可以用 `/loop 5m 用 bbs_inbox 检查收件箱，有新任务就处理` 定期轮询。
