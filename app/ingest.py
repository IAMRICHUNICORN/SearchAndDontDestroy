"""Zpracovani dat od agentu a ze skenovani: parovani zarizeni, HW, SW, monitory, USB."""
import calendar
import json
import re
import time

from .db import now

# Trimistne PNP kody vyrobcu monitoru (EDID)
MONITOR_VENDORS = {
    "ACI": "ASUS", "AUS": "ASUS", "ACR": "Acer", "AOC": "AOC", "APP": "Apple", "AUO": "AU Optronics",
    "BNQ": "BenQ", "BOE": "BOE", "CMN": "Chimei Innolux", "DEL": "Dell", "EIZ": "EIZO", "ENC": "EIZO",
    "FUS": "Fujitsu", "GBT": "Gigabyte", "GSM": "LG", "HPN": "HP", "HWP": "HP", "HSD": "HannStar",
    "IVM": "iiyama", "LEN": "Lenovo", "LGD": "LG Display", "MEI": "Panasonic", "MSI": "MSI",
    "NEC": "NEC", "PHL": "Philips", "SAM": "Samsung", "SDC": "Samsung Display", "SEC": "Samsung",
    "SHP": "Sharp", "SNY": "Sony", "VSC": "ViewSonic", "HKC": "HKC", "XMI": "Xiaomi", "HUA": "Huawei",
    "MED": "Medion", "TSB": "Toshiba", "LPL": "LG Philips", "IVO": "InfoVision", "CSO": "CSOT",
}
VIDEO_OUT = {
    -2: "neznámé", -1: "jiné", 0: "VGA", 1: "S-Video", 2: "kompozitní", 3: "komponentní", 4: "DVI",
    5: "HDMI", 6: "LVDS (interní)", 8: "D-JPN", 9: "SDI", 10: "DisplayPort", 11: "DisplayPort (interní)",
    12: "UDI", 13: "UDI (interní)", 14: "SDTV", 15: "Miracast", 16: "bezdrátové",
    2147483648: "interní panel",
}
LAPTOP_CHASSIS = {8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32}
DESKTOP_CHASSIS = {3, 4, 5, 6, 7, 13, 15, 16, 24, 35, 36}
SERVER_CHASSIS = {17, 23, 28}


USB_CLASSES = {
    "vstupni zarizeni (hid)": "vstupní zařízení (HID)", "uloziste": "úložiště",
    "slozene usb zarizeni": "složené USB zařízení", "tiskarna": "tiskárna", "kamera": "kamera", "zvuk": "zvuk",
    "telefon / prenosne zarizeni": "telefon / přenosné zařízení", "seriovy port": "sériový port",
    "skener": "skener", "usb zarizeni": "USB zařízení", "klavesnice": "klávesnice", "mys": "myš",
    "kamera / skener": "kamera / skener", "sitovy adapter": "síťový adaptér", "ctecka karet": "čtečka karet",
    "ctecka otisku": "čtečka otisků",
}


USB_STORAGE = "úložiště"   # evidujeme jen USB zarizeni pro ukladani dat a telefony / prenosna zarizeni
USB_PHONE = "telefon / přenosné zařízení"
USB_ALERT_CLASSES = (USB_STORAGE, USB_PHONE)


def s(value, limit=255):
    """Bezpecny retezec z libovolne hodnoty z JSON."""
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return ""
    return str(value).strip()[:limit]


