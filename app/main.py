"""HWSW Monitor - webova aplikace a API."""
import asyncio
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import tempfile
import time
from typing import Optional

from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from . import db, discovery, entities, ingest, tls
from .bus import bus

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
COOKIE = "hwsw_session"
SESSION_HOURS = 12
MASK = "********"

app = FastAPI(title="HWSW Monitor", version=db.APP_VERSION, docs_url=None, redoc_url=None, openapi_url=None)


# ------------------------------------------------------------------ hesla

def hash_pw(password):
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 240000)
    return "pbkdf2$240000$%s$%s" % (salt.hex(), dk.hex())


def check_pw(password, stored):
    try:
        _algo, rounds, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, AttributeError):
        return False


def check_new_password(password):
    if not isinstance(password, str) or len(password) < 8:
        raise HTTPException(400, "Heslo musí mít alespoň 8 znaků")


# ---------------------------------------------------------------- start

DEFAULT_VIEWS = [
    ("Síť – všechna zařízení", "Přehled všeho, co bylo v síti nalezeno", "devices",
     ["hostname", "device_type", "online", "ip", "mac", "manufacturer", "model", "open_ports", "last_seen"],
     [], "ip", "asc"),
    ("Počítače – hardware", "Výrobce, model, sériové číslo, procesor, paměť a uživatel", "devices",
     ["hostname", "device_type", "manufacturer", "model", "serial", "cpu", "ram_gb", "disk_gb", "os_name",
      "logged_user", "user_name", "monitors"],
     [{"col": "last_inventory", "op": "not_empty", "value": ""}], "hostname", "asc"),
    ("Software – souhrn", "Jaký software je ve firmě a na kolika počítačích", "software_summary",
     ["name", "publisher", "installs", "versions", "latest"], [], "installs", "desc"),
    ("Monitory", "Monitory podle výrobce, modelu a sériového čísla", "monitors",
     ["manufacturer", "model", "serial", "size_inch", "year", "connected", "hostname", "logged_user"],
     [], "manufacturer", "asc"),
    ("USB – události", "Připojení a odpojení USB zařízení", "usb_events",
     ["ts", "action", "name", "class", "serial", "hostname", "event_user"], [], "ts", "desc"),
]


@app.on_event("startup")
def on_startup():
    info = db.startup()
    print("HWSW Monitor %s - %s" % (db.APP_VERSION, info), flush=True)
    with db.db() as conn:
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            password = os.environ.get("HWSW_ADMIN_PASSWORD") or "admin"
            conn.execute("INSERT INTO users(username, full_name, pw_hash, role, must_change) VALUES(?,?,?,?,1)",
                         ("admin", "Administrátor", hash_pw(password), "admin"))
            print("Vytvořen účet 'admin' - při prvním přihlášení je nutné změnit heslo.", flush=True)
            for pos, (name, desc, entity, cols, flt, sort, direction) in enumerate(DEFAULT_VIEWS):
                conn.execute("INSERT INTO views(name, description, entity, columns, filters, sort, sort_dir, "
                             "shared_all, position) VALUES(?,?,?,?,?,?,?,0,?)",
                             (name, desc, entity, json.dumps(cols), json.dumps(flt), sort, direction, pos))
        if not db.get_settings(conn, decrypt=False).get("agent_token"):
            db.set_setting(conn, "agent_token", secrets.token_urlsafe(32))
    discovery.start_scheduler()


@app.on_event("startup")
async def bind_loop():
    bus.loop = asyncio.get_event_loop()


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if (path.startswith("/api/") and not path.startswith("/api/agent/")
            and request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-hwsw") != "1"):
        return JSONResponse({"detail": "Chybí hlavička X-HWSW"}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
    if path.startswith("/api/") or path.startswith("/static/") or path == "/":
        response.headers["Cache-Control"] = "no-store" if path.startswith("/api/") else "no-cache"
    return response


# ------------------------------------------------------------ prihlaseni

def current_user(request: Request):
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Nepřihlášen")
    with db.db() as conn:
        row = conn.execute(
            "SELECT u.id, u.username, u.full_name, u.role, u.must_change FROM sessions s "
            "JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > datetime('now')",
            (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
    if row is None:
        raise HTTPException(401, "Přihlášení vypršelo")
    return dict(row)


def active_user(user=Depends(current_user)):
    if user["must_change"]:
        raise HTTPException(403, "Nejdříve si změňte heslo")
    return user


def admin_user(user=Depends(active_user)):
    if user["role"] != "admin":
        raise HTTPException(403, "Jen pro administrátora")
    return user


_fails = {}


@app.post("/api/login")
def login(request: Request, body: dict = Body(...)):
    ip = request.client.host if request.client else "?"
    count, until = _fails.get(ip, (0, 0))
    if until > time.time():
        raise HTTPException(429, "Příliš mnoho pokusů, zkuste to za chvíli")
    username, password = str(body.get("username", "")).strip(), str(body.get("password", ""))
    with db.db() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if row is None or not check_pw(password, row["pw_hash"]):
            count += 1
            _fails[ip] = (count, time.time() + (60 if count >= 5 else 0))
            if len(_fails) > 5000:
                _fails.clear()
            raise HTTPException(401, "Neplatné jméno nebo heslo")
        _fails.pop(ip, None)
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO sessions(token, user_id, expires) VALUES(?,?,datetime('now', ?))",
                     (hashlib.sha256(token.encode()).hexdigest(), row["id"], "+%d hours" % SESSION_HOURS))
        conn.execute("UPDATE users SET last_login = ? WHERE id = ?", (db.now(), row["id"]))
    response = JSONResponse({"ok": True})
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, token, max_age=SESSION_HOURS * 3600, httponly=True, samesite="lax", secure=secure)
    return response


@app.post("/api/logout")
def logout(request: Request):
    token = request.cookies.get(COOKIE)
    if token:
        with db.db() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (hashlib.sha256(token.encode()).hexdigest(),))
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE)
    return response


