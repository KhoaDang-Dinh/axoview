# AI access policy

| Context | General/public chat | Read diagram | Search private workspace | Edit |
|---|---|---|---|---|
| Guest | quota limited | only exact public shared resource, where granted | no | no |
| Public snapshot viewer | quota limited | exact current published snapshot | no | no |
| Drive viewer | quota limited | only with valid Drive grant and supported read path | no | no |
| Authenticated owner in editable app | yes | owned/authorized | owned/authorized | approval and fresh version check |
| Authenticated user on read-only route | yes | authorized view only | only independently authorized data | no |
| External MCP client | N/A | scope + per-resource authorization | explicit read/search scope | separate write grant and approval |

Resolve workspace using a verified Cognito sub, never a user-provided workspace ID. Invalid bearer tokens are 401, never silently guest. On logout/account switch stop private streams and clear private chat state. Public share UUID never allows owner's unrelated diagrams; recheck revocation at read time. Google Drive permissions are not equivalent to Axoview share snapshots.

For each run, SSE read, MCP call, RAG result and tool action, enforce actor, resource scope, current permissions, quota and flags **server-side**. Vector metadata filters alone do not constitute authorization. Treat retrieved diagram labels as untrusted data, not instructions. Prevent cross-user run/conversation IDs. Guest use needs WAF/rate-limit/token budget before enabling.

Writes: separate `diagrams:write` scope where relevant; user approval binds exact proposal hash, diagram, version, owner and expiry. Validate again before optimistic-concurrency save. Record bounded audit events, avoid logging private prompt content. Update privacy disclosure before transmitting private diagrams to model provider.
