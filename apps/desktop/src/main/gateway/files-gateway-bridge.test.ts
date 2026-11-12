import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectImportCandidates, collectImportPlan, FilesGatewayBridge } from './files-gateway-bridge'
import type { GatewaySupervisor } from './gateway-supervisor'
import {
  HighRiskImportCoordinator,
} from '../high-risk-import-coordinator'
import type {
  HighRiskImportQueue,
  PendingManualImportBatch,
} from '../high-risk-import-coordinator'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('collectImportCandidates', () => {
  it('recursively collects supported files while ignoring hidden and unsupported entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'nested'))
    await mkdir(join(directory, '.hidden'))
    await writeFile(join(directory, 'root.md'), '# root')
    await writeFile(join(directory, 'nested', 'notes.txt'), 'notes')
    await writeFile(join(directory, 'nested', 'report.pdf'), 'pdf')
    await writeFile(join(directory, 'nested', 'ignored.json'), '{}')
    await writeFile(join(directory, '.hidden', 'secret.md'), 'secret')

    await expect(collectImportCandidates([directory])).resolves.toEqual([
      { filePath: join(directory, 'nested', 'notes.txt'), filename: 'nested/notes.txt' },
      { filePath: join(directory, 'nested', 'report.pdf'), filename: 'nested/report.pdf' },
      { filePath: join(directory, 'root.md'), filename: 'root.md' },
    ])
  })

  it('drops a directly selected JSON file before upload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-json-'))
    temporaryDirectories.push(directory)
    const jsonPath = join(directory, 'package.json')
    await writeFile(jsonPath, '{}')

    await expect(collectImportCandidates([jsonPath])).resolves.toEqual([])
  })

  it('ignores dependency and build directories during a one-time directory scan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-ignored-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'node_modules', 'dependency'), { recursive: true })
    await mkdir(join(directory, 'build'), { recursive: true })
    await mkdir(join(directory, 'notes'), { recursive: true })
    await writeFile(join(directory, 'node_modules', 'dependency', 'README.md'), '# dependency')
    await writeFile(join(directory, 'build', 'generated.txt'), 'generated')
    await writeFile(join(directory, 'notes', 'kept.md'), '# kept')

    await expect(collectImportCandidates([directory])).resolves.toEqual([
      { filePath: join(directory, 'notes', 'kept.md'), filename: 'notes/kept.md' },
    ])
  })

  it('deduplicates overlapping and missing selections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-duplicate-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'notes.md')
    await writeFile(filePath, '# notes')

    await expect(collectImportCandidates([
      directory,
      filePath,
      filePath,
      join(directory, 'missing.md'),
    ])).resolves.toEqual([
      { filePath, filename: 'notes.md' },
    ])
  })

  it('collects image files by default (heic included on darwin)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-images-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'photo.png'), 'png')
    await writeFile(join(directory, 'shot.bmp'), 'bmp')
    await writeFile(join(directory, 'camera.heic'), 'heic')

    const plan = await collectImportPlan([directory])
    const filenames = plan.candidates.map((candidate) => candidate.filename)
    expect(filenames).toContain('photo.png')
    expect(filenames).toContain('shot.bmp')
    if (process.platform === 'darwin') {
      expect(filenames).toContain('camera.heic')
    } else {
      expect(plan.unsupported.map((candidate) => candidate.filename)).toContain('camera.heic')
    }
  })

  it('counts supported non-Office/PDF files as high risk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-risk-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'proposal.docx'), 'office')
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeFile(join(directory, `note-${index}.md`), '# note')))

    await expect(collectImportPlan([directory])).resolves.toMatchObject({
      highRiskFileCount: 101,
      candidates: expect.arrayContaining([
        { filePath: join(directory, 'proposal.docx'), filename: 'proposal.docx' },
        { filePath: join(directory, 'note-0.md'), filename: 'note-0.md' },
      ]),
    })
  })
})

