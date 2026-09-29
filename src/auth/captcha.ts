// 自带的图形验证码：答案用 AES-GCM 加密进 token（密钥来自 SESSION_SECRET），不依赖外部服务。
// 5 分钟有效、单次使用；SVG 渲染时逐字随机旋转/错位并加干扰线。
import crypto from 'node:crypto'
import { config } from '../config.js'
import { badRequest } from '../core/errors.js'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉 0/O/1/I
const LEN = 5
const TTL_MS = 5 * 60e3
const KEY = crypto.createHash('sha256').update('captcha:' + config.sessionSecret).digest()

interface Payload {
  a: string // 答案
  e: number // 过期时间戳
  n: string // nonce，防重放
}

const used = new Map<string, number>() // nonce → 过期时间
function gcUsed() {
  const t = Date.now()
  for (const [k, e] of used) if (e < t) used.delete(k)
}

function encrypt(p: Payload): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(p), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')
}

function decrypt(token: string): Payload | null {
  try {
    const buf = Buffer.from(token, 'base64url')
    if (buf.length < 12 + 16 + 1) return null
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    const p = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as Payload
    return typeof p.a === 'string' && typeof p.e === 'number' && typeof p.n === 'string' ? p : null
  } catch {
    return null
  }
}

export function newCaptcha(): string {
  let a = ''
  for (let i = 0; i < LEN; i++) a += ALPHABET[crypto.randomInt(ALPHABET.length)]
  return encrypt({ a, e: Date.now() + TTL_MS, n: crypto.randomBytes(8).toString('base64url') })
}

/** 校验并作废；失败抛 400 */
export function checkCaptcha(token: string, answer: string): void {
  const p = decrypt(token)
  if (!p || p.e < Date.now()) throw badRequest('验证码已过期，请重试')
  gcUsed()
  if (used.has(p.n)) throw badRequest('验证码已使用，请重试')
  if (answer.trim().toUpperCase() !== p.a) {
    used.set(p.n, p.e) // 答错也作废，逼着换一张
    throw badRequest('验证码不对')
  }
  used.set(p.n, p.e)
}

/** 未过期的 token 才渲染；过期/坏 token 渲染一张"已过期" */
export function renderCaptchaSvg(token: string): string {
  const p = decrypt(token)
  const text = p && p.e >= Date.now() ? p.a : '过期'
  const W = 160
  const H = 52
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  const color = () => `hsl(${Math.floor(rnd(0, 360))},60%,${Math.floor(rnd(25, 45))}%)`
  const parts: string[] = []
  for (let i = 0; i < 4; i++) {
    parts.push(`<path d="M${rnd(0, 20)} ${rnd(0, H)} C${rnd(20, 60)} ${rnd(0, H)},${rnd(80, 120)} ${rnd(0, H)},${rnd(140, W)} ${rnd(0, H)}" stroke="${color()}" stroke-width="${rnd(1, 2).toFixed(1)}" fill="none" opacity="0.6"/>`)
  }
  for (let i = 0; i < 30; i++) parts.push(`<circle cx="${rnd(0, W).toFixed(0)}" cy="${rnd(0, H).toFixed(0)}" r="${rnd(0.7, 1.6).toFixed(1)}" fill="${color()}" opacity="0.7"/>`)
  const step = (W - 24) / text.length
  text.split('').forEach((ch, i) => {
    const x = 12 + step * i + rnd(0, step * 0.35)
    const y = rnd(32, 40)
    const rot = rnd(-28, 28).toFixed(0)
    const skew = rnd(-15, 15).toFixed(0)
    const size = rnd(24, 30).toFixed(0)
    parts.push(`<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" font-size="${size}" font-family="Georgia,'Times New Roman',serif" font-weight="bold" fill="${color()}" transform="rotate(${rot} ${x.toFixed(0)} ${y.toFixed(0)}) skewX(${skew})">${ch}</text>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f3f4f6"/>${parts.join('')}</svg>`
}
