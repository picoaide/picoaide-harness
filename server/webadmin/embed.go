// Package webadmin embeds the built admin UI for static serving.
package webadmin

import "embed"

//go:embed dist
var FS embed.FS
