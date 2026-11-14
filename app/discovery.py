"""Zjistovani zarizeni: sken IP rozsahu, Active Directory (LDAP), WinRM, planovac uloh."""
import asyncio
import ipaddress
import os
import platform
import random
import re
import socket
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import db, ingest, snapshots, tls
from .bus import bus

MAX_SCAN_HOSTS = 8192
SCAN_PORTS = [22, 23, 80, 135, 139, 443, 445, 515, 631, 3389, 5985, 8080, 9100]


# ------------------------------------------------------------ IP rozsahy

def parse_ranges(text):
    """'192.168.1.0/24, 10.0.0.5-10.0.0.40' -> seznam IP adres (max MAX_SCAN_HOSTS)."""
    ips, seen = [], set()
    for part in re.split(r"[\s,;]+", text or ""):
        if not part:
            continue
        try:
            if "-" in part:
                a, b = part.split("-", 1)
                start = ipaddress.IPv4Address(a.strip())
                b = b.strip()
                end = ipaddress.IPv4Address(b if "." in b else "%s.%s" % (str(start).rsplit(".", 1)[0], b))
                if int(end) < int(start):
                    start, end = end, start
                rng = range(int(start), int(end) + 1)
                items = (ipaddress.IPv4Address(i) for i in rng)
            elif "/" in part:
                items = ipaddress.IPv4Network(part, strict=False).hosts()
            else:
                items = [ipaddress.IPv4Address(part)]
        except ValueError:
            raise ValueError("Neplatný rozsah: %s" % part)
        for ip in items:
            if ip not in seen:
                seen.add(ip)
                ips.append(str(ip))
                if len(ips) > MAX_SCAN_HOSTS:
                    raise ValueError("Rozsah je příliš velký (max %d adres na jeden sken)" % MAX_SCAN_HOSTS)
    return ips


# ------------------------------------------------------------ sitove sondy

