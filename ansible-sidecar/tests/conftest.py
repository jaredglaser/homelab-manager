from __future__ import annotations

import threading
from types import SimpleNamespace
from typing import Any

import pytest

import app.runs
from app.runs import Run, RunRegistry


@pytest.fixture
def runner_config(tmp_path):
    artifact_dir = tmp_path / "artifacts"
    (artifact_dir / "job_events").mkdir(parents=True)
    return SimpleNamespace(
        ident="run-1",
        command=["ansible-playbook", "host_baseline.yml"],
        env={"ANSIBLE_HOST_KEY_CHECKING": "True"},
        cwd=str(tmp_path),
        artifact_dir=str(artifact_dir),
        check_job_event_data=False,
    )


@pytest.fixture
def start_run(monkeypatch, tmp_path):
    captured: dict[str, Any] = {}
    threads: list[threading.Thread] = []
    release = threading.Event()

    def fake_run_async(**kwargs: Any) -> tuple[threading.Thread, object]:
        captured.clear()
        captured.update(kwargs)
        # The supervisor fails the run the instant this thread exits, so it has to
        # outlive the assertions of every test that is not about the supervisor.
        thread = threading.Thread(target=release.wait, daemon=True)
        thread.start()
        threads.append(thread)
        return thread, object()

    monkeypatch.setattr(app.runs, "PRIVATE_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(app.runs, "ansible_runner", SimpleNamespace(run_async=fake_run_async))

    registry = RunRegistry()

    def start(
        run_id: str = "run-1",
        playbook: str = "host_baseline.yml",
        hosts: list[str] | None = None,
        check: bool = False,
        extravars: dict[str, Any] | None = None,
    ) -> Run:
        return registry.start(
            run_id=run_id,
            playbook=playbook,
            hosts=["host-a"] if hosts is None else hosts,
            check=check,
            extravars={} if extravars is None else extravars,
        )

    yield SimpleNamespace(
        registry=registry,
        start=start,
        captured=captured,
        release=release.set,
        private_data_dir=str(tmp_path),
    )

    release.set()
    for thread in threads:
        thread.join()
