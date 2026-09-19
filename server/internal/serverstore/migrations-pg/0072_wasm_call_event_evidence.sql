-- 0072: WASM 调用事件 —— 落库"失败分类依据"（evidence）(2026-09-19)。
--
-- 触发（第三轮对抗审计 P3-1）：`oom_evidence` 与命中的运行时 OOM 特征行此前只写进
-- **瞬时**错误信封（runtime/errors.go 的 details），`wasm_call_events` 里没有对应列。
-- 后果是事后在诊断页/AI 上看到的正是"平台记录反过来证明不是内存问题"那幅自相矛盾的画面：
--
--   reason_code=RUNTIME_MEMORY + peak_memory_bytes=3407872（= 上限的 5.1%）
--   + stderr_tail 全是 goroutine 回溯（特征行早被挤掉）
--
-- 且**无法分辨**"真 OOM / 普通 panic 误报 / 应用自己打印的同名文本"三种形态。
--
-- 为什么加列而不是复用既有列：诊断面的其余列都是**计量数值**（cpu_ms/peak_memory_bytes/
-- host_call_count/…）或 guest 原文（stderr_tail 是"尾巴"语义，前插证据会破坏它的定义）。
-- 分类依据是一个**结构化单行文本**（kind=…; peak=…; limit=…; exit=…; line="…"），
-- 语义与任何既有列都不重合，因此按追加式迁移加一列。
--
-- 列语义与约束：
--   * 有界：写入侧保证 ≤ capapi.MaxEvidenceBytes（200 B，与错误信封里的证据行同口径），
--     events 落库前再按 headUTF8 截一次；列本身不加 CHECK（诊断是旁路，宁可有界存下来
--     也不要因为一侧没夹紧就让整批 INSERT 失败）。
--   * 可空语义：''（默认）= 这次失败没有留下结构化依据（0072 之前的历史行、或本身
--     不需要依据的错误码）——**不是** NULL，与其余 TEXT 列同风格（NOT NULL DEFAULT ''）。
--   * 不进哈希链（wasm_call_events 本就独立于 audit_logs 的链，见 0069 文件头）。
--
-- 幂等可重放（IF NOT EXISTS），与既有迁移同风格。

ALTER TABLE wasm_call_events ADD COLUMN IF NOT EXISTS evidence TEXT NOT NULL DEFAULT '';

-- 自检：列必须真的可读写（fail-loud，而不是"看起来加上了、其实写到别处"）。
DO $wasm_call_event_evidence_check$
DECLARE
  probe_id BIGINT;
BEGIN
  INSERT INTO wasm_call_events (app_id, user_id, outcome, reason_code, evidence)
  VALUES ('__migration_0072_probe__', 0, 'killed', 'RUNTIME_MEMORY', 'kind=probe')
  RETURNING id INTO probe_id;
  IF (SELECT evidence FROM wasm_call_events WHERE id = probe_id) <> 'kind=probe' THEN
    RAISE EXCEPTION '0072: wasm_call_events.evidence 写入后读不回（列未生效）';
  END IF;
  DELETE FROM wasm_call_events WHERE id = probe_id;
END
$wasm_call_event_evidence_check$;
