/**
 * 「用外部应用打开」的目标解析回归：
 * 目录条目（资料库/产物/Agent 产物）必须走 storage 路由；
 * `/v1/files/:id` 只覆盖旧 uploadedFiles 表，用它拿路径会 404 → 入口静默消失。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveOpenWithTarget } from '../src/main/files/open-with-target'
import { OpenWithStaging } from '../src/main/files/open-with-staging'

let root: string
let staging: OpenWithStaging
let storageFile: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'everroom-open-target-'))
  staging = new OpenWithStaging(join(root, 'staged'))
  storageFile = join(root, 'objects', 'sha256', 'ab', 'deadbeef')
  await mkdir(join(root, 'objects', 'sha256', 'ab'), { recursive: true })
  await writeFile(storageFile, 'docx-bytes')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveOpenWithTarget', () => {
  it('目录条目：用 storage 路由 + catalog 原始名，不碰旧文件表接口', async () => {
    const ports = {
      storagePath: vi.fn(async () => storageFile),
      catalogEntry: vi.fn(async () => ({ originalName: '报告.docx' })),
      legacyFile: vi.fn(async () => ({ originalName: 'legacy.docx' })),
    }
    const target = await resolveOpenWithTarget(ports, staging, 'file-1', 'association')

    expect(ports.storagePath).toHaveBeenCalledWith('file-1')
    expect(ports.catalogEntry).toHaveBeenCalledWith('file-1')
    expect(ports.legacyFile).not.toHaveBeenCalled()
    expect(target.endsWith('file-1-报告.docx')).toBe(true)
  })

  it('catalog 元数据不可用时回退旧文件表的原始名', async () => {
    const ports = {
      storagePath: vi.fn(async () => storageFile),
      catalogEntry: vi.fn(async () => { throw new Error('catalog 404') }),
      legacyFile: vi.fn(async () => ({ originalName: '旧条目.pdf' })),
    }
    const target = await resolveOpenWithTarget(ports, staging, 'file-2', 'open')
    expect(ports.legacyFile).toHaveBeenCalledWith('file-2')
    expect(target.endsWith('旧条目.pdf')).toBe(true)
  })

  it('storagePath 为空或文件不存在时报错（不造无内容占位）', async () => {
    const ports = {
      storagePath: vi.fn(async () => ''),
      catalogEntry: vi.fn(async () => ({ originalName: 'x.docx' })),
      legacyFile: vi.fn(async () => ({ originalName: 'x.docx' })),
    }
    await expect(resolveOpenWithTarget(ports, staging, 'file-3', 'association')).rejects.toThrow('文件不存在')
  })
})