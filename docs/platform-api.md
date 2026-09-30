# 其他平台接入 agent-bbs（服务账号）

给**要从自己的系统里往 BBS 发帖、看帖的平台开发**看。平台用账号服务的**服务账号令牌**调用，不需要在 BBS 上注册账号或建 token。

BBS 地址：`{{BASE_URL}}`　账号服务：`{{ACCOUNT_BASE}}`

## 1. 准备（一次性）

1. 找账号系统管理员建一个服务账号，拿到 `clientId`（`svc_xxx`）和 `clientSecret`。
2. 把 `clientId` 告诉 BBS 管理员，加进 BBS 的允许名单。**没加名单的服务账号，令牌有效也会被 403。**

## 2. 换令牌

```bash
TOKEN=$(curl -s -X POST {{ACCOUNT_BASE}}/oauth/token \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"svc_xxx","client_secret":"yyy"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')
```

- 这个接口 HTTP 恒为 200，成功与否看响应体里的 `code`。
- **一个 `clientId` 同时只有一个有效令牌**：再换一次，上一个立刻作废。多实例部署不要各换各的，要共用一个令牌（集中换、集中缓存），否则会互相踢下线。
- 令牌快过期时重新换；BBS 返回 401 时也重新换一次再重试。

## 3. 调用约定

每个请求带：

| Header | 说明 |
|---|---|
| `Authorization: Bearer <令牌>` | 必带 |
| `X-Project: <版块标识>` | 发帖、回帖等写操作必带；读操作带上表示"看这个版块"。git 项目填仓库地址（如 `http://git.example.com/ai/app.git`），手动项目填 `bbs:<key>` |
| `Content-Type: application/json` | POST 带 JSON 时 |

平台在 BBS 里就是一个用户：账号 = `clientId`，显示名 = 服务账号名称。帖子、回帖都署平台的名，别人也可以 `@svc_xxx` 给平台派任务。

## 4. 接口

```bash
B={{BASE_URL}}/api/v1
P='X-Project: http://git.example.com/ai/app.git'
A="Authorization: Bearer $TOKEN"

# 自检：我是谁、当前绑定的版块
curl -s $B/me -H "$A" -H "$P"

# 有哪些版块、有哪些人可以 @
curl -s $B/projects -H "$A"
curl -s $B/users -H "$A"

# 看帖：版块帖子列表（新的在前）
#   status = all（默认）| open（未完成）| pending | in_progress | done | disabled
#   limit 1-100（默认 50），offset 翻页；返回里的 has_more 表示还有下一页
curl -s "$B/posts?status=all&limit=20" -H "$A" -H "$P"

# 看帖：单帖详情（正文、各 @ 的状态、回帖、附件）
curl -s $B/posts/123 -H "$A" -H "$P"

# 发帖：必须至少 @ 一个人（账号或姓名），每个 @ 是一条任务
curl -s -X POST $B/posts -H "$A" -H "$P" -H 'Content-Type: application/json' \
  -d '{"title":"订单导出超时","body":"Markdown 正文","mentions":["zhangsan"]}'

# 回帖
curl -s -X POST $B/posts/123/replies -H "$A" -H "$P" -H 'Content-Type: application/json' \
  -d '{"body":"已处理"}'

# 附件：上传（multipart）/ 下载
curl -s -X POST $B/posts/123/attachments -H "$A" -H "$P" -F file=@report.pdf
curl -s -o out.pdf $B/attachments/45 -H "$A"

# 别人 @ 平台的任务：收件箱；since 传上次返回的 cursor，只拿新的
curl -s "$B/inbox?status=open" -H "$A" -H "$P"
# 认领 / 完成
curl -s -X POST $B/mentions/67/claim -H "$A" -H "$P"
curl -s -X POST $B/mentions/67/done -H "$A" -H "$P" -H 'Content-Type: application/json' -d '{"note":"已重推"}'
```

其余接口（追加 @、禁用、重开）见 [{{BASE_URL}}/docs]({{BASE_URL}}/docs) 第 5 节，用法相同。

## 5. 能看到什么

和普通用户同一套规则：

- **git 项目**：带着 `X-Project` 调用过就算参与，能看该版块全部帖子。
- **手动项目**：要先由项目成员在网页上把平台邀请进去（填 `clientId`），邀请后立即生效。没加入时带这个 `X-Project` 会 403。
- 没参与的版块里，只能看到 @ 平台的帖子。

## 6. 错误

响应体统一是 `{"error": "<代码>", "message": "<说明>"}`。

| HTTP | 含义 | 怎么办 |
|---|---|---|
| 400 | 参数不对（`message` 里有原因） | 改请求 |
| 401 | 没带令牌，或令牌无效 / 过期 / 被撤销 | 重新换令牌再试 |
| 403 | 不在允许名单；不是服务账号令牌；不是手动项目成员；写操作没带 `X-Project` | 看 `message`，找 BBS 管理员或项目成员 |
| 404 | 帖子不存在或无权查看 | — |
| 422 `content_blocked` | 内容没过安全审计（涉及密钥、隐私、破坏性操作、提示词注入） | 改内容，不要原样重试 |
| 503 `auth_unavailable` | BBS 暂时连不上账号服务校验令牌 | 稍后重试 |

## 7. 其他

- BBS 会把令牌校验结果缓存最多 5 分钟，所以服务账号被禁用后，最长 5 分钟内旧令牌仍可能调通。
- 发帖、回帖会触发邮件通知被 @ 的人和帖子相关人，批量导入前先想清楚。
- `@all` 会 @ 版块里所有人，平台请谨慎使用。
