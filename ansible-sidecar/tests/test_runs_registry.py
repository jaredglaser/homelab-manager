from __future__ import annotations

from types import SimpleNamespace

import pytest

import app.runs
from app.runs import HostBusyError, RunRegistry, strip_event

FAILED_THREAD_EVENT = {
    "event": "runner_status",
    "status": "failed",
    "message": "runner thread exited before the run finished",
}


def test_dispatch_keeps_secrets_off_disk_and_pins_host_key_checking(start_run):
    start_run.start(hosts=["host-a", "host-b"], check=True, extravars={"token": "s3cret"})

    kwargs = start_run.captured
    assert kwargs["suppress_env_files"] is True
    assert kwargs["envvars"] == {"ANSIBLE_HOST_KEY_CHECKING": "True"}
    assert kwargs["cmdline"] == "--check --diff"
    assert kwargs["limit"] == "host-a,host-b"
    assert kwargs["extravars"] == {"token": "s3cret"}
    assert kwargs["playbook"] == "host_baseline.yml"
    assert kwargs["private_data_dir"] == start_run.private_data_dir


def test_host_key_checking_honours_the_environment(start_run, monkeypatch):
    monkeypatch.setenv("ANSIBLE_HOST_KEY_CHECKING", "False")

    start_run.start()

    assert start_run.captured["envvars"] == {"ANSIBLE_HOST_KEY_CHECKING": "False"}


def test_a_non_check_run_sends_no_cmdline(start_run):
    start_run.start(check=False)

    assert start_run.captured["cmdline"] is None


def test_settings_carry_the_module_timeouts(start_run, monkeypatch):
    monkeypatch.setattr(app.runs, "JOB_TIMEOUT_SECONDS", 11)
    monkeypatch.setattr(app.runs, "IDLE_TIMEOUT_SECONDS", 7)

    start_run.start()

    assert start_run.captured["settings"] == {
        "job_timeout": 11,
        "idle_timeout": 7,
        "suppress_ansible_output": True,
    }


def test_an_overlapping_host_is_rejected_while_the_first_run_is_live(start_run):
    start_run.start(run_id="first", hosts=["host-a", "host-b"])

    with pytest.raises(HostBusyError) as err:
        start_run.start(run_id="second", hosts=["host-b", "host-c"])

    assert err.value.hosts == ["host-b"]
    assert start_run.registry.get("second") is None


def test_a_finished_run_releases_its_hosts(start_run):
    first = start_run.start(run_id="first", hosts=["host-a"])
    first.finish()

    second = start_run.start(run_id="second", hosts=["host-a"])

    assert second.run_id == "second"


def test_a_dispatch_failure_publishes_and_finishes_before_raising(monkeypatch, tmp_path):
    def boom(**_kwargs):
        raise RuntimeError("playbook not found")

    monkeypatch.setattr(app.runs, "PRIVATE_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(app.runs, "ansible_runner", SimpleNamespace(run_async=boom))
    registry = RunRegistry()

    with pytest.raises(RuntimeError, match="playbook not found"):
        registry.start(
            run_id="doomed", playbook="host_baseline.yml", hosts=["host-a"], check=False, extravars={}
        )

    run = registry.get("doomed")
    assert list(run.stream()) == [
        {"event": "runner_status", "status": "failed", "message": "playbook not found"}
    ]


def test_a_late_subscriber_replays_every_event_from_the_first(start_run):
    run = start_run.start()
    run.publish({"event": "one"})
    run.publish({"event": "two"})
    run.finish()

    assert list(run.stream()) == [{"event": "one"}, {"event": "two"}]
    assert list(run.stream()) == [{"event": "one"}, {"event": "two"}]


def test_a_dead_runner_thread_drives_the_run_to_a_terminal_failure(start_run):
    run = start_run.start()

    start_run.release()
    run.thread.join()
    events = list(run.stream())

    assert run.finished is True
    assert events == [FAILED_THREAD_EVENT]


def test_the_supervisor_stays_quiet_once_the_run_finished(start_run):
    run = start_run.start()
    start_run.captured["finished_callback"](object())

    start_run.release()
    run.thread.join()

    assert list(run.stream()) == []


def test_strip_event_drops_module_results_and_task_args():
    event = {
        "event": "runner_on_ok",
        "event_data": {"host": "host-a", "res": {"rc": 0}, "task_args": "password=hunter2"},
    }

    assert strip_event(event)["event_data"] == {"host": "host-a"}


def test_strip_event_leaves_a_non_dict_event_data_alone():
    assert strip_event({"event": "verbose", "event_data": None})["event_data"] is None
