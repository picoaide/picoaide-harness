import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DesktopDirectoryPickerResponse } from './directory-picker-contract.ts'

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/** Validate and serve one native directory-picker request from the desktop renderer. */
export async function handleDesktopDirectoryPickerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  pickDirectory: () => Promise<string | null>,
  reportError: (cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' })
  // 同源 POST 也允许无 Origin(本地脚本/非浏览器客户端);跨站请求无法隐藏 Origin。
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  try {
    const response: DesktopDirectoryPickerResponse = { path: await pickDirectory() }
    finishJson(res, 200, response)
  } catch (cause: unknown) {
    reportError(cause)
    finishJson(res, 500, { error: 'native directory picker failed' })
  }
}
