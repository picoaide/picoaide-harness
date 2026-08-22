/**
 * Task context assembly: builds the full prompt injected into the execution
 * session. The session is a fresh conversation inside the pinned project
 * (workspace); the first message carries the task's full context (title,
 * description, project, permission, timestamps) plus the user's prompt, so
 * the agent executes with the same understanding the board shows — and the
 * execution record persists the exact injected text for post-run review.
 */
import type { TaskRecord } from './tasks.ts';
/** Build the model-facing task context block (stable, deterministic prose). */
export declare function buildTaskPrompt(task: TaskRecord): string;
