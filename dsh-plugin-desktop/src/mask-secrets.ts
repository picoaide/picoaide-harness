/** Mask secret-shaped substrings in a rendered log line. */

const MASK = '****'

/** Secret-shaped patterns applied in order to a rendered log line. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{12,}/gu, // OpenAI/DeepSeek-style sk- keys
  /\b[a-zA-Z0-9]{32,}\b/gu, // long hex/base64 tokens
  /Bearer\s+[A-Za-z0-9._-]+/giu, // Authorization bearer tokens
]

/** Replace secret-shaped substrings, preserving a short leading prefix. */
export function maskSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      if (match.startsWith('Bearer')) return 'Bearer ****'
      return `${match.slice(0, 3)}${MASK}`
    })
  }
  return out
}
