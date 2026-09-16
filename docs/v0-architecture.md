# Tax Agent V0 Architecture (Frozen)

Status: **frozen for V0 implementation**  
Scope: read-only WeCom accounting queries  
Related contract: [`17dz-mcp-spec.md`](17dz-mcp-spec.md), v0.5

## 1. Goal

V0 proves one dependable, auditable path:

```text
WeCom employee
  -> tax-agent
  -> 17dz read MCP server
  -> YiQiYing / 17dz-platform
  -> tax-agent
  -> WeCom reply
```

The product may answer questions about the account sets the caller is configured to access. It does not make business changes.

## 2. Boundaries

```text
┌──────────┐    ┌─────────────────────────────────┐    ┌──────────────────────┐
│  WeCom   │ -> │ tax-agent                       │ -> │ 17dz read MCP server │
│ channel  │ <- │                                 │ <- │                      │
└──────────┘    │ Channel adapter                 │    │ Read-only tools      │
                │ Identity + scope config         │    │ Account-set allowlist│
                │ Agent runtime + tool policy     │    │ YiQiYing adapter     │
                │ MCP stdio host                  │    └──────────────────────┘
                │ Session + audit storage         │
                └─────────────────────────────────┘
```

| Component | Owns | Must not own |
|---|---|---|
| WeCom adapter | receive/reply, message identity | business authorization or browser automation |
| Identity/scope config | map WeCom user to allowed account sets | LLM-generated identity or role data |
| Agent runtime (Pi adapter in the initial implementation) | understand request, decide read tools, compose reply | selectors, browser state, credentials |
| MCP host | stdio lifecycle, discovery, timeout, result parsing | business implementation |
| 17dz read MCP | account-set lookup and read business tools | WeCom identity, LLM prompt, credentials input |
| 17dz-platform | reliable YiQiYing/API/browser adaptation | channel-specific conversation handling |
| Audit storage | evidence of request and execution | source of financial truth |

## 3. Security model for V0

V0 uses static, deployment-level scope configuration rather than full RBAC.

```text
WeCom user -> configured accountSetIds -> configured read MCP instance
```

The host rejects a requested account set outside the caller's configured scope. The 17dz server may additionally enforce `ALLOWED_ACCOUNT_SETS`; this is defense in depth, not a replacement for future user-level authorization.

Rules:

- The LLM never supplies or changes a caller identity, account scope, server command, or environment configuration.
- Only the read MCP server is spawned in V0. The process has no write tools.
- Account sets are addressed by `accountSetId` returned by `search_account_sets`; names are display-only.
- No credentials are passed through messages, prompts, or MCP tool arguments.

## 4. Request flow

1. WeCom adapter receives a message and extracts the immutable WeCom user ID and message ID.
2. Identity resolver loads the caller's configured account-set scope.
3. Agent runtime receives the user message plus a trusted execution context. It can only use read tools. The runtime is behind an adapter so Pi can be replaced later without changing the host or 17dz contract.
4. MCP host starts or reuses the configured stdio server, performs `initialize`, `notifications/initialized`, and `tools/list` after each new connection.
5. Before calling a tool with `accountSetId`, the host verifies it belongs to the trusted scope.
6. Host parses MCP `content[0].text` as the v0.5 JSON envelope, records the raw result, and provides a bounded summary to the runtime.
7. Agent produces a reply based only on returned data. WeCom adapter sends it to the caller.
8. Host records the request, tool calls, response summary, error code, and correlation IDs.

## 5. V0 MCP capabilities

The real server and the Fake server expose the current read contract:

```text
get_login_status
search_account_sets
get_current_accounting_period
list_vouchers
inspect_account_set
```

`tools/list` is the runtime source of truth. The host must not assume that a connected server has a particular tool set.

## 6. Failure handling

| MCP outcome | V0 host behavior |
|---|---|
| `NEEDS_LOGIN` | notify an operator; tell the caller the query cannot proceed yet |
| `PROFILE_BUSY` / `TIMEOUT` | bounded retry with server-provided backoff; then report failure |
| `ACCOUNT_SET_NOT_FOUND` / `ACCOUNT_SET_AMBIGUOUS` | re-search or ask the caller to disambiguate |
| `ACCOUNT_SET_FORBIDDEN` | deny without retrying or revealing other account sets |
| `NEEDS_USER_INPUT` | ask a focused follow-up question |
| other error | return a safe failure message; retain trace and artifact reference for operators |

V0 does not expose browser control to users. An artifact ID is retained in audit data; its retrieval follows the deployment's shared-volume convention in the MCP specification.

## 7. Minimal persistent records

The implementation may choose any database, but must preserve these logical records:

```text
principal_scope
  wecomUserId, accountSetIds, enabled

agent_request
  requestId, wecomMessageId, principalId, input, createdAt, outcome

tool_call
  requestId, traceId, toolName, safeArguments, source, startedAt, finishedAt,
  status, errorCode, artifactId

conversation_session
  sessionId, principalId, channelConversationId, updatedAt
```

Raw MCP responses are audit evidence and must not be blindly copied into the LLM context or sent to WeCom.

## 8. V0 deployment decisions

The following are implementation decisions for V0, not extensions to the MCP contract:

```yaml
principals:
  wecom:<user-id>:
    mcpProfile: read-default
    accountSetIds: [as_001]
    enabled: true

mcpProfiles:
  read-default:
    command: node automation/mcp/src/server-read.js
    cwd: /path/to/17dz-platform
    requestTimeoutMs: 60000
    maxRetries: 2
```

- Session key: `wecomUserId + conversationId`.
- V0 uses synchronous replies only. The channel-facing request budget is 75 seconds; an MCP read-tool call is limited to 60 seconds.
- V0 development persistence uses SQLite behind a repository interface. Migration to a production database is not an architectural change.
- Production retention and desensitization policy must be configured before any non-test financial data is retained. Credentials, filesystem paths, and unauthorized account-set data are never recorded in ordinary application logs.

## 9. Deliberately deferred

The following are not V0 requirements and must not expand the implementation scope:

```text
write MCP server, voucher submission, drafts and confirmation
full Principal / role / permission RBAC
Job Manager, checkpointing, scheduler, proactive tasks
Browser worker pool, noVNC, human takeover workflow
RAG, vector database, persistent memory, case learning
HTTP MCP transport and MCP resources
```

## 10. Change control

Changes to the read-tool schema, envelope, error codes, or account-set identity convention require a versioned update to `17dz-mcp-spec.md` and matching Fake-server contract tests. New V0 application features may be added only if they do not weaken the boundaries above.
