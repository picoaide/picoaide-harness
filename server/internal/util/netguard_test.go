package util

import (
	"net"
	"testing"
)

func TestIsBlockedOutboundIP(t *testing.T) {
	blocked := []string{"169.254.169.254", "169.254.170.2", "100.100.100.200", "0.0.0.0", "fe80::1", "fd00:ec2::254"}
	for _, s := range blocked {
		if !IsBlockedOutboundIP(net.ParseIP(s)) {
			t.Fatalf("IsBlockedOutboundIP(%s) = false, want true", s)
		}
	}
	allowed := []string{"1.1.1.1", "10.0.0.5", "192.168.1.10", "172.16.0.9", "127.0.0.1", "::1", "2606:4700:4700::1111"}
	for _, s := range allowed {
		if IsBlockedOutboundIP(net.ParseIP(s)) {
			t.Fatalf("IsBlockedOutboundIP(%s) = true, want false", s)
		}
	}
	if !IsBlockedOutboundIP(nil) {
		t.Fatal("nil IP must be blocked")
	}
}

func TestIsBlockedOutboundHost(t *testing.T) {
	for _, h := range []string{"metadata", "metadata.google.internal", "Metadata.Goog", "instance-data"} {
		if !IsBlockedOutboundHost(h) {
			t.Fatalf("host %s must be blocked", h)
		}
	}
	for _, h := range []string{"api.deepseek.com", "llm.internal.corp"} {
		if IsBlockedOutboundHost(h) {
			t.Fatalf("host %s must be allowed (private upstreams are supported)", h)
		}
	}
}
