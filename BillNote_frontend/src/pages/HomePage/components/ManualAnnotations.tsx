import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { del, get, set } from 'idb-keyval'
import { v4 as uuid } from 'uuid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTaskStore } from '@/store/taskStore'
import { downloadAnnotationVideo } from '@/services/note'
import { manualMediaKey, parseManualSource, readManualVideos, updateManualVideos } from '@/lib/manualAnnotations'
import type { ManualAnnotation, ManualVideo } from '@/lib/manualAnnotations'
import ManualAnnotationEditor from './ManualAnnotationEditor'

export default function ManualAnnotations({ active }: { active: boolean }) {
  const task = useTaskStore(state => state.getCurrentTask())
  const fileInput = useRef<HTMLInputElement>(null)
  const [videos, setVideos] = useState<ManualVideo[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    readManualVideos().then(saved => {
      if (cancelled) return
      setVideos(saved)
      setSelectedId(saved[0]?.id ?? '')
    }).catch(() => {
      if (!cancelled) setError('无法读取浏览器中保存的批注。')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  async function openLink(input: string, platform?: string, title?: string, playbackPath?: string | null) {
    setError('')
    setBusy(true)
    setPreparing(true)
    try {
      const source = parseManualSource(input, platform)
      const candidate: ManualVideo = { id: uuid(), title: title || input.trim(), source, annotations: [] }
      if (playbackPath) {
        candidate.playbackPath = playbackPath
      } else if (source.kind === 'media' && platform !== 'local') {
        const key = manualMediaKey(source.url)
        if (!await get<Blob>(key)) {
          const response = await fetch(source.url, { credentials: 'omit' })
          if (!response.ok) throw new Error(`直链下载失败（HTTP ${response.status}）。`)
          const blob = await response.blob()
          if (!blob.size || (blob.type && !/^(video\/|application\/octet-stream|binary\/octet-stream)/.test(blob.type))) {
            throw new Error('链接没有返回视频文件，请检查直链或选择本地视频。')
          }
          await set(key, blob)
        }
        candidate.localCopy = true
      } else if (source.kind !== 'media') {
        const downloaded = await downloadAnnotationVideo(source.url, platform)
        candidate.playbackPath = downloaded.playback_url
        candidate.title = title || downloaded.title || candidate.title
      }
      let nextId = candidate.id
      const saved = await updateManualVideos(current => {
        const existing = current.find(video => video.source.kind !== 'file' && video.source.url === source.url)
        if (existing) {
          nextId = existing.id
          return current.map(video => video.id === existing.id ? {
            ...video,
            playbackPath: candidate.playbackPath || video.playbackPath,
            localCopy: candidate.localCopy || video.localCopy,
          } : video)
        }
        return [candidate, ...current]
      })
      setVideos(saved)
      setSelectedId(nextId)
      setUrl('')
    } catch (err) {
      const response = err as { msg?: string }
      setError(response?.msg || (err instanceof TypeError
        ? '无法下载此直链。请检查链接和站点下载权限，或先下载到电脑再选择本地视频。'
        : err instanceof Error ? err.message : '无法保存视频，请检查链接或浏览器存储。'))
    } finally {
      setBusy(false)
      setPreparing(false)
    }
  }

  async function openFile(file: File) {
    setError('')
    setBusy(true)
    const video: ManualVideo = { id: uuid(), title: file.name, source: { kind: 'file' }, annotations: [] }
    const fileKey = manualMediaKey(video.id)
    try {
      await set(fileKey, file)
      const saved = await updateManualVideos(current => [video, ...current])
      setVideos(saved)
      setSelectedId(video.id)
    } catch {
      await del(fileKey).catch(() => {})
      setError('无法保存本地视频，请检查浏览器可用空间。')
    } finally {
      setBusy(false)
    }
  }

  async function changeAnnotations(change: (notes: ManualAnnotation[]) => ManualAnnotation[]) {
    setBusy(true)
    try {
      const saved = await updateManualVideos(current => current.map(video => video.id === selectedId
        ? { ...video, annotations: change(video.annotations) }
        : video))
      setVideos(saved)
    } finally {
      setBusy(false)
    }
  }

  function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!busy && url.trim()) void openLink(url)
  }

  const selected = videos.find(video => video.id === selectedId)
  const taskUrl = task?.formData?.video_url
  const taskPlatform = task?.formData?.platform
  const canUseTask = taskUrl && (taskPlatform !== 'local' || taskUrl.startsWith('/uploads/'))
  const disabled = loading || busy

  return (
    <ScrollArea className="h-full">
      <section aria-label="手动批注" className="space-y-4 pr-3 pb-4">
        <div className="space-y-2">
          <form onSubmit={submitLink} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="批注视频链接"
              placeholder="粘贴视频链接"
              className="min-w-40 flex-1"
              value={url}
              onChange={event => setUrl(event.target.value)}
              disabled={disabled}
            />
            <Button type="submit" variant="outline" disabled={disabled || !url.trim()}>下载并打开</Button>
            <Button type="button" variant="outline" disabled={disabled} onClick={() => fileInput.current?.click()}>
              选择本地视频
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="video/*,.mkv"
              aria-label="本地批注视频"
              hidden
              onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file && !disabled) void openFile(file)
              }}
            />
            {canUseTask && (
              <Button type="button" variant="outline" disabled={disabled}
                onClick={() => void openLink(taskUrl, taskPlatform, task?.audioMeta?.title, task?.audioMeta?.playback_url)}>
                使用当前笔记的视频
              </Button>
            )}
          </form>
          {preparing && <p role="status" className="text-muted-foreground text-sm">正在准备本地视频，下载和转码可能需要一些时间。</p>}
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          {videos.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="shrink-0">批注视频</span>
              <select className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2"
                value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={disabled}>
                {videos.map(video => <option key={video.id} value={video.id}>{video.title}</option>)}
              </select>
            </label>
          )}
        </div>
        {selected ? (
          <ManualAnnotationEditor key={`${selected.id}:${selected.playbackPath ?? selected.localCopy ?? ''}`}
            video={selected} active={active} busy={busy} onChange={changeAnnotations} />
        ) : (
          <p className="text-muted-foreground text-sm">
            {loading ? '正在读取批注…' : '打开链接或选择视频文件，即可开始批注。批注保存在当前浏览器。'}
          </p>
        )}
      </section>
    </ScrollArea>
  )
}