def netbios_query(ip, timeout=1.0):
    """NetBIOS node status: vraci (jmeno, skupina, MAC) nebo None."""
    packet = struct.pack(">HHHHHH", random.randint(1, 65535), 0, 1, 0, 0, 0)
    packet += b"\x20CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\x00" + struct.pack(">HH", 0x21, 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(packet, (ip, 137))
        data, _ = sock.recvfrom(2048)
    except OSError:
        return None
    finally:
        sock.close()
    try:
        count = data[56]
        name = group = ""
        pos = 57
        for _ in range(count):
            raw, suffix, flags = data[pos:pos + 15], data[pos + 15], struct.unpack(">H", data[pos + 16:pos + 18])[0]
            text = raw.decode("ascii", "replace").strip()
            if suffix == 0x00:
                if flags & 0x8000:
                    group = group or text
                else:
                    name = name or text
            pos += 18
        mac = ":".join("%02X" % b for b in data[pos:pos + 6])
        return name, group, ingest.norm_mac(mac)
    except (IndexError, struct.error):
        return None


def _ber(tag, payload):
    n = len(payload)
    if n < 128:
        return bytes([tag, n]) + payload
    size = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([tag, 0x80 | len(size)]) + size + payload


def _ber_parse(data):
    """Rozlozi BER data na seznam (tag, hodnota); konstruovane typy rekurzivne."""
    out, pos = [], 0
    while pos + 2 <= len(data):
        tag = data[pos]
        length = data[pos + 1]
        pos += 2
        if length & 0x80:
            n = length & 0x7F
            length = int.from_bytes(data[pos:pos + n], "big")
            pos += n
        value = data[pos:pos + length]
        pos += length
        out.append((tag, _ber_parse(value) if tag & 0x20 else value))
    return out


def snmp_sysinfo(ip, community="public", timeout=1.5):
    """SNMP v2c GET sysDescr + sysName. Vraci (popis, jmeno) nebo None."""
    def varbind(last):
        oid = bytes([0x2B, 6, 1, 2, 1, 1, last, 0])
        return _ber(0x30, _ber(0x06, oid) + b"\x05\x00")
    req_id = random.randint(0x10000000, 0x7FFFFFFF)
    pdu = _ber(0xA0, _ber(0x02, req_id.to_bytes(4, "big")) + b"\x02\x01\x00\x02\x01\x00"
               + _ber(0x30, varbind(1) + varbind(5)))
    packet = _ber(0x30, b"\x02\x01\x01" + _ber(0x04, community.encode()) + pdu)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(packet, (ip, 161))
        data, _ = sock.recvfrom(4096)
    except OSError:
        return None
    finally:
        sock.close()
    try:
        message = _ber_parse(data)[0][1]
        pdu_items = message[2][1]
        values = []
        for _tag, vb in pdu_items[3][1]:
            val = vb[1][1]
            values.append(val.decode("utf-8", "replace").strip() if isinstance(val, bytes) else "")
        return (values + ["", ""])[0], (values + ["", ""])[1]
    except (IndexError, TypeError):
        return None


def arp_table():
    table = {}
    try:
        with open("/proc/net/arp", encoding="ascii", errors="replace") as f:
            for line in f.readlines()[1:]:
                cols = line.split()
                if len(cols) >= 4 and cols[2] != "0x0":
                    mac = ingest.norm_mac(cols[3])
                    if mac:
                        table[cols[0]] = mac
    except OSError:
        pass
    return table


def reverse_dns(ip):
    try:
        return socket.gethostbyaddr(ip)[0]
    except OSError:
        return ""


def guess_type(ports, descr, netbios):
    d = (descr or "").lower()
    p = set(ports)
    checks = [
        (("printer", "laserjet", "officejet", "deskjet", "pagewide", "tiskárna", "mfp", "kyocera", "ricoh",
          "konica", "brother", "xerox", "lexmark", "epson", "oki ", "canon", "sharp mx", "bizhub"), "tiskárna"),
        (("qnap", "synology", "diskstation", "truenas", "freenas", "readynas", " nas"), "NAS"),
        (("switch", "procurve", "catalyst", "aruba", "edgeswitch", "powerconnect", "jetstream", "comware"), "switch"),
        (("router", "routeros", "mikrotik", "fortigate", "fortinet", "pfsense", "opnsense", "edgerouter",
          "sophos", "firewall", "zyxel", "draytek"), "router / firewall"),
        (("access point", "unifi", "uap", "wireless", "wlan", " ap "), "Wi-Fi AP"),
        (("ups", "apc ", "eaton", "smart-ups"), "UPS"),
        (("camera", "hikvision", "dahua", "axis ", "ipcam"), "IP kamera"),
        (("vmware esx", "esxi", "proxmox", "hyper-v"), "hypervizor"),
        (("windows",), "počítač (Windows)"),
        (("linux",), "Linux zařízení"),
    ]
    for words, label in checks:
        if any(w in d for w in words):
            return label
    if p & {9100, 515, 631} and not p & {445, 3389}:
        return "tiskárna"
    if netbios or p & {135, 445, 3389, 5985}:
        return "počítač (Windows)"
    if 22 in p:
        return "Linux zařízení"
    if p & {80, 443, 23, 8080}:
        return "síťové zařízení"
    return "neznámé"


async def _tcp_open(ip, port, timeout=1.0):
    try:
        _r, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout)
        writer.close()
        return True
    except (OSError, asyncio.TimeoutError):
        return False


_PING_ARGS = ["-c", "1", "-W", "1000" if platform.system() == "Darwin" else "1"]


async def _ping(ip):
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", *_PING_ARGS, ip, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        return await asyncio.wait_for(proc.wait(), 4) == 0
    except (OSError, asyncio.TimeoutError):
        return False


