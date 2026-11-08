import request from '@/utils/request'
import type { IResponse } from '@/utils/request'
import type { AudioMeta, TaskStatus, Transcript } from '@/store/taskStore'
import toast from 'react-hot-toast'

export interface GenerateNoteRequest {
  video_url: string
  platform: string
  quality: string
  model_name: string
  provider_id: string
  link?: boolean
  screenshot?: boolean
  task_id?: string
  format?: string[]
  style?: string
  extras?: string
  video_understanding?: boolean
  video_interval?: number
  grid_size?: [number, number]
}

export const generateNote = async (data: GenerateNoteRequest) => {
  const response = await request.post<unknown, { task_id: string }>('/generate_note', data, { suppressToast: true })
  toast.success('笔记生成任务已提交！')
  return response
}

export const downloadAnnotationVideo = (video_url: string, platform?: string) =>
  request.post<unknown, { playback_url: string; title: string }>('/annotation_video/download', { video_url, platform }, {
    timeout: 0,
    suppressToast: true,
  })

export const delete_task = async ({ video_id, platform }) => {
  try {
    const data = {
      video_id,
      platform,
    }
    const res = await request.post('/delete_task', data)


      toast.success('任务已成功删除')
      return res
  } catch (e) {
    toast.error('请求异常，删除任务失败')
    console.error('❌ 删除任务失败:', e)
    throw e
  }
}

interface TaskStatusResult {
  status: TaskStatus
  message?: string
  result?: { markdown: string; transcript: Transcript; audio_meta: AudioMeta }
}

export const get_task_status = async (task_id: string): Promise<TaskStatusResult> => {
  try {
    return await request.get<unknown, TaskStatusResult>('/task_status/' + task_id, { suppressToast: true })
  } catch (error) {
    const failure = error as IResponse<TaskStatusResult | null> | undefined
    if (failure?.code === 500 && (failure.data?.status === 'FAILED' || failure.data === null)) {
      return { status: 'FAILED', message: failure.msg }
    }
    throw error
  }
}
