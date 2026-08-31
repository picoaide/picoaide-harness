package llmgateway

import (
	"sync"
	"testing"
)

func TestConcurrencyMeterBeginDone(t *testing.T) {
	m := newConcurrencyMeter()
	d1 := m.begin("deepseek-v4-flash")
	d2 := m.begin("deepseek-v4-flash")
	d3 := m.begin("deepseek-v4-pro")

	snap := m.snapshot()
	if snap["deepseek-v4-flash"] != 2 {
		t.Errorf("flash in-flight = %d, want 2", snap["deepseek-v4-flash"])
	}
	if snap["deepseek-v4-pro"] != 1 {
		t.Errorf("pro in-flight = %d, want 1", snap["deepseek-v4-pro"])
	}

	d1()
	d2()
	snap = m.snapshot()
	if _, ok := snap["deepseek-v4-flash"]; ok {
		t.Error("flash should be absent from snapshot after all done (0 filtered)")
	}
	d3()
	if len(m.snapshot()) != 0 {
		t.Errorf("all done, snapshot = %v, want empty", m.snapshot())
	}
}

func TestConcurrencyMeterDoubleDoneIdempotent(t *testing.T) {
	m := newConcurrencyMeter()
	done := m.begin("m")
	done()
	done() // 幂等:第二次不得减到负数
	if n := m.snapshot()["m"]; n != 0 {
		t.Errorf("in-flight = %d, want 0", n)
	}
}

func TestConcurrencyMeterConcurrentStress(t *testing.T) {
	m := newConcurrencyMeter()
	var wg sync.WaitGroup
	const n = 500
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			done := m.begin("stress-model")
			done()
		}()
	}
	wg.Wait()
	if len(m.snapshot()) != 0 {
		t.Errorf("after stress, snapshot = %v, want empty", m.snapshot())
	}
}

func TestConcurrencyMeterSnapshotNoNegative(t *testing.T) {
	m := newConcurrencyMeter()
	done := m.begin("m")
	done()
	done() // 防御:重复 done 后 snapshot 不得出现负数
	for _, v := range m.snapshot() {
		if v < 0 {
			t.Errorf("negative in-flight: %d", v)
		}
	}
}
