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
          <span class="muted small" style="margin-left:12px">
            <a href="/auth/forgot">忘记密码？</a>
          </span>
        </p>
      </form>
    </div>
  </Layout>
)

export const RegisterPage: FC<{ flash?: string | null; username?: string; displayName?: string; email?: string; captcha: string }> = ({ flash, username, displayName, email, captcha }) => (
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
          <label>邮箱（会发验证链接；之后的通知邮件也发到这里）</label>
          <input type="text" name="email" value={email ?? ''} autocomplete="email" inputmode="email" />
          <label>密码（至少 8 位）</label>
          <input type="password" name="password" autocomplete="new-password" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit" />
          <label>验证码（不分大小写）</label>
          <div class="captcha-row">
            <img src={`/auth/captcha/${captcha}.svg`} alt="验证码" width="160" height="52" style="border-radius:6px;border:1px solid var(--line)" />
            <input type="text" name="captcha" autocomplete="off" maxlength={5} style="width:120px" />
            <a href="/auth/register" class="small">换一张</a>
          </div>
          <input type="hidden" name="captcha_token" value={captcha} />
          <p style="margin-top:14px">
            <button class="primary" type="submit">发送验证邮件</button>
            <span class="muted small" style="margin-left:12px">
              已有账号？<a href="/auth/login">登录</a>
            </span>
          </p>
        </form>
      )}
    </div>
  </Layout>
)

export const VerifySentPage: FC<{ email: string }> = ({ email }) => (
  <Layout title="验证邮箱">
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>验证邮件已发送</h1>
      <p>
        已发到 <b>{email}</b>，点邮件里的链接完成注册（24 小时内有效）。没收到请检查垃圾邮件，或<a href="/auth/register">重新提交</a>。
      </p>
    </div>
  </Layout>
)

export const ForgotPage: FC<{ flash?: string | null; identifier?: string; captcha: string }> = ({ flash, identifier, captcha }) => (
  <Layout title="重置密码" flash={flash}>
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>重置密码</h1>
      <form method="post" action="/auth/forgot">
        <label>账号或邮箱（注册邮箱 / 通知邮箱）</label>
        <input type="text" name="identifier" value={identifier ?? ''} autocomplete="username" autofocus />
        <label>验证码（不分大小写）</label>
        <div class="captcha-row">
          <img src={`/auth/captcha/${captcha}.svg`} alt="验证码" width="160" height="52" style="border-radius:6px;border:1px solid var(--line)" />
          <input type="text" name="captcha" autocomplete="off" maxlength={5} style="width:120px" />
          <a href="/auth/forgot" class="small">换一张</a>
        </div>
        <input type="hidden" name="captcha_token" value={captcha} />
        <p style="margin-top:14px">
          <button class="primary" type="submit">发送重置邮件</button>
          <span class="muted small" style="margin-left:12px">
            <a href="/auth/login">返回登录</a>
          </span>
        </p>
      </form>
    </div>
  </Layout>
)

export const ResetSentPage: FC = () => (
  <Layout title="重置密码">
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>请查收邮件</h1>
      <p>
        如果该账号存在且留有邮箱，重置链接已发到它的注册邮箱 / 通知邮箱（1 小时内有效）。没收到请检查垃圾邮件，一分钟后可<a href="/auth/forgot">重新申请</a>；账号没留邮箱的请联系管理员。
      </p>
    </div>
  </Layout>
)

export const ResetPage: FC<{ flash?: string | null; token: string; username: string }> = ({ flash, token, username }) => (
  <Layout title="重置密码" flash={flash}>
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>设置新密码</h1>
      <form method="post" action={`/auth/reset/${token}`}>
        <label>账号</label>
        <input type="text" name="username" value={username} autocomplete="username" readonly />
        <label>新密码（至少 8 位）</label>
        <input type="password" name="new_password" autocomplete="new-password" autofocus style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit" />
        <label>再输一次</label>
        <input type="password" name="confirm_password" autocomplete="new-password" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit" />
        <p style="margin-top:14px">
          <button class="primary" type="submit">重置密码</button>
        </p>
      </form>
    </div>
  </Layout>
)
