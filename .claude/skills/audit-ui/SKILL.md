---
name: audit-ui
description: Attach to the SIGMA audit pipeline browser UI to observe progress, take screenshots, approve cost estimates, and interact with the live dashboard. Use when the user wants to see, inspect, or interact with the progress UI spawned by `bun run all` or `bun audit`.
allowed-tools: Bash(playwright-cli:*), Bash(grep:*), Bash(lsof:*)
---

# Audit UI — Browser Automation Skill

Connect to the SIGMA audit pipeline's live progress UI using playwright-cli.

## Architecture

The audit system runs two Bun.serve HTTP servers, both on random ports (`port: 0`):

| Server | Spawned by | UI | API routes |
|---|---|---|---|
| Progress UI | `bun run all` / `bun audit` | React SPA at `/` | `/api/events` (SSE), `/api/state` (GET), `/api/confirm` (POST) |
| Config editor | `bun config --ui` | React SPA at `/` | `/api/config` (GET/PUT) |

Both servers open the default browser automatically on startup. The port is logged to stdout as `Progress UI: http://localhost:{port}` or `Config editor: http://localhost:{port}`.

## Discovering the Port

Since the servers use `port: 0`, you must discover the port from the running process. Use `lsof` to find Bun processes listening on TCP:

```bash
# Find the progress UI port (Bun process serving the audit UI)
lsof -iTCP -sTCP:LISTEN -P -n | grep bun
```

Or parse it from the log output if the pipeline is running in a visible terminal:

```bash
# From the log files
grep -r "Progress UI:" logs/.tmp/ 2>/dev/null | tail -1
```

## Connecting

Use a named session so the connection persists across commands:

```bash
# Connect to the progress UI
playwright-cli -s=audit open http://localhost:<port> --headed

# Connect to the config editor
playwright-cli -s=config open http://localhost:<port> --headed
```

## Common Workflows

### Watch pipeline progress

```bash
playwright-cli -s=audit open http://localhost:<port> --headed
playwright-cli -s=audit snapshot          # see current UI state
playwright-cli -s=audit screenshot        # capture visual state
```

### Approve a cost estimate

When the pipeline pauses for cost confirmation, the CostConfirmation component renders two buttons — "Approve" and "Reject". Use snapshot to find their refs, then click:

```bash
playwright-cli -s=audit snapshot          # find the Approve/Reject button refs
playwright-cli -s=audit click <ref>       # click Approve
```

Alternatively, approve via the API directly:

```bash
# Get current state to find the requestId
playwright-cli -s=audit eval "fetch('/api/state').then(r=>r.json()).then(s=>JSON.stringify(s.costConfirmRequest))"

# Approve
playwright-cli -s=audit eval "fetch('/api/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approved:true,requestId:'<id>'})})"
```

### Capture the final summary

```bash
# Wait for pipeline completion, then screenshot
playwright-cli -s=audit snapshot
playwright-cli -s=audit screenshot --filename=audit-summary.png
```

### Record a full pipeline run

```bash
playwright-cli -s=audit open http://localhost:<port> --headed
playwright-cli -s=audit video-start
# ... pipeline runs ...
playwright-cli -s=audit video-stop pipeline-run.webm
```

### Inspect the SSE event stream

```bash
playwright-cli -s=audit console           # see console output from the React app
playwright-cli -s=audit network           # see network requests including SSE
```

### Edit config in the browser

```bash
playwright-cli -s=config open http://localhost:<port> --headed
playwright-cli -s=config snapshot
playwright-cli -s=config fill <ref> "new-value"
playwright-cli -s=config click <ref>      # save button
```

## UI Components

The progress UI is a single-page React app with these sections:

| Component | What it shows |
|---|---|
| **Header** | "SIGMA — Audit Pipeline" branding + connection status dot (green/red) |
| **PipelinePhases** | Stepper bar: scan → audit → fix → done |
| **CostConfirmation** | Cost estimate card with Approve/Reject buttons. Shows per-policy breakdown when running multi-policy audits. |
| **AuditProgress** | Per-policy audit cards with branch-level progress bars |
| **FixProgress** | Fix batch cards with attempt counts and check status |
| **SummaryPanel** | Right sidebar with stats: issues found, branches scanned, cost, duration |
| **LogStream** | Scrolling log output at bottom |

## Cleanup

```bash
playwright-cli -s=audit close
playwright-cli -s=config close
# or
playwright-cli close-all
```