def num(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def fnum(value):
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def norm_mac(value):
    hexs = re.sub(r"[^0-9A-Fa-f]", "", s(value))
    if len(hexs) != 12 or hexs in ("000000000000", "FFFFFFFFFFFF", "ffffffffffff"):
        return ""
    hexs = hexs.upper()
    return ":".join(hexs[i:i + 2] for i in range(0, 12, 2))


def short_host(value):
    return s(value).split(".")[0].upper()[:63]


def sam_of(user):
    user = s(user)
    if "\\" in user:
        user = user.split("\\", 1)[1]
    if "@" in user:
        user = user.split("@", 1)[0]
    return user


def find_device(conn, hostname="", mac="", ip="", allow_ip=False):
    if hostname:
        row = conn.execute("SELECT * FROM devices WHERE hostname = ? ORDER BY id LIMIT 1", (hostname,)).fetchone()
        if row:
            return row
    if mac:
        row = conn.execute("SELECT * FROM devices WHERE mac = ? ORDER BY id LIMIT 1", (mac,)).fetchone()
        if row and (not hostname or not row["hostname"]):
            return row
    if allow_ip and ip:
        row = conn.execute("SELECT * FROM devices WHERE ip = ? AND hostname = '' AND mac = '' "
                           "ORDER BY id LIMIT 1", (ip,)).fetchone()
        if row:
            return row
    return None


def _device_type(payload):
    system = payload.get("system") or {}
    os_name = s((payload.get("os") or {}).get("name")).lower()
    model = (s(system.get("model")) + " " + s(system.get("manufacturer"))).lower()
    chassis = set()
    raw = system.get("chassis")
    for c in (raw if isinstance(raw, list) else [raw]):
        chassis.add(num(c, -1))
    if any(k in model for k in ("virtual", "vmware", "kvm", "qemu", "hyper-v", "xen", "parallels")):
        return "virtuální server" if "server" in os_name else "virtuální počítač"
    if "server" in os_name or chassis & SERVER_CHASSIS:
        return "server"
    if chassis & LAPTOP_CHASSIS:
        return "notebook"
    if chassis & DESKTOP_CHASSIS:
        return "počítač"
    return "počítač"


def _volume(u):
    """Souhrn svazku USB uloziste z hlaseni agenta (pismeno, nazev, souborovy system, velikost, obsazeno, sifrovani)."""
    vols = [v for v in (u.get("volumes") or []) if isinstance(v, dict)]
    if not vols:
        return None
    size = sum(fnum(v.get("size_gb")) or 0 for v in vols)
    free = sum(fnum(v.get("free_gb")) or 0 for v in vols)
    enc = {s(v.get("encrypted"), 10).lower() for v in vols if s(v.get("encrypted"), 10)}
    return {"drive": ", ".join(s(v.get("drive"), 4) for v in vols if s(v.get("drive"), 4)),
            "label": s(vols[0].get("label"), 60), "fs": s(vols[0].get("fs"), 20),
            "size": round(size, 2), "used": round(max(0.0, size - free), 2),
            "enc": "ano" if enc == {"ano"} else ("ne" if "ne" in enc else "")}


def sync_usb(conn, device, usb_list, user):
    """Porovna hlasena USB uloziste se stavem v DB, zapise udalosti. Vraci nove udalosti.
    Evidujeme jen uloziste s mediem a telefony / prenosna zarizeni; ostatni tridy USB (mys, klavesnice, dongle...) se zahazuji.
    Agent od 2.2.0 posila u uloziste priznak media (false = prazdna ctecka, dock, kabel) - takove se nehlasi."""
    dev_id = device["id"]
    reported = {}
    for u in usb_list or []:
        if not isinstance(u, dict):
            continue
        pnp = s(u.get("pnp_id"), 400).upper()
        cls = USB_CLASSES.get(s(u.get("class"), 80).lower(), s(u.get("class"), 80))
        if not pnp or cls not in USB_ALERT_CLASSES:
            continue
        if cls == USB_STORAGE and u.get("media") is False:
            continue
        reported[pnp] = u
    current = {r["pnp_id"]: r for r in conn.execute("SELECT * FROM usb_current WHERE device_id = ?", (dev_id,))}
    baseline = bool(device["usb_baseline"])
    events = []
    ts = now()
    for pnp, u in reported.items():
        vol = _volume(u)
        if pnp in current:
            if vol:
                conn.execute("UPDATE usb_current SET drive=?, label=?, fs=?, size_gb=?, used_gb=?, encrypted=?, "
                             "used_start_gb=COALESCE(used_start_gb, ?) WHERE id=?",
                             (vol["drive"], vol["label"], vol["fs"], vol["size"], vol["used"], vol["enc"],
                              vol["used"], current[pnp]["id"]))
            continue
        vals = (s(u.get("name")) or "USB zařízení", s(u.get("manufacturer")), s(u.get("vid"), 8).upper(),
                s(u.get("pid"), 8).upper(), s(u.get("serial")),
                USB_CLASSES.get(s(u.get("class"), 80).lower(), s(u.get("class"), 80)))
        origin = "připojeno za provozu" if baseline else "nalezeno při první inventuře"
        conn.execute("INSERT INTO usb_current(device_id, pnp_id, name, manufacturer, vid, pid, serial, class, "
                     "connected_at, drive, label, fs, size_gb, used_gb, used_start_gb, encrypted, source) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (dev_id, pnp) + vals + (ts, vol["drive"] if vol else "", vol["label"] if vol else "",
                                             vol["fs"] if vol else "", vol["size"] if vol else None,
                                             vol["used"] if vol else None, vol["used"] if vol else None,
                                             vol["enc"] if vol else "", origin))
        action = "připojeno" if baseline else "nalezeno"
        conn.execute("INSERT INTO usb_events(device_id, ts, action, pnp_id, name, manufacturer, vid, pid, "
                     "serial, class, logged_user, drive, label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (dev_id, ts, action, pnp) + vals + (s(user), vol["drive"] if vol else "",
                                                         vol["label"] if vol else ""))
        events.append({"action": action, "name": vals[0], "class": vals[5], "serial": vals[4], "alert": True,
                       "label": vol["label"] if vol else "", "drive": vol["drive"] if vol else ""})
    for pnp, r in current.items():
        if pnp in reported:
            continue
        conn.execute("DELETE FROM usb_current WHERE id = ?", (r["id"],))
        delta = None
        if r["used_gb"] is not None and r["used_start_gb"] is not None:
            delta = round((r["used_gb"] - r["used_start_gb"]) * 1024, 1)
        # souhrn prenosu dat za dobu pripojeni
        tot = conn.execute(
            "SELECT SUM(CASE WHEN direction = 'na USB' THEN 1 ELSE 0 END) AS nt, SUM(CASE WHEN direction = 'z USB' THEN 1 ELSE 0 END) AS nf, "
            "SUM(CASE WHEN direction = 'na USB' THEN COALESCE(size_bytes, 0) ELSE 0 END) AS bt, "
            "SUM(CASE WHEN direction = 'z USB' THEN COALESCE(size_bytes, 0) ELSE 0 END) AS bf "
            "FROM usb_files WHERE device_id = ? AND pnp_id = ? AND ts >= ?", (dev_id, pnp, r["connected_at"] or "")).fetchone()
        conn.execute("INSERT INTO usb_events(device_id, ts, action, pnp_id, name, manufacturer, vid, pid, "
                     "serial, class, logged_user, drive, label, delta_mb, files_to, files_from, mb_to, mb_from) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (dev_id, ts, "odpojeno", pnp, r["name"], r["manufacturer"], r["vid"], r["pid"],
                      r["serial"], r["class"], s(user), r["drive"], r["label"], delta,
                      tot["nt"] or 0, tot["nf"] or 0, round((tot["bt"] or 0) / 1048576.0, 2), round((tot["bf"] or 0) / 1048576.0, 2)))
        events.append({"action": "odpojeno", "name": r["name"], "class": r["class"], "serial": r["serial"]})
    if not baseline:
        conn.execute("UPDATE devices SET usb_baseline = 1 WHERE id = ?", (dev_id,))
    for e in events:
        e.update({"ts": ts, "hostname": device["hostname"], "device_id": dev_id, "user": s(user)})
    return events


