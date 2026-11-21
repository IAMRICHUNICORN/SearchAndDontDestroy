"""Security: vyhodnoceni zasadnich bezpecnostnich kontrol zarizeni (prehled, matice, karta PC) a vyjimky.

Kontroly se pocitaji ze stavajicich dat agenta (details.security, details.remote, os, zdravi agenta); novy agent neni potreba.
Stav kontroly: ok / warn / err / none (nezjisteno) / exc (vyjimka - pocita se jako v poradku, ale je oznacena).
"""
import datetime
import json
import re

from . import db, entities

CHECKS = [
    ("bitlocker", "Šifrování disku"),
    ("antivirus", "Antivirus"),
    ("firewall", "Firewall"),
    ("updates", "Aktualizace"),
    ("os", "Podpora OS"),
    ("rdp", "Vzdálená plocha"),
    ("disk", "Disk (S.M.A.R.T.)"),
    ("agent", "Agent"),
]
CHECK_KEYS = [k for k, _ in CHECKS]
RANK = {"err": 3, "warn": 2, "ok": 1, "exc": 1, "none": 0}

# konec podpory (podretezec nazvu OS, malymi pismeny -> datum); LTSC/IoT se nehodnoti
OS_EOL = [
    ("windows xp", "2014-04-08"), ("vista", "2017-04-11"), ("windows 7", "2020-01-14"), ("windows 8", "2023-01-10"),
    ("windows 10", "2025-10-14"),
    ("server 2003", "2015-07-14"), ("server 2008", "2020-01-14"), ("server 2012", "2023-10-10"),
    ("server 2016", "2027-01-12"), ("server 2019", "2029-01-09"), ("server 2022", "2031-10-14"), ("server 2025", "2034-10-10"),
]


def _cfg_int(cfg, key, default):
    try:
        return max(1, int(float(cfg.get(key) or default)))
    except (TypeError, ValueError):
        return default


def thresholds(cfg):
    return {"update_warn_days": _cfg_int(cfg, "sec_update_warn_days", 30),
            "update_err_days": _cfg_int(cfg, "sec_update_err_days", 60),
            "os_warn_days": _cfg_int(cfg, "sec_os_warn_days", 183)}


def _c(st, text="", hint="", days=None):
    out = {"st": st, "text": text}
    if hint:
        out["hint"] = hint
    if days is not None:
        out["days"] = days
    return out


def _short_os(name):
    m = re.search(r"windows server (\d{4}(?: r2)?)", name, re.I)
    if m:
        return "Server " + m.group(1)
    m = re.search(r"windows (xp|vista|7|8(?:\.1)?|10|11)", name, re.I)
    if m:
        return "Win " + m.group(1)
    return name[:14]


def _bool(v):
    if v is None or v == "":
        return None
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "ano")
    return bool(v)


def check_bitlocker(sec, dev):
    v = str(sec.get("bitlocker_os") or "").lower()
    if v == "ano":
        return _c("ok", "ano")
    if v == "ne":
        if dev.get("type") == "notebook":
            return _c("err", "ne", "Notebook bez šifrování disku: zapnout BitLocker (např. přes GPO)")
        return _c("warn", "ne", "Disk není šifrovaný (u stolního PC nebo serveru jen varování)")
    return _c("none", "?")


def check_antivirus(sec):
    av = [a for a in (sec.get("antivirus") or []) if isinstance(a, dict)]
    df = sec.get("defender") if isinstance(sec.get("defender"), dict) else {}
    on = [a for a in av if a.get("enabled")]
    if on:
        name = str(on[0].get("name") or "AV")[:24]
        if all(not a.get("up_to_date") for a in on):
            return _c("warn", "staré definice", "Antivirus má zastaralé definice: " + name)
        return _c("ok", name)
    if df.get("enabled"):
        if df.get("realtime") is False:
            return _c("warn", "bez ochrany v reálném čase", "Defender nemá zapnutou ochranu v reálném čase")
        return _c("ok", "Defender")
    if av or df or str(sec.get("antivirus_text") or "").lower() == "vypnuto":
        return _c("err", "vypnut", "Žádný antivirus není zapnutý")
    return _c("none", "?")


def check_firewall(sec):
    v = str(sec.get("firewall_text") or "").lower()
    if v == "zapnuto":
        return _c("ok", "ano")
    if v in ("castecne", "částečně"):
        return _c("warn", "částečně", "Firewall není zapnutý ve všech profilech (doména, soukromá, veřejná)")
    if v == "vypnuto":
        return _c("err", "vypnut", "Firewall je vypnutý")
    return _c("none", "?")


def check_updates(sec, th, today):
    last = str(sec.get("last_hotfix") or "")[:10]
    try:
        days = (today - datetime.date.fromisoformat(last)).days
    except ValueError:
        return _c("none", "?")
    days = max(0, days)
    if days >= th["update_err_days"]:
        return _c("err", "", "Aktualizace Windows jsou staré: spustit Windows Update", days)
    if days >= th["update_warn_days"]:
        return _c("warn", "", "Aktualizace Windows jsou starší než nastavený limit", days)
    return _c("ok", "", "", days)


