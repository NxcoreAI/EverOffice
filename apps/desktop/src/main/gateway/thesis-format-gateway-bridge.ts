/**
 * 论文格式管线的桌面→网关桥：设为论文模版（库内文件/磁盘直传 zip）、
 * 格式卡列表/删除、一键装订。装订是长任务（子代理映射 + 本机渲染 + 入库），
 * 超时放宽；完成事件由 office:agent-file 广播（装订产物走同一入库通道）。
 *
 * Room 已删除：格式卡按工作区作用域存取，网关侧 `/v1/thesis-format/*` 把 scope
 * 统一写成 WORKSPACE_DOCUMENT_CHANNEL（thesis_format_cards.room_id 历史列），
 * 本桥不再接收 Room id，全部走工作区作用域入口。
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { GatewaySupervisor } from './gateway-supervisor'

/** 工作区作用域的论文格式管线前缀（旧 `/rooms/:roomId/*` 路由仅网关侧兼容保留）。 */
const THESIS_FORMAT_BASE = '/v1/thesis-format'

export interface ThesisFormatCardDto {
  id: string
  sourceName: string
  sourceFileEntryId: string | null
  updatedAt: string
  /** ThesisFormatCard 全量 JSON（预览样张的数据源）。 */
  card: Record<string, unknown>
}

export interface ThesisReformatOutcomeDto {
  fileEntryId: string
  originalName: string
}

export class ThesisFormatGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  async listCards(): Promise<ThesisFormatCardDto[]> {
    const response = await this.request(`${THESIS_FORMAT_BASE}/cards`)
    if (!response.ok) throw new Error(`论文格式卡列表读取失败（${response.status}）`)
    return await response.json() as ThesisFormatCardDto[]
  }

  /** 资料区已有文件设为模版（docx/doc/pdf）。 */
  async parseFromLibrary(fileEntryId: string): Promise<{ cardId: string; sourceName: string }> {
    return this.parse({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileEntryId }),
    })
  }

  /** 磁盘直传模版（zip 不进文件库；docx/doc/pdf 也走此通道）。 */
  async parseFromDisk(filePath: string): Promise<{ cardId: string; sourceName: string }> {
    const bytes = await readFile(filePath)
    const name = basename(filePath)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)]), name)
    return this.parse({ method: 'POST', body: form })
  }

  async removeCard(cardId: string): Promise<void> {
    const response = await this.request(
      `${THESIS_FORMAT_BASE}/cards/${encodeURIComponent(cardId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) throw new Error(`论文格式卡删除失败（${response.status}）`)
  }

  private async parse(init: RequestInit): Promise<{ cardId: string; sourceName: string }> {
    const upload = init.body instanceof FormData
    const response = await this.request(
      `${THESIS_FORMAT_BASE}/${upload ? 'parse-upload' : 'parse'}`,
      init,
      10 * 60_000,
    )
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error || `论文模版解析失败（${response.status}）`)
    }
    const body = await response.json() as { cardId?: string; sourceName?: string }
    return {
      cardId: typeof body.cardId === 'string' ? body.cardId : '',
      sourceName: typeof body.sourceName === 'string' ? body.sourceName : '',
    }
  }

  /** 一键装订：产物为新文件（xxx-排版版.docx），完成后 office:agent-file 广播。 */
  async reformat(fileEntryId: string, cardId?: string): Promise<ThesisReformatOutcomeDto> {
    const response = await this.request(
      `${THESIS_FORMAT_BASE}/reformat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileEntryId, cardId }),
      },
      10 * 60_000,
    )
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error || `论文排版失败（${response.status}）`)
    }
    return await response.json() as ThesisReformatOutcomeDto
  }

  private async request(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
    const connection = this.supervisor.getConnection()
    return fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
}
