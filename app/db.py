"""SQLite databaze: pripojeni, migrace schematu, zalohy a obnova.

Zasady:
- databaze lezi v /data (Docker volume), nikdy v image,
- pred kazdou migraci (nova verze aplikace nebo schematu) se nejdrive udela
  overena zaloha; kdyz se zaloha nepovede, migrace se nespusti,
- kazda migrace bezi v transakci - bud projde cela, nebo se nezmeni nic.
"""
import gzip
import io
import json
import os
import re
import shutil
import sqlite3
import tarfile
import tempfile
import threading
import time
from contextlib import contextmanager

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("HWSW_DATA", "/data")
DB_PATH = os.path.join(DATA_DIR, "hwsw.db")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
SECRET_PATH = os.path.join(DATA_DIR, "secret.key")

with open(os.path.join(APP_DIR, "VERSION"), encoding="utf-8") as _f:
    APP_VERSION = _f.read().strip()

_maintenance = threading.RLock()

# Kazda polozka = jedna verze schematu. Existujici polozky se NIKDY nemeni,
# nove zmeny se pridavaji jen na konec seznamu.
MIGRATIONS = [
    [
        """CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)""",
        """CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)""",
        """CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            full_name TEXT DEFAULT '',
            pw_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            must_change INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_login TEXT)""",
        """CREATE TABLE sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires TEXT NOT NULL)""",
        """CREATE TABLE devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hostname TEXT DEFAULT '' COLLATE NOCASE,
            fqdn TEXT DEFAULT '',
            domain TEXT DEFAULT '',
            ip TEXT DEFAULT '',
            mac TEXT DEFAULT '',
            device_type TEXT DEFAULT '',
            manufacturer TEXT DEFAULT '',
            model TEXT DEFAULT '',
            serial TEXT DEFAULT '',
            asset_tag TEXT DEFAULT '',
            location TEXT DEFAULT '',
            os_name TEXT DEFAULT '',
            os_version TEXT DEFAULT '',
            cpu TEXT DEFAULT '',
            ram_mb INTEGER DEFAULT 0,
            disk_gb INTEGER DEFAULT 0,
            bios_version TEXT DEFAULT '',
            logged_user TEXT DEFAULT '',
            user_sam TEXT DEFAULT '' COLLATE NOCASE,
            assigned_user TEXT DEFAULT '',
            ad_dn TEXT DEFAULT '',
            ad_ou TEXT DEFAULT '',
            ad_description TEXT DEFAULT '',
            ad_last_logon TEXT DEFAULT '',
            ad_enabled INTEGER,
            open_ports TEXT DEFAULT '',
            source TEXT DEFAULT '',
            agent_version TEXT DEFAULT '',
            online INTEGER NOT NULL DEFAULT 0,
            usb_baseline INTEGER NOT NULL DEFAULT 0,
            first_seen TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen TEXT DEFAULT '',
            last_inventory TEXT DEFAULT '',
            note TEXT DEFAULT '',
            details TEXT DEFAULT '{}')""",
        """CREATE INDEX idx_devices_hostname ON devices(hostname)""",
        """CREATE INDEX idx_devices_mac ON devices(mac)""",
        """CREATE INDEX idx_devices_ip ON devices(ip)""",
        """CREATE TABLE ad_users (
            sam TEXT PRIMARY KEY COLLATE NOCASE,
            display_name TEXT DEFAULT '',
            mail TEXT DEFAULT '',
            department TEXT DEFAULT '',
            title TEXT DEFAULT '',
            enabled INTEGER DEFAULT 1)""",
        """CREATE TABLE monitors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
            manufacturer TEXT DEFAULT '',
            model TEXT DEFAULT '',
            serial TEXT DEFAULT '',
            year INTEGER,
            size_inch REAL,
            connection TEXT DEFAULT '',
            connected INTEGER NOT NULL DEFAULT 1,
            first_seen TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen TEXT DEFAULT '',
            note TEXT DEFAULT '')""",
        """CREATE INDEX idx_monitors_device ON monitors(device_id)""",
        """CREATE TABLE software (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            version TEXT DEFAULT '',
            publisher TEXT DEFAULT '',
            install_date TEXT DEFAULT '')""",
        """CREATE INDEX idx_software_device ON software(device_id)""",
        """CREATE INDEX idx_software_name ON software(name)""",
        """CREATE TABLE sw_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            ts TEXT NOT NULL DEFAULT (datetime('now')),
            action TEXT NOT NULL,
            name TEXT NOT NULL,
            version TEXT DEFAULT '')""",
        """CREATE INDEX idx_sw_changes_device ON sw_changes(device_id)""",
        """CREATE TABLE usb_current (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            pnp_id TEXT NOT NULL,
            name TEXT DEFAULT '',
            manufacturer TEXT DEFAULT '',
            vid TEXT DEFAULT '',
            pid TEXT DEFAULT '',
            serial TEXT DEFAULT '',
            class TEXT DEFAULT '',
            connected_at TEXT NOT NULL DEFAULT (datetime('now')))""",
        """CREATE INDEX idx_usb_current_device ON usb_current(device_id)""",
        """CREATE TABLE usb_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            ts TEXT NOT NULL DEFAULT (datetime('now')),
            action TEXT NOT NULL,
            pnp_id TEXT DEFAULT '',
            name TEXT DEFAULT '',
            manufacturer TEXT DEFAULT '',
            vid TEXT DEFAULT '',
            pid TEXT DEFAULT '',
            serial TEXT DEFAULT '',
            class TEXT DEFAULT '',
            logged_user TEXT DEFAULT '')""",
        """CREATE INDEX idx_usb_events_device ON usb_events(device_id)""",
        """CREATE INDEX idx_usb_events_ts ON usb_events(ts)""",
        """CREATE TABLE licenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product TEXT NOT NULL,
            vendor TEXT DEFAULT '',
            license_type TEXT DEFAULT '',
            license_key TEXT DEFAULT '',
            seats INTEGER DEFAULT 0,
            match_pattern TEXT DEFAULT '',
            purchased TEXT DEFAULT '',
            expires TEXT DEFAULT '',
            cost TEXT DEFAULT '',
            supplier TEXT DEFAULT '',
            invoice TEXT DEFAULT '',
            assigned_to TEXT DEFAULT '',
            note TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')))""",
        """CREATE TABLE views (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            entity TEXT NOT NULL,
            columns TEXT NOT NULL DEFAULT '[]',
            filters TEXT NOT NULL DEFAULT '[]',
            sort TEXT DEFAULT '',
            sort_dir TEXT DEFAULT 'asc',
            shared_all INTEGER NOT NULL DEFAULT 0,
            user_ids TEXT NOT NULL DEFAULT '[]',
            allow_detail INTEGER NOT NULL DEFAULT 0,
            position INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')))""",
        """CREATE TABLE jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            started TEXT NOT NULL DEFAULT (datetime('now')),
            finished TEXT,
            status TEXT NOT NULL DEFAULT 'running',
            summary TEXT DEFAULT '')""",
    ],
    [
        # verze 1.1.0: hotovy pohled "Zabezpeceni" (admin ho muze upravit nebo smazat)
        """INSERT INTO views(name, description, entity, columns, filters, sort, sort_dir, position)
           SELECT 'Zabezpečení počítačů',
                  'BitLocker, antivirus, firewall, Secure Boot, TPM, aktualizace a stav disků',
                  'devices',
                  '["hostname","logged_user","os_name","sec_bitlocker","sec_antivirus","sec_firewall","sec_secure_boot","sec_tpm","sec_last_hotfix","sec_pending_reboot","disk_health","local_admins"]',
                  '[{"col":"last_inventory","op":"not_empty","value":""}]',
                  'hostname', 'asc', 100
           WHERE NOT EXISTS (SELECT 1 FROM views WHERE name = 'Zabezpečení počítačů')""",
    ],
]


