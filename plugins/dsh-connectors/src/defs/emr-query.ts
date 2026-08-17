import type { ConnectorDef } from '../types.ts'

/** 弹性MapReduce connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "emr-query",
  "name": "弹性MapReduce",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "tccli",
    "args": [
      "auth",
      "login"
    ],
    "installCommand": "python -m pip install --upgrade tccli",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "tccli",
    "statusArgs": [
      "emr",
      "DescribeInstancesList",
      "--region",
      "ap-guangzhou",
      "--version",
      "2019-01-03",
      "--cli-unfold-argument",
      "--DisplayStrategy",
      "clusterList",
      "--Limit",
      "1",
      ">/dev/null",
      "2>&1",
      "&&",
      "echo",
      "'Authenticated",
      "and",
      "EMR",
      "accessible'",
      "||",
      "(echo",
      "'Not",
      "authenticated",
      "or",
      "no",
      "EMR",
      "access'",
      ">&2;",
      "exit",
      "1)"
    ]
  },
  "mcp": []
}
