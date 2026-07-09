# syntax=docker/dockerfile:1

# Lightweight container image for rigshare-mcp — used by Glama.ai and
# Smithery.ai for their hosted-execution option. When a user visits
# the Glama listing and clicks "Install Server", Glama can either:
#   (a) generate a local config (via smithery.yaml) that runs
#       `npx rigshare-mcp` on the user's machine, or
#   (b) route the user to a Glama-hosted endpoint that runs this
#       container on Glama's infrastructure.
#
# This Dockerfile enables option (b) without requiring users to have
# Node.js or npm installed locally — they can use rigshare-mcp from
# anywhere via an HTTPS endpoint that Glama wraps around the stdio
# protocol.

FROM node:20-alpine

# Install the published rigshare-mcp package globally from the npm
# registry. Tracks @latest ON PURPOSE: a hard version pin here silently
# rotted (the image shipped 1.1.3 long after 2.0.0 published), so a fresh
# hosted build should always pull the current release — no manual "bump on
# publish" step to forget. The published package already includes the
# compiled dist/index.js, so no build step is needed inside the container.
RUN npm install -g rigshare-mcp@latest

# The MCP server reads protocol on stdin, writes to stdout, and logs
# to stderr. Glama/Smithery infrastructure wraps this stdio transport
# with their own stdio↔HTTP bridge so agents can invoke the server
# over HTTP. No HTTP server is run inside this container.
ENTRYPOINT ["rigshare-mcp"]