FILE_ACTIONS = {"zapis": "zápis", "prejmenovani": "přejmenování", "cteni": "čtení"}


def store_usb_files(conn, device, files, user):
    """Ulozi seznam souboru na USB uloziste (jen kdyz je funkce v Nastaveni zapnuta). Vraci pocet ulozenych.
    Smer: 'na USB' (zapis z watcheru agenta) nebo 'z USB' (cteni, z auditu Windows - jen kdyz je zapnuty usb_audit_enabled)."""
    row = conn.execute("SELECT value FROM settings WHERE key = 'usb_files_enabled'").fetchone()
    if not row or row["value"] != "1" or not isinstance(files, list):
        return 0
    arow = conn.execute("SELECT value FROM settings WHERE key = 'usb_audit_enabled'").fetchone()
    audit_on = bool(arow and arow["value"] == "1")
    cur = {r["pnp_id"]: r for r in conn.execute("SELECT pnp_id, name, drive FROM usb_current WHERE device_id = ?", (device["id"],))}
    by_drive = {}
    for r in cur.values():
        for d in (r["drive"] or "").split(","):
            if d.strip():
                by_drive[d.strip().upper()] = r
    n = 0
    for f in files[:1000]:
        if not isinstance(f, dict) or not s(f.get("path"), 500):
            continue
        direction = "z USB" if s(f.get("direction"), 10) == "z USB" else "na USB"
        if direction == "z USB" and not audit_on:
            continue
        size = f.get("size")
        pnp = s(f.get("pnp_id"), 400).upper()
        drive = s(f.get("drive"), 8)
        usb = cur.get(pnp) or by_drive.get(drive.upper())
        if usb is not None and not pnp:
            pnp = usb["pnp_id"]
        who = s(f.get("user"), 120) or s(user)
        # stejny soubor ve stejnem smeru se do peti minut nezapisuje znovu (cteni se v auditu opakuje)
        if conn.execute("SELECT 1 FROM usb_files WHERE device_id = ? AND path = ? AND direction = ? "
                        "AND ts >= datetime('now', '-5 minutes') LIMIT 1", (device["id"], s(f.get("path"), 500), direction)).fetchone():
            continue
        conn.execute("INSERT INTO usb_files(device_id, ts, pnp_id, drive, path, size_bytes, action, logged_user, direction, process, usb_name) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     (device["id"], now(),
                      pnp, drive, s(f.get("path"), 500),
                      num(size, None) if size is not None else None,
                      FILE_ACTIONS.get(s(f.get("action"), 30), "zápis" if direction == "na USB" else "čtení"), who, direction,
                      s(f.get("process"), 120), usb["name"] if usb is not None else ""))
        n += 1
    return n