def connect(path=None):
    conn = sqlite3.connect(path or DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    """Pripojeni s jednou transakci: commit pri uspechu, rollback pri chybe."""
    conn = connect()
    try:
        conn.execute("BEGIN")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())


def _stamp():
    return time.strftime("%Y%m%d-%H%M%S")


def _integrity(conn):
    row = conn.execute("PRAGMA integrity_check").fetchone()
    return row is not None and row[0] == "ok"


# ------------------------------------------------------------------ zalohy

def _snapshot(dest_path):
    """Konzistentni kopie zive databaze (SQLite backup API) + kontrola integrity."""
    src = connect()
    dst = sqlite3.connect(dest_path)
    try:
        src.backup(dst)
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Záloha neprošla kontrolou integrity")
    finally:
        dst.close()
        src.close()


def backup_db(label="manual"):
    """Vytvori komprimovanou zalohu databaze, vraci jmeno souboru."""
    label = re.sub(r"[^A-Za-z0-9._-]", "_", label)[:60] or "manual"
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = _stamp()
    name = "hwsw-%s-%s.db.gz" % (label, stamp)
    while os.path.exists(os.path.join(BACKUP_DIR, name)):  # dve zalohy ve stejne sekunde
        time.sleep(1)
        stamp = _stamp()
        name = "hwsw-%s-%s.db.gz" % (label, stamp)
    final = os.path.join(BACKUP_DIR, name)
    fd, tmp = tempfile.mkstemp(suffix=".db", dir=BACKUP_DIR)
    os.close(fd)
    try:
        _snapshot(tmp)
        with open(tmp, "rb") as fi, gzip.open(final + ".part", "wb", compresslevel=6) as fo:
            shutil.copyfileobj(fi, fo, 1024 * 1024)
        os.replace(final + ".part", final)
    finally:
        for p in (tmp, final + ".part"):
            if os.path.exists(p):
                os.remove(p)
    return name