async def _scan_all(ips, community):
    sem = asyncio.Semaphore(96)
    loop = asyncio.get_event_loop()
    pool = ThreadPoolExecutor(max_workers=32)
    results = []

    async def one(ip):
        async with sem:
            checks = await asyncio.gather(_ping(ip), *[_tcp_open(ip, p) for p in SCAN_PORTS])
            ports = [p for p, ok in zip(SCAN_PORTS, checks[1:]) if ok]
            if not (checks[0] or ports):
                return
            nb, snmp, dns = await asyncio.gather(
                loop.run_in_executor(pool, netbios_query, ip),
                loop.run_in_executor(pool, snmp_sysinfo, ip, community) if community else asyncio.sleep(0),
                loop.run_in_executor(pool, reverse_dns, ip))
            descr = snmp[0] if snmp else ""
            hostname = (nb[0] if nb and nb[0] else "") or (dns or "") or (snmp[1] if snmp else "")
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", hostname or ""):
                hostname = ""
            results.append({
                "ip": ip, "ports": ports, "hostname": hostname, "mac": nb[2] if nb else "",
                "device_type": guess_type(ports, descr, bool(nb and nb[0])),
                "description": re.sub(r"\s+", " ", descr)[:200],
            })

    try:
        await asyncio.gather(*[one(ip) for ip in ips])
    finally:
        pool.shutdown(wait=False)
    return results


def job_ip_scan():
    with db.db() as conn:
        cfg = db.get_settings(conn)
    ips = parse_ranges(cfg["scan_ranges"])
    if not ips:
        return "Není zadán žádný IP rozsah"
    results = asyncio.run(_scan_all(ips, cfg.get("snmp_community", "").strip()))
    arp = arp_table()
    new = 0
    with db.db() as conn:
        for host in results:
            if not host["mac"]:
                host["mac"] = arp.get(host["ip"], "")
            if ingest.upsert_scanned(conn, host):
                new += 1
    return "Prohledáno %d adres, nalezeno %d zařízení, z toho %d nových" % (len(ips), len(results), new)


def clean_scan_data(conn):
    """Smaze jen to, co vzniklo samotnym skenem: zarizeni nalezena jen skenem, bez agenta, bez rucnich udaju,
    bez skupiny a bez SW. U ostatnich zarizeni (mimo agenta) vynuluje online stav a porty. Vraci pocet smazanych."""
    removed = conn.execute(
        "DELETE FROM devices WHERE source = 'sken' AND COALESCE(last_inventory, '') = '' "
        "AND COALESCE(agent_version, '') = '' AND COALESCE(asset_tag, '') = '' AND COALESCE(location, '') = '' "
        "AND COALESCE(assigned_user, '') = '' AND COALESCE(note, '') = '' AND section_manual IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM device_group_members m WHERE m.device_id = devices.id) "
        "AND NOT EXISTS (SELECT 1 FROM software s WHERE s.device_id = devices.id)").rowcount
    conn.execute("UPDATE devices SET online = 0, open_ports = '' WHERE source <> 'agent'")
    return removed


def job_clean_scan():
    """Cisty sken: snimek stavu + zaloha DB, smazani udaju ze skenu, novy sken IP rozsahu."""
    with db.db() as conn:
        cfg = db.get_settings(conn)
        if not parse_ranges(cfg["scan_ranges"]):
            return "Není zadán žádný IP rozsah – nic nebylo smazáno"
        snap_id = snapshots.take(conn, "Před čistým skenem", "před čistým skenem")
    backup = db.backup_db("pre-clean-scan")
    with db.db() as conn:
        removed = clean_scan_data(conn)
    result = job_ip_scan()
    return "Snímek č. %d, záloha %s, odstraněno %d záznamů ze skenu. %s" % (snap_id, backup, removed, result)


# ------------------------------------------------------- Active Directory

def _first(value):
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    return "" if value is None else str(value)


def _filetime(value):
    try:
        ft = int(_first(value))
    except ValueError:
        return ""
    if ft <= 0:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ft / 10000000 - 11644473600))


