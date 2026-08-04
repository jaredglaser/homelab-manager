from __future__ import annotations

import pytest

from app import server
from app.server import InvalidRequest, parse_start_request


def handler_with(authorization: str | None):
    handler = server.Handler.__new__(server.Handler)
    handler.headers = {} if authorization is None else {"Authorization": authorization}
    return handler


def test_a_matching_bearer_token_is_authorized(monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "s3cret")

    assert handler_with("Bearer s3cret")._authorized() is True


@pytest.mark.parametrize(
    "authorization",
    [None, "", "Bearer ", "Bearer wrong", "s3cret", "Basic s3cret", "bearer s3cret"],
)
def test_anything_but_the_token_is_rejected(monkeypatch, authorization):
    monkeypatch.setattr(server, "TOKEN", "s3cret")

    assert handler_with(authorization)._authorized() is False


def test_an_unset_token_rejects_every_request(monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "")

    assert handler_with("Bearer ")._authorized() is False
    assert handler_with(None)._authorized() is False


def test_a_valid_request_is_normalized():
    parsed = parse_start_request(
        {
            "runId": "run_1-A",
            "playbook": "host_baseline.yml",
            "hosts": ["host-a", "host-b"],
            "check": 1,
            "extravars": {"token": "s3cret"},
        }
    )

    assert parsed == {
        "run_id": "run_1-A",
        "playbook": "host_baseline.yml",
        "hosts": ["host-a", "host-b"],
        "check": True,
        "extravars": {"token": "s3cret"},
    }


def test_check_and_extravars_default_when_absent():
    parsed = parse_start_request(
        {"runId": "run-1", "playbook": "host_baseline.yaml", "hosts": ["host-a"]}
    )

    assert parsed["check"] is False
    assert parsed["extravars"] == {}


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (["not", "an", "object"], "body must be an object"),
        ({"playbook": "p.yml", "hosts": ["h"]}, "runId"),
        ({"runId": "bad id", "playbook": "p.yml", "hosts": ["h"]}, "runId"),
        ({"runId": "r" * 65, "playbook": "p.yml", "hosts": ["h"]}, "runId"),
        ({"runId": "r", "playbook": "../../etc/passwd.yml", "hosts": ["h"]}, "playbook"),
        ({"runId": "r", "playbook": "host_baseline", "hosts": ["h"]}, "playbook"),
        ({"runId": "r", "playbook": "p.yml.sh", "hosts": ["h"]}, "playbook"),
        ({"runId": "r", "playbook": "p.yml", "hosts": []}, "hosts"),
        ({"runId": "r", "playbook": "p.yml", "hosts": "host-a"}, "hosts"),
        ({"runId": "r", "playbook": "p.yml", "hosts": [""]}, "hosts"),
        ({"runId": "r", "playbook": "p.yml", "hosts": [1]}, "hosts"),
        ({"runId": "r", "playbook": "p.yml", "hosts": ["h"], "extravars": []}, "extravars"),
    ],
)
def test_a_malformed_request_is_rejected(payload, message):
    with pytest.raises(InvalidRequest, match=message):
        parse_start_request(payload)


@pytest.mark.parametrize(
    ("path", "run_id"),
    [
        ("/runs/run-1/events", "run-1"),
        ("/runs/RUN_1/events", "RUN_1"),
    ],
)
def test_the_events_path_matches_a_run_id(path, run_id):
    assert server._EVENTS_PATH.match(path).group(1) == run_id


@pytest.mark.parametrize(
    "path",
    ["/runs//events", "/runs/../events", "/runs/run-1/events/extra", "/runs/run-1"],
)
def test_the_events_path_rejects_anything_else(path):
    assert server._EVENTS_PATH.match(path) is None
