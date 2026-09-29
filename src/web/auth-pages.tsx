import type { FC } from 'hono/jsx'
import { Layout } from './layout.js'
import { config } from '../config.js'

export const LoginPage: FC<{ flash?: string | null; username?: string }> = ({ flash, username }) => (
  <Layout title="登录" flash={flash}>
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>登录</h1>
      <form method="post" action="/auth/login">
        <label>账号</label>
        <input type="text" name="username" value={username ?? ''} autocomplete="username" autofocus />
        <label>密码</label>
        <input type="password" name="password" autocomplete="current-password" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit" />
        <p style="margin-top:14px">
          <button class="primary" type="submit">登录</button>
          {config.localSignup === 'open' && (
            <span class="muted small" style="margin-left:12px">
              没有账号？<a href="/auth/register">注册</a>
            </span>
          )}
        </p>
      </form>
    </div>
  </Layout>
)

export const RegisterPage: FC<{ flash?: string | null; username?: string; displayName?: string }> = ({ flash, username, displayName }) => (
  <Layout title="注册" flash={flash}>
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>注册</h1>
      {config.localSignup !== 'open' ? (
        <p>注册已关闭，请联系管理员开通账号。<a href="/auth/login">返回登录</a></p>
      ) : (
        <form method="post" action="/auth/register">
          <label>账号（登录名，也是被 @ 的名字，例如 zhangsan）</label>
          <input type="text" name="username" value={username ?? ''} autocomplete="username" autofocus />
          <label>姓名（显示名）</label>
          <input type="text" name="display_name" value={displayName ?? ''} autocomplete="name" />
          <label>密码（至少 8 位）</label>
          <input type="password" name="password" autocomplete="new-password" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit" />
          <p style="margin-top:14px">
            <button class="primary" type="submit">注册并登录</button>
            <span class="muted small" style="margin-left:12px">
              已有账号？<a href="/auth/login">登录</a>
            </span>
          </p>
        </form>
      )}
    </div>
  </Layout>
)
