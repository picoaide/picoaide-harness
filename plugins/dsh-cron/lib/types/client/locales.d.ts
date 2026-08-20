/**
 * Cron plugin UI copy: zh is the key source, en mirrors the full key set.
 */
export declare const zh: {
    readonly 'settings.title': "定时任务";
    readonly 'settings.enabled': "启用定时任务";
    readonly 'settings.enabledDesc': "关闭后调度器停止触发，已配置的任务保留。";
    readonly 'settings.announce': "向 Agent 公告插件能力";
    readonly 'settings.announceDesc': "在系统提示词中声明定时任务能力，模型可据此协作。";
    readonly 'settings.catchUp': "补跑错过的触发";
    readonly 'settings.catchUpDesc': "应用重启或系统休眠恢复后，为每个到期任务补跑最近一次错过的触发（默认跳过）。";
    readonly 'settings.hostMeta': "Host 时区 {timeZone} · 修订 {revision}";
    readonly 'job.listTitle': "定时任务";
    readonly 'job.empty': "暂无定时任务";
    readonly 'job.new': "新建任务";
    readonly 'job.name': "名称";
    readonly 'job.cron': "Cron 表达式";
    readonly 'job.cronInvalid': "cron 表达式无效";
    readonly 'job.enabled': "启用";
    readonly 'job.disabled': "已停用";
    readonly 'job.nextRun': "下次运行";
    readonly 'job.notScheduled': "未调度";
    readonly 'job.lastTriggered': "上次触发";
    readonly 'job.never': "从未";
    readonly 'job.delete': "删除";
    readonly 'job.run': "立即执行";
    readonly 'job.actionTask': "执行任务";
    readonly 'job.actionPrompt': "发送消息";
    readonly 'job.workspace': "项目";
    readonly 'job.workspaceCurrent': "当前项目（默认）";
    readonly 'job.taskId': "任务";
    readonly 'job.taskSelect': "选择任务…";
    readonly 'job.nameRequired': "请填写任务名称";
    readonly 'job.taskIdRequired': "请选择要执行的任务";
    readonly 'job.sessionIdRequired': "请填写会话 ID";
    readonly 'job.promptTextRequired': "请填写消息内容";
    readonly 'job.sessionId': "会话 ID";
    readonly 'job.promptText': "消息内容";
    readonly 'job.save': "保存";
    readonly 'job.cancel': "取消";
    readonly 'job.history': "触发历史";
    readonly 'job.deleteConfirm': "确定删除该定时任务吗？";
    readonly 'job.showHistory': "展开触发历史";
    readonly 'job.hideHistory': "收起触发历史";
    readonly 'job.execution.succeeded': "成功";
    readonly 'job.execution.failed': "失败";
    readonly 'job.execution.cancelled': "已取消";
    readonly 'job.execution.pending': "执行中";
    readonly 'preset.daily9': "每天 09:00";
    readonly 'preset.hourly': "每小时";
    readonly 'preset.tenMin': "每 10 分钟";
    readonly 'preset.weeklyMon9': "每周一 09:00";
    readonly 'board.close': "返回聊天";
};
export type CronKey = keyof typeof zh;
export declare const en: Record<CronKey, string>;
/** Translate a key with optional {name} params. */
export declare function t(key: CronKey, params?: Record<string, string>): string;
