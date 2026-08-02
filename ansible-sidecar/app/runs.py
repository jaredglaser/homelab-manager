"""Run registry: owns ansible-runner invocations, per-host locking, and event fan-out."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from typing import Any, Iterator

import ansible_runner

PRIVATE_DATA_DIR = os.environ.get("ANSIBLE_PRIVATE_DATA_DIR", "/runner")
JOB_TIMEOUT_SECONDS = int(os.environ.get("ANSIBLE_JOB_TIMEOUT_SECONDS", "1800"))
IDLE_TIMEOUT_SECONDS = int(os.environ.get("ANSIBLE_IDLE_TIMEOUT_SECONDS", "600"))

# event_data.res carries whatever a module returned, which for a task without
# no_log includes its arguments. The app applies a strict allowlist of its own;
# dropping these here keeps the payload small and gives that allowlist a second floor.
_STRIPPED_EVENT_DATA_KEYS = ("res", "task_args")


class HostBusyError(Exception):
    def __init__(self, hosts: list[str]) -> None:
        super().__init__(f"hosts already running: {', '.join(sorted(hosts))}")
        self.hosts = sorted(hosts)


@dataclass
class Run:
    """Events are buffered rather than fanned out live, so a subscriber that attaches
    after the run started still sees every event from the first one."""

    run_id: str
    hosts: list[str]
    events: list[dict[str, Any]] = field(default_factory=list)
    finished: bool = False
    status: str = "pending"
    cancelled: bool = False
    thread: threading.Thread | None = None
    condition: threading.Condition = field(default_factory=threading.Condition)

    def publish(self, event: dict[str, Any]) -> None:
        with self.condition:
            self.events.append(event)
            self.condition.notify_all()

    def finish(self) -> None:
        with self.condition:
            self.finished = True
            self.condition.notify_all()

    def stream(self) -> Iterator[dict[str, Any]]:
        index = 0
        while True:
            with self.condition:
                while index >= len(self.events) and not self.finished:
                    self.condition.wait()
                if index >= len(self.events):
                    return
                event = self.events[index]
                index += 1
            yield event


def strip_event(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("event_data")
    if isinstance(data, dict):
        event["event_data"] = {k: v for k, v in data.items() if k not in _STRIPPED_EVENT_DATA_KEYS}
    return event


class RunRegistry:
    """One registry per process. Host locking is in-process because there is one sidecar;
    a second one would need the PostgreSQL advisory lock the deploy pipeline already uses."""

    def __init__(self) -> None:
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()

    def get(self, run_id: str) -> Run | None:
        with self._lock:
            return self._runs.get(run_id)

    def _busy_hosts(self, hosts: list[str]) -> list[str]:
        active = {
            host
            for run in self._runs.values()
            if not run.finished
            for host in run.hosts
        }
        return [host for host in hosts if host in active]

    def start(
        self,
        run_id: str,
        playbook: str,
        hosts: list[str],
        check: bool,
        extravars: dict[str, Any],
    ) -> Run:
        with self._lock:
            busy = self._busy_hosts(hosts)
            if busy:
                raise HostBusyError(busy)
            run = Run(run_id=run_id, hosts=list(hosts))
            self._runs[run_id] = run

        def on_event(event: dict[str, Any]) -> bool:
            run.publish(strip_event(event))
            return True

        def on_status(status: dict[str, Any], _runner_config: Any = None) -> None:
            run.status = status.get("status", run.status)
            run.publish({"event": "runner_status", "status": run.status})

        def on_finished(_runner: Any) -> None:
            run.finish()

        def should_cancel() -> bool:
            return run.cancelled

        envvars = {
            # ansible-runner defaults this to False when the variable is absent.
            "ANSIBLE_HOST_KEY_CHECKING": os.environ.get("ANSIBLE_HOST_KEY_CHECKING", "True"),
        }

        try:
            thread, _runner = ansible_runner.run_async(
                private_data_dir=PRIVATE_DATA_DIR,
                playbook=playbook,
                limit=",".join(hosts),
                extravars=extravars,
                envvars=envvars,
                cmdline="--check --diff" if check else None,
                # Without this, extravars land in <private_data_dir>/env/extravars in plaintext.
                suppress_env_files=True,
                settings={
                    "job_timeout": JOB_TIMEOUT_SECONDS,
                    "idle_timeout": IDLE_TIMEOUT_SECONDS,
                    "suppress_ansible_output": True,
                },
                event_handler=on_event,
                status_handler=on_status,
                finished_callback=on_finished,
                cancel_callback=should_cancel,
            )
        except Exception as err:
            run.publish({"event": "runner_status", "status": "failed", "message": str(err)})
            run.finish()
            raise

        run.thread = thread
        return run

    def cancel(self, run_id: str) -> bool:
        run = self.get(run_id)
        if run is None:
            return False
        run.cancelled = True
        return True
