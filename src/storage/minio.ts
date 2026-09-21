import { Client } from 'minio'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { config } from '../config.js'

let client: Client | null = null

export function minioEnabled(): boolean {
  return !!(config.minio.accessKey && config.minio.secretKey)
}

function getClient(): Client {
  if (!client) {
    client = new Client({
      endPoint: config.minio.endPoint,
      port: config.minio.port,
      useSSL: config.minio.useSSL,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
      region: config.minio.region,
      pathStyle: true,
    })
  }
  return client
}

export function makeObjectKey(postId: number, filename: string): string {
  const safe = filename.replace(/[^\w.\-一-鿿]+/g, '_').slice(0, 120)
  return `posts/${postId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`
}

export async function putObject(key: string, data: Buffer, mime: string): Promise<void> {
  await getClient().putObject(config.minio.bucket, key, data, data.length, { 'Content-Type': mime })
}

export async function getObjectStream(key: string): Promise<Readable> {
  return getClient().getObject(config.minio.bucket, key)
}

export async function removeObject(key: string): Promise<void> {
  await getClient().removeObject(config.minio.bucket, key)
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
