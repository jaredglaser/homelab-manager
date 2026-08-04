"""Pins the ansible-runner callback contract against the real installed Runner.

The handlers under test are driven by ansible_runner.runner.Runner itself rather than
by a stand-in, because a stand-in written from the same reading of the API as the
sidecar would agree with the sidecar and still be wrong.
"""

from __future__ import annotations

import ast
import inspect
import json
import textwrap
from pathlib import Path

import pytest
from ansible_runner.runner import Runner

CALLBACK_KWARGS = {"event_handler", "status_handler", "finished_callback", "cancel_callback"}
RUNNER_STATUSES = {"starting", "running", "successful", "failed", "timeout", "canceled"}


def emitted_statuses() -> set[str]:
    tree = ast.parse(textwrap.dedent(inspect.getsource(Runner.run)))
    return {
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "status_callback"
        and node.args
        and isinstance(node.args[0], ast.Constant)
    }


def test_run_async_is_given_the_callback_names_runner_accepts(start_run):
    start_run.start()

    assert CALLBACK_KWARGS <= set(inspect.signature(Runner.__init__).parameters)
    assert CALLBACK_KWARGS <= set(start_run.captured)


@pytest.mark.parametrize("status", sorted(RUNNER_STATUSES))
def test_status_handler_accepts_runner_config_as_a_keyword(start_run, runner_config, status):
    run = start_run.start()
    runner = Runner(runner_config, status_handler=start_run.captured["status_handler"])

    runner.status_callback(status)

    assert run.status == status
    assert run.events[-1] == {"event": "runner_status", "status": status}


def test_ansible_runner_calls_status_handler_with_a_runner_config_keyword(runner_config):
    def underscored(status, _runner_config=None):
        raise AssertionError("status_callback should not have reached the body")

    with pytest.raises(TypeError, match="runner_config"):
        Runner(runner_config, status_handler=underscored).status_callback("starting")


def test_runner_emits_only_the_statuses_the_app_maps():
    assert emitted_statuses() == RUNNER_STATUSES, (
        "ansible-runner's status vocabulary changed; RUNNER_STATUS_MAP in "
        "src/lib/ansible/events.ts has to change with it"
    )


def test_event_handler_writes_the_artifact_with_result_payloads_stripped(start_run, runner_config):
    run = start_run.start()
    runner = Runner(runner_config, event_handler=start_run.captured["event_handler"])

    runner.event_callback(
        {
            "uuid": "abc",
            "counter": 1,
            "event": "runner_on_ok",
            "event_data": {
                "host": "host-a",
                "res": {"cmd": "echo hunter2"},
                "task_args": "password=hunter2",
            },
        }
    )

    assert run.events[-1]["event_data"] == {"host": "host-a"}
    artifact = Path(runner_config.artifact_dir) / "job_events" / "1-abc.json"
    assert artifact.exists()
    assert json.loads(artifact.read_text())["event_data"] == {"host": "host-a"}


def test_finished_callback_takes_the_runner_positionally(start_run, runner_config):
    run = start_run.start()
    runner = Runner(runner_config, finished_callback=start_run.captured["finished_callback"])

    runner.finished_callback(runner)

    assert run.finished is True
    assert list(run.stream()) == []


def test_cancel_callback_takes_no_arguments(start_run, runner_config):
    start_run.start(run_id="cancel-me")
    runner = Runner(runner_config, cancel_callback=start_run.captured["cancel_callback"])

    assert runner.cancel_callback() is False
    assert start_run.registry.cancel("cancel-me") is True
    assert runner.cancel_callback() is True
