# Connecting a Hermes agent

Status: POC. Everything here is behind the `MCP_ENABLED` flag and is off by default.

homelab-manager connects to a [Hermes agent](https://hermes-agent.nousresearch.com/docs/)
in two directions:

- **Pull.** Hermes reaches an MCP server at `/api/mcp` to read container inventory, logs,
  events, deploys and stats. This is what ships first.
- **Push.** homelab-manager posts a signed webhook to the Hermes gateway when a detector
  rule fires. This arrives in a later phase.

Hermes runs on its own machine on your LAN. It is not part of the compose stack, and
nothing here installs it.

## 1. Enable the endpoint

`/api/mcp` is a route on the existing web server. It needs no new port and no new
container, only the flag:

```bash
MCP_ENABLED=true
```

With the flag unset or set to anything else, the route returns 404 before doing any work.

## 2. Create a token

MCP authenticates with a bearer token, not the OIDC session cookie. Create one in
**Settings** next to git tokens, copy it once, and store it on the Hermes machine in
`~/.hermes/.env`:

```bash
HOMELAB_MCP_TOKEN=hlm_...
```

Tokens are scoped. A read-only token is enough for the pull path; the write scopes only
matter once the push path lands. Give the smallest scope that works, because this token can
read every container log in the fleet.

## 3. Reverse proxy

`self-hosting/README.md` already covers the three dashboard requirements. `/api/mcp` adds
two more, and both fail in ways that look like a hang rather than an error.

**Do not buffer it.** Streamable HTTP MCP can hold a long-lived response, the same as the
SSE routes under `/api/`. A buffering proxy makes every tool call appear to time out.

**Do not put an auth layer in front of it.** MCP presents a bearer token. A proxy that
demands the session cookie on `/api/*` will reject Hermes with a redirect to the login page,
which the MCP client reports as a protocol error.

Caddy:

```caddyfile
homelab.example.net {
	@mcp path /api/mcp
	handle @mcp {
		reverse_proxy homelab-manager:3000 {
			flush_interval -1
			transport http {
				read_timeout 0
				write_timeout 0
			}
		}
	}

	handle {
		reverse_proxy homelab-manager:3000 {
			flush_interval -1
		}
	}
}
```

`flush_interval -1` disables response buffering. Caddy's internal CA is enough on a LAN;
Hermes trusts it the way any client would.

Keep this on your LAN. The advice in `self-hosting/README.md` about not exposing the
dashboard publicly applies harder to an endpoint that serves logs to an agent.

## 4. Configure Hermes

In `~/.hermes/config.yaml` on the Hermes machine:

```yaml
mcp_servers:
  homelab:
    url: "https://homelab.example.net/api/mcp"
    headers:
      Authorization: "Bearer ${HOMELAB_MCP_TOKEN}"
    tools:
      resources: false
      prompts: false
    timeout: 120
    connect_timeout: 30

skills:
  external_dirs:
    - /path/to/homelab-manager/hermes/skills
```

Streamable HTTP is the default for a `url` server, so no `transport` key is needed. The
`external_dirs` entry points Hermes at the skill pack in this repository, so the triage
procedure stays versioned with the code that backs it. Clone the repo on the Hermes machine
or mount the directory; either works.

Restart the gateway, then confirm Hermes sees the tools:

```bash
hermes mcp list
```

Tools appear prefixed, as `mcp_homelab_list_hosts` and so on.

## 5. Verify

From the homelab-manager checkout:

```bash
bun scripts/validate-log-assumptions.ts hermes \
  --webhook http://hermes.lan:8644/homelab-log-triage \
  --secret "$HOMELAB_WEBHOOK_SECRET" \
  --mcp https://homelab.example.net/api/mcp \
  --mcp-token "$HOMELAB_MCP_TOKEN"
```

Run this **through the reverse proxy**, not against localhost. Pointing it at localhost
skips the proxy and hides exactly the two failures step 3 warns about.

The same script has a `docker` stage worth running on any host in the fleet. It checks what
mocked tests cannot: whether Docker applies `tail` before or after the `since` filter,
whether `since` is inclusive, what a query reaching past log rotation returns, and how many
concurrent follow streams one process can hold.

## Security notes

Container logs are attacker-controlled text. Anything running on your fleet can write a log
line addressed to the agent reading it.

- The token cannot reach a deploy, restart or rollback path. No action tools exist.
- The triage webhook route should grant no `terminal` or `file` toolset. MCP tools only.
- Run the gateway in a container, per the Hermes Docker guidance.
- Give Hermes a dedicated profile for this workload so its config and skills are isolated
  from anything else you use it for.