def list_backups():
    out = []
    if not os.path.isdir(BACKUP_DIR):
        return out
    for name in os.listdir(BACKUP_DIR):
        if not name.endswith(".db.gz"):
            continue
        st = os.stat(os.path.join(BACKUP_DIR, name))
        m = re.match(r"hwsw-(.+)-\d{8}-\d{6}\.db\.gz$", name)
        out.append({
            "name": name,
            "size": st.st_size,
            "created": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(st.st_mtime)),
            "label": m.group(1) if m else "",
        })
    out.sort(key=lambda b: b["created"], reverse=True)
    return out


def backup_path(name):
    """Bezpecne prevede jmeno zalohy na cestu (zadne ../)."""
    if not re.match(r"^[A-Za-z0-9._-]+\.db\.gz$", name):
        raise ValueError("Neplatné jméno zálohy")
    path = os.path.join(BACKUP_DIR, name)
    if not os.path.isfile(path):
        raise FileNotFoundError(name)
    return path


def prune_backups(keep_auto):
    """Smaze stare automaticke zalohy. Rucni a pred-aktualizacni se nemazou."""
    autos = [b for b in list_backups() if b["label"] == "auto"]
    for b in autos[max(1, int(keep_auto)):]:
        try:
            os.remove(os.path.join(BACKUP_DIR, b["name"]))
        except OSError:
            pass


def full_backup_file():
    """Kompletni zaloha datoveho adresare (databaze + sifrovaci klic) jako tar.gz.

    Vraci cestu k docasnemu souboru; volajici ho po odeslani smaze.
    """
    os.makedirs(BACKUP_DIR, exist_ok=True)
    fd, snap = tempfile.mkstemp(suffix=".db", dir=BACKUP_DIR)
    os.close(fd)
    fd, out = tempfile.mkstemp(suffix=".tar.gz", dir=BACKUP_DIR)
    os.close(fd)
    try:
        _snapshot(snap)
        manifest = json.dumps({
            "app": "hwsw-monitor",
            "app_version": APP_VERSION,
            "schema_version": len(MIGRATIONS),
            "created_utc": now(),
        }, indent=2).encode()
        with tarfile.open(out, "w:gz") as tar:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(manifest)
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(manifest))
            tar.add(snap, arcname="hwsw.db")
            if os.path.isfile(SECRET_PATH):
                tar.add(SECRET_PATH, arcname="secret.key")
    except BaseException:
        if os.path.exists(out):
            os.remove(out)
        raise
    finally:
        if os.path.exists(snap):
            os.remove(snap)
    return out


def restore_from_file(upload_path):
    """Obnovi databazi ze souboru (.db, .db.gz nebo kompletni .tar.gz).

    Pred obnovou vzdy zalohuje aktualni stav. Vraci jmeno teto zalohy.
    """
    os.makedirs(BACKUP_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".db", dir=BACKUP_DIR)
    os.close(fd)
    new_secret = None
    try:
        with open(upload_path, "rb") as f:
            head = f.read(16)
        if head.startswith(b"SQLite format 3"):
            shutil.copyfile(upload_path, tmp)
        elif head[:2] == b"\x1f\x8b":
            is_tar = False
            try:
                with tarfile.open(upload_path, "r:gz") as tar:
                    names = tar.getnames()
                    is_tar = "hwsw.db" in names
                    if is_tar:
                        with open(tmp, "wb") as fo:
                            shutil.copyfileobj(tar.extractfile("hwsw.db"), fo)
                        if "secret.key" in names:
                            new_secret = tar.extractfile("secret.key").read(4096)
            except tarfile.TarError:
                is_tar = False
            if not is_tar:
                with gzip.open(upload_path, "rb") as fi, open(tmp, "wb") as fo:
                    shutil.copyfileobj(fi, fo, 1024 * 1024)
        else:
            raise ValueError("Soubor není záloha HWSW (očekává se .db, .db.gz nebo .tar.gz)")

        src = sqlite3.connect(tmp)
        try:
            if src.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Záloha je poškozená (kontrola integrity selhala)")
            tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"meta", "devices", "users"} <= tables:
                raise ValueError("Soubor není databáze HWSW Monitoru")
            ver = src.execute("PRAGMA user_version").fetchone()[0]
            if ver > len(MIGRATIONS):
                raise ValueError("Záloha pochází z novější verze aplikace (schéma %d), "
                                 "tato verze umí nejvýše %d" % (ver, len(MIGRATIONS)))
            with _maintenance:
                safety = backup_db("pre-restore")
                dst = connect()
                try:
                    src.backup(dst)
                finally:
                    dst.close()
                if new_secret:
                    with open(SECRET_PATH, "wb") as f:
                        f.write(new_secret)
                    os.chmod(SECRET_PATH, 0o600)
                _migrate()
        finally:
            src.close()
        return safety
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ----------------------------------------------------------------- migrace

