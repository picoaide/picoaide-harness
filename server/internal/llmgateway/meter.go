package llmgateway

import (
	"sync"
	"sync/atomic"
)

// concurrencyMeter 按模型统计 in-flight 请求数(发起→结束,含流式)。
// 非 QPS:并发 = 同时活跃的请求条数。
// 请求在模型确认后 begin(返回 done 闭包,defer 执行),所有退出路径均减。
//
// 实现说明:entry 一旦创建即永久留在 map(模型数量 ≤ 数百,无内存风险)。
// 不做"归零删除"——删除与 begin 存在竞态(见历史):A done 读到 0 删除
// entry 时,B begin 已从 map 拿到同一指针并在 +1,导致快照短暂漏计该模型。
// 减少的代价是 map 保留所有出现过的模型(含已不用的),可接受。
type concurrencyMeter struct {
	mu     sync.Mutex
	counts map[string]*int64
}

func newConcurrencyMeter() *concurrencyMeter {
	return &concurrencyMeter{counts: map[string]*int64{}}
}

// begin 记录某模型一个请求开始,返回 done(幂等,必须恰好调用一次;
// defer 保证 panic 也减计数)。
func (m *concurrencyMeter) begin(model string) func() {
	m.mu.Lock()
	c := m.counts[model]
	if c == nil {
		c = new(int64)
		m.counts[model] = c
	}
	m.mu.Unlock()
	atomic.AddInt64(c, 1)
	var once sync.Once
	return func() {
		once.Do(func() {
			atomic.AddInt64(c, -1)
		})
	}
}

// snapshot 返回各模型当前 in-flight 数(无请求的模型不在结果中,或为 0 时
// 过滤——活跃请求模型才返回)。
func (m *concurrencyMeter) snapshot() map[string]int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]int64, len(m.counts))
	for k, v := range m.counts {
		if n := atomic.LoadInt64(v); n > 0 {
			out[k] = n
		}
	}
	return out
}
