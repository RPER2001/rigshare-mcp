# syntax=docker/dockerfile:1

# Lightweight container image for rigshare-mcp, for hosted MCP platforms
# such as Glama.ai and Smithery.ai. A user can either:
#   (a) generate a local config (via smithery.yaml) that runs
#       `npx rigshare-mcp` on their own machine, or
#   (b) use a platform-hosted endpoint that runs this container.
#
# Option (b) lets people use rigshare-mcp without Node.js or npm installed
# locally, via an HTTPS endpoint the platform wraps around the stdio
# protocol.

FROM node:20-alpine

# Install the published rigshare-mcp package globally from the npm registry.
# Tracks @latest on purpose, so a fresh hosted build always runs the current
# release without a separate version bump here. The published package already
# includes the compiled dist/index.js, so no build step is needed.
RUN npm install -g rigshare-mcp@latest

# The MCP server reads protocol on stdin, writes to stdout, and logs to
# stderr. Hosting platforms wrap this stdio transport with their own
# stdio-to-HTTP bridge. No HTTP server runs inside this container.
ENTRYPOINT ["rigshare-mcp"]
