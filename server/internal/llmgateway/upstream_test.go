package llmgateway

import (
	"fmt"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestLoadUpstreamsSkipsBrokenProvider: one provider with an undecryptable
// key must not abort the whole gateway; the healthy provider still loads.
func TestLoadUpstreamsSkipsBrokenProvider(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled) VALUES ('good', 'https://a', 'decryptable', '["m1"]', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled) VALUES ('bad', 'https://b', 'broken', '["m2"]', 1)`); err != nil {
		t.Fatal(err)
	}

	orig := DecryptSecret
	DecryptSecret = func(s string) (string, error) {
		if s == "broken" {
			return "", fmt.Errorf("cannot decrypt")
		}
		return s, nil
	}
	t.Cleanup(func() { DecryptSecret = orig })

	ups, err := LoadUpstreams(db)
	if err != nil {
		t.Fatalf("LoadUpstreams = %v, want nil", err)
	}
	if len(ups) != 1 || ups[0].Name != "good" {
		t.Fatalf("ups = %+v, want only the good provider", ups)
	}
	if len(ups[0].Models) != 1 || ups[0].Models[0] != "m1" {
		t.Fatalf("models = %v", ups[0].Models)
	}
}
