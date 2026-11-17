"""Verze agenta: archiv vydanych verzi, cilova verze (globalni i pro konkretni PC), vykresleni skriptu a jeho SHA-256."""
import hashlib
import json
import os
import re

AGENT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent")
RELEASES_DIR = os.path.join(AGENT_DIR, "releases")
MASTER = os.path.join(AGENT_DIR, "hwsw-agent.ps1")
_VER = re.compile(r"^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$")
_cache = {}


def parse(version):
    m = _VER.match(str(version or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


def current_version():
    """Nejnovejsi verze agenta = obsah souboru AGENT_VERSION."""
    with open(os.path.join(AGENT_DIR, "AGENT_VERSION"), encoding="utf-8") as f:
        return f.read().strip()


def is_legacy(version):
    p = parse(version)
    return p is None or p < (2, 0, 0)


def releases():
    """Dostupne verze (nejnovejsi prvni): {version, date, notes, legacy, latest}."""
    try:
        with open(os.path.join(RELEASES_DIR, "releases.json"), encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        meta = []
    latest = current_version()
    out = []
    for r in meta:
        v = r.get("version")
        if parse(v) and (v == latest or os.path.isfile(os.path.join(RELEASES_DIR, "hwsw-agent-%s.ps1" % v))):
            out.append({"version": v, "date": r.get("date", ""), "notes": r.get("notes", ""),
                        "legacy": is_legacy(v), "latest": v == latest})
    if latest not in [r["version"] for r in out]:
        out.append({"version": latest, "date": "", "notes": "", "legacy": is_legacy(latest), "latest": True})
    out.sort(key=lambda r: parse(r["version"]), reverse=True)
    return out


def known(version):
    return version in [r["version"] for r in releases()]


def global_target(cfg):
    """Globalni cilova verze: nastavena administratorem, jinak nejnovejsi."""
    chosen = (cfg.get("agent_target_version") or "").strip()
    return chosen if chosen and known(chosen) else current_version()


def effective_target(cfg, pinned):
    pinned = (pinned or "").strip()
    return pinned if pinned and known(pinned) else global_target(cfg)


def _path(version):
    return MASTER if version == current_version() else os.path.join(RELEASES_DIR, "hwsw-agent-%s.ps1" % version)


def render(version, base, token, mode, pin):
    """Skript dane verze s dosazenou adresou serveru, tokenem, rezimem a otiskem certifikatu (bajty vcetne BOM)."""
    key = (version, base, token, mode, pin)
    path = _path(version)
    stamp = os.stat(path).st_mtime
    hit = _cache.get(key)
    if hit and hit[0] == stamp:
        return hit[1]
    with open(path, encoding="utf-8") as f:
        script = f.read()
    script = (script.replace("__SERVER_URL__", base).replace("__TOKEN__", token)
              .replace("__MODE__", mode).replace("__VERSION__", version).replace("__CERT_PIN__", pin))
    data = ("﻿" + script).encode("utf-8")
    if len(_cache) > 64:
        _cache.clear()
    _cache[key] = (stamp, data)
    return data


def sha256(data):
    return hashlib.sha256(data).hexdigest()
