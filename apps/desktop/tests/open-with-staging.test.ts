/**
 * 「用外部应用打开」的目标落盘：内容寻址的对象库路径没有扩展名，
 * 直接交给 LaunchServices 只会得到通用文本/归档程序，必须先复制成
 * 带原始扩展名的副本再查询/启动。这里锁住目标选择、命名安全与清理。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isDirectOpenTarget,
  OpenWithStaging,
  safeFileName,
  stagedFileName,
} from '../src/main/files/open-with-staging'

let root: string
let stagingDirectory: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'everroom-open-with-'))
  stagingDirectory = join(root, 'staged')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('safeFileName / stagedFileName', () => {
  it('保留原始文件名与扩展名，去掉路径成分与非法字符', () => {
    expect(safeFileName('季度报告.docx')).toBe('季度报告.docx')
    expect(safeFileName('../../etc/passwd.docx')).toBe('passwd.docx')
    expect(safeFileName('a:b*c?.docx')).toBe('a_b_c_.docx')
    expect(safeFileName('   ')).toBe('file')
  })

  it('超长中文名按 UTF-8 字节截断，不超过文件名上限', () => {
    const longName = `${'季度总结报告'.repeat(30)}.docx`
    const safe = safeFileName(longName)
    expect(Buffer.byteLength(safe, 'utf8')).toBeLessThan(250)
    expect(safe.endsWith('.docx')).toBe(true)
  })

  it('副本名带 fileId 前缀，同一条目重复打开复用同一路径', () => {
    const name = stagedFileName('file-1234', '报告.docx')
    expect(name).toBe('file-1234-报告.docx')
    expect(stagedFileName('file-1234', '报告.docx')).toBe(name)
  })

  it('fileId 里的路径字符不会逃出目录', () => {
    expect(stagedFileName('../../file', 'x.docx')).toBe('file-x.docx')
  })
})

describe('isDirectOpenTarget', () => {
  it('真实磁盘文件（扩展名一致且存在）直接打开', async () => {
    const source = join(root, '真实.docx')
    await writeFile(source, 'docx')
    expect(isDirectOpenTarget(source, '真实.docx')).toBe(true)
  })

  it('内容寻址路径（没有扩展名）与扩展名不符的路径都走副本', async () => {
    const objectPath = join(root, 'files', 'sha256', 'ab', 'deadbeef')
    await mkdir(join(root, 'files', 'sha256', 'ab'), { recursive: true })
    await writeFile(objectPath, 'docx')
    expect(isDirectOpenTarget(objectPath, '报告.docx')).toBe(false)
    expect(isDirectOpenTarget(join(root, 'not-there'), '报告.docx')).toBe(false)
  })
})

describe('OpenWithStaging', () => {
  it('关联查询只为对象库条目建带扩展名的空占位（不复制内容），重复调用复用', async () => {
    const storagePath = join(root, 'object-blob')
    await writeFile(storagePath, 'docx-bytes')
    const staging = new OpenWithStaging(stagingDirectory)
    const target = await staging.associationTarget(storagePath, 'file-1', '报告.docx')

    expect(target.endsWith('file-1-报告.docx')).toBe(true)
    expect((await stat(target)).size).toBe(0)
    expect(await staging.associationTarget(storagePath, 'file-1', '报告.docx')).toBe(target)
  })

  it('启动前把对象库字节复制成同名副本（原子替换、内容完整）', async () => {
    const storagePath = join(root, 'object-blob')
    await writeFile(storagePath, 'real-docx-bytes')
    const staging = new OpenWithStaging(stagingDirectory)
    const target = await staging.openTarget(storagePath, 'file-2', '合同.docx')

    expect(target.endsWith('file-2-合同.docx')).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('real-docx-bytes')
  })

  it('对象库条目第二次打开覆盖副本内容（反映文件库最新版本）', async () => {
    const storagePath = join(root, 'object-blob')
    const staging = new OpenWithStaging(stagingDirectory)
    await writeFile(storagePath, 'v1')
    const first = await staging.openTarget(storagePath, 'file-3', '版本.docx')
    await writeFile(storagePath, 'v2')
    const second = await staging.openTarget(storagePath, 'file-3', '版本.docx')

    expect(second).toBe(first)
    expect(await readFile(second, 'utf8')).toBe('v2')
  })

  it('真实磁盘文件直接返回原路径（外部应用的保存写回真实文件）', async () => {
    const source = join(root, '真实.docx')
    await writeFile(source, 'docx')
    const staging = new OpenWithStaging(stagingDirectory)
    await expect(staging.openTarget(source, 'file-4', '真实.docx')).resolves.toBe(source)
    await expect(staging.associationTarget(source, 'file-4', '真实.docx')).resolves.toBe(source)
  })

  it('清理删除整目录（启动时调用）', async () => {
    const staging = new OpenWithStaging(stagingDirectory)
    const target = await staging.associationTarget(join(root, 'object-blob'), 'file-5', '纪要.md')
    await staging.cleanup()
    expect(isDirectOpenTarget(target, '纪要.md')).toBe(false)
    await expect(stat(stagingDirectory)).rejects.toThrow()
  })
})