@app.get("/api/me")
def me(user=Depends(current_user)):
    return dict(user, version=db.APP_VERSION)


@app.post("/api/password")
def change_password(request: Request, body: dict = Body(...), user=Depends(current_user)):
    check_new_password(body.get("new"))
    with db.db() as conn:
        row = conn.execute("SELECT pw_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
        if not check_pw(str(body.get("old", "")), row["pw_hash"]):
            raise HTTPException(400, "Původní heslo nesouhlasí")
        conn.execute("UPDATE users SET pw_hash = ?, must_change = 0 WHERE id = ?", (hash_pw(body["new"]), user["id"]))
        keep = hashlib.sha256((request.cookies.get(COOKIE) or "").encode()).hexdigest()
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token <> ?", (user["id"], keep))
    return {"ok": True}


# -------------------------------------------------------------- prehled

@app.get("/api/dashboard")
def dashboard(user=Depends(active_user)):
    admin = user["role"] == "admin"
    with db.db() as conn:
        one = lambda sql, *p: conn.execute(sql, p).fetchone()[0]  # noqa: E731
        data = {
            "devices": one("SELECT COUNT(*) FROM devices"),
            "online": one("SELECT COUNT(*) FROM devices WHERE online = 1"),
            "inventoried": one("SELECT COUNT(*) FROM devices WHERE last_inventory <> ''"),
            "monitors": one("SELECT COUNT(*) FROM monitors WHERE connected = 1"),
            "software_titles": one("SELECT COUNT(*) FROM (SELECT 1 FROM software GROUP BY name, publisher)"),
            "usb_now": one("SELECT COUNT(*) FROM usb_current"),
            "usb_24h": one("SELECT COUNT(*) FROM usb_events WHERE ts >= datetime('now', '-1 day')"),
            "licenses": one("SELECT COUNT(*) FROM licenses"),
            "by_type": [dict(r) for r in conn.execute(
                "SELECT CASE WHEN device_type = '' THEN 'neznámé' ELSE device_type END AS label, COUNT(*) AS n "
                "FROM devices GROUP BY 1 ORDER BY n DESC LIMIT 12")],
            "by_os": [dict(r) for r in conn.execute(
                "SELECT os_name AS label, COUNT(*) AS n FROM devices WHERE os_name <> '' "
                "GROUP BY 1 ORDER BY n DESC LIMIT 8")],
            "by_maker": [dict(r) for r in conn.execute(
                "SELECT manufacturer AS label, COUNT(*) AS n FROM devices WHERE manufacturer <> '' "
                "AND last_inventory <> '' GROUP BY 1 ORDER BY n DESC LIMIT 8")],
        }
        if admin:
            _m, rows, _t = entities.run_query(conn, "licenses", ["product", "seats", "used", "free", "expires"],
                                              limit=0)
            soon = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 60 * 86400))
            today = time.strftime("%Y-%m-%d")
            alerts = []
            for r in rows:
                if r["free"] is not None and r["free"] < 0:
                    alerts.append({"id": r["_id"], "product": r["product"], "kind": "over",
                                   "text": "nainstalováno %s, zakoupeno %s" % (r["used"], r["seats"])})
                if r["expires"] and r["expires"] <= soon:
                    alerts.append({"id": r["_id"], "product": r["product"],
                                   "kind": "expired" if r["expires"] < today else "expiring",
                                   "text": ("platnost skončila " if r["expires"] < today else "platnost končí ")
                                   + r["expires"]})
            data["license_alerts"] = alerts
            data["usb_recent"] = [dict(r) for r in conn.execute(
                "SELECT e.ts, e.action, e.name, e.class, e.serial, e.logged_user AS user, d.hostname, "
                "e.device_id FROM usb_events e JOIN devices d ON d.id = e.device_id ORDER BY e.id DESC LIMIT 15")]
            data["jobs"] = [dict(r) for r in conn.execute("SELECT * FROM jobs ORDER BY id DESC LIMIT 6")]
            data["agents"] = one("SELECT COUNT(*) FROM devices WHERE agent_version <> ''")
    return data


# ---------------------------------------------------- dotazy a pohledy

@app.get("/api/schema")
def get_schema(user=Depends(active_user)):
    return entities.schema()


def _page_args(body):
    size = min(500, max(10, ingest.num(body.get("page_size"), 50)))
    page = max(1, ingest.num(body.get("page"), 1))
    return size, (page - 1) * size


@app.post("/api/query")
def query(body: dict = Body(...), user=Depends(admin_user)):
    entity = body.get("entity")
    if entity not in entities.ENTITIES:
        raise HTTPException(400, "Neznámý typ dat")
    size, offset = _page_args(body)
    with db.db() as conn:
        if body.get("export"):
            meta, rows, _t = entities.run_query(conn, entity, body.get("columns"), body.get("filters"),
                                                body.get("search"), body.get("sort"), body.get("sort_dir"),
                                                limit=0, show_secrets=True)
            return Response(entities.to_csv(meta, rows), media_type="text/csv; charset=utf-8",
                            headers={"Content-Disposition": 'attachment; filename="hwsw-%s.csv"' % entity})
        meta, rows, total = entities.run_query(conn, entity, body.get("columns"), body.get("filters"),
                                               body.get("search"), body.get("sort"), body.get("sort_dir"),
                                               limit=size, offset=offset, show_secrets=False)
    return {"columns": meta, "rows": rows, "total": total, "page_size": size}