def record_problem(conn, ip, hostname, kind, detail):
    """Zapise problem agenta (odmitnuty pozadavek, chyba agenta); opakovane stejne problemy se pocitaji."""
    ts = now()
    conn.execute("INSERT INTO agent_problems(first_ts, last_ts, ip, hostname, kind, detail, count) VALUES(?,?,?,?,?,?,1) "
                 "ON CONFLICT(ip, kind, detail) DO UPDATE SET last_ts=excluded.last_ts, count=count+1, "
                 "hostname=CASE WHEN excluded.hostname<>'' THEN excluded.hostname ELSE hostname END",
                 (ts, ts, s(ip, 45), s(hostname, 63), s(kind, 40), s(detail, 300)))


def log_agent_error(conn, dev_id, msg, at, is_new):
    """Historie chyb agenta po dnech (den, text, prvni a posledni vyskyt, pocet) - zustava k vyhledani i po oprave agenta.
    Pocita se jen nove hlaseni (stejnou chybu agent posila znovu pri kazdem spojeni, dokud ji server nepotvrdi)."""
    if not msg:
        return
    day = (at or now())[:10]
    if is_new:
        conn.execute("INSERT INTO agent_error_log(device_id, day, msg, first_ts, last_ts, count) VALUES(?,?,?,?,?,1) "
                     "ON CONFLICT(device_id, day, msg) DO UPDATE SET last_ts=excluded.last_ts, count=count+1",
                     (dev_id, day, msg, at, at))
    else:
        conn.execute("INSERT OR IGNORE INTO agent_error_log(device_id, day, msg, first_ts, last_ts, count) VALUES(?,?,?,?,?,1)",
                     (dev_id, day, msg, at, at))


