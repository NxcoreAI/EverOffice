import { describe, expect, it } from 'vitest'

import { navigationSections, pageLabels } from './navigation'

describe('desktop navigation', () => {
  it('keeps Office and Schedules under Execution without legacy Agent or Tasks pages', () => {
    const execution = navigationSections.find((section) => section.id === 'execution')
    const pageIds = navigationSections.flatMap((section) => section.items.map((item) => item.id))

    expect(execution?.items.map((item) => item.id)).toEqual(['office', 'schedules', 'agent-connections'])
    expect(pageIds).not.toContain('agents')
    expect(pageIds).not.toContain('tasks')
    expect(pageIds).not.toContain('office-test')
    expect(pageLabels.office).toBe('surface:navigation.office')
  })

  it('no longer routes to the removed memory, Context Room, diary, wiki or perception pages', () => {
    const pageIds = navigationSections.flatMap((section) => section.items.map((item) => item.id))

    for (const removed of ['rooms', 'memory', 'wiki', 'diary', 'inspiration', 'recording']) {
      expect(pageIds).not.toContain(removed)
    }
    expect(pageIds).toEqual(['home', 'docs', 'sources', 'files', 'office', 'schedules', 'agent-connections', 'settings'])
  })

  it('exposes the sources page without legacy connector pages', () => {
    const pages = navigationSections.flatMap((section) => section.items.map((item) => item.id))

    expect(pages).toContain('sources')
    expect(pages).not.toContain('connectors')
  })
})