def _ou_of(dn):
    parts = re.split(r"(?<!\\),", dn)
    ous = [p[3:] for p in parts[1:] if p.upper().startswith(("OU=", "CN="))]
    return " / ".join(reversed(ous))


def _ad_connect(cfg):
    import ldap3
    if not cfg["ad_server"] or not cfg["ad_user"]:
        raise ValueError("Vyplňte adresu řadiče domény a přihlašovací účet")
    server = ldap3.Server(cfg["ad_server"], use_ssl=cfg["ad_use_ssl"] == "1", get_info=ldap3.DSA,
                          connect_timeout=10)
    auth = ldap3.NTLM if "\\" in cfg["ad_user"] else ldap3.SIMPLE
    conn = ldap3.Connection(server, user=cfg["ad_user"], password=cfg["ad_password"], authentication=auth,
                            auto_bind=True, receive_timeout=60, read_only=True)
    base = cfg["ad_base_dn"].strip()
    if not base and server.info is not None:
        base = _first(server.info.other.get("defaultNamingContext"))
    if not base:
        raise ValueError("Nepodařilo se zjistit Base DN, vyplňte ho ručně (např. DC=firma,DC=local)")
    return conn, base


def _ad_search(conn, base, flt, attrs):
    import ldap3
    for entry in conn.extend.standard.paged_search(base, flt, search_scope=ldap3.SUBTREE, attributes=attrs,
                                                   paged_size=500, generator=True):
        if entry.get("type") == "searchResEntry":
            yield entry.get("dn", ""), entry.get("raw_attributes") or entry.get("attributes") or {}


def ad_test(cfg):
    conn, base = _ad_connect(cfg)
    try:
        computers = sum(1 for _ in _ad_search(conn, base, "(objectCategory=computer)", ["name"]))
    finally:
        conn.unbind()
    return "Připojení v pořádku. Base DN: %s, počítačů v doméně: %d" % (base, computers)


def job_ad_sync():
    with db.db() as conn:
        cfg = db.get_settings(conn)
    ldap, base = _ad_connect(cfg)
    try:
        computers = list(_ad_search(ldap, base, "(objectCategory=computer)", [
            "name", "dNSHostName", "operatingSystem", "operatingSystemVersion", "lastLogonTimestamp",
            "description", "userAccountControl"]))
        users = list(_ad_search(ldap, base, "(&(objectCategory=person)(objectClass=user))", [
            "sAMAccountName", "displayName", "mail", "department", "title", "userAccountControl"]))
    finally:
        ldap.unbind()
    domain = ".".join(p[3:] for p in base.split(",") if p.strip().upper().startswith("DC="))
    new = 0
    with db.db() as conn:
        for dn, a in computers:
            hostname = ingest.short_host(_first(a.get("name")))
            if not hostname:
                continue
            os_name = _first(a.get("operatingSystem"))
            try:
                enabled = 0 if int(_first(a.get("userAccountControl")) or 0) & 2 else 1
            except ValueError:
                enabled = 1
            device = ingest.find_device(conn, hostname)
            if device is None:
                dtype = "server" if "server" in os_name.lower() else "počítač"
                cur = conn.execute("INSERT INTO devices(hostname, device_type, source, os_name, os_version) "
                                   "VALUES(?,?,?,?,?)", (hostname, dtype, "AD", os_name,
                                                         _first(a.get("operatingSystemVersion"))))
                dev_id = cur.lastrowid
                new += 1
            else:
                dev_id = device["id"]
                if not device["last_inventory"] and os_name:
                    conn.execute("UPDATE devices SET os_name=?, os_version=? WHERE id=?",
                                 (os_name, _first(a.get("operatingSystemVersion")), dev_id))
                if device["device_type"] in ("", "neznámé", "počítač (Windows)", "síťové zařízení"):
                    conn.execute("UPDATE devices SET device_type=? WHERE id=?",
                                 ("server" if "server" in os_name.lower() else "počítač", dev_id))
            conn.execute(
                "UPDATE devices SET fqdn=CASE WHEN ?<>'' THEN ? ELSE fqdn END, domain=?, ad_dn=?, ad_ou=?, "
                "ad_description=?, ad_last_logon=?, ad_enabled=? WHERE id=?",
                (_first(a.get("dNSHostName")), _first(a.get("dNSHostName")), domain, dn, _ou_of(dn),
                 _first(a.get("description"))[:255], _filetime(a.get("lastLogonTimestamp")), enabled, dev_id))
        conn.execute("DELETE FROM ad_users")
        for _dn, a in users:
            sam = _first(a.get("sAMAccountName"))
            if not sam:
                continue
            try:
                enabled = 0 if int(_first(a.get("userAccountControl")) or 0) & 2 else 1
            except ValueError:
                enabled = 1
            conn.execute("INSERT OR REPLACE INTO ad_users(sam, display_name, mail, department, title, enabled) "
                         "VALUES(?,?,?,?,?,?)",
                         (sam, _first(a.get("displayName")), _first(a.get("mail")),
                          _first(a.get("department")), _first(a.get("title")), enabled))
    return "Načteno %d počítačů (%d nových) a %d uživatelů z domény %s" % (len(computers), new, len(users), domain)


