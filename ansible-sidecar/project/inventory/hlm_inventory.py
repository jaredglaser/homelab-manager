#!/usr/bin/env python3
"""Executable dynamic inventory sourced from the Homelab Manager API.

The inventory JSON is built and tested on the app side (src/lib/ansible/inventory.ts);
this script only fetches it, so enrollment and targeting cannot disagree.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

EMPTY = {"_meta": {"hostvars": {}}, "all": {"children": ["ungrouped"]}, "ungrouped": {"hosts": []}}


def fetch() -> dict:
    base = os.environ.get("HLM_API_URL", "").rstrip("/")
    token = os.environ.get("HLM_API_TOKEN", "")
    if not base or not token:
        raise RuntimeError("HLM_API_URL and HLM_API_TOKEN are required")
    request = urllib.request.Request(
        f"{base}/api/ansible-inventory",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    timeout = float(os.environ.get("HLM_API_TIMEOUT_SECONDS", "10"))
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return json.load(response)


def main(argv: list[str]) -> int:
    # _meta.hostvars is always populated, so --host is never consulted for variables.
    if "--host" in argv:
        print(json.dumps({}))
        return 0
    if "--list" not in argv:
        print("usage: hlm_inventory.py --list | --host <name>", file=sys.stderr)
        return 2
    try:
        print(json.dumps(fetch()))
    except (urllib.error.URLError, OSError, ValueError, RuntimeError) as err:
        # An empty inventory fails the play with "no hosts matched" rather than
        # silently converging a stale host set.
        print(f"hlm_inventory: {err}", file=sys.stderr)
        print(json.dumps(EMPTY))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
