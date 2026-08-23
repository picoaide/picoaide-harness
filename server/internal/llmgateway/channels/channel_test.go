package channels

import (
	"context"
	"testing"
)

type stubChannel struct{ name, base string }

func (s stubChannel) Name() string    { return s.name }
func (s stubChannel) BaseURL() string { return s.base }
func (s stubChannel) FetchModels(ctx context.Context, apiKey string, fetchFn func(url string) ([]byte, error)) ([]ModelInfo, error) {
	return []ModelInfo{{ID: "m1"}}, nil
}
func (s stubChannel) RequestOverrides(modelID string) (map[string]any, []string) {
	return map[string]any{"thinking": map[string]any{"type": "enabled"}}, []string{"temperature"}
}
func (s stubChannel) DefaultModelCaps() (int64, int64) { return 1048576, 393216 }

func TestRegistryLookup(t *testing.T) {
	Register(stubChannel{name: "stub", base: "http://stub"})
	if _, ok := Get("stub"); !ok {
		t.Fatal("Get(stub) not found")
	}
	if _, ok := Get("nope"); ok {
		t.Fatal("Get(nope) should be missing")
	}
	if len(All()) == 0 {
		t.Fatal("All() empty")
	}
}

func TestParseOAIModels(t *testing.T) {
	body := []byte(`{"object":"list","data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`)
	ms, err := ParseOAIModels(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].ID != "deepseek-v4-flash" || ms[0].DisplayName != "deepseek-v4-flash" {
		t.Fatalf("models = %+v", ms)
	}
}

func TestDeepSeekFetchModels(t *testing.T) {
	fetchFn := func(url string) ([]byte, error) {
		if url != "https://api.deepseek.com/models" {
			t.Fatalf("url = %s", url)
		}
		return []byte(`{"object":"list","data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	ds, ok := Get("deepseek")
	if !ok {
		t.Fatal("Get(deepseek) not found")
	}
	ms, err := ds.FetchModels(context.Background(), "k", fetchFn)
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].ID != "deepseek-v4-flash" || ms[1].ID != "deepseek-v4-pro" {
		t.Fatalf("models = %+v", ms)
	}
}

func TestDeepSeekOverrides(t *testing.T) {
	ds, ok := Get("deepseek")
	if !ok {
		t.Fatal("Get(deepseek) not found")
	}
	ov, rm := ds.RequestOverrides("deepseek-v4-flash")
	if ov["reasoning_effort"] != "max" {
		t.Fatalf("reasoning_effort = %v", ov["reasoning_effort"])
	}
	thinking, _ := ov["thinking"].(map[string]any)
	if thinking["type"] != "enabled" {
		t.Fatalf("thinking = %v", ov["thinking"])
	}
	want := map[string]bool{"temperature": true, "top_p": true, "presence_penalty": true, "frequency_penalty": true}
	if len(rm) != 4 {
		t.Fatalf("removeKeys = %v", rm)
	}
	for _, k := range rm {
		if !want[k] {
			t.Fatalf("unexpected removeKey %q", k)
		}
	}
}

func TestDeepSeekCaps(t *testing.T) {
	ds, ok := Get("deepseek")
	if !ok {
		t.Fatal("Get(deepseek) not found")
	}
	cl, mo := ds.DefaultModelCaps()
	if cl != 1048576 || mo != 393216 {
		t.Fatalf("caps = %d/%d", cl, mo)
	}
}