# ------------------------------------------------------------------ WinRM

def job_winrm():
    import winrm
    with db.db() as conn:
        cfg = db.get_settings(conn)
        token = cfg.get("agent_token", "")
        hours = max(1, int(cfg["winrm_interval_min"] or 720) // 60)
        rows = conn.execute(
            "SELECT id, hostname, fqdn, ip, agent_version, last_inventory FROM devices "
            "WHERE (os_name LIKE '%Windows%' OR device_type IN ('počítač','notebook','server','počítač (Windows)') "
            "       OR (',' || open_ports || ',') LIKE '%,5985,%') "
            "AND (last_inventory = '' OR last_inventory < datetime('now', ?)) "
            "AND (ad_enabled IS NULL OR ad_enabled = 1)", ("-%d hours" % hours,)).fetchall()
    server = cfg["server_url"].rstrip("/")
    if not server:
        raise ValueError("V nastavení chybí adresa serveru (URL, na které počítače uvidí tuto aplikaci)")
    if not cfg["winrm_user"]:
        raise ValueError("V nastavení chybí účet pro WinRM")
    mode = "install" if cfg["winrm_mode"] == "install" else "once"
    if tls.enabled() and server.lower().startswith("http://"):
        server = "https://" + server[7:]
    pin = tls.thumbprint() if server.lower().startswith("https://") else ""
    script = tls.bootstrap_ps("%s/agent/hwsw-agent.ps1?token=%s&mode=%s" % (server, token, mode), pin)

    def run(row):
        target = row["fqdn"] or row["ip"] or row["hostname"]
        try:
            sess = winrm.Session("http://%s:5985/wsman" % target, auth=(cfg["winrm_user"], cfg["winrm_password"]),
                                 transport="ntlm", operation_timeout_sec=120, read_timeout_sec=150)
            res = sess.run_ps(script)
            return res.status_code == 0
        except Exception:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(run, rows))
    return "Osloveno %d počítačů přes WinRM, úspěšně %d" % (len(rows), sum(1 for r in results if r))


# ---------------------------------------------------------- ulohy a plan

JOBS = {
    "ad_sync": ("Synchronizace s Active Directory", job_ad_sync),
    "ip_scan": ("Sken IP rozsahu", job_ip_scan),
    "clean_scan": ("Čistý sken (se snímkem a zálohou)", job_clean_scan),
    "winrm": ("Inventura přes WinRM", job_winrm),
}
_running = set()
_running_lock = threading.Lock()


