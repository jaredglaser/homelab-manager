from __future__ import annotations

import importlib.util
import io
import json
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "project" / "inventory" / "hlm_inventory.py"


@pytest.fixture
def hlm_inventory():
    spec = importlib.util.spec_from_file_location("hlm_inventory", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("HLM_API_URL", "http://app:3000/")
    monkeypatch.setenv("HLM_API_TOKEN", "s3cret")
    requests = []

    def respond(payload):
        def urlopen(request, timeout=None):
            requests.append((request, timeout))
            return io.BytesIO(json.dumps(payload).encode())

        monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    def raise_with(error):
        def urlopen(request, timeout=None):
            requests.append((request, timeout))
            raise error

        monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    return SimpleNamespace(respond=respond, raise_with=raise_with, requests=requests)


def test_host_mode_prints_an_empty_object(hlm_inventory, capsys):
    assert hlm_inventory.main(["--host", "host-a"]) == 0
    assert json.loads(capsys.readouterr().out) == {}


def test_no_mode_flag_is_a_usage_error(hlm_inventory, capsys):
    assert hlm_inventory.main([]) == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "usage: hlm_inventory.py" in captured.err


def test_list_mode_prints_the_fetched_inventory(hlm_inventory, api, capsys):
    inventory = {"_meta": {"hostvars": {"host-a": {"ansible_host": "10.0.0.1"}}}}
    api.respond(inventory)

    assert hlm_inventory.main(["--list"]) == 0
    assert json.loads(capsys.readouterr().out) == inventory


def test_list_mode_authenticates_against_the_inventory_endpoint(hlm_inventory, api, monkeypatch):
    monkeypatch.setenv("HLM_API_TIMEOUT_SECONDS", "2.5")
    api.respond({})

    hlm_inventory.main(["--list"])

    request, timeout = api.requests[0]
    assert request.full_url == "http://app:3000/api/ansible-inventory"
    assert request.get_header("Authorization") == "Bearer s3cret"
    assert timeout == 2.5


@pytest.mark.parametrize(
    "error",
    [urllib.error.URLError("connection refused"), OSError("broken pipe"), ValueError("not json")],
)
def test_a_fetch_failure_prints_an_empty_inventory_and_exits_nonzero(
    hlm_inventory, api, capsys, error
):
    api.raise_with(error)

    assert hlm_inventory.main(["--list"]) == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == hlm_inventory.EMPTY
    assert "hlm_inventory:" in captured.err


def test_missing_credentials_print_an_empty_inventory(hlm_inventory, monkeypatch, capsys):
    monkeypatch.delenv("HLM_API_URL", raising=False)
    monkeypatch.delenv("HLM_API_TOKEN", raising=False)

    assert hlm_inventory.main(["--list"]) == 1
    assert json.loads(capsys.readouterr().out) == hlm_inventory.EMPTY


def test_the_empty_inventory_matches_no_hosts(hlm_inventory):
    assert hlm_inventory.EMPTY["ungrouped"]["hosts"] == []
    assert hlm_inventory.EMPTY["_meta"]["hostvars"] == {}
