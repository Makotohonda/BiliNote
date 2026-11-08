import { FC, useEffect, useState } from 'react'
import HomeLayout from '@/layouts/HomeLayout.tsx'
import NoteForm from '@/pages/HomePage/components/NoteForm.tsx'
import MarkdownViewer from '@/pages/HomePage/components/MarkdownViewer.tsx'
import { useTaskStore } from '@/store/taskStore'
import History from '@/pages/HomePage/components/History.tsx'
import ManualAnnotations from '@/pages/HomePage/components/ManualAnnotations.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
type ViewStatus = 'idle' | 'loading' | 'success' | 'failed'
export const HomePage: FC = () => {
  const tasks = useTaskStore(state => state.tasks)
  const currentTaskId = useTaskStore(state => state.currentTaskId)

  const currentTask = tasks.find(t => t.id === currentTaskId)

  const [status, setStatus] = useState<ViewStatus>('idle')
  const [previewTab, setPreviewTab] = useState('ai')
  const [manualOpened, setManualOpened] = useState(false)

  useEffect(() => {
    if (!currentTask) {
      setStatus('idle')
    } else if (currentTask.status === 'SUCCESS') {
      setStatus('success')
    } else if (currentTask.status === 'FAILED' || currentTask.status === 'FAILD') {
      setStatus('failed')
    } else {
      // PENDING、PARSING、DOWNLOADING、TRANSCRIBING、SUMMARIZING 等所有进行中状态
      setStatus('loading')
    }
  }, [currentTask, currentTask?.status])

  // useEffect( () => {
  //     get_task_status('d4e87938-c066-48a0-bbd5-9bec40d53354').then(res=>{
  //         console.log('res1',res)
  //         setContent(res.data.result.markdown)
  //     })
  // }, [tasks]);
  return (
    <HomeLayout
      NoteForm={<NoteForm />}
      Preview={(
        <Tabs className="h-full min-h-0" value={previewTab} onValueChange={value => {
          setPreviewTab(value)
          if (value === 'manual') setManualOpened(true)
        }}>
          <TabsList className="shrink-0" aria-label="笔记视图">
            <TabsTrigger value="ai">AI 笔记</TabsTrigger>
            <TabsTrigger value="manual">手动批注</TabsTrigger>
          </TabsList>
          <TabsContent value="ai" forceMount className="min-h-0 data-[state=inactive]:hidden">
            <MarkdownViewer status={status} />
          </TabsContent>
          <TabsContent value="manual" forceMount className="min-h-0 data-[state=inactive]:hidden">
            {manualOpened && <ManualAnnotations active={previewTab === 'manual'} />}
          </TabsContent>
        </Tabs>
      )}
      History={<History />}
    />
  )
}