@app.get("/api/devices-summary")
def devices_summary(user=Depends(admin_user)):
    with db.db() as conn:
        return entities.agent_summary(conn)


@app.get("/api/distinct")
def distinct(entity: str, col: str, user=Depends(admin_user)):
    if entity not in entities.ENTITIES:
        raise HTTPException(400, "Neznámý typ dat")
    with db.db() as conn:
        return {"values": entities.distinct_values(conn, entity, col)}


def _view_row(row, admin):
    item = {"id": row["id"], "name": row["name"], "description": row["description"], "entity": row["entity"],
            "entity_label": entities.ENTITIES.get(row["entity"], {}).get("label", row["entity"]),
            "allow_detail": bool(row["allow_detail"]), "sort": row["sort"], "sort_dir": row["sort_dir"]}
    if admin:
        item.update({"columns": json.loads(row["columns"]), "filters": json.loads(row["filters"]),
                     "shared_all": bool(row["shared_all"]), "user_ids": json.loads(row["user_ids"])})
    return item


def _visible_view(conn, view_id, user):
    row = conn.execute("SELECT * FROM views WHERE id = ?", (view_id,)).fetchone()
    if row is None or row["entity"] not in entities.ENTITIES:
        raise HTTPException(404, "Pohled neexistuje")
    if user["role"] != "admin" and not row["shared_all"] and user["id"] not in json.loads(row["user_ids"]):
        raise HTTPException(404, "Pohled neexistuje")
    return row


@app.get("/api/views")
def list_views(user=Depends(active_user)):
    admin = user["role"] == "admin"
    with db.db() as conn:
        rows = conn.execute("SELECT * FROM views ORDER BY position, name").fetchall()
    out = []
    for row in rows:
        if row["entity"] not in entities.ENTITIES:
            continue
        if admin or row["shared_all"] or user["id"] in json.loads(row["user_ids"]):
            out.append(_view_row(row, admin))
    return out


def _view_values(body):
    entity = body.get("entity")
    if entity not in entities.ENTITIES:
        raise HTTPException(400, "Neznámý typ dat")
    name = str(body.get("name", "")).strip()[:100]
    if not name:
        raise HTTPException(400, "Pohled musí mít název")
    sort = body.get("sort") if body.get("sort") in entities.ENTITIES[entity]["columns"] else ""
    user_ids = [int(u) for u in body.get("user_ids") or [] if str(u).isdigit()]
    return (name, str(body.get("description", ""))[:300], entity,
            json.dumps(entities.clean_columns(entity, body.get("columns"))),
            json.dumps(entities.clean_filters(entity, body.get("filters"))),
            sort, "desc" if body.get("sort_dir") == "desc" else "asc",
            1 if body.get("shared_all") else 0, json.dumps(user_ids), 1 if body.get("allow_detail") else 0)


@app.post("/api/views")
def create_view(body: dict = Body(...), user=Depends(admin_user)):
    vals = _view_values(body)
    with db.db() as conn:
        pos = conn.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM views").fetchone()[0]
        cur = conn.execute("INSERT INTO views(name, description, entity, columns, filters, sort, sort_dir, "
                           "shared_all, user_ids, allow_detail, position, created_by) "
                           "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", vals + (pos, user["id"]))
    return {"id": cur.lastrowid}


