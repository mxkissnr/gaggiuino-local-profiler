// Package mcp is GLP's built-in Model Context Protocol server (#1196): a
// Streamable-HTTP endpoint that exposes shot history, the library and
// analytics to AI assistants, built on the official Go SDK. The blank import
// below pins the SDK in go.mod/go.sum until the server code lands.
package mcp

import _ "github.com/modelcontextprotocol/go-sdk/mcp"
