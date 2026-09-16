import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
export function safeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
    const h = url.hostname.toLowerCase()
    if (!h.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /\.(local|internal|localhost)$/.test(h)) return
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return
    return url.href
  } catch { return }
}
