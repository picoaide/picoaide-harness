import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DesktopDirectoryPickerResponse } from './directory-picker-contract.ts'
import { acceptWriteProof, type WriteProofDeps } from './write-proof.ts'

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/**
 * Validate and serve one native directory-picker request from the desktop renderer.
 *
 * R4-RV3a：这是本机原生对话框的写面入口，除 Origin 检查外还要一份 BrowserAuth
 * 持有性证明；`proof` 未接线 ⇒ fail-closed（见 `write-proof.ts`）。
 */
export async function handleDesktopDirectoryPickerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  pickDirectory: () => Promise<string | null>,
  proof: WriteProofDeps | undefined,
  reportError: (cause: unknown) => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' })
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  if (!acceptWriteProof(req, res, proof)) return
  try {
    const response: DesktopDirectoryPickerResponse = { path: await pickDirectory() }
    finishJson(res, 200, response)
  } catch (cause: unknown) {
    reportError(cause)
    finishJson(res, 500, { error: 'native directory picker failed' })
  }
}
