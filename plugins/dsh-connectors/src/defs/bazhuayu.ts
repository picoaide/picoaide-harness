import type { ConnectorDef } from '../types.ts'

/** 八爪鱼 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "bazhuayu",
  "name": "八爪鱼",
  "description": "用自然语言驱动八爪鱼云采集：搜索模板、启动任务、查询进度、导出结构化数据，并管理已有任务。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.bazhuayu.com?includeTools=search_templates,execute_task,get_task_status,export_data,search_tasks,start_or_stop_task",
    "clientId": "",
    "authorizeUrl": "",
    "tokenUrl": "",
    "redirectUri": "http://127.0.0.1/callback",
    "pkce": true,
    "publicClient": true,
    "scopes": "offline_access"
  },
  "mcp": [
    {
      "serverName": "bazhuayu",
      "transport": "streamable-http",
      "url": "https://mcp.bazhuayu.com?includeTools=search_templates,execute_task,get_task_status,export_data,search_tasks,start_or_stop_task"
    }
  ]
}