def store_agent_state(conn, dev_id, payload, ts):
    """Zdravi agenta: cas posledniho kontaktu, informace o behu (prava, USB sledovani, hodiny, neuplna data) a posledni chyba."""
    info = payload.get("info")
    last_error = payload.get("last_error")
    row = conn.execute("SELECT agent_info FROM devices WHERE id = ?", (dev_id,)).fetchone()
    try:
        merged = json.loads(row["agent_info"] or "{}") if row else {}
    except ValueError:
        merged = {}
    if isinstance(info, dict):
        for k in ("elevated", "usb_watch", "partial", "inv_ms", "clock", "ps", "usb_files", "upd_state", "upd_target", "upd_at", "bad",
                  "watch_drives", "file_events", "file_last", "audit_events", "audit_state", "usb_audit"):
            if k in info:
                merged[k] = info[k] if isinstance(info[k], (bool, int, float)) else (
                    [s(x, 60) for x in info[k]][:20] if isinstance(info[k], list) else s(info[k], 80))
    clock = s(merged.get("clock"), 19) if isinstance(info, dict) and "clock" in info else ""
    if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", clock):
        try:
            merged["skew_s"] = int(calendar.timegm(time.strptime(clock, "%Y-%m-%d %H:%M:%S")) - time.time())
        except (ValueError, OverflowError):
            pass
    sets, vals = ["agent_beat=?", "agent_info=?"], [ts, json.dumps(merged, ensure_ascii=False)]
    ver = s(payload.get("agent_version"), 20)
    if re.match(r"^\d{1,4}\.\d{1,4}\.\d{1,4}$", ver):
        sets.append("agent_version=?")
        vals.append(ver)
    if isinstance(last_error, dict) and s(last_error.get("msg")):
        at = s(last_error.get("at"), 19)
        if not re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", at):
            at = ts
        sets += ["agent_error=?", "agent_error_at=?"]
        vals += [s(last_error.get("msg"), 300), at]
        dev = conn.execute("SELECT hostname, ip, agent_error_at FROM devices WHERE id = ?", (dev_id,)).fetchone()
        if dev and dev["agent_error_at"] != at:
            record_problem(conn, dev["ip"], dev["hostname"], "chyba agenta", s(last_error.get("msg"), 300))
        if dev:
            log_agent_error(conn, dev_id, s(last_error.get("msg"), 300), at, dev["agent_error_at"] != at)
    conn.execute("UPDATE devices SET %s WHERE id=?" % ", ".join(sets), vals + [dev_id])


