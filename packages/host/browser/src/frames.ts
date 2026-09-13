/**
 * Frame index for `browser_eval`'s `frame: N` (R-4, 2026-09-13).
 *
 * The number the model passes is a **DOM position** ("1 = first subframe"):
 * that is the only numbering the model can reason about, because that is what
 * it sees when it looks at a page (`document.querySelectorAll('iframe')` order,
 * the order the frames appear in a screenshot, the order `browser_get_snapshot`
 * lists the surrounding document).
 *
 * `Page.getFrameTree` does NOT answer that question on a site-isolated page.
 * Verified on Electron 43.4.0 / Chromium 150 with real CDP (probe
 * `tests/probes/frame-index-probe.mjs`): a page whose FIRST iframe is
 * cross-origin (`http://localhost:B/pay`) and whose SECOND is same-process
 * (`about:srcdoc`) reports a frame tree with exactly one child — the srcdoc
 * one. Indexing that array made `frame: 1` silently mean the *second* iframe,
 * i.e. the model was handed a different frame than it asked for. Silent
 * mis-targeting is the defect; this module makes the index provably 1:1 with
 * the DOM or refuses.
 *
 * Reconciliation rules (all of them fail loud, never "closest match"):
 * - every frame owner in a document (`iframe`/`frame`) must be accounted for by
 *   a reachable frame (same-process frame tree child, or an out-of-process
 *   iframe attached as a flat CDP target);
 * - the URL lists must line up position by position, so duplicate-URL iframes
 *   are only accepted when the reachable set carries the same duplicates;
 * - anything left over — a frame owner with no reachable frame, a reachable
 *   frame with no owner, an ambiguous pairing — is reported as a
 *   {@link FrameOrderProblem} and turned into a fail-loud tool error.
 * @module @picoaide/dsh-browser
 */

/** CDP's address for a `srcdoc` frame (`iframe.srcdoc` has no URL of its own). */
export const SRCDOC_URL = 'about:srcdoc'

/** One reachable frame (frame-tree child or attached out-of-process target). */
export interface FrameCandidate {
  /** CDP frame id (authoritative; the OOPIF target's own `Page.getFrameTree`). */
  frameId: string
  url: string
  /** Flat CDP session id when the frame lives in its own process. */
  sessionId?: string
}

/** Why a document's frame owners cannot be mapped 1:1 onto reachable frames. */
export interface FrameOrderProblem {
  /** Frame-owner URLs in DOM order, as `document.querySelectorAll` sees them. */
  domUrls: string[]
  /** URLs of the frames CDP can actually reach, in the order CDP reported. */
  reachableUrls: string[]
  /** Human-readable cause of the mismatch (model-facing error text). */
  reason: string
  /** Nesting level of the document the mismatch was found in (0 = top). */
  depth?: number
}

/**
 * Order `candidates` to match the DOM owner order of `domUrls`.
 *
 * Pass 1 pairs URL against URL (the frame owner's `src` with the reachable
 * frame's URL). Whatever is left over is paired **only when the leftovers are
 * a single DOM owner and a single frame**: that pairing is forced by
 * elimination, so it is still provable, and it is what a redirecting frame
 * needs — the owner keeps `src="/redir"` while CDP reports the frame's final
 * URL. Two or more leftovers on either side are ambiguous and refused.
 *
 * @returns the candidates in DOM order, or a {@link FrameOrderProblem} when the
 *   two sets cannot be paired unambiguously.
 */
export function orderFramesByDom(
  domUrls: readonly string[],
  candidates: readonly FrameCandidate[],
): FrameCandidate[] | FrameOrderProblem {
  const problem = (reason: string): FrameOrderProblem => ({
    domUrls: [...domUrls],
    reachableUrls: candidates.map((candidate) => candidate.url),
    reason,
  })
  if (domUrls.length !== candidates.length) {
    return problem(`${domUrls.length} frame element(s) in the document but ${candidates.length} reachable frame(s)`)
  }
  const taken = new Array<boolean>(candidates.length).fill(false)
  const ordered: Array<FrameCandidate | undefined> = new Array(domUrls.length).fill(undefined)
  const leftovers: number[] = []
  for (const [position, url] of domUrls.entries()) {
    const hit = candidates.findIndex((candidate, index) => !taken[index] && candidate.url === url)
    if (hit < 0) {
      leftovers.push(position)
      continue
    }
    taken[hit] = true
    ordered[position] = candidates[hit]
  }
  const freeCandidates = candidates.filter((_candidate, index) => !taken[index])
  if (leftovers.length === 1 && freeCandidates.length === 1) {
    const position = leftovers[0]!
    ordered[position] = freeCandidates[0]
  } else if (leftovers.length > 0) {
    const urls = leftovers.map((position) => JSON.stringify(domUrls[position])).join(', ')
    const reachable = freeCandidates.map((candidate) => JSON.stringify(candidate.url)).join(', ')
    return problem(
      leftovers.length === freeCandidates.length
        ? `cannot pair frame element(s) ${urls} with the reachable frame(s) ${reachable || '(none)'} unambiguously`
        : `frame element(s) ${urls} have no reachable frame (unpaired reachable: ${reachable || 'none'})`,
    )
  }
  return ordered.map((candidate) => candidate!)
}

/** True when `value` is a {@link FrameOrderProblem} rather than an order. */
export function isFrameOrderProblem(value: FrameCandidate[] | FrameOrderProblem): value is FrameOrderProblem {
  return !Array.isArray(value)
}

/**
 * Model-facing error text for an index that cannot be proven 1:1.
 *
 * Deliberately explicit about the cause: "the page has an out-of-process
 * (cross-origin) frame that the frame index cannot place" is actionable (use
 * the main frame, a snapshot or a selector), while a silent off-by-one is not.
 */
export function frameOrderErrorMessage(problem: FrameOrderProblem): string {
  const depth = problem.depth ?? 0
  const where = depth === 0 ? 'this page' : `subframe #${depth}`
  return `browser: frame index is not reliable for ${where} — ${problem.reason}; `
    + 'cross-origin (out-of-process) frames and frames CDP cannot pair with a DOM position are refused '
    + 'rather than guessed. Use frame 0, browser_get_snapshot or browser_get_text instead.'
}