def check_os(dev, th, today):
    name = str(dev.get("os_name") or "")
    low = name.lower()
    if not name:
        return _c("none", "?")
    if "windows" not in low:
        return _c("none", name[:14])
    if any(k in low for k in ("ltsc", "ltsb", "iot")):
        return _c("ok", _short_os(name) + " LTSC")
    for pat, eol in OS_EOL:
        if pat in low:
            end = datetime.date.fromisoformat(eol)
            left = (end - today).days
            if left < 0:
                return _c("err", _short_os(name), "Podpora systému skončila %s" % end.strftime("%d. %m. %Y"))
            if left <= th["os_warn_days"]:
                return _c("warn", _short_os(name), "Podpora systému končí %s" % end.strftime("%d. %m. %Y"))
            return _c("ok", _short_os(name))
    return _c("ok", _short_os(name))


def check_rdp(sec, remote):
    """RDP podle skutecneho stavu (agent 2.4.1+): posloucha se na portu RDP. Starsi agent skutecny stav neposila -> neovereno."""
    listening = remote.get("rdp_listening")
    if listening is None or "rdp_port" not in remote:
        return _c("none", "neověřeno", "Skutečný stav vzdálené plochy zatím nikdo nezjistil: počkejte na agenta 2.4.1 nebo novější")
    listening = _bool(listening)
    cfg = _bool(remote.get("rdp_cfg"))
    if cfg is None:
        cfg = _bool(sec.get("rdp_enabled"))
    nla = _bool(sec.get("rdp_nla"))
    if nla is None:
        nla = _bool(remote.get("rdp_nla"))
    if not listening:
        hint = ""
        if cfg:
            hint = "V nastavení je vzdálená plocha povolená, ale nikdo na portu neposlouchá (služba neběží nebo se ještě nespustila)"
        return _c("ok", "vypnuta", hint)
    if _bool(remote.get("rdp_fw")) is False:
        return _c("ok", "blokuje firewall", "Vzdálená plocha běží, ale firewall nemá povolené příchozí pravidlo, zvenku se nepřipojíte")
    if nla is False:
        return _c("err", "bez NLA", "Vzdálená plocha běží bez ověření NLA")
    return _c("warn", "zapnuta", "Vzdálená plocha běží (ověření NLA je zapnuté)")


def check_disk(sec):
    v = sec.get("disk_failure_predicted")
    if v is None or v == "":
        return _c("none", "?")
    if _bool(v):
        return _c("err", "hrozí selhání", "Disk hlásí blížící se selhání (S.M.A.R.T.): zálohovat a vyměnit")
    return _c("ok", "OK")


def check_agent(health, reason):
    h = health or ""
    if h == "v pořádku":
        return _c("ok", "OK")
    if h == "varování":
        return _c("warn", "varování", reason or "")
    if h == "bez agenta":
        return _c("err", "bez agenta", "Na zařízení není agent: bez něj nejsou k dispozici údaje o zabezpečení")
    if h == "chyba":
        return _c("err", "chyba", reason or "")
    return _c("none", "?")


def evaluate(dev, details, health, reason, cfg, today=None):
    """dev: {type, os_name}; vraci {kontrola: {st, text, hint, days}} a nejhorsi uroven zarizeni."""
    today = today or datetime.date.today()
    th = thresholds(cfg)
    sec = details.get("security") if isinstance(details.get("security"), dict) else {}
    remote = details.get("remote") if isinstance(details.get("remote"), dict) else {}
    checks = {
        "bitlocker": check_bitlocker(sec, dev),
        "antivirus": check_antivirus(sec),
        "firewall": check_firewall(sec),
        "updates": check_updates(sec, th, today),
        "os": check_os(dev, th, today),
        "rdp": check_rdp(sec, remote),
        "disk": check_disk(sec),
        "agent": check_agent(health, reason),
    }
    return checks


def apply_exceptions(checks, exc):
    """exc: {kontrola: {note, by, ts}}; kontrola s vyjimkou zustane viditelna jako 'exc' (pocita se jako v poradku)."""
    for k, e in (exc or {}).items():
        c = checks.get(k)
        if not c:
            continue
        c["orig"] = c["st"]
        c["st"] = "exc"
        c["note"] = e.get("note", "")
        c["by"] = e.get("by", "")
        c["ts"] = e.get("ts", "")
    return checks


def level(checks):
    worst = max((RANK[c["st"]] for c in checks.values()), default=0)
    if any(c["st"] == "err" for c in checks.values()):
        return "err"
    if any(c["st"] == "warn" for c in checks.values()):
        return "warn"
    return "ok" if worst > 0 else "none"