def _sync_monitors(conn, dev_id, monitors):
    ts = now()
    conn.execute("UPDATE monitors SET connected = 0 WHERE device_id = ?", (dev_id,))
    for m in monitors or []:
        if not isinstance(m, dict):
            continue
        code = s(m.get("manufacturer"), 40)
        maker = MONITOR_VENDORS.get(code.upper(), code)
        internal = num(m.get("connection"), -2) in (6, 11, 13, 2147483648)
        model = s(m.get("model")) or ("vestavěný displej" if internal else "neznámý model")
        serial = s(m.get("serial"))
        if serial in ("0", "00000000", "16843009"):
            serial = ""
        year = num(m.get("year"), 0) or None
        size = None
        try:
            size = round(float(m.get("size_inch")), 1) if m.get("size_inch") else None
        except (TypeError, ValueError):
            size = None
        conn_code = m.get("connection")
        connection = VIDEO_OUT.get(num(conn_code, -2), "") if conn_code not in (None, "") else ""
        row = None
        if serial:
            row = conn.execute("SELECT id FROM monitors WHERE model = ? AND serial = ? ORDER BY id LIMIT 1",
                               (model, serial)).fetchone()
        if row is None:
            row = conn.execute("SELECT id FROM monitors WHERE device_id = ? AND model = ? AND serial = ? "
                               "AND connected = 0 ORDER BY id LIMIT 1", (dev_id, model, serial)).fetchone()
        if row:
            conn.execute("UPDATE monitors SET device_id=?, manufacturer=?, year=?, size_inch=?, connection=?, "
                         "connected=1, last_seen=? WHERE id=?",
                         (dev_id, maker, year, size, connection, ts, row["id"]))
        else:
            conn.execute("INSERT INTO monitors(device_id, manufacturer, model, serial, year, size_inch, "
                         "connection, connected, first_seen, last_seen) VALUES(?,?,?,?,?,?,?,1,?,?)",
                         (dev_id, maker, model, serial, year, size, connection, ts, ts))


def _sync_software(conn, dev_id, software, had_inventory):
    new = {}
    for item in software or []:
        if not isinstance(item, dict):
            continue
        name = s(item.get("name"))
        if not name:
            continue
        version = s(item.get("version"), 80)
        new[(name, version)] = (s(item.get("publisher")), s(item.get("install_date"), 20))
    old = {(r["name"], r["version"]) for r in
           conn.execute("SELECT name, version FROM software WHERE device_id = ?", (dev_id,))}
    if had_inventory:
        ts = now()
        for name, version in set(new) - old:
            conn.execute("INSERT INTO sw_changes(device_id, ts, action, name, version) VALUES(?,?,?,?,?)",
                         (dev_id, ts, "nainstalováno", name, version))
        for name, version in old - set(new):
            conn.execute("INSERT INTO sw_changes(device_id, ts, action, name, version) VALUES(?,?,?,?,?)",
                         (dev_id, ts, "odebráno", name, version))
    conn.execute("DELETE FROM software WHERE device_id = ?", (dev_id,))
    conn.executemany(
        "INSERT INTO software(device_id, name, version, publisher, install_date) VALUES(?,?,?,?,?)",
        [(dev_id, k[0], k[1], v[0], v[1]) for k, v in sorted(new.items())])


