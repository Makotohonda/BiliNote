import { get, update } from 'idb-keyval'

export interface ManualAnnotation {
  id: string
  startMs: number
  endMs: number | null
  title: string
  body: string
}

export type ManualSource =
  | { kind: 'file' }
  | { kind: 'media' | 'page'; url: string }
  | { kind: 'bilibili'; url: string; videoId: string; page: string }
  | { kind: 'youtube'; url: string; videoId: string }

export interface ManualVideo {
  id: string
  title: string
  source: ManualSource
  annotations: ManualAnnotation[]
  playbackPath?: string
  localCopy?: boolean
}

const libraryKey = 'manual-annotation-videos'

export const manualMediaKey = (id: string) => `manual-annotation-file:${id}`

export function annotationPlaybackUrl(path: string) {
  const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
  const apiBase = base.endsWith('/api') ? base : `${base}/api`
  return `${apiBase}${path}`
}

export async function readManualVideos() {
  return (await get<ManualVideo[]>(libraryKey)) ?? []
}

export async function updateManualVideos(change: (videos: ManualVideo[]) => ManualVideo[]) {
  let videos: ManualVideo[] = []
  await update<ManualVideo[]>(libraryKey, current => {
    videos = change(current ?? [])
    return videos
  })
  return videos
}

export function parseAnnotationTime(text: string) {
  const value = text.trim()
  if (!/^(?:\d{1,7}:){0,2}\d{1,7}(?:\.\d{1,3})?$/.test(value)) return null
  const parts = value.split(':').map(Number)
  if (parts.slice(1).some(part => part >= 60)) return null
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000)
}

export function formatAnnotationTime(ms: number) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const pad = (value: number) => String(value).padStart(2, '0')
  const clock = minutes >= 60
    ? `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${pad(seconds % 60)}`
    : `${pad(minutes)}:${pad(seconds % 60)}`
  return ms % 1000 ? `${clock}.${String(ms % 1000).padStart(3, '0')}` : clock
}

export function parseManualSource(input: string, platform?: string): Exclude<ManualSource, { kind: 'file' }> {
  const value = input.trim()
  if (platform === 'local' && /^\/uploads\/[^/\\]+$/.test(value)) {
    return { kind: 'media', url: annotationPlaybackUrl(`/annotation_video/${encodeURIComponent(value.slice('/uploads/'.length))}`) }
  }
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入不含登录凭据的 HTTP 或 HTTPS 视频链接。')
  }
  url.hash = ''
  const host = url.hostname.replace(/^www\./, '')

  if (host === 'bilibili.com') {
    const videoId = url.pathname.match(/^\/video\/(BV[\da-z]{10}|av\d+)(?:\/|$)/i)?.[1]
    if (videoId) {
      const page = url.searchParams.get('p') || '1'
      const part = /^\d+$/.test(page) && Number(page) > 0 ? String(Number(page)) : '1'
      const source = new URL(`https://www.bilibili.com/video/${videoId}/`)
      if (part !== '1') source.searchParams.set('p', part)
      return { kind: 'bilibili', url: source.href, videoId, page: part }
    }
  }

  if (['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
    const videoId = host === 'youtu.be'
      ? url.pathname.split('/')[1]
      : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]
    if (videoId && /^[\w-]{11}$/.test(videoId)) {
      return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${videoId}`, videoId }
    }
  }

  const pageHosts = ['bilibili.com', 'b23.tv', 'youtube.com', 'youtu.be', 'douyin.com', 'kuaishou.com', 'xiaohongshu.com', 'xhslink.com']
  const isPage = pageHosts.some(domain => host === domain || host.endsWith(`.${domain}`))
  return { kind: isPage ? 'page' : 'media', url: url.href }
}

export function manualEmbedUrl(source: ManualSource, startMs: number) {
  const seconds = String(Math.floor(startMs / 1000))
  if (source.kind === 'bilibili') {
    const url = new URL('https://player.bilibili.com/player.html')
    if (source.videoId.toLowerCase().startsWith('av')) url.searchParams.set('aid', source.videoId.slice(2))
    else url.searchParams.set('bvid', source.videoId)
    url.searchParams.set('p', source.page)
    url.searchParams.set('autoplay', '0')
    url.searchParams.set('t', seconds)
    return url.href
  }
  if (source.kind === 'youtube') return `https://www.youtube-nocookie.com/embed/${source.videoId}?start=${seconds}`
  return null
}