@app.put("/api/views/{view_id}")
def update_view(view_id: int, body: dict = Body(...), user=Depends(admin_user)):
    vals = _view_values(body)
    with db.db() as conn:
        cur = conn.execute("UPDATE views SET name=?, description=?, entity=?, columns=?, filters=?, sort=?, "
                           "sort_dir=?, shared_all=?, user_ids=?, allow_detail=? WHERE id=?", vals + (view_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Pohled neexistuje")
    return {"ok": True}


@app.delete("/api/views/{view_id}")
def delete_view(view_id: int, user=Depends(admin_user)):
    with db.db() as conn:
        conn.execute("DELETE FROM views WHERE id = ?", (view_id,))
    return {"ok": True}


@app.post("/api/views/{view_id}/data")
def view_data(view_id: int, body: dict = Body(default={}), user=Depends(active_user)):
    size, offset = _page_args(body)
    admin = user["role"] == "admin"
    with db.db() as conn:
        view = _visible_view(conn, view_id, user)
        cols, flt = json.loads(view["columns"]), json.loads(view["filters"])
        sort = body.get("sort") if body.get("sort") in cols else view["sort"]
        sort_dir = body.get("sort_dir") if body.get("sort") in cols else view["sort_dir"]
        if body.get("export"):
            meta, rows, _t = entities.run_query(conn, view["entity"], cols, flt, body.get("search"), sort,
                                                sort_dir, limit=0, show_secrets=admin)
            return Response(entities.to_csv(meta, rows), media_type="text/csv; charset=utf-8",
                            headers={"Content-Disposition": 'attachment; filename="hwsw-pohled-%d.csv"' % view_id})
        meta, rows, total = entities.run_query(conn, view["entity"], cols, flt, body.get("search"), sort,
                                               sort_dir, limit=size, offset=offset)
    return {"columns": meta, "rows": rows, "total": total, "page_size": size, "view": _view_row(view, admin),
            "sort": sort, "sort_dir": sort_dir}


# --------------------------------------------------------------- skupiny

GROUP_COLORS = ("#3b82a0", "#2f9e6e", "#c9922b", "#c4573f", "#8a63c7", "#c25a95", "#5b6fd0", "#6b7c85")


def _group_body(body, current=None):
    name = str(body.get("name", current["name"] if current else "")).strip()[:60]
    if not name:
        raise HTTPException(400, "Zadejte název skupiny")
    color = str(body.get("color", current["color"] if current else GROUP_COLORS[0])).strip().lower()
    if not re.match(r"^#[0-9a-f]{6}$", color):
        color = GROUP_COLORS[0]
    desc = str(body.get("description", current["description"] if current else "")).strip()[:300]
    return name, desc, color


def _selected_ids(conn, body):
    """Zarizeni z pozadavku: device_ids, nebo vse, co odpovida filtru (select_all)."""
    sel = body.get("select_all")
    if isinstance(sel, dict):
        _m, rows, _t = entities.run_query(conn, "devices", ["hostname"], sel.get("filters"), sel.get("search"),
                                          limit=5000)
        return [r["_id"] for r in rows]
    return [int(i) for i in (body.get("device_ids") or []) if str(i).isdigit()][:5000]


@app.post("/api/devices/section")
def devices_section(body: dict = Body(...), user=Depends(admin_user)):
    """Presune zarizeni do sekce. section: nazev sekce, "" = bez sekce (jen ve Vse), null = automaticky podle typu."""
    section = body.get("section")
    if section is not None:
        section = str(section)
        if section != "" and section not in entities.SECTIONS:
            raise HTTPException(400, "Neznámá sekce")
    with db.db() as conn:
        ids = _selected_ids(conn, body)
        changed = 0
        for device_id in ids:
            changed += conn.execute("UPDATE devices SET section_manual = ? WHERE id = ?", (section, device_id)).rowcount
    return {"ok": True, "changed": changed, "selected": len(ids)}


def _group_name_taken(conn, name, except_id=None):
    return any(r["name"].casefold() == name.casefold() and r["id"] != except_id
               for r in conn.execute("SELECT id, name FROM device_groups"))


@app.get("/api/groups")
def groups_list(user=Depends(admin_user)):
    with db.db() as conn:
        rows = conn.execute(
            "SELECT g.id, g.name, g.description, g.color, "
            "(SELECT COUNT(*) FROM device_group_members m WHERE m.group_id = g.id) AS devices "
            "FROM device_groups g ORDER BY g.name COLLATE NOCASE").fetchall()
    return {"groups": [dict(r) for r in rows], "colors": list(GROUP_COLORS)}


@app.post("/api/groups")
def groups_create(body: dict = Body(...), user=Depends(admin_user)):
    name, desc, color = _group_body(body)
    with db.db() as conn:
        if _group_name_taken(conn, name):
            raise HTTPException(400, "Skupina s tímto názvem už existuje")
        cur = conn.execute("INSERT INTO device_groups(name, description, color) VALUES(?,?,?)", (name, desc, color))
    return {"ok": True, "id": cur.lastrowid}


@app.put("/api/groups/{group_id}")
def groups_update(group_id: int, body: dict = Body(...), user=Depends(admin_user)):
    with db.db() as conn:
        row = conn.execute("SELECT * FROM device_groups WHERE id = ?", (group_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Skupina neexistuje")
        name, desc, color = _group_body(body, row)
        if _group_name_taken(conn, name, group_id):
            raise HTTPException(400, "Skupina s tímto názvem už existuje")
        conn.execute("UPDATE device_groups SET name=?, description=?, color=? WHERE id=?", (name, desc, color, group_id))
    return {"ok": True}


@app.delete("/api/groups/{group_id}")
def groups_delete(group_id: int, user=Depends(admin_user)):
    with db.db() as conn:
        conn.execute("DELETE FROM device_groups WHERE id = ?", (group_id,))  # vazby zmizi kaskadou, zarizeni zustanou
    return {"ok": True}


@app.post("/api/groups/{group_id}/members")
def groups_members(group_id: int, body: dict = Body(...), user=Depends(admin_user)):
    """Prida/odebere zarizeni. Zarizeni: device_ids, nebo vse, co odpovida filtru (select_all)."""
    action = body.get("action")
    if action not in ("add", "remove"):
        raise HTTPException(400, "Neplatná akce")
    with db.db() as conn:
        if conn.execute("SELECT 1 FROM device_groups WHERE id = ?", (group_id,)).fetchone() is None:
            raise HTTPException(404, "Skupina neexistuje")
        ids = _selected_ids(conn, body)
        changed = 0
        for device_id in ids:
            if action == "add":
                cur = conn.execute("INSERT OR IGNORE INTO device_group_members(group_id, device_id) "
                                   "SELECT ?, id FROM devices WHERE id = ?", (group_id, device_id))
            else:
                cur = conn.execute("DELETE FROM device_group_members WHERE group_id = ? AND device_id = ?",
                                   (group_id, device_id))
            changed += cur.rowcount
    return {"ok": True, "changed": changed, "selected": len(ids)}


@app.put("/api/devices/{device_id}/groups")
def device_groups_set(device_id: int, body: dict = Body(...), user=Depends(admin_user)):
    ids = [int(i) for i in (body.get("group_ids") or []) if str(i).isdigit()]
    with db.db() as conn:
        if conn.execute("SELECT 1 FROM devices WHERE id = ?", (device_id,)).fetchone() is None:
            raise HTTPException(404, "Zařízení neexistuje")
        conn.execute("DELETE FROM device_group_members WHERE device_id = ?", (device_id,))
        for gid in ids:
            conn.execute("INSERT OR IGNORE INTO device_group_members(group_id, device_id) "
                         "SELECT id, ? FROM device_groups WHERE id = ?", (device_id, gid))
    return {"ok": True}


# ------------------------------------------------------------- zarizeni

@app.get("/api/devices/{device_id}")
def device_detail(device_id: int, view: Optional[int] = None, user=Depends(active_user)):
    with db.db() as conn:
        if user["role"] != "admin":
            if view is None:
                raise HTTPException(403, "Detail není v tomto pohledu povolen")
            vrow = _visible_view(conn, view, user)
            ent = entities.ENTITIES[vrow["entity"]]
            if not vrow["allow_detail"] or not ent["device_id"]:
                raise HTTPException(403, "Detail není v tomto pohledu povolen")
            _m, _r, total = entities.run_query(conn, vrow["entity"], json.loads(vrow["columns"]),
                                               json.loads(vrow["filters"]), limit=1, only_device=device_id)
            if total == 0:
                raise HTTPException(404, "Zařízení neexistuje")
        row = conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Zařízení neexistuje")
        device = dict(row)
        try:
            device["details"] = json.loads(device["details"] or "{}")
        except ValueError:
            device["details"] = {}
        if user["role"] != "admin" and isinstance(device["details"].get("licenses"), dict):
            device["details"]["licenses"].pop("oem_key", None)  # klic ve firmware vidi jen administrator
        person = conn.execute("SELECT * FROM ad_users WHERE sam = ?", (device["user_sam"],)).fetchone()
        device["person"] = dict(person) if person and device["user_sam"] else None
        q = lambda sql: [dict(r) for r in conn.execute(sql, (device_id,))]  # noqa: E731
        device["groups"] = q("SELECT g.id, g.name, g.color FROM device_group_members m JOIN device_groups g "
                             "ON g.id = m.group_id WHERE m.device_id = ? ORDER BY g.name COLLATE NOCASE")
        device["monitors"] = q("SELECT * FROM monitors WHERE device_id = ? ORDER BY connected DESC, model")
        device["software"] = q("SELECT name, version, publisher, install_date FROM software WHERE device_id = ? "
                               "ORDER BY name COLLATE NOCASE")
        device["usb_current"] = q("SELECT * FROM usb_current WHERE device_id = ? ORDER BY name COLLATE NOCASE")
        device["usb_events"] = q("SELECT * FROM usb_events WHERE device_id = ? ORDER BY id DESC LIMIT 200")
        device["sw_changes"] = q("SELECT * FROM sw_changes WHERE device_id = ? ORDER BY id DESC LIMIT 200")
    return device


@app.put("/api/devices/{device_id}")
def device_update(device_id: int, body: dict = Body(...), user=Depends(admin_user)):
    fields = ("device_type", "asset_tag", "location", "assigned_user", "note")
    sets = [(f, str(body[f])[:2000 if f == "note" else 200]) for f in fields if f in body]
    if sets:
        with db.db() as conn:
            conn.execute("UPDATE devices SET %s WHERE id = ?" % ", ".join(f + "=?" for f, _ in sets),
                         [v for _, v in sets] + [device_id])
    return {"ok": True}


@app.delete("/api/devices/{device_id}")
def device_delete(device_id: int, user=Depends(admin_user)):
    with db.db() as conn:
        conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    return {"ok": True}


@app.put("/api/monitors/{monitor_id}")
def monitor_update(monitor_id: int, body: dict = Body(...), user=Depends(admin_user)):
    with db.db() as conn:
        conn.execute("UPDATE monitors SET note = ? WHERE id = ?", (str(body.get("note", ""))[:500], monitor_id))
    return {"ok": True}


@app.delete("/api/monitors/{monitor_id}")
def monitor_delete(monitor_id: int, user=Depends(admin_user)):
    with db.db() as conn:
        conn.execute("DELETE FROM monitors WHERE id = ?", (monitor_id,))
    return {"ok": True}


# --------------------------------------------------------------- licence

LICENSE_FIELDS = ("product", "vendor", "license_type", "license_key", "seats", "match_pattern", "purchased",
                  "expires", "cost", "supplier", "invoice", "assigned_to", "note")
LICENSE_ALIASES = {
    "product": ("product", "produkt", "název", "nazev", "software", "name"),
    "vendor": ("vendor", "výrobce", "vyrobce", "publisher", "vydavatel"),
    "license_type": ("license_type", "typ", "typ licence", "type"),
    "license_key": ("license_key", "klíč", "klic", "licenční klíč", "licencni klic", "key", "product key"),
    "seats": ("seats", "počet", "pocet", "počet licencí", "pocet licenci", "quantity", "qty", "ks"),
    "match_pattern": ("match_pattern", "vzor", "pattern"),
    "purchased": ("purchased", "zakoupeno", "datum nákupu", "datum nakupu", "purchase date"),
    "expires": ("expires", "platnost", "platnost do", "expirace", "expiration"),
    "cost": ("cost", "cena", "price"),
    "supplier": ("supplier", "dodavatel"),
    "invoice": ("invoice", "faktura", "doklad"),
    "assigned_to": ("assigned_to", "přiděleno", "prideleno", "uživatel", "uzivatel"),
    "note": ("note", "poznámka", "poznamka", "notes"),
}


def _iso_date(value):
    value = str(value or "").strip()
    m = re.match(r"^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$", value)
    if m:
        return "%s-%02d-%02d" % (m.group(3), int(m.group(2)), int(m.group(1)))
    return value[:20]


def _license_values(body):
    product = str(body.get("product", "")).strip()[:200]
    if not product:
        raise HTTPException(400, "Licence musí mít název produktu")
    pattern = str(body.get("match_pattern", "")).strip()[:200]
    if pattern and "%" not in pattern:
        pattern = "%" + pattern + "%"
    vals = {f: str(body.get(f, "") or "").strip()[:2000 if f == "note" else 300] for f in LICENSE_FIELDS}
    vals.update(product=product, match_pattern=pattern, seats=max(0, ingest.num(body.get("seats"), 0)),
                purchased=_iso_date(body.get("purchased")), expires=_iso_date(body.get("expires")))
    return [vals[f] for f in LICENSE_FIELDS]


@app.get("/api/licenses/{license_id}")
def license_get(license_id: int, user=Depends(admin_user)):
    with db.db() as conn:
        row = conn.execute("SELECT * FROM licenses WHERE id = ?", (license_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Licence neexistuje")
        item = dict(row)
        item["installs"] = [dict(r) for r in conn.execute(
            "SELECT d.id AS device_id, d.hostname, d.logged_user, s.name, s.version FROM software s "
            "JOIN devices d ON d.id = s.device_id WHERE ? <> '' AND s.name LIKE ? "
            "ORDER BY d.hostname, s.name LIMIT 2000", (item["match_pattern"], item["match_pattern"]))]
    return item


@app.post("/api/licenses")
def license_create(body: dict = Body(...), user=Depends(admin_user)):
    vals = _license_values(body)
    with db.db() as conn:
        cur = conn.execute("INSERT INTO licenses(%s) VALUES(%s)" % (
            ", ".join(LICENSE_FIELDS), ",".join("?" * len(LICENSE_FIELDS))), vals)
    return {"id": cur.lastrowid}


@app.put("/api/licenses/{license_id}")
def license_update(license_id: int, body: dict = Body(...), user=Depends(admin_user)):
    vals = _license_values(body)
    with db.db() as conn:
        conn.execute("UPDATE licenses SET %s WHERE id = ?" % ", ".join(f + "=?" for f in LICENSE_FIELDS),
                     vals + [license_id])
    return {"ok": True}


@app.delete("/api/licenses/{license_id}")
def license_delete(license_id: int, user=Depends(admin_user)):
    with db.db() as conn:
        conn.execute("DELETE FROM licenses WHERE id = ?", (license_id,))
    return {"ok": True}


@app.post("/api/licenses/import")
def license_import(body: dict = Body(...), user=Depends(admin_user)):
    text = str(body.get("csv", "")).lstrip("﻿")
    if not text.strip():
        raise HTTPException(400, "Soubor je prázdný")
    first = text.splitlines()[0]
    delimiter = max((";", ",", "\t"), key=first.count)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    header = [h.strip().lower() for h in next(reader)]
    mapping = {}
    for field, aliases in LICENSE_ALIASES.items():
        for idx, name in enumerate(header):
            if name in aliases and field not in mapping:
                mapping[field] = idx
    if "product" not in mapping:
        raise HTTPException(400, "V hlavičce CSV chybí sloupec 'produkt'. Nalezené sloupce: " + ", ".join(header))
    imported, skipped = 0, 0
    with db.db() as conn:
        for line in reader:
            item = {f: (line[i].strip() if i < len(line) else "") for f, i in mapping.items()}
            if not item.get("product"):
                skipped += 1
                continue
            conn.execute("INSERT INTO licenses(%s) VALUES(%s)" % (
                ", ".join(LICENSE_FIELDS), ",".join("?" * len(LICENSE_FIELDS))), _license_values(item))
            imported += 1
    return {"imported": imported, "skipped": skipped, "columns": sorted(mapping)}


# ------------------------------------------------------------- uzivatele

@app.get("/api/users")
def users_list(user=Depends(admin_user)):
    with db.db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT id, username, full_name, role, must_change, created_at, last_login FROM users ORDER BY username")]


@app.post("/api/users")
def users_create(body: dict = Body(...), user=Depends(admin_user)):
    username = str(body.get("username", "")).strip()
    if not re.match(r"^[A-Za-z0-9._@-]{2,60}$", username):
        raise HTTPException(400, "Přihlašovací jméno: 2–60 znaků, písmena, číslice a . _ - @")
    check_new_password(body.get("password"))
    role = "admin" if body.get("role") == "admin" else "user"
    with db.db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise HTTPException(400, "Uživatel s tímto jménem už existuje")
        cur = conn.execute("INSERT INTO users(username, full_name, pw_hash, role, must_change) VALUES(?,?,?,?,1)",
                           (username, str(body.get("full_name", ""))[:100], hash_pw(body["password"]), role))
    return {"id": cur.lastrowid}


def _admin_count(conn):
    return conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]


@app.put("/api/users/{user_id}")
def users_update(user_id: int, body: dict = Body(...), user=Depends(admin_user)):
    with db.db() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Uživatel neexistuje")
        role = "admin" if body.get("role", row["role"]) == "admin" else "user"
        if row["role"] == "admin" and role != "admin" and _admin_count(conn) <= 1:
            raise HTTPException(400, "Musí zůstat alespoň jeden administrátor")
        conn.execute("UPDATE users SET full_name = ?, role = ? WHERE id = ?",
                     (str(body.get("full_name", row["full_name"]))[:100], role, user_id))
        if body.get("password"):
            check_new_password(body["password"])
            conn.execute("UPDATE users SET pw_hash = ?, must_change = ? WHERE id = ?",
                         (hash_pw(body["password"]), 0 if user_id == user["id"] else 1, user_id))
            if user_id != user["id"]:
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return {"ok": True}


@app.delete("/api/users/{user_id}")
def users_delete(user_id: int, user=Depends(admin_user)):
    if user_id == user["id"]:
        raise HTTPException(400, "Nelze smazat vlastní účet")
    with db.db() as conn:
        row = conn.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
        if row and row["role"] == "admin" and _admin_count(conn) <= 1:
            raise HTTPException(400, "Musí zůstat alespoň jeden administrátor")
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return {"ok": True}


# -------------------------------------------------------------- nastaveni

def _base_url(request, cfg):
    base = (cfg.get("server_url") or str(request.base_url)).rstrip("/")
    # server s vlastnim HTTPS na http:// neodpovida - adresu pro agenty proto vzdy vydavame jako https
    if tls.enabled() and base.lower().startswith("http://"):
        base = "https://" + base[7:]
    return base


def _cert_pin(base):
    return tls.thumbprint() if base.lower().startswith("https://") else ""


@app.get("/api/settings")
def settings_get(user=Depends(admin_user)):
    with db.db() as conn:
        cfg = db.get_settings(conn)
    cfg.pop("agent_token", None)
    for key in db.SECRET_SETTINGS:
        cfg[key] = MASK if cfg.get(key) else ""
    return cfg


def _merged_settings(conn, body):
    cfg = db.get_settings(conn)
    for key in db.DEFAULT_SETTINGS:
        if key in body and not (key in db.SECRET_SETTINGS and body[key] == MASK):
            cfg[key] = str(body[key]).strip()
    return cfg


@app.put("/api/settings")
def settings_put(body: dict = Body(...), user=Depends(admin_user)):
    numeric = {"ad_interval_min": (15, 10080), "scan_interval_min": (5, 10080), "winrm_interval_min": (60, 43200),
               "agent_inventory_hours": (1, 168), "offline_after_min": (5, 1440), "agent_stale_hours": (1, 8760), "backup_hour": (0, 23),
               "backup_keep": (1, 365), "usb_events_keep_days": (7, 3650)}
    with db.db() as conn:
        for key in db.DEFAULT_SETTINGS:
            if key not in body:
                continue
            value = str(body[key]).strip()
            if key in db.SECRET_SETTINGS and value == MASK:
                continue
            if key in numeric:
                low, high = numeric[key]
                value = str(min(high, max(low, ingest.num(value, low))))
            if key == "scan_ranges":
                try:
                    discovery.parse_ranges(value)
                except ValueError as exc:
                    raise HTTPException(400, str(exc))
            if key == "server_url" and value and not re.match(r"^https?://[A-Za-z0-9._~:/\[\]%-]+$", value):
                raise HTTPException(400, "Adresa serveru musí začínat http:// nebo https://")
            if key.endswith("_enabled") or key in ("ad_use_ssl", "agent_autoupdate"):
                value = "1" if value in ("1", "true", "True", "on") else "0"
            db.set_setting(conn, key, value)
    return {"ok": True}


@app.post("/api/settings/test-ad")
def settings_test_ad(body: dict = Body(default={}), user=Depends(admin_user)):
    with db.db() as conn:
        cfg = _merged_settings(conn, body)
    try:
        return {"ok": True, "message": discovery.ad_test(cfg)}
    except Exception as exc:
        return {"ok": False, "message": "%s: %s" % (type(exc).__name__, exc)}


@app.get("/api/jobs")
def jobs_list(user=Depends(admin_user)):
    with db.db() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM jobs ORDER BY id DESC LIMIT 50")]
    for r in rows:
        r["label"] = discovery.JOBS.get(r["kind"], (r["kind"],))[0]
    return rows


@app.post("/api/jobs/{kind}/run")
def jobs_run(kind: str, user=Depends(admin_user)):
    if kind not in discovery.JOBS:
        raise HTTPException(404, "Neznámá úloha")
    if not discovery.run_job(kind):
        raise HTTPException(409, "Tato úloha právě běží")
    return {"ok": True}


# ------------------------------------------------------------------ agent

AGENT_END = "#HWSW-AGENT-END"


def _agent_token():
    with db.db() as conn:
        return db.get_settings(conn, decrypt=False).get("agent_token", "")


def _check_agent(request: Request):
    given = request.headers.get("x-agent-token", "")
    token = _agent_token()
    if not token or not hmac.compare_digest(given.encode(), token.encode()):
        raise HTTPException(401, "Neplatný token agenta")
    if int(request.headers.get("content-length") or 0) > 8 * 1024 * 1024:
        raise HTTPException(413, "Příliš velká data")


def _agent_reply(conn):
    cfg = db.get_settings(conn, decrypt=False)
    return {"ok": True, "agent_version": db.APP_VERSION, "autoupdate": cfg["agent_autoupdate"] == "1",
            "inventory_hours": int(cfg["agent_inventory_hours"] or 6)}


def _ps_unwrap(value):
    """Windows PowerShell <= 5.1 umi pole serializovat jako {"value": [...], "Count": n}."""
    if isinstance(value, dict):
        if set(value.keys()) == {"value", "Count"} and isinstance(value["value"], list):
            return [_ps_unwrap(v) for v in value["value"]]
        return {k: _ps_unwrap(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_ps_unwrap(v) for v in value]
    return value


@app.post("/api/agent/inventory")
def agent_inventory(request: Request, body: dict = Body(...)):
    _check_agent(request)
    body = _ps_unwrap(body)
    try:
        with db.db() as conn:
            device_id, events = ingest.ingest_inventory(conn, body)
            reply = _agent_reply(conn)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    for ev in events:
        bus.publish(dict(ev, type="usb"))
    bus.publish({"type": "inventory", "device_id": device_id})
    return reply


@app.post("/api/agent/usb")
def agent_usb(request: Request, body: dict = Body(...)):
    _check_agent(request)
    body = _ps_unwrap(body)
    with db.db() as conn:
        device_id, events = ingest.ingest_usb(conn, body)
        reply = _agent_reply(conn)
    for ev in events:
        bus.publish(dict(ev, type="usb"))
    reply["known"] = device_id is not None
    return reply


@app.post("/api/agent/heartbeat")
def agent_heartbeat(request: Request, body: dict = Body(...)):
    _check_agent(request)
    with db.db() as conn:
        known = ingest.ingest_heartbeat(conn, body)
        reply = _agent_reply(conn)
    reply["known"] = known
    return reply


@app.get("/agent/hwsw-agent.ps1")
def agent_script(request: Request, token: str = "", mode: str = "once"):
    real = _agent_token()
    if not real or not hmac.compare_digest(token.encode(), real.encode()):
        raise HTTPException(401, "Neplatný token agenta")
    if mode not in ("once", "watch", "install", "uninstall", "test"):
        mode = "once"
    with db.db() as conn:
        cfg = db.get_settings(conn, decrypt=False)
    with open(os.path.join(APP_DIR, "agent", "hwsw-agent.ps1"), encoding="utf-8") as f:
        script = f.read()
    base = _base_url(request, cfg)
    if not re.match(r"^https?://[A-Za-z0-9._~:/\[\]%-]+$", base):
        raise HTTPException(400, "Neplatná adresa serveru")
    script = (script.replace("__SERVER_URL__", base).replace("__TOKEN__", real)
              .replace("__MODE__", mode).replace("__VERSION__", db.APP_VERSION)
              .replace("__CERT_PIN__", _cert_pin(base)))
    return Response("﻿" + script, media_type="text/plain; charset=utf-8")


@app.get("/api/agent-info")
def agent_info(request: Request, user=Depends(admin_user)):
    with db.db() as conn:
        cfg = db.get_settings(conn, decrypt=False)
        agents = conn.execute("SELECT COUNT(*) FROM devices WHERE agent_version <> ''").fetchone()[0]
    base, token = _base_url(request, cfg), cfg.get("agent_token", "")
    url = "%s/agent/hwsw-agent.ps1?token=%s&mode=" % (base, token)
    pin = _cert_pin(base)

    def one(mode):
        return 'powershell -NoProfile -ExecutionPolicy Bypass -Command "%s"' % tls.bootstrap_ps(url + mode, pin)

    return {"server_url": base, "server_url_set": bool(cfg.get("server_url")), "token": token, "agents": agents,
            "install": one("install"), "once": one("once"), "test": one("test"), "uninstall": one("uninstall"),
            "download": url + "watch", "tls": tls.enabled(), "cert_thumbprint": pin}


@app.get("/api/tls/cert")
def tls_cert(user=Depends(admin_user)):
    if not tls.enabled() or not os.path.isfile(tls.CERT_PATH):
        raise HTTPException(404, "HTTPS s vlastním certifikátem není zapnuté")
    return Response(tls.cert_pem(), media_type="application/x-pem-file",
                    headers={"Content-Disposition": 'attachment; filename="hwsw-monitor.crt"'})


@app.post("/api/agent-token/regenerate")
def agent_token_regenerate(user=Depends(admin_user)):
    with db.db() as conn:
        db.set_setting(conn, "agent_token", secrets.token_urlsafe(32))
    return {"ok": True}


# ----------------------------------------------------------------- zalohy

@app.get("/api/backups")
def backups_list(user=Depends(admin_user)):
    size = os.path.getsize(db.DB_PATH) if os.path.isfile(db.DB_PATH) else 0
    return {"backups": db.list_backups(), "db_size": size, "version": db.APP_VERSION,
            "schema": len(db.MIGRATIONS), "data_dir": db.DATA_DIR}


@app.post("/api/backups")
def backups_create(user=Depends(admin_user)):
    return {"name": db.backup_db("manual")}


@app.get("/api/backups/full")
def backups_full(user=Depends(admin_user)):
    path = db.full_backup_file()
    name = "hwsw-full-%s.tar.gz" % time.strftime("%Y%m%d-%H%M%S")
    return FileResponse(path, filename=name, media_type="application/gzip",
                        background=BackgroundTask(os.remove, path))


@app.get("/api/backups/{name}/download")
def backups_download(name: str, user=Depends(admin_user)):
    try:
        return FileResponse(db.backup_path(name), filename=name, media_type="application/gzip")
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "Záloha neexistuje")


@app.delete("/api/backups/{name}")
def backups_delete(name: str, user=Depends(admin_user)):
    try:
        os.remove(db.backup_path(name))
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "Záloha neexistuje")
    return {"ok": True}


@app.post("/api/backups/{name}/restore")
def backups_restore(name: str, user=Depends(admin_user)):
    try:
        path = db.backup_path(name)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "Záloha neexistuje")
    try:
        safety = db.restore_from_file(path)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True, "safety_backup": safety}


@app.post("/api/backups/upload-restore")
async def backups_upload_restore(request: Request, user=Depends(admin_user)):
    os.makedirs(db.BACKUP_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".upload", dir=db.BACKUP_DIR)
    try:
        size = 0
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > 2 * 1024 ** 3:
                    raise HTTPException(413, "Soubor je příliš velký")
                f.write(chunk)
        try:
            safety = await run_in_threadpool(db.restore_from_file, tmp)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"ok": True, "safety_backup": safety}


# ------------------------------------------------------- zive udalosti

@app.get("/api/events")
async def events(request: Request):
    user = await run_in_threadpool(current_user, request)
    admin = user["role"] == "admin"
    queue = bus.subscribe()

    async def stream():
        try:
            yield ": ok\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), 20)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if not admin:
                    event = {"type": event.get("type")}
                yield "data: %s\n\n" % json.dumps(event, ensure_ascii=False)
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- web

@app.get("/healthz")
def healthz():
    with db.db() as conn:
        conn.execute("SELECT 1 FROM meta LIMIT 1")
    return {"ok": True, "version": db.APP_VERSION}


@app.get("/")
def index():
    with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
        html = f.read().replace("__V__", db.APP_VERSION)
    return Response(html, media_type="text/html; charset=utf-8")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