def ingest_inventory(conn, payload):
    """Ulozi kompletni inventuru z agenta. Vraci (device_id, usb udalosti)."""
    hostname = short_host(payload.get("hostname"))
    if not hostname:
        raise ValueError("chybí hostname")
    system = payload.get("system") or {}
    osinfo = payload.get("os") or {}
    mac = norm_mac(payload.get("primary_mac"))
    ip = s(payload.get("primary_ip"), 45)
    user = s(payload.get("user"))
    ts = now()

    cpus = [c for c in (payload.get("cpu") or []) if isinstance(c, dict)]
    cpu = s(cpus[0].get("name")) if cpus else ""
    cpu = re.sub(r"\s+", " ", cpu)
    if len(cpus) > 1:
        cpu = "%d× %s" % (len(cpus), cpu)
    disks = [d for d in (payload.get("disks") or []) if isinstance(d, dict)]
    disk_gb = sum(num(d.get("size_gb")) for d in disks)

    serial = s(system.get("serial"))
    if serial.lower() in ("to be filled by o.e.m.", "default string", "system serial number", "none", "0"):
        serial = ""

    details = {k: payload.get(k) for k in
               ("system", "os", "cpu", "ram_modules", "disks", "volumes", "gpus", "nics", "printers",
                "security", "licenses", "accounts", "network")}
    details_json = json.dumps(details, ensure_ascii=False)[:400000]

    device = find_device(conn, hostname, mac)
    if device is None:
        cur = conn.execute("INSERT INTO devices(hostname, first_seen, source) VALUES(?,?,?)",
                           (hostname, ts, "agent"))
        device = conn.execute("SELECT * FROM devices WHERE id = ?", (cur.lastrowid,)).fetchone()
    had_inventory = bool(device["last_inventory"])
    dev_type = _device_type(payload)
    # typ rucne zmeneny administratorem (napr. "pokladna") se neprepisuje
    auto_types = ("", "počítač", "notebook", "server", "virtuální server", "virtuální počítač",
                  "počítač (Windows)", "síťové zařízení", "neznámé")
    if device["device_type"] not in auto_types:
        dev_type = device["device_type"]

    conn.execute(
        """UPDATE devices SET hostname=?, fqdn=?, domain=?, ip=?, mac=?, device_type=?, manufacturer=?,
           model=?, serial=?, os_name=?, os_version=?, cpu=?, ram_mb=?, disk_gb=?, bios_version=?,
           logged_user=?, user_sam=?, source='agent', agent_version=?, online=1, last_seen=?,
           last_inventory=?, details=? WHERE id=?""",
        (hostname, s(payload.get("fqdn")), s(payload.get("domain")), ip or device["ip"], mac or device["mac"],
         dev_type, s(system.get("manufacturer")), s(system.get("model")), serial,
         s(osinfo.get("name")), s(osinfo.get("version"), 60), cpu, num(payload.get("ram_mb")), disk_gb,
         s(system.get("bios_version")), user or device["logged_user"], sam_of(user) or device["user_sam"],
         s(payload.get("agent_version"), 20), ts, ts, details_json, device["id"]))

    _track_login(conn, device["id"], user, ts, device["logged_user"], details.get("accounts"))
    store_agent_state(conn, device["id"], payload, ts)
    _sync_monitors(conn, device["id"], payload.get("monitors"))
    _sync_software(conn, device["id"], payload.get("software"), had_inventory)
    events = []
    if isinstance(payload.get("usb"), list):
        events = sync_usb(conn, device, payload.get("usb"), user)
    return device["id"], events


def _track_login(conn, device_id, user, ts, known_user="", accounts=None):
    """Zapamatuje, zda je uzivatel prave prihlasen, a kdy byl naposledy videt."""
    if user:
        conn.execute("UPDATE devices SET user_current=1, last_login_at=? WHERE id=?", (ts, device_id))
        return
    conn.execute("UPDATE devices SET user_current=0 WHERE id=?", (device_id,))
    if not known_user and accounts is not None:
        best = _profile_fallback(accounts)
        if best:
            conn.execute("UPDATE devices SET logged_user=?, user_sam=?, last_login_at=? WHERE id=?",
                         (best[0], sam_of(best[0]), best[1], device_id))


def _profile_fallback(accounts):
    """Kdyz nikdo neni prihlasen a server nezna zadneho uzivatele: nejnovejsi profil z agenta."""
    best = None
    for p in (accounts or {}).get("profiles") or []:
        if not isinstance(p, dict):
            continue
        name, when = s(p.get("user")), s(p.get("last_use"))
        if not name or not when or name.upper().startswith(("NT ", "S-1-")) or name.lower().endswith("\\defaultuser0"):
            continue
        if best is None or when > best[1]:
            best = (name, when)
    return best


def ingest_usb(conn, payload):
    hostname = short_host(payload.get("hostname"))
    device = find_device(conn, hostname) if hostname else None
    if device is None:
        return None, []
    user = s(payload.get("user"))
    conn.execute("UPDATE devices SET online=1, last_seen=?, logged_user=CASE WHEN ?<>'' THEN ? ELSE logged_user END, "
                 "user_sam=CASE WHEN ?<>'' THEN ? ELSE user_sam END WHERE id=?",
                 (now(), user, user, user, sam_of(user), device["id"]))
    _track_login(conn, device["id"], user, now())
    store_agent_state(conn, device["id"], payload, now())
    store_usb_files(conn, device, payload.get("files"), user)
    return device["id"], sync_usb(conn, device, payload.get("usb") or [], user)


