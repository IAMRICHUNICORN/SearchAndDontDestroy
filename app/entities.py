"""Popis datovych pohledu (entit) a bezpecny generator SQL dotazu.

Sablony pohledu ukladaji jen KLICE sloupcu a filtru. SQL vyrazy jsou pevne dane
zde, takze uzivatel nemuze do dotazu podstrcit vlastni SQL.

Sloupec: klic -> (popisek, SQL vyraz, typ). Typy: text, num, date, bool.
"""
import csv
import io

_DEV = "LEFT JOIN devices d ON d.id = x.device_id LEFT JOIN ad_users u ON u.sam = d.user_sam"

_DEVICE_REF = {
    "hostname": ("Počítač", "d.hostname", "text"),
    "device_ip": ("IP počítače", "d.ip", "text"),
    "logged_user": ("Uživatel", "d.logged_user", "text"),
    "user_name": ("Jméno uživatele", "u.display_name", "text"),
    "department": ("Oddělení", "u.department", "text"),
    "location": ("Umístění", "d.location", "text"),
    "device_type": ("Typ zařízení", "d.device_type", "text"),
}

_LIC_USED = ("(SELECT COUNT(DISTINCT s.device_id) FROM software s "
             "WHERE x.match_pattern <> '' AND s.name LIKE x.match_pattern)")

