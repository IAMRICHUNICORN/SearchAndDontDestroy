#!/usr/bin/env python3
"""Naplni HWSW Monitor ukazkovymi daty pres API agenta (pro vyzkouseni bez Windows pocitacu).

Pouziti: python3 scripts/demo_data.py https://localhost:8580 TOKEN_AGENTA

Certifikat serveru se neoveruje - skript je jen pro vyzkouseni na vlastnim stroji.
"""
import json
import random
import ssl
import sys
import urllib.request

URL, TOKEN = sys.argv[1].rstrip("/"), sys.argv[2]
random.seed(7)
CTX = ssl._create_unverified_context() if URL.lower().startswith("https://") else None


def post(path, data):
    req = urllib.request.Request(URL + path, json.dumps(data).encode(), {
        "Content-Type": "application/json", "X-Agent-Token": TOKEN})
    return json.load(urllib.request.urlopen(req, timeout=20, context=CTX))


MODELS = [("Dell Inc.", "OptiPlex 7010", [3]), ("Dell Inc.", "Latitude 5540", [10]), ("LENOVO", "ThinkPad T14 Gen 4", [10]),
          ("HP", "HP EliteDesk 800 G9", [3]), ("HP", "HP ProBook 450 G10", [10]), ("LENOVO", "ThinkCentre M70q", [35])]
CPUS = ["Intel(R) Core(TM) i5-13500", "Intel(R) Core(TM) i7-1355U", "AMD Ryzen 5 PRO 7540U", "Intel(R) Core(TM) i5-12400"]
MONITORS = [("DEL", "DELL U2422H", 23.8), ("DEL", "DELL P2723D", 27.0), ("GSM", "LG 27UL500", 27.0), ("PHL", "PHL 243V7", 23.8),
            ("SAM", "S24R350", 23.8), ("EIZ", "EV2456", 24.1)]
PEOPLE = ["novakova", "svoboda", "dvorak", "cerna", "prochazka", "kucerova", "vesely", "horak", "nemcova", "marek",
          "pokorna", "kral"]
BASE_SW = [("Microsoft 365 Apps for business - cs-cz", "16.0.17928.20156", "Microsoft Corporation"),
           ("Google Chrome", "130.0.6723.117", "Google LLC"), ("7-Zip 24.08 (x64)", "24.08", "Igor Pavlov"),
           ("Adobe Acrobat Reader DC - Czech", "24.004.20220", "Adobe"), ("ESET Endpoint Security", "11.1.2052.0", "ESET, spol. s r.o."),
           ("Microsoft Teams", "24277.3507.3205.5228", "Microsoft Corporation")]
EXTRA_SW = [("Adobe Acrobat Pro (64-bit)", "24.004.20220", "Adobe"), ("AutoCAD LT 2025", "25.0.58.0", "Autodesk"),
            ("POHODA SQL", "13800.6", "STORMWARE s.r.o."), ("Mozilla Firefox (x64 cs)", "132.0.1", "Mozilla"),
            ("Notepad++ (64-bit x64)", "8.7.1", "Notepad++ Team"), ("TeamViewer", "15.59.3", "TeamViewer"),
            ("WinRAR 7.01 (64-bit)", "7.01.0", "win.rar GmbH"), ("Zoom Workplace", "6.2.7", "Zoom")]
USB_BASE = [("USB Input Device", "046D", "C31C", "", "vstupni zarizeni (hid)", "Logitech"),
            ("USB Composite Device", "046D", "C077", "", "slozene usb zarizeni", "Logitech")]

