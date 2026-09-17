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
    const previews: Pick<ToolSource, 'image' | 'page_image'> = {}
    for (const key of ['image', 'page_image'] as const) {
      if (item[key] == null) continue
      const raw = item[key].thumbnail_url
      if (typeof raw !== 'string' || raw.length > 4096 || !safeUrl(raw)) return
      const thumbnail = new URL(raw)
      if (thumbnail.protocol !== 'https:') return
      previews[key] = { thumbnail_url: thumbnail.href }
    }
    let content: SourceContent | undefined
    if (item.content != null) {
      const body = item.content
      if (
        typeof body !== 'object' ||
        !['reading', 'summarizing', 'read', 'failed', 'skipped', 'cancelled'].includes(body.status) ||
        typeof body.text !== 'string' || Array.from(body.text).length > 32000 ||
        typeof body.truncated !== 'boolean' ||
        !(body.final_url === null || (typeof body.final_url === 'string' && body.final_url.length <= 4096 && safeUrl(body.final_url))) ||
        ![null, 'page_unavailable', 'page_timeout', 'budget_exhausted', 'page_blocked', 'page_not_found', 'page_size_limit', 'unsupported_content_type', 'unsupported_encoding', 'empty_page', 'unsafe_url'].includes(body.error_code) ||
        (['read', 'summarizing'].includes(body.status) && (item.access !== 'page_read' || !body.text.trim() || !body.final_url || body.error_code !== null)) ||
        (['failed', 'skipped'].includes(body.status) && (body.text !== '' || body.error_code === null)) ||
        (body.status === 'reading' && (body.text !== '' || body.error_code !== null)) ||
        (body.summary !== undefined && (typeof body.summary !== 'string' || Array.from(body.summary).length > 2000 || (body.summary && !['read', 'summarizing', 'cancelled'].includes(body.status)))) ||
        ![undefined, null, 'summary_unavailable', 'summary_timeout', 'summary_budget_exhausted'].includes(body.summary_error)
      ) return
      content = { status: body.status, text: body.text, truncated: body.truncated, final_url: body.final_url, error_code: body.error_code, summary: body.summary, summary_error: body.summary_error }
    }
    sources.push({
      id: item.id,
      url: item.url,
      title: item.title,
      access: item.access,
      accessed_at: item.accessed_at,
      verification: 'unverified',
      ...(content ? { content } : {}),
      ...previews,
    })
  }
  return [...new Map(sources.map((s) => [s.id, s])).values()]
}
