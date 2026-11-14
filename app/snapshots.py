"""Snimky stavu evidence: ulozeni pred cistym skenem a porovnani se soucasnym stavem."""
import json

from . import db, entities

_FIELDS = (("hostname", "Název"), ("ip", "IP adresa"), ("mac", "MAC adresa"), ("device_type", "Typ"),
           ("manufacturer", "Výrobce"), ("model", "Model"), ("os_name", "Operační systém"),
           ("section", "Sekce"), ("online", "Online"))
MAX_LIST = 2000


def _devices(conn):
    """Soucasna zarizeni vcetne sekce, SW, USB a monitoru (jmena)."""
    section = entities.ENTITIES["devices"]["columns"]["section"][1]
    rows = [dict(r) for r in conn.execute(
        "SELECT d.id, d.hostname, d.ip, d.mac, d.device_type, d.manufacturer, d.model, d.os_name, d.online, "
        "%s AS section FROM devices d ORDER BY d.id" % section)]
    by_id = {r["id"]: r for r in rows}
    for r in rows:
        r["software"], r["usb"], r["monitors"] = [], [], []
    for r in conn.execute("SELECT device_id, name FROM software ORDER BY name"):
        if r["device_id"] in by_id and len(by_id[r["device_id"]]["software"]) < MAX_LIST:
            by_id[r["device_id"]]["software"].append(r["name"])
    for r in conn.execute("SELECT device_id, name FROM usb_current ORDER BY name"):
        if r["device_id"] in by_id:
            by_id[r["device_id"]]["usb"].append(r["name"])
    for r in conn.execute("SELECT device_id, manufacturer, model FROM monitors WHERE connected = 1 ORDER BY id"):
        if r["device_id"] in by_id:
            by_id[r["device_id"]]["monitors"].append(((r["manufacturer"] or "") + " " + (r["model"] or "")).strip())
    return rows


def take(conn, label="", kind="ruční"):
    """Ulozi snimek vsech zarizeni. Vraci id snimku."""
    rows = _devices(conn)
    snap_id = conn.execute("INSERT INTO snapshots(taken_at, label, kind, device_count) VALUES(?,?,?,?)",
                           (db.now(), (label or "")[:120], kind, len(rows))).lastrowid
    for r in rows:
        conn.execute(
            "INSERT INTO snapshot_devices(snapshot_id, device_id, hostname, ip, mac, device_type, manufacturer, "
            "model, os_name, section, online, software, usb, monitors) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (snap_id, r["id"], r["hostname"] or "", r["ip"] or "", r["mac"] or "", r["device_type"] or "",
             r["manufacturer"] or "", r["model"] or "", r["os_name"] or "", r["section"] or "",
             1 if r["online"] else 0, json.dumps(r["software"], ensure_ascii=False),
             json.dumps(r["usb"], ensure_ascii=False), json.dumps(r["monitors"], ensure_ascii=False)))
    return snap_id


def list_all(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM snapshots ORDER BY id DESC")]


def delete(conn, snap_id):
    return conn.execute("DELETE FROM snapshots WHERE id = ?", (snap_id,)).rowcount


def _name(r):
    return r.get("hostname") or r.get("ip") or "(bez názvu)"


def _list(value):
    try:
        out = json.loads(value or "[]")
        return out if isinstance(out, list) else []
    except ValueError:
        return []


def compare(conn, snap_id):
    """Porovna snimek se soucasnym stavem: nova, zmizela a zmenena zarizeni."""
    snap = conn.execute("SELECT * FROM snapshots WHERE id = ?", (snap_id,)).fetchone()
    if snap is None:
        return None
    old = [dict(r) for r in conn.execute("SELECT * FROM snapshot_devices WHERE snapshot_id = ?", (snap_id,))]
    cur = _devices(conn)
    idx = {"id": {}, "mac": {}, "hostname": {}, "ip": {}}
    for r in cur:
        idx["id"][r["id"]] = r
        if r["mac"]:
            idx["mac"].setdefault(r["mac"].upper(), r)
        if r["hostname"]:
            idx["hostname"].setdefault(r["hostname"].upper(), r)
        if r["ip"] and not r["hostname"] and not r["mac"]:
            idx["ip"].setdefault(r["ip"], r)
    used = set()
    pairs, removed = [], []
    for o in old:
        found = None
        for kind, key in (("id", o["device_id"]), ("mac", (o["mac"] or "").upper()),
                          ("hostname", (o["hostname"] or "").upper()), ("ip", o["ip"])):
            if not key:
                continue
            c = idx[kind].get(key)
            if c is None or c["id"] in used:
                continue
            if kind == "id" and ((o["mac"] and c["mac"] and o["mac"].upper() != c["mac"].upper()) or
                                 (o["hostname"] and c["hostname"] and o["hostname"].upper() != c["hostname"].upper())):
                continue  # stejne id, ale uz jine zarizeni (po obnove databaze)
            found = c
            break
        if found is None:
            removed.append(o)
        else:
            used.add(found["id"])
            pairs.append((o, found))
    added = [r for r in cur if r["id"] not in used]

    changed = []
    for o, c in pairs:
        diffs = []
        for key, label in _FIELDS:
            a, b = o.get(key) or "", c.get(key) or ""
            if key == "online":
                a, b = ("online" if a else "offline"), ("online" if b else "offline")
            if str(a) != str(b):
                diffs.append({"field": label, "old": a, "new": b})
        for key, label in (("software", "Software"), ("usb", "USB úložiště"), ("monitors", "Monitory")):
            before, after = _list(o.get(key)), c.get(key) or []
            plus = sorted(set(after) - set(before))
            minus = sorted(set(before) - set(after))
            if plus or minus:
                diffs.append({"field": label, "added": plus[:30], "removed": minus[:30],
                              "added_n": len(plus), "removed_n": len(minus)})
        if diffs:
            changed.append({"name": _name(c), "device_id": c["id"], "diffs": diffs})
    fields = ("hostname", "ip", "mac", "device_type", "os_name")
    return {
        "snapshot": dict(snap),
        "now_count": len(cur),
        "added": [{k: r.get(k) or "" for k in fields} | {"name": _name(r), "device_id": r["id"]} for r in added],
        "removed": [{k: r.get(k) or "" for k in fields} | {"name": _name(r)} for r in removed],
        "changed": changed,
    }
