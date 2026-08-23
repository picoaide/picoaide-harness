/**
 * New-task modal: title, description, project picker, and the execution
 * prompt.
 */
import { useEffect, useState } from 'react'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { TaskController } from './controller.ts'
import { styles } from './styles.ts'
import { t } from './locales.ts'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { PermissionPicker } from './PermissionPicker.tsx'

export function NewTaskModal({ controller, workspaces, onClose }: {
  controller: TaskController
  workspaces?: IWorkspaces
  onClose: () => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [permission, setPermission] = useState('')
  const [error, setError] = useState('')

  // Modal mutex: announce this modal and close when another modal opens.
  // Cross-package coordination rides the existing dsh-panel-activate event
  // family via a dedicated event so every overlay is mutually exclusive
  // (task board ↔ cron ↔ connectors ↔ skill center ↔ context popup).
  useEffect(() => {
    document.dispatchEvent(new CustomEvent('dsh-modal-open', { detail: 'task-new' }))
    const onOtherModal = (event: Event): void => {
      if ((event as CustomEvent).detail !== 'task-new') onClose()
    }
    document.addEventListener('dsh-modal-open', onOtherModal)
    return () => {
      document.removeEventListener('dsh-modal-open', onOtherModal)
    }
  }, [onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = (): void => {
    // UX-4: an empty title must not be a silent no-op — the user clicked
    // 保存 and nothing happened, which reads as a bug.
    if (title.trim() === '') {
      setError(t('new.titleRequired'))
      return
    }
    setError('')
    controller.create({
      title: title.trim(),
      description,
      prompt: prompt.trim() !== '' ? prompt.trim() : title.trim(),
      ...(workspaceId === '' ? {} : { workspaceId }),
      ...(permission === '' ? {} : { permission }),
    })
    onClose()
  }

  return (
    <div style={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div style={styles.editor} role="dialog" aria-label={t('new.title')}>
        <div style={styles.field}>
          <span style={styles.label}>{t('new.name')}</span>
          <input style={styles.input} value={title} onChange={(event) => { setTitle(event.target.value); if (error !== '') setError('') }} autoFocus />
          {error !== '' && <span style={styles.error}>{error}</span>}
        </div>
        <div style={styles.field}>
          <span style={styles.label}>{t('new.description')}</span>
          <input style={styles.input} value={description} onChange={(event) => { setDescription(event.target.value) }} />
        </div>
        <WorkspacePicker workspaces={workspaces} value={workspaceId} onChange={setWorkspaceId} />
        <PermissionPicker value={permission} onChange={setPermission} />
        <div style={styles.field}>
          <span style={styles.label}>{t('new.prompt')}</span>
          <textarea style={styles.input} rows={4} value={prompt} onChange={(event) => { setPrompt(event.target.value) }} />
        </div>
        <div style={styles.editorActions}>
          <button type="button" style={styles.button} onClick={onClose}>{t('new.cancel')}</button>
          <button type="button" style={{ ...styles.button, ...styles.buttonPrimary }} onClick={save}>{t('new.save')}</button>
        </div>
      </div>
    </div>
  )
}