def run_job(kind, wait=False):
    """Spusti ulohu na pozadi. Vraci False, kdyz uz stejna uloha bezi."""
    if kind not in JOBS:
        raise ValueError("Neznámá úloha")
    with _running_lock:
        if kind in _running:
            return False
        _running.add(kind)
    with db.db() as conn:
        job_id = conn.execute("INSERT INTO jobs(kind, started) VALUES(?,?)", (kind, db.now())).lastrowid

    def work():
        status, summary = "ok", ""
        try:
            summary = JOBS[kind][1]()
        except Exception as exc:  # chyba ulohy nesmi shodit aplikaci
            status, summary = "chyba", "%s: %s" % (type(exc).__name__, exc)
        finally:
            with _running_lock:
                _running.discard(kind)
        try:
            with db.db() as conn:
                conn.execute("UPDATE jobs SET finished=?, status=?, summary=? WHERE id=?",
                             (db.now(), status, str(summary)[:1000], job_id))
        except Exception:
            pass
        bus.publish({"type": "job", "kind": kind, "status": status})

    thread = threading.Thread(target=work, name="job-" + kind, daemon=True)
    thread.start()
    if wait:
        thread.join()
    return True


def _due(conn, kind, minutes):
    row = conn.execute("SELECT MAX(started) FROM jobs WHERE kind = ?", (kind,)).fetchone()
    if not row[0]:
        return True
    return conn.execute("SELECT ? < datetime('now', ?)", (row[0], "-%d minutes" % max(5, minutes))).fetchone()[0] == 1


def _tick(state):
    with db.db() as conn:
        cfg = db.get_settings(conn, decrypt=False)
        offline = max(5, int(cfg["offline_after_min"] or 20))
        scan_gap = max(offline, int(cfg["scan_interval_min"] or 30) * 2 + 5)
        conn.execute(
            "UPDATE devices SET online = 0 WHERE online = 1 AND (last_seen = '' OR last_seen < datetime('now', "
            "CASE WHEN source = 'agent' THEN ? ELSE ? END))",
            ("-%d minutes" % offline, "-%d minutes" % scan_gap))
        todo = []
        for kind, flag, interval in (("ad_sync", "ad_enabled", "ad_interval_min"),
                                     ("ip_scan", "scan_enabled", "scan_interval_min"),
                                     ("winrm", "winrm_enabled", "winrm_interval_min")):
            if cfg[flag] == "1" and _due(conn, kind, int(cfg[interval] or 60)):
                todo.append(kind)
        if time.time() - state.get("cleanup", 0) > 3600:
            state["cleanup"] = time.time()
            conn.execute("DELETE FROM sessions WHERE expires < datetime('now')")
            conn.execute("DELETE FROM jobs WHERE started < datetime('now', '-60 days')")
            keep = max(7, int(cfg["usb_events_keep_days"] or 365))
            conn.execute("DELETE FROM usb_events WHERE ts < datetime('now', ?)", ("-%d days" % keep,))
            conn.execute("DELETE FROM sw_changes WHERE ts < datetime('now', ?)", ("-%d days" % keep,))
    for kind in todo:
        run_job(kind)
    if cfg["backup_enabled"] == "1":
        today = time.strftime("%Y%m%d")
        if time.localtime().tm_hour >= int(cfg["backup_hour"] or 2) and state.get("backup_day") != today:
            done = any(b["label"] == "auto" and today in b["name"] for b in db.list_backups())
            if not done:
                db.backup_db("auto")
                db.prune_backups(int(cfg["backup_keep"] or 14))
            state["backup_day"] = today


def start_scheduler():
    def loop():
        state = {}
        time.sleep(5)
        while True:
            try:
                _tick(state)
            except Exception as exc:
                print("Plánovač: %s: %s" % (type(exc).__name__, exc), flush=True)
            time.sleep(30)

    threading.Thread(target=loop, name="scheduler", daemon=True).start()


if os.environ.get("HWSW_NO_SCHEDULER") == "1":
    def start_scheduler():  # noqa: F811 - pro testy
        return None