def ingest_heartbeat(conn, payload):
    hostname = short_host(payload.get("hostname"))
    device = find_device(conn, hostname) if hostname else None
    if device is None:
        return False
    user = s(payload.get("user"))
    conn.execute("UPDATE devices SET online=1, last_seen=?, logged_user=CASE WHEN ?<>'' THEN ? ELSE logged_user END, "
                 "user_sam=CASE WHEN ?<>'' THEN ? ELSE user_sam END WHERE id=?",
                 (now(), user, user, user, sam_of(user), device["id"]))
    _track_login(conn, device["id"], user, now())
    store_agent_state(conn, device["id"], payload, now())
    store_usb_files(conn, device, payload.get("files"), user)
    return True


def upsert_scanned(conn, host):
    """Ulozi vysledek IP skenu. host: ip, mac, hostname, ports, device_type, description, vendor."""
    hostname = short_host(host.get("hostname"))
    mac = norm_mac(host.get("mac"))
    ip = s(host.get("ip"), 45)
    ts = now()
    if hostname and mac:
        # prejmenovane zarizeni (stejna MAC, jiny nazev): zaznam ze skenu/AD jen prejmenujeme, at nevznikne duplicita
        taken = conn.execute("SELECT 1 FROM devices WHERE hostname = ?", (hostname,)).fetchone()
        old = conn.execute("SELECT id FROM devices WHERE mac = ? AND source <> 'agent' AND hostname <> '' "
                           "AND hostname <> ? ORDER BY id LIMIT 1", (mac, hostname)).fetchone()
        if old and not taken:
            conn.execute("UPDATE devices SET hostname = ? WHERE id = ?", (hostname, old["id"]))
    device = find_device(conn, hostname, mac, ip, allow_ip=True)
    if device is None and ip:
        # zarizeni zname podle IP (napr. z minuleho skenu bez MAC)
        device = conn.execute("SELECT * FROM devices WHERE ip = ? AND source = 'sken' ORDER BY id LIMIT 1",
                              (ip,)).fetchone()
        if device is not None and hostname and device["hostname"] and device["hostname"] != hostname:
            device = None
    ports = ",".join(str(p) for p in host.get("ports") or [])
    if device is None:
        conn.execute(
            "INSERT INTO devices(hostname, ip, mac, device_type, model, manufacturer, open_ports, source, online, "
            "first_seen, last_seen) VALUES(?,?,?,?,?,?,?,'sken',1,?,?)",
            (hostname, ip, mac, s(host.get("device_type")) or "neznámé", s(host.get("description")),
             s(host.get("vendor")), ports, ts, ts))
        return True
    sets = ["ip=?", "open_ports=?", "online=1", "last_seen=?"]
    vals = [ip, ports, ts]
    if mac and not device["mac"]:
        sets.append("mac=?")
        vals.append(mac)
    if hostname and not device["hostname"]:
        sets.append("hostname=?")
        vals.append(hostname)
    if device["source"] != "agent":
        if host.get("device_type") and device["device_type"] in ("", "neznámé", "síťové zařízení"):
            sets.append("device_type=?")
            vals.append(s(host.get("device_type")))
        if host.get("description") and not device["model"]:
            sets.append("model=?")
            vals.append(s(host.get("description")))
        if host.get("vendor") and not device["manufacturer"]:
            sets.append("manufacturer=?")
            vals.append(s(host.get("vendor")))
    vals.append(device["id"])
    conn.execute("UPDATE devices SET %s WHERE id=?" % ", ".join(sets), vals)
    return False
