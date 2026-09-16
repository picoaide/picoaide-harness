package serverstore

import (
	"testing"
	"time"
)

func TestRecordConcurrencySampleAndPeaks(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)

	// 同日多次采样:峰值只增不减(GREATEST),时间取首次触发峰值
	if err := RecordConcurrencySample(db, "deepseek-v4-flash", 100, now); err != nil {
		t.Fatal(err)
	}
	if err := RecordConcurrencySample(db, "deepseek-v4-flash", 2500, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := RecordConcurrencySample(db, "deepseek-v4-flash", 1800, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// 另一模型
	if err := RecordConcurrencySample(db, "deepseek-v4-pro", 400, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	// 服务器信息页的生产入口是 PeakConcurrencyByModel(返回 model→峰值;
	// 富字段版 ModelConcurrencyPeaks 已随死代码删除,展示层不再消费排序)。
	peaks, err := PeakConcurrencyByModel(db, now.AddDate(0, 0, -90))
	if err != nil {
		t.Fatal(err)
	}
	if len(peaks) != 2 {
		t.Fatalf("peaks = %d models, want 2", len(peaks))
	}
	// 同日多次采样只保留最大值(GREATEST):flash 的 100/2500/1800 收敛到 2500。
	if peaks["deepseek-v4-flash"] != 2500 || peaks["deepseek-v4-pro"] != 400 {
		t.Errorf("peaks = %v, want flash=2500 pro=400", peaks)
	}
}

func TestPeakConcurrencyByModel(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	now := time.Now().UTC()
	_ = RecordConcurrencySample(db, "m1", 5, now)
	_ = RecordConcurrencySample(db, "m2", 9, now)

	peaks, err := PeakConcurrencyByModel(db, now.AddDate(0, 0, -90))
	if err != nil {
		t.Fatal(err)
	}
	if peaks["m1"] != 5 || peaks["m2"] != 9 {
		t.Errorf("peaks = %v, want m1=5 m2=9", peaks)
	}
}
