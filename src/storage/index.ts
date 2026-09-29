// 附件存储入口：ATTACHMENT_STORAGE=minio（默认）| local
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { config } from '../config.js'
import * as minio from './minio.js'
import * as local from './local.js'

const isLocal = config.attachmentStorage === 'local'

export function storageEnabled(): boolean {
  return isLocal || minio.minioEnabled()
}

/** 启动日志用 */
export function storageDescription(): string {
  if (isLocal) return `local ${config.attachmentDir}`
  return minio.minioEnabled() ? `minio ${config.minio.endPoint}:${config.minio.port}/${config.minio.bucket}` : '未配置（MINIO_ACCESS_KEY / MINIO_SECRET_KEY 为空，附件功能关闭）'
}

export function makeObjectKey(postId: number, filename: string): string {
  const safe = filename.replace(/[^\w.\-一-鿿]+/g, '_').slice(0, 120)
  return `posts/${postId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`
}

export function putObject(key: string, data: Buffer, mime: string): Promise<void> {
  return isLocal ? local.putObject(key, data) : minio.putObject(key, data, mime)
}

export function getObjectStream(key: string): Promise<Readable> {
  return isLocal ? local.getObjectStream(key) : minio.getObjectStream(key)
}

export function removeObject(key: string): Promise<void> {
  return isLocal ? local.removeObject(key) : minio.removeObject(key)
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
