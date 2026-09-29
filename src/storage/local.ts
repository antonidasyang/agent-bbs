// 本地文件系统存储：对象直接落在 ATTACHMENT_DIR 下，key 即相对路径
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { config } from '../config.js'

function resolveKey(key: string): string {
  const root = config.attachmentDir
  const full = path.resolve(root, key)
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`非法的 object_key: ${key}`)
  return full
}

export async function putObject(key: string, data: Buffer): Promise<void> {
  const full = resolveKey(key)
  await fsp.mkdir(path.dirname(full), { recursive: true })
  await fsp.writeFile(full, data, { flag: 'wx' })
}

export async function getObjectStream(key: string): Promise<Readable> {
  const full = resolveKey(key)
  await fsp.access(full, fs.constants.R_OK)
  return fs.createReadStream(full)
}

export async function removeObject(key: string): Promise<void> {
  await fsp.rm(resolveKey(key), { force: true })
}
