import type { ToolSource } from '../types'
import { safeUrl } from './utils'

export function parseToolSources(value: unknown): ToolSource[] | undefined {
  if (!Array.isArray(value) || value.length > 220) return
  const sources: ToolSource[] = []
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !/^src_[a-f0-9]{24}$/.test(item.id) ||
      typeof item.url !== 'string' ||
      item.url.length > 4096 ||
      !safeUrl(item.url) ||
      typeof item.title !== 'string' ||
      item.title.length > 4096 ||
      !['search_result', 'page_read'].includes(item.access) ||
      typeof item.accessed_at !== 'string' ||
      !Number.isFinite(Date.parse(item.accessed_at)) ||
      item.verification !== 'unverified'
    )
      return
    sources.push({
      id: item.id,
      url: item.url,
      title: item.title,
      access: item.access,
      accessed_at: item.accessed_at,
      verification: 'unverified',
    })
  }
  return [...new Map(sources.map((s) => [s.id, s])).values()]
}
