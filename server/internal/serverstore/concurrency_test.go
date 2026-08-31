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

	peaks, err := ModelConcurrencyPeaks(db, now.AddDate(0, 0, -90))
	if err != nil {
		t.Fatal(err)
	}
	if len(peaks) != 2 {
		t.Fatalf("peaks = %d models, want 2", len(peaks))
	}
	// 排序:按 90 天峰值降序 → flash(2500) 在前
	if peaks[0].Model != "deepseek-v4-flash" || peaks[0].Peak90Day != 2500 {
		t.Errorf("flash peak = %+v, want peak 2500", peaks[0])
	}
	if peaks[1].Model != "deepseek-v4-pro" || peaks[1].Peak90Day != 400 {
		t.Errorf("pro peak = %+v, want peak 400", peaks[1])
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