describe('FilesGatewayBridge.importPathsOnce', () => {
  it('imports an Obsidian project with stable project provenance and room-only pipelines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-obsidian-memory-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'Project'))
    await writeFile(join(directory, 'Project', 'brief.md'), '# Brief')

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/files/capabilities')) {
        return new Response(JSON.stringify({ items: [{ extension: '.md', manualImport: true }] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const metadata = JSON.parse(String((init?.body as FormData).get('metadata'))) as Record<string, unknown>
      expect(metadata).toMatchObject({
        sourceKind: 'manual-upload',
        sourceKey: 'obsidian:vault-project:resource-brief',
        provider: 'Obsidian · Product Vault',
        connectionId: 'vault-project',
        relativePath: 'Project/brief.md',
        pipelines: { room: false, wiki: false },
      })
      expect(metadata).not.toHaveProperty('roomId')
      return new Response(JSON.stringify({
        fileEntryId: 'file-obsidian', fileVersionId: 'version-obsidian',
        versionDeduped: false, jobId: 'job-obsidian',
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await expect(new FilesGatewayBridge(supervisor).importObsidianProject({
      rootPath: directory,
      projectId: 'vault-project',
      projectName: 'Product Vault',
      pipelines: { room: false, wiki: false },
      resourceIdsByRelativePath: { 'Project/brief.md': 'resource-brief' },
    })).resolves.toEqual([expect.objectContaining({ filename: 'Project/brief.md', error: null })])
  })

  it('does not put large Markdown-heavy Obsidian projects into high-risk review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-obsidian-large-'))
    temporaryDirectories.push(directory)
    await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(directory, `note-${index}.md`), `# ${index}`)))
    const enqueueManual = vi.fn()
    const highRiskImports = {
      enqueueManual,
      enqueueAuto: vi.fn(),
      setManualResolver: vi.fn(),
      setAutoResolver: vi.fn(),
      discardAutoSource: vi.fn(),
      isSkippedManualPath: () => false,
    } satisfies HighRiskImportQueue
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/v1/files/capabilities')) {
        return new Response(JSON.stringify({ items: [{ extension: '.md', manualImport: true }] }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        fileEntryId: 'file-entry', fileVersionId: 'file-version', versionDeduped: false, jobId: 'job',
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const supervisor = { getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }) } as unknown as GatewaySupervisor

    const outcomes = await new FilesGatewayBridge(supervisor, highRiskImports).importObsidianProject({
      rootPath: directory,
      projectId: 'large-vault',
      projectName: 'Large Vault',
      pipelines: { room: false, wiki: false },
    })

    expect(outcomes).toHaveLength(101)
    expect(enqueueManual).not.toHaveBeenCalled()
  })

  it('filters with gateway capabilities and imports through the unified manual path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-once-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'notes'))
    await writeFile(join(directory, 'notes', 'kept.md'), '# kept')
    await writeFile(join(directory, 'ignored.pdf'), 'pdf')

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/files/capabilities')) {
        return new Response(JSON.stringify({
          items: [{ extension: '.md', manualImport: true }],
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      expect(url).toBe('http://gateway.test/v1/file-imports')
      expect(init?.method).toBe('POST')
      const metadata = JSON.parse(String((init?.body as FormData).get('metadata'))) as Record<string, unknown>
      expect(metadata).toMatchObject({
        sourceKind: 'manual-upload',
        originalName: 'kept.md',
        relativePath: 'notes/kept.md',
      })
      expect(metadata.sourceKey).toMatch(/^manual:/)
      return new Response(JSON.stringify({
        fileEntryId: 'file-entry-1',
        fileVersionId: 'file-version-1',
        versionDeduped: false,
        jobId: 'job-1',
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await expect(new FilesGatewayBridge(supervisor).importPathsOnce([directory])).resolves.toEqual([
      expect.objectContaining({
        filename: 'notes/kept.md',
        fileId: 'file-entry-1',
        fileVersionId: 'file-version-1',
        routeJobId: 'job-1',
        error: null,
        skippedReason: null,
      }),
      expect.objectContaining({
        filename: 'ignored.pdf',
        fileId: null,
        error: null,
        skippedReason: 'unsupported_format',
      }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('queues a large high-risk batch without delaying low-risk files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-high-risk-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'proposal.pdf'), 'pdf')
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeFile(join(directory, `note-${index}.md`), '# note')))

    let manualResolver: ((batch: PendingManualImportBatch, accepted: boolean) => Promise<unknown>) | null = null
    const enqueueManual = vi.fn(async (batch: PendingManualImportBatch) => ({
      id: 'review-1', origin: 'manual-import' as const, sourceLabel: directory,
      fileCount: batch.files.length, createdAt: new Date().toISOString(),
    }))
    const highRiskImports = {
      enqueueManual,
      enqueueAuto: vi.fn(),
      setManualResolver: (resolver) => { manualResolver = resolver },
      setAutoResolver: vi.fn(),
      discardAutoSource: vi.fn(),
      isSkippedManualPath: () => false,
    } satisfies HighRiskImportQueue
    const importedNames: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/files/capabilities')) {
        return new Response(JSON.stringify({ items: [
          { extension: '.md', manualImport: true },
          { extension: '.pdf', manualImport: true },
        ] }), { headers: { 'Content-Type': 'application/json' } })
      }
      const metadata = JSON.parse(String((init?.body as FormData).get('metadata'))) as { originalName: string }
      importedNames.push(metadata.originalName)
      return new Response(JSON.stringify({
        fileEntryId: `file-${importedNames.length}`, fileVersionId: `version-${importedNames.length}`,
        versionDeduped: false, blobDeduped: false, contentHash: 'a'.repeat(64), jobId: `job-${importedNames.length}`,
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    const outcomes = await new FilesGatewayBridge(supervisor, highRiskImports).importPathsOnce([directory])
    // 低风险 pdf 立即导入；101 个高风险 md 以 pending_review 跳过行回报（不静默消失）
    expect(outcomes.filter((outcome) => outcome.fileId).map((outcome) => outcome.filename)).toEqual(['proposal.pdf'])
    expect(outcomes.filter((outcome) => outcome.skippedReason === 'pending_review')).toHaveLength(101)
    expect(importedNames).toEqual(['proposal.pdf'])
    expect(enqueueManual).toHaveBeenCalledWith(
      expect.objectContaining({ files: expect.arrayContaining([
        expect.objectContaining({ filename: 'note-0.md' }),
      ]) }),
      expect.any(String),
    )
    expect(manualResolver).not.toBeNull()
  })

  it('does not re-review skipped files when the same folder is retried', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-skip-retry-'))
    temporaryDirectories.push(directory)
    const stateDirectory = await mkdtemp(join(tmpdir(), 'everroom-import-skip-state-'))
    temporaryDirectories.push(stateDirectory)
    await writeFile(join(directory, 'proposal.pdf'), 'pdf')
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeFile(join(directory, `note-${index}.md`), '# note')))

    // 真实协调器：resolve(id, false) 应记住跳过的文件，重试同目录不再复审。
    const coordinator = new HighRiskImportCoordinator(join(stateDirectory, 'high-risk-imports.json'))
    await coordinator.initialize()
    const uploadedNames: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/files/capabilities')) {
        return new Response(JSON.stringify({ items: [
          { extension: '.md', manualImport: true },
          { extension: '.pdf', manualImport: true },
        ] }), { headers: { 'Content-Type': 'application/json' } })
      }
      const metadata = JSON.parse(String((init?.body as FormData).get('metadata'))) as { originalName: string }
      uploadedNames.push(metadata.originalName)
      return new Response(JSON.stringify({
        fileEntryId: `file-${uploadedNames.length}`, fileVersionId: `version-${uploadedNames.length}`,
        versionDeduped: false, blobDeduped: false, contentHash: 'a'.repeat(64), jobId: `job-${uploadedNames.length}`,
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor
    const bridge = new FilesGatewayBridge(supervisor, coordinator)

    // 首次导入：高风险批次进审查（pending_review 跳过行回报），低风险 pdf 立即导入。
    const firstOutcomes = await bridge.importPathsOnce([directory])
    expect(firstOutcomes.filter((outcome) => outcome.fileId)).toHaveLength(1)
    expect(firstOutcomes.filter((outcome) => outcome.skippedReason === 'pending_review')).toHaveLength(101)
    const review = coordinator.list()[0]!
    expect(review.fileCount).toBe(101)
    // 用户点「跳过」。
    await expect(coordinator.resolve(review.id, false)).resolves.toEqual({ accepted: false, imported: 0, failed: 0 })

    // 重试同一目录：101 个 md 不再进入审查（否则又会弹一次跳过确认），也不再回报跳过行。
    await expect(bridge.importPathsOnce([directory])).resolves.toHaveLength(1)
    expect(coordinator.list()).toEqual([])
    expect(uploadedNames).toEqual(['proposal.pdf', 'proposal.pdf'])
  })
})

describe('FilesGatewayBridge.readMarkdown', () => {
  it('waits for an asynchronously parsed file without surfacing intermediate 404s', async () => {
    let attempts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts += 1
      if (attempts === 1) return new Response(JSON.stringify({ error: 'file_not_parsed' }), { status: 404 })
      return new Response(JSON.stringify({ markdown: '# Parsed PDF' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await expect(new FilesGatewayBridge(supervisor).readMarkdown('file-1', { waitMs: 1_000, pollMs: 100 }))
      .resolves.toEqual({ markdown: '# Parsed PDF' })
    expect(attempts).toBe(2)
  })
})

describe('FilesGatewayBridge.importAgentAttachments', () => {
  it('uploads chat image attachments through the single byte entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-agent-attach-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'pic.png'), 'png-bytes')
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'http://gateway.test/v1/files') {
        calls.push('upload')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toMatchObject({ filename: 'pic.png', assetKind: 'photo', originChannel: 'agent-composer' })
        return new Response(JSON.stringify({ id: 'upl-1', bytes: 9, originalName: 'pic.png' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const supervisor = { getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }) } as unknown as GatewaySupervisor

    const attachments = await new FilesGatewayBridge(supervisor).importAgentAttachments([join(directory, 'pic.png')])

    expect(attachments).toEqual([expect.objectContaining({ fileId: 'upl-1', kind: 'image', mimeType: 'image/png' })])
    expect(calls).toEqual(['upload'])
  })

  it('tags document attachments with the owning workspace so they land in that workspace library', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-agent-attach-ws-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'doc.pdf'), 'pdf-bytes')
    const uploadedMetadata: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'http://gateway.test/v1/file-imports') {
        const metadata = JSON.parse(String((init?.body as FormData).get('metadata'))) as Record<string, unknown>
        uploadedMetadata.push(metadata)
        return new Response(JSON.stringify({
          fileEntryId: 'file-1', fileVersionId: 'version-1',
          versionDeduped: false, blobDeduped: false, contentHash: 'a'.repeat(64), jobId: 'job-1',
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/markdown')) {
        return new Response(JSON.stringify({ markdown: '# parsed' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const supervisor = { getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }) } as unknown as GatewaySupervisor

    await new FilesGatewayBridge(supervisor).importAgentAttachments([join(directory, 'doc.pdf')], { workspaceId: 'ws-42' })

    expect(uploadedMetadata).toEqual([expect.objectContaining({ workspaceId: 'ws-42' })])
  })
})

describe('FilesGatewayBridge.readText', () => {
  it('decodes UTF-8 content and forwards bearer auth to the exact content endpoint', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = []
    const text = '# 标题\n\n这是一份中文 Markdown，含 emoji ✅。\n'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({
        url: String(input),
        authorization: (init?.headers as Record<string, string>).Authorization ?? null,
      })
      return new Response(Buffer.from(text, 'utf8'), {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      })
    })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await expect(new FilesGatewayBridge(supervisor).readText('file 1/二')).resolves.toEqual({ text })
    expect(calls).toEqual([{
      url: 'http://gateway.test/v1/files/file%201%2F%E4%BA%8C/content',
      authorization: 'Bearer token',
    }])
  })

  it('rejects with the HTTP status when the gateway refuses to return the file', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }))
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await expect(new FilesGatewayBridge(supervisor).readText('file-1'))
      .rejects.toThrow('文件内容读取失败（404）')
  })

  it('rejects files above the 8 MB editor limit instead of decoding them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(8 * 1024 * 1024 + 1), { status: 200 }),
    )
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await expect(new FilesGatewayBridge(supervisor).readText('file-1'))
      .rejects.toThrow(/文件过大（8388609 字节）.*8 MB/)
  })
})

describe('FilesGatewayBridge.saveMarkdown', () => {
  const markdown = '# 标题\n\n正文 with non-ASCII — 我们的内容。\n'

  function supervisorStub(): GatewaySupervisor {
    return {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor
  }

  it('writes a temp .md file and pins the agent import to the same fileEntry', async () => {
    let uploadedMetadata: Record<string, unknown> | null = null
    let uploadedFileName: string | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'http://gateway.test/v1/files/catalog/file-1') {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token')
        return new Response(JSON.stringify({
          id: 'file-1',
          originalName: '笔记.md',
          workspaceId: 'ws-catalog',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://gateway.test/v1/file-imports') {
        expect(init?.method).toBe('POST')
        const form = init?.body as FormData
        uploadedMetadata = JSON.parse(String(form.get('metadata'))) as Record<string, unknown>
        const uploaded = form.get('file')
        uploadedFileName = uploaded && typeof uploaded !== 'string' ? uploaded.name : null
        return new Response(JSON.stringify({
          fileEntryId: 'file-1',
          fileVersionId: 'version-2',
          jobId: 'job-2',
          contentHash: 'a'.repeat(64),
          blobDeduped: false,
          versionDeduped: false,
        }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const bridge = new FilesGatewayBridge(supervisorStub())
    const originalImport = bridge.importAgentGeneratedFile.bind(bridge)
    const captured: Array<{ filePath: string; originalName: string; text: string }> = []
    vi.spyOn(bridge, 'importAgentGeneratedFile').mockImplementation(async (importInput) => {
      captured.push({
        filePath: importInput.filePath,
        originalName: importInput.originalName,
        text: await readFile(importInput.filePath, 'utf8'),
      })
      return originalImport(importInput)
    })

    await expect(bridge.saveMarkdown({ fileId: 'file-1', markdown })).resolves.toEqual({
      fileEntryId: 'file-1',
      fileVersionId: 'version-2',
      contentHash: 'a'.repeat(64),
      originalName: '笔记.md',
    })
    expect(captured).toEqual([{
      filePath: expect.stringContaining('everroom-markdown-'),
      originalName: '笔记.md',
      text: markdown,
    }])
    expect(uploadedMetadata).toMatchObject({
      sourceKind: 'agent-generated',
      sourceKey: 'agent:markdown:edit:file-1',
      fileEntryId: 'file-1',
      originalName: '笔记.md',
      // 渲染端没带 workspaceId 时回落到 catalog 的归属空间。
      workspaceId: 'ws-catalog',
    })
    expect(uploadedFileName).toBe('笔记.md')
    // finally 里的 rm 已执行：保存成功后临时目录不留残余。
    await expect(stat(dirname(captured[0]!.filePath))).rejects.toThrow()
  })

  it('appends .md when the catalog name lacks a markdown extension and prefers an explicit workspaceId', async () => {
    let uploadedMetadata: Record<string, unknown> | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'http://gateway.test/v1/files/catalog/file-2') {
        return new Response(JSON.stringify({
          id: 'file-2',
          originalName: 'README',
          workspaceId: 'ws-catalog',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://gateway.test/v1/file-imports') {
        const form = init?.body as FormData
        uploadedMetadata = JSON.parse(String(form.get('metadata'))) as Record<string, unknown>
        return new Response(JSON.stringify({
          fileEntryId: 'file-2',
          fileVersionId: 'version-3',
          jobId: 'job-3',
          contentHash: 'b'.repeat(64),
          blobDeduped: false,
          versionDeduped: false,
        }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const supervisor = supervisorStub()

    await expect(new FilesGatewayBridge(supervisor).saveMarkdown({
      fileId: 'file-2',
      markdown: 'hi',
      workspaceId: 'ws-input',
    })).resolves.toEqual({
      fileEntryId: 'file-2',
      fileVersionId: 'version-3',
      contentHash: 'b'.repeat(64),
      originalName: 'README.md',
    })
    expect(uploadedMetadata).toMatchObject({
      originalName: 'README.md',
      fileEntryId: 'file-2',
      sourceKey: 'agent:markdown:edit:file-2',
      workspaceId: 'ws-input',
    })
  })

  it('rejects invalid edits before touching the gateway', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const supervisor = supervisorStub()
    const bridge = new FilesGatewayBridge(supervisor)

    await expect(bridge.saveMarkdown({ fileId: '  ', markdown: '# x' })).rejects.toThrow('缺少文件 id。')
    await expect(bridge.saveMarkdown({
      fileId: 'file-1',
      markdown: 42 as unknown as string,
    })).rejects.toThrow('缺少 Markdown 内容。')
    await expect(bridge.saveMarkdown({
      fileId: 'file-1',
      markdown: 'a'.repeat(8 * 1024 * 1024 + 1),
    })).rejects.toThrow(/Markdown 内容过大.*8 MB/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('submits a single newline placeholder when the user clears the whole document', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === 'http://gateway.test/v1/files/catalog/file-clear') {
        return new Response(JSON.stringify({
          id: 'file-clear',
          originalName: 'blank.md',
          workspaceId: 'ws-clear',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://gateway.test/v1/file-imports') {
        return new Response(JSON.stringify({
          fileEntryId: 'file-clear',
          fileVersionId: 'version-clear',
          jobId: 'job-clear',
          contentHash: 'e'.repeat(64),
          blobDeduped: false,
          versionDeduped: false,
        }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const bridge = new FilesGatewayBridge(supervisorStub())
    const originalImport = bridge.importAgentGeneratedFile.bind(bridge)
    let uploadedText: string | null = null
    vi.spyOn(bridge, 'importAgentGeneratedFile').mockImplementation(async (importInput) => {
      uploadedText = await readFile(importInput.filePath, 'utf8')
      return originalImport(importInput)
    })

    await expect(bridge.saveMarkdown({ fileId: 'file-clear', markdown: '' }))
      .resolves.toMatchObject({ fileEntryId: 'file-clear', originalName: 'blank.md' })
    // 网关拒绝 0 字节导入：空文档用单换行占位，保证「清空正文」也能保存成功。
    expect(uploadedText).toBe('\n')
  })
})

describe('FilesGatewayBridge.saveMarkdown local-folder write-back', () => {
  function supervisorStub(): GatewaySupervisor {
    return {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor
  }

  function gatewaysMock(options: {
    sourceKind: string
    storagePath: string
    onUpload?: (metadata: Record<string, unknown>) => void
  }): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'http://gateway.test/v1/files/catalog/file-local') {
        return new Response(JSON.stringify({
          id: 'file-local',
          originalName: 'draft.md',
          sourceKind: options.sourceKind,
          workspaceId: 'ws-local',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://gateway.test/v1/files/file-local/storage') {
        return new Response(JSON.stringify({ storagePath: options.storagePath }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === 'http://gateway.test/v1/file-imports') {
        const form = init?.body as FormData
        options.onUpload?.(JSON.parse(String(form.get('metadata'))) as Record<string, unknown>)
        return new Response(JSON.stringify({
          fileEntryId: 'file-local',
          fileVersionId: 'version-local',
          jobId: 'job-local',
          contentHash: 'c'.repeat(64),
          blobDeduped: false,
          versionDeduped: false,
        }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  it('writes the edit back to the local-folder source file so reopen is not stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-local-folder-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, 'draft.md')
    await writeFile(sourcePath, '# old disk content\n', 'utf8')
    const edited = '# 新标题\n\n磁盘文件也更新了。\n'
    let uploadedMetadata: Record<string, unknown> | null = null
    gatewaysMock({
      sourceKind: 'local-folder',
      storagePath: sourcePath,
      onUpload: (metadata) => { uploadedMetadata = metadata },
    })

    await expect(new FilesGatewayBridge(supervisorStub()).saveMarkdown({
      fileId: 'file-local',
      markdown: edited,
    })).resolves.toEqual({
      fileEntryId: 'file-local',
      fileVersionId: 'version-local',
      contentHash: 'c'.repeat(64),
      originalName: 'draft.md',
    })

    // 关键断言：/content 对 local-folder 读的就是这个磁盘文件，必须已是新内容。
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe(edited)
    expect(uploadedMetadata).toMatchObject({
      fileEntryId: 'file-local',
      originalName: 'draft.md',
      sourceKey: 'agent:markdown:edit:file-local',
      workspaceId: 'ws-local',
    })
    // 原子写回（临时文件 + rename）不残留同目录临时文件。
    await expect(readdir(directory)).resolves.toEqual(['draft.md'])
  })

  it('rejects with a distinct write-back error and still removes the import temp dir', async () => {
    const missingDirectory = join(tmpdir(), `everroom-missing-${Date.now()}`)
    const sourcePath = join(missingDirectory, 'draft.md')
    gatewaysMock({ sourceKind: 'local-folder', storagePath: sourcePath })

    const bridge = new FilesGatewayBridge(supervisorStub())
    const originalImport = bridge.importAgentGeneratedFile.bind(bridge)
    let importTempFile: string | null = null
    vi.spyOn(bridge, 'importAgentGeneratedFile').mockImplementation(async (importInput) => {
      importTempFile = importInput.filePath
      return originalImport(importInput)
    })

    await expect(bridge.saveMarkdown({ fileId: 'file-local', markdown: '# edited\n' }))
      .rejects.toThrow(/^本地文件写回失败（/)
    expect(importTempFile).not.toBeNull()
    // saveMarkdown 的 finally 仍然执行：导入用的临时目录被清理。
    await expect(stat(dirname(importTempFile!))).rejects.toThrow()
    // 回写目标所在目录本来就不存在，不会被意外创建。
    await expect(stat(missingDirectory)).rejects.toThrow()
  })

  it('does not touch the source file for non-local-folder catalog entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-managed-folder-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, 'unused.md')
    await writeFile(sourcePath, '# managed blob, not this file\n', 'utf8')
    let storageRequested = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'http://gateway.test/v1/files/catalog/file-local') {
        return new Response(JSON.stringify({
          id: 'file-local',
          originalName: 'notes.md',
          sourceKind: 'manual-upload',
          workspaceId: 'ws-local',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'http://gateway.test/v1/file-imports') {
        return new Response(JSON.stringify({
          fileEntryId: 'file-local',
          fileVersionId: 'version-local',
          jobId: 'job-local',
          contentHash: 'd'.repeat(64),
          blobDeduped: false,
          versionDeduped: false,
        }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/storage')) storageRequested = true
      throw new Error(`unexpected fetch: ${url}`)
    })

    await expect(new FilesGatewayBridge(supervisorStub()).saveMarkdown({
      fileId: 'file-local',
      markdown: '# managed\n',
    })).resolves.toMatchObject({ originalName: 'notes.md', fileVersionId: 'version-local' })
    expect(storageRequested).toBe(false)
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('# managed blob, not this file\n')
  })
})
