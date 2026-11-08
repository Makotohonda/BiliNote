import { useEffect } from 'react'
import { useTaskStore } from '@/store/taskStore'
import { get_task_status } from '@/services/note.ts'
import toast from 'react-hot-toast'

export const useTaskPolling = (interval = 3000) => {
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const { updateTaskContent } = useTaskStore.getState()

    const poll = async () => {
      const pendingTasks = useTaskStore.getState().tasks.filter(
        task => !['SUCCESS', 'FAILED', 'FAILD'].includes(task.status),
      )
      try {
        for (const task of pendingTasks) {
          if (stopped) return
          try {
            const { status, message, result } = await get_task_status(task.id)
            if (stopped) return

            if (status === 'SUCCESS' && result) {
              const { markdown, transcript, audio_meta } = result
              updateTaskContent(task.id, { status, markdown, transcript, audioMeta: audio_meta, pollError: undefined })
              toast.success('笔记生成成功')
            } else if (status === 'FAILED') {
              const failureMessage = message || '生成任务失败，后端未返回具体原因。'
              updateTaskContent(task.id, { status, failureMessage, pollError: undefined })
              toast.error(failureMessage)
            } else if (status !== 'SUCCESS' && (status !== task.status || task.pollError)) {
              updateTaskContent(task.id, { status, pollError: undefined })
            }
          } catch {
            if (!stopped && !task.pollError) {
              updateTaskContent(task.id, {
                pollError: '暂时无法查询任务状态。请检查后端连接，页面会自动重试。',
              })
            }
          }
        }
      } finally {
        if (!stopped) timer = setTimeout(poll, interval)
      }
    }

    timer = setTimeout(poll, interval)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [interval])
}
