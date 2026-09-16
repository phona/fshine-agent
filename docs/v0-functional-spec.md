# Tax Agent V0 Functional Specification (Frozen)

Status: **frozen for V0 implementation**  
Scope: WeCom employees querying permitted accounting data through 17dz read MCP  
Architecture: [`v0-architecture.md`](v0-architecture.md)  
MCP contract: [`17dz-mcp-spec.md`](17dz-mcp-spec.md), v0.5

## 1. User and value

The V0 user is an internal employee using a WeCom bot. The bot helps locate an allowed account set and answer read-only questions about accounting periods, vouchers, and account-set context.

V0 succeeds when an employee can obtain a correct, traceable answer without needing to operate YiQiYing directly for routine lookup.

## 2. In scope

| Capability | User-facing behavior |
|---|---|
| Account-set lookup | Find an allowed account set by name; request clarification for multiple matches |
| Current period | Tell the user the current accounting period of an allowed account set |
| Voucher lookup | Fetch and summarize vouchers for a chosen account set and period; support paged follow-up queries |
| Account-set inspection | Summarize subjects, assistants, and recent-voucher context returned by 17dz |
| Login awareness | Explain that the upstream session requires operator login when `NEEDS_LOGIN` occurs |
| Auditability | Associate every reply with the incoming request and MCP trace ID |

## 3. Out of scope

```text
creating, editing, deleting, submitting, or approving any voucher
invoice, declaration, payment, or other tax write action
customer-facing channels
full RBAC, approval flows, long-running jobs, browser takeover
knowledge-base retrieval, automatic learning, proactive inspection
```

## 4. Core user flows

### 4.1 Query vouchers

```text
Employee: “查一下幻晟本期的凭证。”
  -> resolve employee scope
  -> search account sets when necessary
  -> obtain current period
  -> list vouchers (default first page)
  -> return a concise summary and identify that more results are available
```

The bot must say which account set and period it used. It must not invent vouchers, totals, or period values.

### 4.2 Ambiguous account set

```text
Employee: “查幻晟的凭证。”
  -> search returns several allowed candidates
  -> bot presents only those candidates
  -> employee selects one
  -> query continues
```

### 4.3 Access denied

```text
Employee requests an account set outside configured scope
  -> host denies before MCP call
  -> bot states it has no access
  -> bot does not reveal account-set data or names outside scope
```

### 4.4 Upstream login failure

```text
17dz returns NEEDS_LOGIN
  -> operator notification / visible operational alert
  -> employee receives a concise “system login requires processing” reply
  -> request is recorded with MCP trace ID
```

## 5. Functional rules

- Every request has a `requestId`; every tool call records the returned `traceId` where available.
- Account set access is checked by trusted host configuration before an MCP call.
- The Agent may call only tools discovered from the connected read server's `tools/list`.
- Host validates and parses MCP JSON envelopes. It passes a bounded, relevant result to the Agent instead of raw large payloads.
- Voucher data is paged. The default response is the first page; large lists are summarized, with a clear way to ask for more.
- A data-bearing reply states the selected account set, applicable period when used, source, and retrieval time from MCP `meta`.
- Error messages sent to employees are understandable and do not disclose stack traces, filesystem paths, credentials, or unauthorized data.
- Any MCP artifact reference is retained for operators, not automatically sent to employees.

## 6. Configuration required before test

```yaml
principals:
  wecom:<user-id>:
    accountSetIds: [as_001]
    mcpServer: 17dz-read
    enabled: true
```

For the real MCP server, the deployment may also configure `ALLOWED_ACCOUNT_SETS`. It is optional in early local testing but required where account-set isolation is expected.

The V0 session key is `wecomUserId + conversationId`. V0 replies synchronously; its channel-facing time budget is 75 seconds, with a 60-second budget for one MCP read-tool call.

## 7. Acceptance criteria

V0 is ready for internal use only when all of these pass against both Fake MCP and real 17dz read MCP where applicable:

1. A configured user can query a permitted account set and receives the correct account-set name, period, and voucher summary.
2. An unconfigured or disabled user is denied before any MCP business-tool call.
3. A configured user cannot query an account set outside their scope, including by prompt injection or direct tool-argument manipulation.
4. A multi-match account-set search results in a clarification prompt, not a guess.
5. A result with more than one page is summarized without overflowing the reply; a follow-up can retrieve the next page.
6. `NEEDS_LOGIN`, `PROFILE_BUSY`, `TIMEOUT`, and `NEEDS_USER_INPUT` follow the host behavior in the architecture document.
7. MCP process restart triggers reconnect, initialization, and fresh `tools/list` discovery.
8. Each test request can be correlated from WeCom message ID through `requestId` and MCP `traceId`.
9. No V0 path can invoke a write MCP server or a write-capable tool.
10. Data-bearing replies show the selected account set and returned source/time, without exposing raw MCP JSON.

## 8. Delivery order

```text
1. Fake17dzMcpServer + contract tests
2. MCP stdio host + envelope/error handling
3. principal scope configuration + audit persistence
4. Agent read-tool policy + deterministic test conversations
5. WeCom adapter
6. Real 17dz read MCP integration
7. internal acceptance test run
```

No V1 feature is started until the V0 acceptance criteria are met or explicitly revised.
