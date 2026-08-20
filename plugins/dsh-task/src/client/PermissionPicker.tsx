/**
 * Permission-preset picker shared by the new-task modal and the task detail
 * editor. The presets map to the official `/permission` command vocabulary
 * (read-only / workspace-write / danger-full-access). The unattended hint
 * steers scheduled/background runs to `danger-full-access` (approval: never),
 * which never blocks on an approval prompt nobody is there to answer.
 */
import { styles } from './styles.ts'
import { t, type TaskKey } from './locales.ts'

export const PERMISSION_OPTIONS: ReadonlyArray<{ value: string; label: TaskKey }> = [
  { value: '', label: 'permission.none' },
  { value: 'read-only', label: 'permission.read-only' },
  { value: 'workspace-write', label: 'permission.workspace-write' },
  { value: 'danger-full-access', label: 'permission.danger-full-access' },
]

export function PermissionPicker({ value, onChange }: {
  value: string
  onChange: (permission: string) => void
}): JSX.Element {
  return (
    <div style={styles.field}>
      <span style={styles.label}>{t('detail.permission')}</span>
      <select style={styles.input} value={value} onChange={(event) => { onChange(event.target.value) }}>
        {PERMISSION_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>{t(option.label)}</option>
        ))}
      </select>
      {value === 'danger-full-access' && <span style={styles.rowDesc}>{t('permission.unattended')}</span>}
    </div>
  )
}
