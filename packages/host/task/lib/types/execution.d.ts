/**
 * Execution result vocabulary shared by the task ledger and the runner.
 */
export type ExecutionResult = 'succeeded' | 'failed' | 'cancelled';
export declare function isExecutionResult(value: unknown): value is ExecutionResult;
