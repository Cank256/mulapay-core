#!/usr/bin/env python3.11
"""
Generate docs/mulapay.postman_collection.json from the Bruno collection at
~/Documents/bruno/MulaPay Core API/.

Usage:
    python3 scripts/generate-postman.py
"""

import json
import os
import re
import sys
from pathlib import Path

import yaml  # pip install pyyaml

BRUNO_ROOT = Path.home() / "Documents" / "bruno" / "MulaPay Core API"
OUT_FILE = Path(__file__).parent.parent / "docs" / "mulapay.postman_collection.json"

# ---------------------------------------------------------------------------
# Postman script equivalent for Bruno after-response scripts that set
# accessToken. Bruno uses  bru.setCollectionVar / res.getBody();
# Postman uses pm.collectionVariables.set / pm.response.json().
# ---------------------------------------------------------------------------
POSTMAN_LOGIN_SCRIPT = {
    "listen": "test",
    "script": {
        "type": "text/javascript",
        "exec": [
            "const body = pm.response.json();",
            "const token = body && body.data && body.data.accessToken;",
            "if (token) {",
            "    pm.collectionVariables.set('accessToken', token);",
            "    console.log('accessToken saved to collection variable');",
            "} else {",
            "    console.warn('Login succeeded but no accessToken found in response');",
            "}",
        ],
    },
}


def load_yaml(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def bruno_url_to_postman(raw_url: str) -> dict:
    """Convert a Bruno URL string (with :param placeholders) to a Postman url object."""
    # Replace {{var}} — keep as-is for Postman
    # Split path segments
    parts = raw_url.split("/", 3)  # scheme://host / path
    # Postman raw url stays the same; we just need host + path segments
    # Strip the host variable e.g. {{baseUrl}}
    without_base = raw_url.replace("{{baseUrl}}", "", 1).lstrip("/")
    segments = without_base.split("/") if without_base else []

    return {
        "raw": raw_url,
        "host": ["{{baseUrl}}"],
        "path": segments,
    }


def has_login_script(bruno_file: dict) -> bool:
    """Return True if this Bruno request file contains a login after-response script."""
    runtime = bruno_file.get("runtime", {})
    scripts = runtime.get("scripts", []) if isinstance(runtime, dict) else []
    for s in scripts:
        if s.get("type") == "after-response":
            code = s.get("code", "")
            if "accessToken" in code or "bru.setCollectionVar" in code:
                return True
    return False


def build_request(bruno: dict, file_path: Path) -> dict:
    http = bruno.get("http", {})
    method = http.get("method", "GET").upper()
    url_raw = http.get("url", "")
    headers = [
        {"key": h["name"], "value": h["value"]}
        for h in http.get("headers", [])
        if h.get("name") and h.get("value") is not None
    ]

    req: dict = {
        "method": method,
        "header": headers,
        "url": bruno_url_to_postman(url_raw),
    }

    # Description
    docs = bruno.get("docs", "")
    if isinstance(docs, dict):
        docs = docs.get("content", "")
    if docs:
        req["description"] = str(docs)

    # Body
    body = http.get("body", {})
    if body and body.get("type") == "json" and body.get("data"):
        req["body"] = {
            "mode": "raw",
            "raw": str(body["data"]),
            "options": {"raw": {"language": "json"}},
        }

    return req


def build_item(bruno: dict, file_path: Path) -> dict:
    item: dict = {
        "name": bruno["info"]["name"],
        "request": build_request(bruno, file_path),
    }
    if has_login_script(bruno):
        item["event"] = [POSTMAN_LOGIN_SCRIPT]
    return item


def sorted_yml_entries(folder: Path) -> list[Path]:
    """Return .yml request files sorted by their seq field, then name."""
    entries = []
    for f in folder.iterdir():
        if f.suffix == ".yml" and f.name not in ("folder.yml", "opencollection.yml"):
            try:
                data = load_yaml(f)
                seq = data.get("info", {}).get("seq", 9999)
            except Exception:
                seq = 9999
            entries.append((seq, f.name, f))
    entries.sort(key=lambda x: (x[0], x[1]))
    return [e[2] for e in entries]


def sorted_subfolder_entries(folder: Path) -> list[Path]:
    """Return subdirectories sorted by their folder.yml seq field, then name."""
    entries = []
    for d in folder.iterdir():
        if d.is_dir():
            folder_yml = d / "folder.yml"
            seq = 9999
            if folder_yml.exists():
                try:
                    data = load_yaml(folder_yml)
                    seq = data.get("info", {}).get("seq", 9999)
                except Exception:
                    pass
            entries.append((seq, d.name, d))
    entries.sort(key=lambda x: (x[0], x[1]))
    return [e[2] for e in entries]


def build_folder(folder: Path) -> dict:
    folder_yml_path = folder / "folder.yml"
    name = folder.name
    description = ""
    if folder_yml_path.exists():
        data = load_yaml(folder_yml_path)
        name = data.get("info", {}).get("name", name)
        docs = data.get("docs", "")
        if isinstance(docs, dict):
            docs = docs.get("content", "")
        description = str(docs) if docs else ""

    items = []

    # Request files first (sorted by seq)
    for f in sorted_yml_entries(folder):
        try:
            bruno = load_yaml(f)
            if bruno.get("info", {}).get("type") == "http":
                items.append(build_item(bruno, f))
        except Exception as e:
            print(f"  Warning: skipping {f}: {e}", file=sys.stderr)

    # Then subfolders (sorted by seq)
    for sub in sorted_subfolder_entries(folder):
        items.append(build_folder(sub))

    result: dict = {"name": name, "item": items}
    if description:
        result["description"] = description
    return result


def build_collection(root: Path) -> dict:
    meta = load_yaml(root / "opencollection.yml")
    info_name = meta.get("info", {}).get("name", "MulaPay Core API")
    docs = meta.get("docs", {})
    description = docs.get("content", "") if isinstance(docs, dict) else str(docs)

    variables = []
    for v in meta.get("request", {}).get("variables", []):
        # Never copy live values (tokens, keys, passwords) into the exported file.
        # baseUrl is safe to carry over; everything else is blanked.
        safe_value = str(v.get("value", "")) if v["name"] == "baseUrl" else ""
        variables.append({"key": v["name"], "value": safe_value, "type": "string"})

    items = []
    for sub in sorted_subfolder_entries(root):
        items.append(build_folder(sub))

    return {
        "info": {
            "_postman_id": "5c544434-9b24-41ed-806f-c5b01045a7dc",
            "name": info_name,
            "description": description,
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "variable": variables,
        "auth": {
            "type": "bearer",
            "bearer": [{"key": "token", "value": "{{accessToken}}", "type": "string"}],
        },
        "item": items,
    }


if __name__ == "__main__":
    if not BRUNO_ROOT.exists():
        print(f"Bruno collection not found at {BRUNO_ROOT}", file=sys.stderr)
        sys.exit(1)

    try:
        import yaml
    except ImportError:
        print("pyyaml not installed. Run: pip3 install pyyaml", file=sys.stderr)
        sys.exit(1)

    print(f"Reading Bruno collection from: {BRUNO_ROOT}")
    collection = build_collection(BRUNO_ROOT)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(collection, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Written: {OUT_FILE}")

    # Quick sanity check
    with open(OUT_FILE) as f:
        col = json.load(f)
    total = sum(
        1
        for top in col["item"]
        for mid in top.get("item", [])
        for req in mid.get("item", [top]) if "request" in req
    )
    print(f"Top-level folders: {len(col['item'])}")
