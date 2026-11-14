"""Zpracovani dat od agentu a ze skenovani: parovani zarizeni, HW, SW, monitory, USB."""
import json
import re

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


def sync_usb(conn, device, usb_list, user):
    """Porovna hlasena USB zarizeni se stavem v DB, zapise udalosti. Vraci nove udalosti."""
    dev_id = device["id"]
    reported = {}
    for u in usb_list or []:
        if not isinstance(u, dict):
            continue
        pnp = s(u.get("pnp_id"), 400).upper()
        if pnp:
            reported[pnp] = u
    current = {r["pnp_id"]: r for r in conn.execute("SELECT * FROM usb_current WHERE device_id = ?", (dev_id,))}
    baseline = bool(device["usb_baseline"])
    events = []
    ts = now()
    for pnp, u in reported.items():
        if pnp in current:
            continue
        vals = (s(u.get("name")) or "USB zařízení", s(u.get("manufacturer")), s(u.get("vid"), 8).upper(),
                s(u.get("pid"), 8).upper(), s(u.get("serial")),
                USB_CLASSES.get(s(u.get("class"), 80).lower(), s(u.get("class"), 80)))
        conn.execute("INSERT INTO usb_current(device_id, pnp_id, name, manufacturer, vid, pid, serial, class, "
                     "connected_at) VALUES(?,?,?,?,?,?,?,?,?)", (dev_id, pnp) + vals + (ts,))
        if baseline:
            conn.execute("INSERT INTO usb_events(device_id, ts, action, pnp_id, name, manufacturer, vid, pid, "
                         "serial, class, logged_user) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                         (dev_id, ts, "připojeno", pnp) + vals + (s(user),))
            events.append({"action": "připojeno", "name": vals[0], "class": vals[5], "serial": vals[4]})
    for pnp, r in current.items():
        if pnp in reported:
            continue
        conn.execute("DELETE FROM usb_current WHERE id = ?", (r["id"],))
        conn.execute("INSERT INTO usb_events(device_id, ts, action, pnp_id, name, manufacturer, vid, pid, "
                     "serial, class, logged_user) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     (dev_id, ts, "odpojeno", pnp, r["name"], r["manufacturer"], r["vid"], r["pid"],
                      r["serial"], r["class"], s(user)))
        events.append({"action": "odpojeno", "name": r["name"], "class": r["class"], "serial": r["serial"]})
    if not baseline:
        conn.execute("UPDATE devices SET usb_baseline = 1 WHERE id = ?", (dev_id,))
    for e in events:
        e.update({"ts": ts, "hostname": device["hostname"], "device_id": dev_id, "user": s(user)})
    return events


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
    return True


def upsert_scanned(conn, host):
    """Ulozi vysledek IP skenu. host: ip, mac, hostname, ports, device_type, description, vendor."""
    hostname = short_host(host.get("hostname"))
    mac = norm_mac(host.get("mac"))
    ip = s(host.get("ip"), 45)
    ts = now()
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
