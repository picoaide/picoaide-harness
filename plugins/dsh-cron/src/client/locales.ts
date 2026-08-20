/**
 * Cron plugin UI copy: zh is the key source, en mirrors the full key set.
 */
export const zh = {
  'settings.title': '定时任务',
  'settings.enabled': '启用定时任务',
  'settings.enabledDesc': '关闭后调度器停止触发，已配置的任务保留。',
  'settings.announce': '向 Agent 公告插件能力',
  'settings.announceDesc': '在系统提示词中声明定时任务能力，模型可据此协作。',
  'settings.catchUp': '补跑错过的触发',
  'settings.catchUpDesc': '应用重启或系统休眠恢复后，为每个到期任务补跑最近一次错过的触发（默认跳过）。',
  'settings.hostMeta': 'Host 时区 {timeZone} · 修订 {revision}',
  'job.listTitle': '定时任务',
  'job.empty': '暂无定时任务',
  'job.new': '新建任务',
  'job.name': '名称',
  'job.cron': 'Cron 表达式',
  'job.cronInvalid': 'cron 表达式无效',
  'job.enabled': '启用',
  'job.disabled': '已停用',
  'job.nextRun': '下次运行',
  'job.notScheduled': '未调度',
  'job.lastTriggered': '上次触发',
  'job.never': '从未',
  'job.delete': '删除',
  'job.run': '立即执行',
  'job.actionTask': '执行任务',
  'job.actionPrompt': '发送消息',
  'job.workspace': '项目',
  'job.workspaceCurrent': '当前项目（默认）',
  'job.taskId': '任务',
  'job.taskSelect': '选择任务…',
  'job.sessionId': '会话 ID',
  'job.promptText': '消息内容',
  'job.save': '保存',
  'job.cancel': '取消',
  'job.history': '触发历史',
  'job.execution.succeeded': '成功',
  'job.execution.failed': '失败',
  'job.execution.cancelled': '已取消',
  'job.execution.pending': '执行中',
  'preset.daily9': '每天 09:00',
  'preset.hourly': '每小时',
  'preset.tenMin': '每 10 分钟',
  'preset.weeklyMon9': '每周一 09:00',
  'board.close': '返回聊天',
} as const

export type CronKey = keyof typeof zh

export const en: Record<CronKey, string> = {
  'settings.title': 'Scheduled jobs',
  'settings.enabled': 'Enable scheduled jobs',
  'settings.enabledDesc': 'Disabling stops the scheduler; configured jobs are kept.',
  'settings.announce': 'Announce to agents',
  'settings.announceDesc': 'Declares the scheduler capability in the system prompt so models can collaborate.',
  'settings.catchUp': 'Catch up missed triggers',
  'settings.catchUpDesc': 'After a restart or resume, fire the single most recent missed trigger per due job (default: skip).',
  'settings.hostMeta': 'Host timezone {timeZone} · revision {revision}',
  'job.listTitle': 'Scheduled jobs',
  'job.empty': 'No scheduled jobs',
  'job.new': 'New job',
  'job.name': 'Name',
  'job.cron': 'Cron expression',
  'job.cronInvalid': 'Invalid cron expression',
  'job.enabled': 'Enabled',
  'job.disabled': 'Disabled',
  'job.nextRun': 'Next run',
  'job.notScheduled': 'Not scheduled',
  'job.lastTriggered': 'Last triggered',
  'job.never': 'Never',
  'job.delete': 'Delete',
  'job.run': 'Run now',
  'job.actionTask': 'Run a task',
  'job.actionPrompt': 'Send a message',
  'job.workspace': 'Project',
  'job.workspaceCurrent': 'Current project (default)',
  'job.taskId': 'Task',
  'job.taskSelect': 'Select a task…',
  'job.sessionId': 'Session ID',
  'job.promptText': 'Message text',
  'job.save': 'Save',
  'job.cancel': 'Cancel',
  'job.history': 'Trigger history',
  'job.execution.succeeded': 'Succeeded',
  'job.execution.failed': 'Failed',
  'job.execution.cancelled': 'Cancelled',
  'job.execution.pending': 'Running',
  'preset.daily9': 'Daily 09:00',
  'preset.hourly': 'Hourly',
  'preset.tenMin': 'Every 10 minutes',
  'preset.weeklyMon9': 'Monday 09:00',
  'board.close': 'Back to chat',
}

/** Translate a key with optional {name} params. */
export function t(key: CronKey, params?: Record<string, string>): string {
  let text: string = (zh[key] ?? key) as string
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}
