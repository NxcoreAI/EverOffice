import { describe, expect, it } from 'vitest'

import type { AgentSessionLink } from '@nxcore/agent-contract'

import {
  agentSessionLinkDestination,
  parseAgentNavigationTarget,
  resolveAgentSessionLinkRoute,
} from './agentNavigation'

const link: AgentSessionLink = {
  id: 'link-1',
  sourceSessionId: 'source-session',
  targetSessionId: 'target-session',
  sourceRunId: 'run-1',
  sourcePageId: 'docs',
  sourcePageLabel: '文档',
  sourceRoomId: null,
  target: {
    pageId: 'docs',
    title: 'Release notes',
    action: 'created',
    roomId: null,
    objectId: 'document-1',
    objectType: 'document',
  },
  createdAt: '2026-08-16T00:00:00.000Z',
  returnedAt: null,
}

describe('agent navigation target', () => {
  it('accepts navigation metadata only from a valid tool result', () => {
    expect(parseAgentNavigationTarget({
      details: {
        navigation: {
          pageId: 'docs',
          title: 'Release notes',
          action: 'created',
          objectId: 'document-1',
          objectType: 'document',
        },
      },
    })).toMatchObject({ pageId: 'docs', objectId: 'document-1' })

    // Room 已随本次清理移除：指向 Room 的导航目标一律丢弃。
    expect(parseAgentNavigationTarget({
      details: {
        navigation: {
          pageId: 'rooms',
          title: 'Campus Life',
          action: 'created',
          roomId: 'room-campus-life',
          objectId: 'room-campus-life',
          objectType: 'room',
        },
      },
    })).toBeNull()
    // 文稿导航必须带 objectId，否则落不了位置。
    expect(parseAgentNavigationTarget({ details: { navigation: { pageId: 'docs', title: 'Missing document', action: 'created', objectType: 'document' } } })).toBeNull()
    expect(parseAgentNavigationTarget({ details: { navigation: { pageId: 'settings', title: 'Unsupported', action: 'opened' } } })).toBeNull()
    expect(parseAgentNavigationTarget({ content: 'created room-1' })).toBeNull()
  })

  it('routes a persisted link in both directions without creating another link', () => {
    expect(agentSessionLinkDestination(link, 'target-session')).toBe('source')
    expect(agentSessionLinkDestination(link, 'source-session')).toBe('target')
    expect(agentSessionLinkDestination(link, 'unrelated-session')).toBeNull()

    expect(resolveAgentSessionLinkRoute(link, 'source')).toMatchObject({
      pageId: 'docs',
      roomId: null,
      sessionId: 'source-session',
      documentId: null,
    })
    expect(resolveAgentSessionLinkRoute(link, 'target')).toMatchObject({
      pageId: 'docs',
      roomId: null,
      sessionId: 'target-session',
      documentId: 'document-1',
    })
  })
})