def _migrate():
    conn = connect()
    try:
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        for idx in range(current, len(MIGRATIONS)):
            conn.execute("BEGIN IMMEDIATE")
            try:
                for stmt in MIGRATIONS[idx]:
                    conn.execute(stmt)
                conn.execute("PRAGMA user_version=%d" % (idx + 1))
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        if not _integrity(conn):
            raise RuntimeError("Databáze po migraci neprošla kontrolou integrity")
        conn.execute("INSERT INTO meta(key,value) VALUES('app_version',?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (APP_VERSION,))
    finally:
        conn.close()


def startup():
    """Vola se pri startu kontejneru. Vraci text o tom, co se stalo."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    msg = "nová databáze"
    if os.path.isfile(DB_PATH) and os.path.getsize(DB_PATH) > 0:
        conn = connect()
        try:
            if not _integrity(conn):
                raise RuntimeError(
                    "Databáze %s je poškozená. Aplikace se nespustí, aby data nezhoršila. "
                    "Obnovte poslední zálohu z %s." % (DB_PATH, BACKUP_DIR))
            schema = conn.execute("PRAGMA user_version").fetchone()[0]
            old_app = ""
            if schema > 0:
                row = conn.execute("SELECT value FROM meta WHERE key='app_version'").fetchone()
                old_app = row[0] if row else ""
        finally:
            conn.close()
        if schema > len(MIGRATIONS):
            raise RuntimeError(
                "Databáze má novější schéma (%d) než tato verze aplikace (%d). "
                "Downgrade není podporován - nasaďte novější image nebo obnovte starší zálohu."
                % (schema, len(MIGRATIONS)))
        if schema > 0 and (schema < len(MIGRATIONS) or old_app != APP_VERSION):
            # Zaloha PRED jakoukoli zmenou. Kdyz selze, vyjimka zastavi start.
            name = backup_db("pre-update-%s-to-%s" % (old_app or "x", APP_VERSION))
            msg = "aktualizace %s -> %s, záloha před aktualizací: %s" % (old_app, APP_VERSION, name)
        else:
            msg = "databáze beze změny"
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    finally:
        conn.close()
    _migrate()
    return msg


# -------------------------------------------------------------- nastaveni

SECRET_SETTINGS = {"ad_password", "winrm_password"}
_fernet = None


def _crypto():
    global _fernet
    from cryptography.fernet import Fernet
    if not os.path.isfile(SECRET_PATH):
        with open(SECRET_PATH, "wb") as f:
            f.write(Fernet.generate_key())
        os.chmod(SECRET_PATH, 0o600)
        _fernet = None
    with open(SECRET_PATH, "rb") as f:
        key = f.read().strip()
    if _fernet is None or _fernet[0] != key:
        _fernet = (key, Fernet(key))
    return _fernet[1]


DEFAULT_SETTINGS = {
    "server_url": "",
    "ad_enabled": "0",
    "ad_server": "",
    "ad_use_ssl": "0",
    "ad_user": "",
    "ad_password": "",
    "ad_base_dn": "",
    "ad_interval_min": "360",
    "scan_enabled": "0",
    "scan_ranges": "",
    "scan_interval_min": "30",
    "snmp_community": "public",
    "winrm_enabled": "0",
    "winrm_user": "",
    "winrm_password": "",
    "winrm_mode": "once",
    "winrm_interval_min": "720",
    "agent_inventory_hours": "6",
    "agent_autoupdate": "0",
    "offline_after_min": "20",
    "agent_stale_hours": "72",
    "backup_enabled": "1",
    "backup_hour": "2",
    "backup_keep": "14",
    "usb_events_keep_days": "365",
}


def get_settings(conn, decrypt=True):
    data = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key, value FROM settings"):
        data[row["key"]] = row["value"]
    if decrypt:
        for key in SECRET_SETTINGS:
            if data.get(key):
                try:
                    data[key] = _crypto().decrypt(data[key].encode()).decode()
                except Exception:
                    data[key] = ""
    return data


def set_setting(conn, key, value):
    value = "" if value is None else str(value)
    if key in SECRET_SETTINGS and value:
        value = _crypto().encrypt(value.encode()).decode()
    conn.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