ENTITIES = {
    "devices": {
        "label": "Zařízení (HW a síť)",
        "from": "devices d LEFT JOIN ad_users u ON u.sam = d.user_sam",
        "device_id": "d.id",
        "id": "d.id",
        "columns": {
            "hostname": ("Název", "d.hostname", "text"),
            "device_type": ("Typ", "d.device_type", "text"),
            "online": ("Online", "d.online", "bool"),
            "ip": ("IP adresa", "d.ip", "text"),
            "mac": ("MAC adresa", "d.mac", "text"),
            "manufacturer": ("Výrobce", "d.manufacturer", "text"),
            "model": ("Model", "d.model", "text"),
            "serial": ("Sériové číslo", "d.serial", "text"),
            "asset_tag": ("Inventární číslo", "d.asset_tag", "text"),
            "os_name": ("Operační systém", "d.os_name", "text"),
            "os_version": ("Verze OS", "d.os_version", "text"),
            "cpu": ("Procesor", "d.cpu", "text"),
            "ram_gb": ("RAM (GB)", "ROUND(d.ram_mb / 1024.0, 1)", "num"),
            "disk_gb": ("Disky (GB)", "d.disk_gb", "num"),
            "bios_version": ("BIOS", "d.bios_version", "text"),
            "logged_user": ("Přihlášený uživatel", "d.logged_user", "text"),
            "user_name": ("Jméno uživatele", "u.display_name", "text"),
            "user_mail": ("E-mail uživatele", "u.mail", "text"),
            "department": ("Oddělení", "u.department", "text"),
            "assigned_user": ("Přidělen komu", "d.assigned_user", "text"),
            "location": ("Umístění", "d.location", "text"),
            "domain": ("Doména", "d.domain", "text"),
            "ad_ou": ("AD organizační jednotka", "d.ad_ou", "text"),
            "ad_description": ("Popis v AD", "d.ad_description", "text"),
            "ad_last_logon": ("Poslední přihlášení v AD", "d.ad_last_logon", "date"),
            "open_ports": ("Otevřené porty", "d.open_ports", "text"),
            "monitors": ("Počet monitorů",
                         "(SELECT COUNT(*) FROM monitors m WHERE m.device_id = d.id AND m.connected = 1)", "num"),
            "software_count": ("Počet SW",
                               "(SELECT COUNT(*) FROM software s WHERE s.device_id = d.id)", "num"),
            "usb_count": ("Připojená USB",
                          "(SELECT COUNT(*) FROM usb_current c WHERE c.device_id = d.id)", "num"),
            "source": ("Zdroj dat", "d.source", "text"),
            "agent_version": ("Verze agenta", "d.agent_version", "text"),
            "first_seen": ("Poprvé viděn", "d.first_seen", "date"),
            "last_seen": ("Naposledy viděn", "d.last_seen", "date"),
            "last_inventory": ("Poslední inventura", "d.last_inventory", "date"),
            "note": ("Poznámka", "d.note", "text"),
        },
        "default": ["hostname", "device_type", "online", "ip", "manufacturer", "model",
                    "os_name", "logged_user", "last_seen"],
        "sort": ("hostname", "asc"),
    },
    "software": {
        "label": "Software – instalace",
        "from": "software x " + _DEV,
        "device_id": "x.device_id",
        "id": "x.id",
        "columns": dict({
            "name": ("Software", "x.name", "text"),
            "version": ("Verze", "x.version", "text"),
            "publisher": ("Vydavatel", "x.publisher", "text"),
            "install_date": ("Datum instalace", "x.install_date", "text"),
        }, **_DEVICE_REF),
        "default": ["name", "version", "publisher", "hostname", "logged_user", "install_date"],
        "sort": ("name", "asc"),
    },
    "software_summary": {
        "label": "Software – souhrn",
        "from": ("(SELECT MIN(id) AS id, name, publisher, COUNT(DISTINCT device_id) AS installs, "
                 "COUNT(DISTINCT version) AS versions, MAX(version) AS latest "
                 "FROM software GROUP BY name, publisher) x"),
        "device_id": None,
        "id": "x.id",
        "columns": {
            "name": ("Software", "x.name", "text"),
            "publisher": ("Vydavatel", "x.publisher", "text"),
            "installs": ("Počet instalací", "x.installs", "num"),
            "versions": ("Různých verzí", "x.versions", "num"),
            "latest": ("Nejvyšší verze", "x.latest", "text"),
        },
        "default": ["name", "publisher", "installs", "versions", "latest"],
        "sort": ("installs", "desc"),
    },
    "sw_changes": {
        "label": "Software – změny",
        "from": "sw_changes x " + _DEV,
        "device_id": "x.device_id",
        "id": "x.id",
        "columns": dict({
            "ts": ("Čas", "x.ts", "date"),
            "action": ("Událost", "x.action", "text"),
            "name": ("Software", "x.name", "text"),
            "version": ("Verze", "x.version", "text"),
        }, **_DEVICE_REF),
        "default": ["ts", "action", "name", "version", "hostname", "logged_user"],
        "sort": ("ts", "desc"),
    },
    "monitors": {
        "label": "Monitory",
        "from": "monitors x " + _DEV,
        "device_id": "x.device_id",
        "id": "x.id",
        "columns": dict({
            "manufacturer": ("Výrobce", "x.manufacturer", "text"),
            "model": ("Model", "x.model", "text"),
            "serial": ("Sériové číslo", "x.serial", "text"),
            "year": ("Rok výroby", "x.year", "num"),
            "size_inch": ("Úhlopříčka (\")", "x.size_inch", "num"),
            "connection": ("Připojení", "x.connection", "text"),
            "connected": ("Připojen", "x.connected", "bool"),
            "first_seen": ("Poprvé viděn", "x.first_seen", "date"),
            "last_seen": ("Naposledy viděn", "x.last_seen", "date"),
            "note": ("Poznámka", "x.note", "text"),
        }, **_DEVICE_REF),
        "default": ["manufacturer", "model", "serial", "size_inch", "year", "connection",
                    "connected", "hostname", "logged_user"],
        "sort": ("manufacturer", "asc"),
    },
    "usb_events": {
        "label": "USB – události",
        "from": "usb_events x " + _DEV,
        "device_id": "x.device_id",
        "id": "x.id",
        "columns": dict({
            "ts": ("Čas", "x.ts", "date"),
            "action": ("Událost", "x.action", "text"),
            "name": ("USB zařízení", "x.name", "text"),
            "usb_manufacturer": ("Výrobce USB", "x.manufacturer", "text"),
            "class": ("Třída", "x.class", "text"),
            "vid": ("VID", "x.vid", "text"),
            "pid": ("PID", "x.pid", "text"),
            "serial": ("Sériové číslo USB", "x.serial", "text"),
            "event_user": ("Uživatel v čase události", "x.logged_user", "text"),
        }, **_DEVICE_REF),
        "default": ["ts", "action", "name", "class", "serial", "hostname", "event_user"],
        "sort": ("ts", "desc"),
    },
    "usb_current": {
        "label": "USB – právě připojená",
        "from": "usb_current x " + _DEV,
        "device_id": "x.device_id",
        "id": "x.id",
        "columns": dict({
            "name": ("USB zařízení", "x.name", "text"),
            "usb_manufacturer": ("Výrobce USB", "x.manufacturer", "text"),
            "class": ("Třída", "x.class", "text"),
            "vid": ("VID", "x.vid", "text"),
            "pid": ("PID", "x.pid", "text"),
            "serial": ("Sériové číslo USB", "x.serial", "text"),
            "connected_at": ("Připojeno od", "x.connected_at", "date"),
        }, **_DEVICE_REF),
        "default": ["name", "class", "vid", "pid", "serial", "hostname", "logged_user", "connected_at"],
        "sort": ("connected_at", "desc"),
    },
    "licenses": {
        "label": "Licence",
        "from": "licenses x",
        "device_id": None,
        "id": "x.id",
        "columns": {
            "product": ("Produkt", "x.product", "text"),
            "vendor": ("Výrobce", "x.vendor", "text"),
            "license_type": ("Typ licence", "x.license_type", "text"),
            "seats": ("Zakoupeno", "x.seats", "num"),
            "used": ("Nainstalováno", _LIC_USED, "num"),
            "free": ("Volných", "CASE WHEN x.match_pattern <> '' THEN x.seats - " + _LIC_USED + " END", "num"),
            "expires": ("Platnost do", "x.expires", "text"),
            "purchased": ("Zakoupeno dne", "x.purchased", "text"),
            "cost": ("Cena", "x.cost", "text"),
            "supplier": ("Dodavatel", "x.supplier", "text"),
            "invoice": ("Faktura / doklad", "x.invoice", "text"),
            "assigned_to": ("Přiděleno", "x.assigned_to", "text"),
            "license_key": ("Licenční klíč", "x.license_key", "secret"),
            "match_pattern": ("Vzor názvu SW", "x.match_pattern", "text"),
            "note": ("Poznámka", "x.note", "text"),
        },
        "default": ["product", "vendor", "license_type", "seats", "used", "free", "expires", "assigned_to"],
        "sort": ("product", "asc"),
    },
}

