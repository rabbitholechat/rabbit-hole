import type { SourceContent, ToolSource } from '../types'
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
    let content: SourceContent | undefined
    if (item.content != null) {
      const body = item.content
      if (
        typeof body !== 'object' ||
        !['read', 'failed', 'skipped'].includes(body.status) ||
        typeof body.text !== 'string' || Array.from(body.text).length > 32000 ||
        typeof body.truncated !== 'boolean' ||
        !(body.final_url === null || (typeof body.final_url === 'string' && body.final_url.length <= 4096 && safeUrl(body.final_url))) ||
        ![null, 'page_unavailable', 'page_timeout', 'budget_exhausted'].includes(body.error_code) ||
        (body.status === 'read' && (item.access !== 'page_read' || !body.text.trim() || !body.final_url || body.error_code !== null)) ||
        (body.status !== 'read' && (body.text !== '' || body.error_code === null))
      ) return
      content = { status: body.status, text: body.text, truncated: body.truncated, final_url: body.final_url, error_code: body.error_code }
    }
    sources.push({
      id: item.id,
      url: item.url,
      title: item.title,
      access: item.access,
      accessed_at: item.accessed_at,
      verification: 'unverified',
      ...(content ? { content } : {}),
    })
  }
  return [...new Map(sources.map((s) => [s.id, s])).values()]
}
