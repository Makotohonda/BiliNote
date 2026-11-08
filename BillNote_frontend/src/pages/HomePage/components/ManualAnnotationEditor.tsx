import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { get } from 'idb-keyval'
import { v4 as uuid } from 'uuid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { annotationPlaybackUrl, formatAnnotationTime, manualEmbedUrl, manualMediaKey, parseAnnotationTime } from '@/lib/manualAnnotations'
import type { ManualAnnotation, ManualVideo } from '@/lib/manualAnnotations'

const emptyDraft = { range: false, start: '', end: '', title: '', body: '' }

interface Props {
  video: ManualVideo
  active: boolean
  busy: boolean
  onChange: (change: (notes: ManualAnnotation[]) => ManualAnnotation[]) => Promise<void>
}

export default function ManualAnnotationEditor({ video, active, busy, onChange }: Props) {
  const { source } = video
  const player = useRef<HTMLVideoElement>(null)
  const [fileUrl, setFileUrl] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [playerReady, setPlayerReady] = useState(false)
  const [embed, setEmbed] = useState({ startMs: 0, revision: 0 })
  const [draft, setDraft] = useState(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mediaKey = source.kind === 'file' ? manualMediaKey(video.id)
    : video.localCopy && source.kind === 'media' ? manualMediaKey(source.url) : null

  useEffect(() => {
    if (!mediaKey) return
    let cancelled = false
    let objectUrl = ''
    get<Blob>(mediaKey).then(file => {
      if (cancelled) return
      if (!file) throw new Error('Missing video file')
      objectUrl = URL.createObjectURL(file)
      setFileUrl(objectUrl)
    }).catch(() => {
      if (!cancelled) setMediaError('无法读取已保存的视频文件，仍可手动输入批注时间。')
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [mediaKey])

  useEffect(() => {
    if (!active) player.current?.pause()
  }, [active])

  const mediaUrl = video.playbackPath ? annotationPlaybackUrl(video.playbackPath)
    : source.kind === 'media' && !video.localCopy ? source.url : fileUrl
  const embedUrl = video.playbackPath ? null : manualEmbedUrl(source, embed.startMs)
  const sourceUrl = source.kind === 'page' || source.kind === 'bilibili' || source.kind === 'youtube' ? source.url : null
  const sortedNotes = [...video.annotations].sort((a, b) => a.startMs - b.startMs)

  function capture(field: 'point' | 'start' | 'end') {
    if (!playerReady || !player.current) return
    const time = formatAnnotationTime(Math.round(player.current.currentTime * 1000))
    setDraft(current => field === 'end'
      ? { ...current, range: true, end: time }
      : { ...current, range: field === 'start', start: time, end: field === 'point' ? '' : current.end })
    setError('')
  }

  function jumpTo(startMs: number) {
    if (embedUrl) {
      setEmbed(current => ({ startMs, revision: current.revision + 1 }))
    } else if (playerReady && player.current) {
      player.current.currentTime = startMs / 1000
    }
  }

  function clearDraft() {
    setEditingId(null)
    setDraft(emptyDraft)
    setError('')
  }

  function edit(note: ManualAnnotation) {
    setEditingId(note.id)
    setDraft({
      range: note.endMs !== null,
      start: formatAnnotationTime(note.startMs),
      end: note.endMs === null ? '' : formatAnnotationTime(note.endMs),
      title: note.title,
      body: note.body,
    })
    setDeletingId(null)
    setError('')
    setNotice('')
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError('')
    setNotice('')
    const startMs = parseAnnotationTime(draft.start)
    const endMs = draft.range ? parseAnnotationTime(draft.end) : null
    const title = draft.title.trim()
    const duration = playerReady ? player.current?.duration : undefined
    if (startMs === null || (draft.range && endMs === null)) {
      setError('请输入有效时间，例如 00:08、01:22.500 或 82。')
      return
    }
    if (endMs !== null && endMs <= startMs) {
      setError('结束时间须晚于开始时间。')
      return
    }
    if (duration !== undefined && Number.isFinite(duration) && (endMs ?? startMs) > Math.round(duration * 1000)) {
      setError('批注时间不能超过视频时长。')
      return
    }
    if (!title) {
      setError('请输入批注标题。')
      return
    }
    const note = { id: editingId ?? uuid(), startMs, endMs, title, body: draft.body.trim() }
    try {
      await onChange(notes => {
        if (!editingId) return [...notes, note]
        if (!notes.some(item => item.id === editingId)) throw new Error('Annotation no longer exists')
        return notes.map(item => item.id === editingId ? note : item)
      })
      clearDraft()
      setNotice('批注已保存')
    } catch {
      setError('无法保存批注，请检查浏览器存储后重试。')
    }
  }

  async function remove(id: string) {
    try {
      await onChange(notes => notes.filter(note => note.id !== id))
      if (editingId === id) clearDraft()
      setDeletingId(null)
      setNotice('批注已删除')
    } catch {
      setError('无法删除批注，请重试。')
    }
  }

  return (
    <div className="space-y-4">
      {mediaUrl && (
        <video ref={player} src={mediaUrl} aria-label="批注视频播放器" controls playsInline preload="metadata"
          className="max-h-[45vh] w-full rounded-md border"
          onLoadedMetadata={() => { setPlayerReady(true); setMediaError('') }}
          onError={() => {
            setPlayerReady(false)
            setMediaError('浏览器无法播放此视频。你仍可手动输入时间，或选择浏览器支持的视频文件。')
          }}
        />
      )}
      {active && embedUrl && (
        <iframe key={embed.revision} src={embedUrl} title="批注视频播放器" allowFullScreen
          className="aspect-video max-h-[45vh] w-full rounded-md border"
        />
      )}
      {sourceUrl && (
        <p className="text-muted-foreground text-sm">
          {video.playbackPath ? '正在使用本地视频副本。'
            : embedUrl ? '请参照嵌入播放器手动填写时间。' : '请在原站播放视频，再手动填写批注时间。'}
          {' '}
          <a className="text-primary underline" href={sourceUrl} target="_blank" rel="noopener noreferrer">打开原视频</a>
          {video.playbackPath && (
            <a className="text-primary ml-2 underline" href={mediaUrl} download={`${video.title}.mp4`}>下载 MP4</a>
          )}
        </p>
      )}
      {mediaError && <p className="text-muted-foreground text-sm">{mediaError}</p>}

      <form onSubmit={save} className="space-y-3 rounded-md border p-3">
        <h2 className="text-sm font-medium">{editingId ? '编辑批注' : '新建批注'}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant={draft.range ? 'outline' : 'secondary'} aria-pressed={!draft.range} disabled={busy}
            onClick={() => setDraft(current => ({ ...current, range: false }))}>时间点</Button>
          <Button type="button" size="sm" variant={draft.range ? 'secondary' : 'outline'} aria-pressed={draft.range} disabled={busy}
            onClick={() => setDraft(current => ({ ...current, range: true }))}>时间段</Button>
          {playerReady && (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => capture('point')}>标记当前帧</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => capture('start')}>
                {draft.range ? '取开始时间' : '标记时间段'}
              </Button>
              {draft.range && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => capture('end')}>取结束时间</Button>
              )}
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Input aria-label={draft.range ? '开始时间' : '批注时间'} placeholder={draft.range ? '开始时间' : '时间，例如 00:08.500'}
            className="min-w-36 flex-1" value={draft.start} disabled={busy}
            onChange={event => setDraft({ ...draft, start: event.target.value })} />
          {draft.range && (
            <Input aria-label="结束时间" placeholder="结束时间" className="min-w-36 flex-1" value={draft.end} disabled={busy}
              onChange={event => setDraft({ ...draft, end: event.target.value })} />
          )}
        </div>
        <Input aria-label="批注标题" placeholder="批注标题" maxLength={160} value={draft.title} disabled={busy}
          onChange={event => setDraft({ ...draft, title: event.target.value })} />
        <Textarea aria-label="批注内容" placeholder="记录你的观察…" rows={3} maxLength={10000} value={draft.body} disabled={busy}
          onChange={event => setDraft({ ...draft, body: event.target.value })} />
        {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy}>保存批注</Button>
          {editingId && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={clearDraft}>取消编辑</Button>}
          <span className="text-muted-foreground text-sm" role="status">{notice}</span>
        </div>
      </form>

      {sortedNotes.length === 0 ? (
        <p className="text-muted-foreground text-sm">暂无批注</p>
      ) : (
        <ul aria-label="已保存批注" className="space-y-2">
          {sortedNotes.map(note => {
            const time = formatAnnotationTime(note.startMs) + (note.endMs === null ? '' : `–${formatAnnotationTime(note.endMs)}`)
            return (
              <li key={note.id} className="space-y-1 rounded-md border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {playerReady || embedUrl ? (
                    <Button type="button" size="sm" variant="link" className="h-auto px-0" onClick={() => jumpTo(note.startMs)}>{time}</Button>
                  ) : <span className="text-muted-foreground text-sm">{time}</span>}
                  <h3 className="min-w-0 flex-1 text-sm font-medium break-words">{note.title}</h3>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => edit(note)}>编辑</Button>
                  {deletingId === note.id ? (
                    <>
                      <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void remove(note.id)}>确认删除</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setDeletingId(null)}>取消</Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDeletingId(note.id)}>删除</Button>
                  )}
                </div>
                {note.body && <p className="text-sm break-words whitespace-pre-wrap">{note.body}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