OPERATORS = {
    "contains": "obsahuje",
    "not_contains": "neobsahuje",
    "eq": "je rovno",
    "ne": "není rovno",
    "starts": "začíná na",
    "gt": "větší než",
    "lt": "menší než",
    "empty": "je prázdné",
    "not_empty": "není prázdné",
}


def schema():
    out = {}
    for key, ent in ENTITIES.items():
        out[key] = {
            "label": ent["label"],
            "columns": [{"key": k, "label": v[0], "type": v[2]} for k, v in ent["columns"].items()],
            "default": ent["default"],
            "sort": ent["sort"][0],
            "sort_dir": ent["sort"][1],
            "has_device": bool(ent["device_id"]),
        }
    return {"entities": out, "operators": OPERATORS}


def _like(value):
    return str(value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def clean_columns(entity, columns):
    ent = ENTITIES[entity]
    cols = [c for c in (columns or []) if c in ent["columns"]]
    return cols or list(ent["default"])


def clean_filters(entity, filters):
    ent = ENTITIES[entity]
    out = []
    for f in filters or []:
        if not isinstance(f, dict):
            continue
        if f.get("col") in ent["columns"] and f.get("op") in OPERATORS:
            out.append({"col": f["col"], "op": f["op"], "value": str(f.get("value", ""))[:200]})
    return out


def _filter_sql(ent, f, params):
    expr, typ = ent["columns"][f["col"]][1], ent["columns"][f["col"]][2]
    op, value = f["op"], f["value"]
    if op == "empty":
        return "(%s IS NULL OR %s = '' OR %s = 0)" % (expr, expr, expr) if typ in ("num", "bool") \
            else "(%s IS NULL OR %s = '')" % (expr, expr)
    if op == "not_empty":
        return "(%s IS NOT NULL AND %s <> '' AND %s <> 0)" % (expr, expr, expr) if typ in ("num", "bool") \
            else "(%s IS NOT NULL AND %s <> '')" % (expr, expr)
    if typ in ("num", "bool"):
        try:
            num = float(str(value).replace(",", "."))
        except ValueError:
            low = str(value).strip().lower()
            num = 1.0 if low in ("ano", "true", "yes", "a") else 0.0
        sym = {"eq": "=", "ne": "<>", "gt": ">", "lt": "<"}.get(op, "=")
        params.append(num)
        return "(COALESCE(%s, 0) %s ?)" % (expr, sym)
    if op == "contains":
        params.append("%" + _like(value) + "%")
        return "(%s LIKE ? ESCAPE '\\')" % expr
    if op == "not_contains":
        params.append("%" + _like(value) + "%")
        return "(COALESCE(%s, '') NOT LIKE ? ESCAPE '\\')" % expr
    if op == "starts":
        params.append(_like(value) + "%")
        return "(%s LIKE ? ESCAPE '\\')" % expr
    sym = {"eq": "=", "ne": "<>", "gt": ">", "lt": "<"}[op]
    params.append(value)
    return "(COALESCE(%s, '') %s ? COLLATE NOCASE)" % (expr, sym)


def run_query(conn, entity, columns=None, filters=None, search="", sort="", sort_dir="",
              limit=50, offset=0, show_secrets=False, only_device=None):
    """Vraci (sloupce, radky, celkovy pocet). Radky obsahuji navic _id a _device_id."""
    ent = ENTITIES[entity]
    cols = clean_columns(entity, columns)
    params = []
    where = []
    for f in clean_filters(entity, filters):
        where.append(_filter_sql(ent, f, params))
    search = (search or "").strip()
    if search:
        parts = []
        for key in cols:
            _, expr, typ = ent["columns"][key]
            if typ in ("text", "date"):
                parts.append("%s LIKE ? ESCAPE '\\'" % expr)
                params.append("%" + _like(search) + "%")
        if parts:
            where.append("(" + " OR ".join(parts) + ")")
    if only_device is not None and ent["device_id"]:
        where.append("%s = ?" % ent["device_id"])
        params.append(int(only_device))
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    if sort not in ent["columns"]:
        sort, sort_dir = ent["sort"]
    direction = "DESC" if str(sort_dir).lower() == "desc" else "ASC"
    sort_expr = ent["columns"][sort][1]
    order = " ORDER BY %s %s, %s ASC" % (
        sort_expr + (" COLLATE NOCASE" if ent["columns"][sort][2] == "text" else ""), direction, ent["id"])

    total = conn.execute("SELECT COUNT(*) FROM %s%s" % (ent["from"], where_sql), params).fetchone()[0]
    select = ["%s AS c%d" % (ent["columns"][k][1], i) for i, k in enumerate(cols)]
    select.append("%s AS _id" % ent["id"])
    select.append("%s AS _device_id" % (ent["device_id"] or "NULL"))
    sql = "SELECT %s FROM %s%s%s" % (", ".join(select), ent["from"], where_sql, order)
    qparams = list(params)
    if limit:
        sql += " LIMIT ? OFFSET ?"
        qparams += [int(limit), int(offset)]
    rows = []
    for r in conn.execute(sql, qparams):
        item = {"_id": r["_id"], "_device_id": r["_device_id"]}
        for i, k in enumerate(cols):
            val = r["c%d" % i]
            if ent["columns"][k][2] == "secret" and not show_secrets and val:
                val = "•••••" + str(val)[-4:] if len(str(val)) > 8 else "•••••"
            item[k] = val
        rows.append(item)
    meta = [{"key": k, "label": ent["columns"][k][0], "type": ent["columns"][k][2]} for k in cols]
    return meta, rows, total


def to_csv(meta, rows):
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    writer.writerow([m["label"] for m in meta])
    for r in rows:
        line = []
        for m in meta:
            v = r.get(m["key"])
            if m["type"] == "bool":
                v = "ano" if v else "ne"
            v = "" if v is None else v
            # ochrana proti vzorcum v Excelu (CSV injection)
            if isinstance(v, str) and v[:1] in ("=", "+", "-", "@"):
                v = "'" + v
            line.append(v)
        writer.writerow(line)
    return ("﻿" + buf.getvalue()).encode("utf-8")
