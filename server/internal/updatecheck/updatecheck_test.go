package updatecheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckUpdateAvailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/json" {
			t.Errorf("unexpected Accept header: %q", r.Header.Get("Accept"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"v2.6.0","html_url":"https://github.com/picoaide/picoaide-harness/releases/tag/v2.6.0"}`))
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), "2.5.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Latest != "2.6.0" {
		t.Errorf("Latest = %q, want 2.6.0", res.Latest)
	}
	if !res.UpdateAvailable {
		t.Error("UpdateAvailable = false, want true")
	}
	if res.Current != "2.5.1" {
		t.Errorf("Current = %q, want 2.5.1", res.Current)
	}
	if res.ReleaseURL != "https://github.com/picoaide/picoaide-harness/releases/tag/v2.6.0" {
		t.Errorf("ReleaseURL = %q", res.ReleaseURL)
	}
	if res.CheckedAt == "" {
		t.Error("CheckedAt empty")
	}
}

func TestCheckUpToDate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v2.5.1"}`))
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), "2.5.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.UpdateAvailable {
		t.Error("UpdateAvailable = true, want false")
	}
	if res.Latest != "2.5.1" {
		t.Errorf("Latest = %q, want 2.5.1", res.Latest)
	}
}

func TestCheckUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	_, err := c.Check(context.Background(), "2.5.1")
	if err == nil {
		t.Fatal("expected error for 500 response, got nil")
	}
	if !strings.Contains(err.Error(), ErrUnavailable.Error()) {
		t.Errorf("error %v should wrap ErrUnavailable", err)
	}
}

func TestCheckInvalidTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"not-a-version"}`))
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	_, err := c.Check(context.Background(), "2.5.1")
	if err == nil {
		t.Fatal("expected error for invalid tag, got nil")
	}
}

func TestDevCurrentNeverUpdates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v99.0.0"}`))
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), "dev")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.UpdateAvailable {
		t.Error("dev build should never report update available")
	}
}

func TestCompareSemVer(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"2.5.1", "2.5.1", 0},
		{"2.5.1", "2.5.2", -1},
		{"2.5.2", "2.5.1", 1},
		{"2.5.9", "2.6.0", -1},
		{"2.9.0", "2.10.0", -1},
		{"2.10.0", "2.9.0", 1},
		{"10.0.0", "9.9.9", 1},
		{"1.0.0", "v1.0.0", 0}, // v prefix stripped
		{"dev", "2.5.1", 0},    // invalid → equal
	}
	for _, tc := range cases {
		if got := CompareSemVer(tc.left, tc.right); got != tc.want {
			t.Errorf("CompareSemVer(%q, %q) = %d, want %d", tc.left, tc.right, got, tc.want)
		}
	}
}

func TestIsStableSemVer(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"2.5.1", true},
		{"2.5.1-rc.1", false},
		{"2.5", false},
		{"2.5.1.4", false},
		{"02.5.1", false},
		{"2.5.01", false},
		{"", false},
		{"v2.5.1", true},
		{"2.5.1+build", true},
	}
	for _, tc := range cases {
		if got := IsStableSemVer(tc.in); got != tc.want {
			t.Errorf("IsStableSemVer(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestParseCanonicalStable(t *testing.T) {
	if got := ParseCanonicalStable("v2.5.1"); got != "2.5.1" {
		t.Errorf("ParseCanonicalStable(v2.5.1) = %q", got)
	}
	if got := ParseCanonicalStable("2.5.1"); got != "2.5.1" {
		t.Errorf("ParseCanonicalStable(2.5.1) = %q", got)
	}
	if got := ParseCanonicalStable("v2.5.1-rc.1"); got != "" {
		t.Errorf("ParseCanonicalStable(prerelease) = %q, want empty", got)
	}
}
