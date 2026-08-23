/**
 * Execution result vocabulary shared by the task ledger and the runner.
 */
export type ExecutionResult = 'succeeded' | 'failed' | 'cancelled'

export function isExecutionResult(value: unknown): value is ExecutionResult {
  return value === 'succeeded' || value === 'failed' || value === 'cancelled'
}
