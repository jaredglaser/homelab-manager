# Correlating a log anomaly with what changed

Logs tell you a symptom. These tell you a cause.

## Deploys

`get_deploy_history` for the stack, covering an hour before the window. A deploy reaching a
terminal state shortly before the first bad line is the single most common explanation, and
it converts a vague finding into an actionable one. Check the commit: a rollback that
restored service is itself the finding.

The post-deploy window is also when a container legitimately looks broken. A service that
logs connection errors for 20 seconds while its database starts is not an incident. Look
for errors that continue past the point where dependencies should be up.

## Restarts and health

`get_container_events` carries state transitions. Read the ordering carefully:

- Errors then restart: the container failed and the restart is a consequence.
- Restart then errors: something restarted it and the errors are startup noise.
- Repeated restarts with the same short interval: a crash loop. Report the loop, not the
  individual crashes, and include the interval.
- Health going unhealthy without a restart: the health check is failing while the process
  runs, which usually means a dependency rather than the container itself.

## Resource pressure

`get_stats` over the same window. Memory at the limit immediately before an OOM kill is a
complete explanation. CPU pinned at the ceiling with rising latency in the logs is a
capacity finding, not a bug.

Absence matters too. Errors with flat, unremarkable resource usage rule out a whole class
of cause and make a configuration or dependency explanation more likely.

## Blast radius

If several containers in one stack went bad in the same window, they are one incident with
one cause, usually the stack itself or the host. Say so in a single finding naming every
affected entity, rather than filing one per container.

Check `list_hosts` when several stacks on one host degrade together: an unhealthy agent or
a host-level problem looks like many unrelated container incidents from below.
