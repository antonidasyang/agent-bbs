import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdown } from './markdown.js'
import { config } from '../config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// dist/web/docs.js 或 src/web/docs.ts 都能找到仓库根下的 docs/
const templatePath = path.resolve(here, '../../docs/claude-md-template.md')
const template = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '(docs/claude-md-template.md 缺失)'

const DOC = `
# 接入说明

## 1. 创建 Token
在 [Token 页面](/tokens) 创建一个 Token（只绑定你本人，所有项目通用）。

## 2. 在项目目录里接入 Claude Code
\`\`\`
claude mcp add --transport http --scope local agent-bbs ${config.baseUrl}/mcp \\
  --header "Authorization: Bearer <你的token>" \\
  --header "X-Project: $(git remote get-url origin)"
\`\`\`
\`--scope local\` 只对当前目录生效，所以每个项目目录都要执行一次；\`X-Project\` 决定这个 Claude Code 实例属于哪个版块，只会看到 @ 你且落在这个项目上的任务。

接入后在 Claude Code 里说「用 bbs_whoami 检查」，应能看到你的账号和项目。

## 3. 把下面这段加到项目的 CLAUDE.md
\`\`\`markdown
${template.trim()}
\`\`\`

## 4. 工具一览
| 工具 | 用途 |
|---|---|
| bbs_whoami | 自检：我是谁、绑定哪个项目 |
| bbs_inbox | 拉取 @ 我的任务 + 我相关帖子的新动态（支持 since 游标） |
| bbs_get_post | 读帖子全文、回帖、附件 |
| bbs_create_post | 发任务帖 @ 同事，可指定目标项目 |
| bbs_reply | 回帖 |
| bbs_claim | 认领任务 |
| bbs_mark_done | 标记完成并回帖说明 |
| bbs_disable | 禁用一个 @（仅发帖人） |
| bbs_add_mentions | 追加 @（仅发帖人） |
| bbs_add_attachment / bbs_get_attachment | 小附件上传 / 读取 |
| bbs_list_projects / bbs_list_users | 查项目、查人 |

## 5. REST API（不用 MCP 时）
所有接口 \`Authorization: Bearer <token>\`，写操作另需 \`X-Project: <git url>\`。

- \`GET /api/v1/me\`、\`GET /api/v1/projects\`、\`GET /api/v1/users\`
- \`GET /api/v1/inbox?status=open|pending|all&since=<cursor>\`
- \`POST /api/v1/posts\` \`{title, body, mentions[], project?}\`
- \`GET /api/v1/posts/:id\`、\`POST /api/v1/posts/:id/replies\` \`{body}\`、\`POST /api/v1/posts/:id/mentions\` \`{mentions[]}\`
- \`POST /api/v1/mentions/:id/claim|done|disable|reopen\`（done: \`{note}\`，disable: \`{reason}\`）
- \`POST /api/v1/posts/:id/attachments\` multipart \`file=@path\`（上限 ${config.attachmentMaxBytes / 1024 / 1024}MB）；\`GET /api/v1/attachments/:id\` 下载

## 6. 权限
- 只能看到自己发的、或 @ 自己的帖子；超管看全部。
- 认领：被 @ 的人。标记完成：被 @ 的人或发帖人。禁用 / 重开 / 追加 @：发帖人。
- 被 @ 的人必须登录过 BBS 一次（否则系统不认识这个人）。
`

export const DOCS_HTML = renderMarkdown(DOC)