def exceptions_for(conn, device_id=None):
    sql = "SELECT device_id, check_key, note, by_user, ts FROM security_exceptions"
    args = ()
    if device_id is not None:
        sql += " WHERE device_id = ?"
        args = (device_id,)
    out = {}
    for r in conn.execute(sql, args):
        out.setdefault(r["device_id"], {})[r["check_key"]] = {"note": r["note"], "by": r["by_user"], "ts": r["ts"]}
    return out


def device_eval(conn, dev_id, dev, details, health="", reason=""):
    """Vyhodnoceni jednoho zarizeni pro kartu PC."""
    cfg = db.get_settings(conn)
    checks = evaluate(dev, details, health, reason, cfg)
    apply_exceptions(checks, exceptions_for(conn, dev_id).get(dev_id))
    return {"checks": checks, "level": level(checks), "thresholds": thresholds(cfg)}


def overview(conn):
    """Prehled flotily: radky (pocitace a servery), souhrn po kontrolach a prahy."""
    cfg = db.get_settings(conn)
    th = thresholds(cfg)
    cols = ["hostname", "ip", "device_type", "section", "logged_user", "os_name", "location", "online",
            "agent_health", "agent_health_reason"]
    _m, rows, _t = entities.run_query(conn, "devices", cols, limit=0)
    details = {}
    for r in conn.execute("SELECT id, details FROM devices"):
        try:
            details[r["id"]] = json.loads(r["details"] or "{}")
        except ValueError:
            details[r["id"]] = {}
    groups = {}
    for r in conn.execute("SELECT device_id, group_id FROM device_group_members"):
        groups.setdefault(r["device_id"], []).append(r["group_id"])
    exc = exceptions_for(conn)
    today = datetime.date.today()
    out = []
    summary = {k: {"err": 0, "warn": 0, "exc": 0, "none": 0, "ok": 0} for k in CHECK_KEYS}
    for r in rows:
        if r.get("section") not in ("Počítače", "Servery"):
            continue
        did = r["_device_id"]
        dev = {"type": r.get("device_type") or "", "os_name": r.get("os_name") or ""}
        checks = evaluate(dev, details.get(did, {}), r.get("agent_health"), r.get("agent_health_reason"), cfg, today)
        apply_exceptions(checks, exc.get(did))
        lv = level(checks)
        for k, c in checks.items():
            summary[k][c["st"]] += 1
        out.append({"id": did, "name": r.get("hostname") or r.get("ip") or "", "ip": r.get("ip") or "",
                    "user": r.get("logged_user") or "", "type": dev["type"], "section": r.get("section"),
                    "os": dev["os_name"], "location": r.get("location") or "", "online": bool(r.get("online")),
                    "groups": groups.get(did, []), "level": lv, "checks": checks})
    order = {"err": 0, "warn": 1, "ok": 2, "none": 3}
    out.sort(key=lambda x: (order[x["level"]], sum(1 for c in x["checks"].values() if c["st"] == "err") * -1,
                            x["name"].lower()))
    total = len(out)
    return {"rows": out, "summary": summary, "total": total,
            "ok": sum(1 for x in out if x["level"] == "ok"), "err": sum(1 for x in out if x["level"] == "err"),
            "warn": sum(1 for x in out if x["level"] == "warn"), "checks": [{"key": k, "label": l} for k, l in CHECKS],
            "thresholds": th}


# poradi, ve kterem se vybira nejzavaznejsi problem pro sloupec Security (agent se hodnoti zvlast: sloupec Chyba agenta)
PROBLEM_ORDER = ["os", "bitlocker", "antivirus", "firewall", "updates", "rdp", "disk"]
LEVEL_CS = {"err": "chyba", "warn": "varování", "ok": "v pořádku", "none": ""}


def refresh_temp(conn):
    """Naplni docasnou tabulku se stavem Security (bez kontroly agenta), aby ji mohl seznam zarizeni radit a filtrovat."""
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS sec_tmp (device_id INTEGER PRIMARY KEY, level TEXT, problem TEXT)")
    conn.execute("DELETE FROM temp.sec_tmp")
    labels = dict(CHECKS)
    for r in overview(conn)["rows"]:
        cs = {k: v for k, v in r["checks"].items() if k != "agent"}
        bad = [(k, cs[k]) for k in PROBLEM_ORDER if k in cs and cs[k]["st"] in ("err", "warn")]
        errs = [b for b in bad if b[1]["st"] == "err"]
        main = (errs or bad or [None])[0]
        lv = "err" if errs else ("warn" if bad else level(cs))
        text = ""
        if main:
            text = labels[main[0]] + ((": " + main[1]["text"]) if main[1].get("text") and main[0] not in ("updates",) else "")
            if len(bad) > 1:
                text += " +%d" % (len(bad) - 1)
        conn.execute("INSERT OR REPLACE INTO temp.sec_tmp (device_id, level, problem) VALUES (?, ?, ?)",
                     (r["id"], LEVEL_CS.get(lv, ""), text))
