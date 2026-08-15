# Which tool answers which question

| Question | Tool |
| --- | --- |
| What hosts exist, and are their agents healthy? | `list_hosts` |
| What is running, and where? | `list_containers` |
| What is this container: image, stack, health, restarts? | `get_container` |
| What did it log in this window? | `get_logs` |
| Has it ever logged this before? Where else does this appear? | `search_logs` |
| Did it restart, or go unhealthy? | `get_container_events` |
| Did something deploy just before this? | `get_deploy_history` |
| Was it starved of CPU or memory? | `get_stats` |
| What is it configured to do? | `get_stack_compose` |
| What do I already know about this container? | `get_container_profile` |
| What have I already reported? | `list_findings` |

## Cost

`search_logs` filters server-side and returns matches with context. `get_logs` returns the
window. On a container emitting thousands of lines a minute those differ by orders of
magnitude in what reaches your context, and the answer is usually the same. Reach for
`get_logs` only when you need to read a sequence in order, such as a startup trace.

Every tool is capped. A truncated result says so; treat truncation as a signal to narrow
the window or add a pattern, not as a reason to call again with a bigger limit.
