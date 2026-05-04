# Marketo MCP Server

A Model Context Protocol (MCP) server that exposes the full Marketo REST API as 90+ tools. Built for use with Claude, LangChain, or any MCP-compatible AI agent.

## What It Does

This server acts as a bridge between AI agents and your Marketo instance. Instead of writing custom API integrations, agents can call tools like `get_leads_by_filter`, `create_email`, or `trigger_campaign` directly through the MCP protocol.

## Features

- **90+ tools** covering the full Marketo REST API
- **Lead Database** — CRUD leads, companies, opportunities, custom objects
- **Activities** — query activity logs, create custom activities
- **Asset API** — programs, emails, landing pages, forms, snippets, templates
- **Bulk Import/Export** — large-scale data operations
- **Smart Campaigns & Lists** — trigger campaigns, query smart lists
- **Usage Stats** — monitor API quota consumption
- **OAuth token caching** with automatic refresh
- **API key authentication** — protect your server with a Bearer token
- **Dual transport** — Streamable HTTP (port 3201) + HTTPS (port 3444)
- **SSE fallback** for older MCP clients

## Requirements

- Node.js 18+
- A Marketo instance with API access (REST API + Identity endpoint)
- Client ID and Client Secret from a LaunchPoint integration

## Setup

### 1. Install dependencies

```bash
npm install @modelcontextprotocol/sdk zod dotenv
```

### 2. Configure environment

Create a `.env` file:

```env
MARKETO_BASE_URL=https://xxx-xxx-xxx.mktorest.com
MARKETO_IDENTITY_URL=https://xxx-xxx-xxx.mktorest.com/identity
MARKETO_CLIENT_ID=your-client-id
MARKETO_CLIENT_SECRET=your-client-secret
MARKETO_MCP_PORT=3201
MARKETO_MCP_HTTPS_PORT=3444
MCP_API_KEY=your-api-key-here
```

To find your Marketo API credentials:
1. Go to **Admin > Integration > LaunchPoint** in Marketo
2. Create a new service (or use an existing one)
3. Click "View Details" to get the Client ID and Client Secret
4. Your base URL is your Marketo instance URL (e.g., `https://123-ABC-456.mktorest.com`)

### 3. Generate an API key

The `MCP_API_KEY` protects your server from unauthorized access. Generate a random key:

```bash
openssl rand -hex 32
```

Add the result to your `.env` as `MCP_API_KEY`. If left empty, authentication is disabled (not recommended for production).

All requests (except `/health` and `OPTIONS` preflight) must include:
```
Authorization: Bearer <your-api-key>
```

Unauthenticated requests receive a `401 Unauthorized` response.

### 4. (Optional) HTTPS setup

Place your SSL certificates at:
- `ssl/server.crt`
- `ssl/server.key`

If not present, HTTPS will be skipped and only HTTP will run.

### 5. Run

```bash
# With tsx (recommended for development)
npx tsx marketo-server.ts

# Or compile and run
npx tsc marketo-server.ts --outDir dist --module esnext --moduleResolution bundler
node dist/marketo-server.js
```

## Connecting an MCP Client

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "marketo": {
      "url": "http://localhost:3201/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    }
  }
}
```

### Remote Connection

If running on a VPS, connect via:
```
http://your-server:3201/mcp
```
or
```
https://your-server:3444/mcp
```

Include the `Authorization: Bearer <key>` header in all requests.

### SSE Transport (legacy)

For older clients that only support SSE:
```
http://your-server:3201/sse
```

## Tool Categories

| Category | Tools | Description |
|----------|-------|-------------|
| Leads | 11 | Get, create, update, delete, merge, associate leads |
| Lists | 6 | Manage static lists and list membership |
| Companies | 4 | CRUD company records |
| Opportunities | 4 | CRUD opportunity records |
| Opportunity Roles | 4 | Manage opportunity-lead relationships |
| Sales Persons | 4 | CRUD sales person records |
| Named Accounts | 6 | ABM named account management |
| Custom Objects | 5 | Query and manage custom objects |
| Program Members | 4 | Manage program membership and status |
| Activities | 8 | Query activities, create custom activity types |
| Programs | 7 | CRUD programs, clone |
| Smart Campaigns | 4 | Query, trigger, and schedule campaigns |
| Smart Lists | 3 | Query smart lists and their leads |
| Emails | 12 | Full email asset lifecycle |
| Email Templates | 5 | Manage email templates |
| Landing Pages | 9 | Full landing page lifecycle |
| Landing Page Templates | 3 | Manage LP templates |
| Forms | 5 | Manage form assets |
| Tokens | 3 | My Token CRUD |
| Folders | 5 | Browse and manage folder tree |
| Files | 3 | Manage images and files |
| Snippets | 6 | Manage snippet assets |
| Segmentations | 2 | Query segmentations and segments |
| Tags & Channels | 4 | Browse tags and channels |
| Bulk Export | 9 | Large-scale data export jobs |
| Bulk Import | 4 | Import job status and diagnostics |
| Usage & Errors | 4 | API quota and error monitoring |
| Lead Fields | 3 | Custom field CRUD |
| Custom Object Types | 5 | Schema-level custom object management |

## License

MIT
