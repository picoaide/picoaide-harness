package telemetry

import (
	"sync"
	"time"
)

// callLimiter 是技能调用上报的滑动窗口计数器(P2-20):键 = 用户 / 用户+技能,
// 有界表 + 惰性清扫。与 serverauth.loginLimiter 同算法(该类型未导出,且
// serverauth 不在本包可改范围,故此处按同一形态本地实现)。
type callLimiter struct {
	mu        sync.Mutex
	hits      map[string][]time.Time
	window    time.Duration
	maxKeys   int
	lastSweep time.Time
}

func newCallLimiter(window time.Duration) *callLimiter {
	if window <= 0 {
		window = time.Minute
	}
	return &callLimiter{hits: map[string][]time.Time{}, window: window, maxKeys: 10000}
}

// allow 记录一次上报,返回是否仍在 limit 以内(limit <= 0 = 不限)。
// 表满时淘汰窗口起点最早的键,避免填表 DoS 让所有人都被拒。
func (l *callLimiter) allow(key string, limit int) bool {
	if limit <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.window)

	if now.Sub(l.lastSweep) >= time.Minute {
		for k, ts := range l.hits {
			kept := ts[:0]
			for _, t := range ts {
				if t.After(cutoff) {
					kept = append(kept, t)
				}
			}
			if len(kept) == 0 {
				delete(l.hits, k)
			} else {
				l.hits[k] = kept
			}
		}
		l.lastSweep = now
	}

	ts := l.hits[key]
	kept := ts[:0]
	for _, t := range ts {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= limit {
		l.hits[key] = kept
		return false
	}
	if _, exists := l.hits[key]; !exists && len(l.hits) >= l.maxKeys {
		var victim string
		var oldest time.Time
		for k, v := range l.hits {
			if len(v) > 0 && (victim == "" || v[0].Before(oldest)) {
				victim, oldest = k, v[0]
			}
		}
		delete(l.hits, victim)
	}
	l.hits[key] = append(kept, now)
	return true
}