hosts = []
for i in range(1, 15):
    maker, model, chassis = random.choice(MODELS)
    laptop = chassis == [10]
    name = "%s-%03d" % ("NB" if laptop else "PC", i)
    user = PEOPLE[(i - 1) % len(PEOPLE)]
    ram = random.choice([8192, 16384, 16384, 32768])
    mons = []
    for n in range(1 if laptop and i % 3 else random.choice([1, 2, 2])):
        code, mm, size = random.choice(MONITORS)
        mons.append({"manufacturer": code, "model": mm, "serial": "%s%07d" % (code[0], random.randint(1, 9999999)),
                     "year": random.choice([2019, 2021, 2022, 2023]), "size_inch": size, "connection": random.choice(["5", "10", "10"])})
    if laptop:
        mons.insert(0, {"manufacturer": "BOE", "model": "", "serial": "0", "year": 2023, "size_inch": 14.0, "connection": "2147483648"})
    usb = [{"pnp_id": "USB\\VID_%s&PID_%s\\6&%08X&0&%d" % (v, p, random.getrandbits(32), k), "name": n, "vid": v, "pid": p,
            "serial": s, "class": c, "manufacturer": m} for k, (n, v, p, s, c, m) in enumerate(USB_BASE)]
    sw = [{"name": n, "version": v, "publisher": p, "install_date": "2025-%02d-%02d" % (random.randint(1, 12), random.randint(1, 28))}
          for n, v, p in BASE_SW + random.sample(EXTRA_SW, random.randint(1, 4))]
    payload = {
        "agent_version": "1.0.0", "hostname": name, "domain": "firma.local", "fqdn": name.lower() + ".firma.local",
        "user": "FIRMA\\" + user, "primary_ip": "192.168.10.%d" % (20 + i),
        "primary_mac": "D4:5D:64:%02X:%02X:%02X" % (random.randint(0, 255), random.randint(0, 255), i),
        "system": {"manufacturer": maker, "model": model, "serial": "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789") for _ in range(7)),
                   "chassis": chassis, "bios_version": "1.%d.%d" % (random.randint(8, 24), random.randint(0, 9)), "bios_date": "2024-06-18"},
        "os": {"name": "Microsoft Windows 11 Pro" if i % 4 else "Microsoft Windows 10 Pro", "version": "23H2 (10.0.22631)" if i % 4 else "22H2 (10.0.19045)",
               "arch": "64-bit", "install_date": "2024-02-11", "last_boot": "2026-11-13 07:%02d" % random.randint(10, 59)},
        "cpu": [{"name": random.choice(CPUS), "cores": 6, "threads": 12}], "ram_mb": ram,
        "ram_modules": [{"slot": "DIMM %d" % (k + 1), "size_mb": ram // 2, "speed": 3200, "manufacturer": "Samsung", "part": "M471A1G44AB0-CWE", "serial": "%08X" % random.getrandbits(32)} for k in range(2)],
        "disks": [{"model": "Samsung SSD 980 PRO 512GB", "serial": "S5GXNX0T%06d" % random.randint(1, 999999), "size_gb": 477, "type": "SSD", "interface": "NVMe"}],
        "volumes": [{"drive": "C:", "fs": "NTFS", "size_gb": 475.9, "free_gb": round(random.uniform(60, 380), 1)}],
        "gpus": [{"name": "Intel(R) UHD Graphics 770", "vram_mb": 1024, "driver": "31.0.101.5186"}],
        "nics": [{"name": "Intel(R) Ethernet Connection I219-LM", "mac": "D4:5D:64:00:00:%02X" % i, "ips": ["192.168.10.%d" % (20 + i)],
                  "dhcp": True, "gateway": "192.168.10.1", "dns": "192.168.10.2"}],
        "printers": [{"name": "HP LaserJet M404dn", "driver": "HP Universal Printing PCL 6", "port": "192.168.10.200", "is_default": True}],
        "monitors": mons, "software": sw, "usb": usb,
    }
    post("/api/agent/inventory", payload)
    hosts.append((name, user, usb, payload))

# zmeny USB - vzniknou udalosti
FLASH = [("SanDisk Ultra USB Device", "0781", "5581", "4C530001230101117392", "uloziste", "SanDisk"),
         ("Kingston DataTraveler 3.0 USB Device", "0951", "1666", "E0D55EA574A1F5B0C9A20B1F", "uloziste", "Kingston"),
         ("Apple iPhone", "05AC", "12A8", "00008110001A2D3C1E9B801E", "telefon / prenosne zarizeni", "Apple Inc."),
         ("Logitech BRIO", "046D", "085E", "A1B2C3D4", "kamera", "Logitech")]
for idx, (name, user, usb, _p) in enumerate(hosts[:5]):
    n, v, p, s, c, m = FLASH[idx % len(FLASH)]
    plugged = usb + [{"pnp_id": "USB\\VID_%s&PID_%s\\%s" % (v, p, s), "name": n, "vid": v, "pid": p, "serial": s, "class": c, "manufacturer": m}]
    post("/api/agent/usb", {"hostname": name, "user": "FIRMA\\" + user, "usb": plugged})
    if idx % 2:
        post("/api/agent/usb", {"hostname": name, "user": "FIRMA\\" + user, "usb": usb})

# zmena softwaru na jednom PC - vznikne zaznam "nainstalovano"
name, user, usb, payload = hosts[0]
payload["software"].append({"name": "VLC media player", "version": "3.0.21", "publisher": "VideoLAN", "install_date": "2026-11-12"})
post("/api/agent/inventory", payload)
print("Ukazkova data nahrana: %d pocitacu" % len(hosts))
