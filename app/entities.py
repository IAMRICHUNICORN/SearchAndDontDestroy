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


def _vkey4(col):
    """Klic pro porovnani verzi o az 4 castech podle cisel (10.0 je vetsi nez 9.0)."""
    parts, rest = [], col
    for _ in range(4):
        parts.append("CAST(substr(%s, 1, instr(%s || '.', '.') - 1) AS INTEGER)" % (rest, rest))
        rest = "substr(%s, instr(%s || '.', '.') + 1)" % (rest, rest)
    return "printf('%%08d%%08d%%08d%%08d', %s)" % ", ".join(parts)


def _sw_version(order):
    return ("(SELECT s2.version FROM software s2 WHERE s2.name = x.name AND s2.publisher = x.publisher "
            "AND COALESCE(s2.version, '') <> '' ORDER BY %s %s LIMIT 1)" % (_vkey4("s2.version"), order))

_LIC_USED = ("(SELECT COUNT(DISTINCT s.device_id) FROM software s "
             "WHERE x.match_pattern <> '' AND s.name LIKE x.match_pattern)")

_COMPUTER_TYPES = ("'počítač'", "'notebook'", "'server'", "'virtuální server'", "'virtuální počítač'",
                   "'počítač (Windows)'")
_IS_COMPUTER = ("CASE WHEN d.device_type IN (%s) OR COALESCE(d.agent_version, '') <> '' "
                "OR COALESCE(d.last_inventory, '') <> '' THEN 1 ELSE 0 END" % ", ".join(_COMPUTER_TYPES))
# __STALE__ se pri dotazu nahradi poctem hodin z Nastaveni (agent_stale_hours)
_AGENT_STATE = ("CASE WHEN COALESCE(d.last_inventory, '') <> '' THEN "
                "CASE WHEN d.last_inventory >= datetime('now', '-__STALE__ hours') THEN 'odesílá' ELSE 'neaktivní' END "
                "WHEN %s = 1 THEN 'nikdy' ELSE '' END" % _IS_COMPUTER)
# nejhorsi stav prvni: nikdy (0), neaktivni (1), odesila (2), bez agenta (3)
SECTIONS = ("Počítače", "Servery", "IoT", "Síťové prvky", "Tiskárny")
# automaticke zarazeni podle typu; rucni volba (section_manual) ma vzdy prednost
_SECTION_AUTO = ("CASE "
                 "WHEN d.device_type IN ('server', 'virtuální server') THEN 'Servery' "
                 "WHEN d.device_type = 'tiskárna' THEN 'Tiskárny' "
                 "WHEN d.device_type = 'síťové zařízení' THEN 'Síťové prvky' "
                 "WHEN %s = 1 THEN 'Počítače' ELSE '' END" % _IS_COMPUTER)
_SECTION = "COALESCE(d.section_manual, %s)" % _SECTION_AUTO

_AGENT_STATE_ORDER = ("CASE WHEN COALESCE(d.last_inventory, '') <> '' THEN "
                      "CASE WHEN d.last_inventory >= datetime('now', '-__STALE__ hours') THEN 2 ELSE 1 END "
                      "WHEN %s = 1 THEN 0 ELSE 3 END" % _IS_COMPUTER)

def _ip_sort(col):
    """Razeni IPv4 podle cisel (ne podle textu); ostatni hodnoty (prazdne, IPv6) na konec."""
    parts, rest = [], col
    for _ in range(4):
        parts.append("CAST(substr(%s, 1, instr(%s || '.', '.') - 1) AS INTEGER)" % (rest, rest))
        rest = "substr(%s, instr(%s || '.', '.') + 1)" % (rest, rest)
    return ("CASE WHEN %s GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*' THEN printf('%%03d%%03d%%03d%%03d', %s) "
            "ELSE 'z' || COALESCE(%s, '') END" % (col, ", ".join(parts), col))


# konflikt = stejna IP na vice zarizenich, ktera jsou OBA ted online (a nedavno videna); shodna neprazdna MAC = duplicita.
# Zaznam, ktery uz online neni (napr. stary ERA po vymene za ESMC), konflikt nezpusobuje - jen se ukaze jako starsi zaznam.
_IPC_WHERE = ("o.id <> d.id AND d.ip <> '' AND o.ip = d.ip AND o.online = 1 AND d.online = 1 "
              "AND o.last_seen >= datetime('now', '-__STALE__ hours') "
              "AND d.last_seen >= datetime('now', '-__STALE__ hours') "
              "AND (COALESCE(o.mac, '') = '' OR COALESCE(d.mac, '') = '' OR o.mac <> d.mac)")
_IP_CONFLICT = "CASE WHEN EXISTS (SELECT 1 FROM devices o WHERE %s) THEN 1 ELSE 0 END" % _IPC_WHERE
_IP_CONFLICT_WITH = ("(SELECT GROUP_CONCAT(COALESCE(NULLIF(o.hostname, ''), o.ip) || CASE WHEN COALESCE(o.mac, '') <> '' "
                     "THEN ' (' || o.mac || ')' ELSE '' END, ', ') FROM devices o WHERE %s)" % _IPC_WHERE)
# starsi zaznamy se stejnou IP, ktere uz nejsou online (zastarale nazvy), pro sede upozorneni u IP
_IP_OLD_WITH = ("(SELECT GROUP_CONCAT(COALESCE(NULLIF(o.hostname, ''), o.ip), ', ') FROM devices o "
                "WHERE o.id <> d.id AND d.ip <> '' AND o.ip = d.ip AND o.online = 0 AND d.online = 1)")


def _ver_key(col):
    """Klic pro porovnani verzi a.b.c podle cisel; neplatna verze = prazdny retezec."""
    parts, rest = [], col
    for _ in range(3):
        parts.append("CAST(substr(%s, 1, instr(%s || '.', '.') - 1) AS INTEGER)" % (rest, rest))
        rest = "substr(%s, instr(%s || '.', '.') + 1)" % (rest, rest)
    return ("CASE WHEN %s GLOB '[0-9]*.[0-9]*.[0-9]*' THEN printf('%%05d%%05d%%05d', %s) ELSE '' END"
            % (col, ", ".join(parts)))


# zastarala verze SW: stejny program ma jinde v evidenci vyssi verzi (porovnani prvnich tri cisel verze)
_SW_KEY = "(%s || '.0.0')"
_SW_OUTDATED = ("(" + _ver_key(_SW_KEY % "s.version") + " <> '' AND " + _ver_key(_SW_KEY % "s.version") + " < "
                "(SELECT MAX(" + _ver_key(_SW_KEY % "s2.version") + ") FROM software s2 WHERE s2.name = s.name))")

# cilova verze agenta pro PC: pripnuta u zarizeni, jinak globalni (__GTARGET__ se dosadi z Nastaveni)
_AGENT_TARGET = "COALESCE(NULLIF(d.agent_target, ''), __GTARGET__)"
_VER_STATUS = ("CASE WHEN COALESCE(d.agent_version, '') = '' THEN '' "
               "WHEN d.agent_version = %(t)s THEN 'aktuální' "
               "WHEN %(k)s = '' THEN 'neznámá' "
               "WHEN %(k)s < %(kt)s THEN 'zastaralý' ELSE 'novější' END"
               % {"t": _AGENT_TARGET, "k": _ver_key("d.agent_version"), "kt": _ver_key(_AGENT_TARGET)})
_HAS_AGENT = "(COALESCE(d.agent_version, '') <> '' OR COALESCE(d.last_inventory, '') <> '')"
_SKEW = "ABS(COALESCE(json_extract(d.agent_info, '$.skew_s'), 0))"
# duvody, proc agent neni v poradku (kazdy kus konci "; ")
# chyba spojeni se serverem (sit, restart serveru): je "prechodna", kdyz se agent zase ozval; zdravi nebarvi na cerveno
_TRANS = ("(d.agent_error LIKE '%nelze připojit%' OR d.agent_error LIKE '%Unable to connect%' OR d.agent_error LIKE '%timed out%' "
          "OR d.agent_error LIKE '%Operace vypršela%' OR d.agent_error LIKE '%nelze přeložit%' OR d.agent_error LIKE '%could not be resolved%' "
          "OR d.agent_error LIKE '%connection was closed%' OR d.agent_error LIKE '%připojení bylo zavřeno%' "
          "OR d.agent_error LIKE '%No connection could be made%' OR d.agent_error LIKE '%Nebylo možné navázat%')")
_BEAT_OK = "COALESCE(d.agent_beat, '') >= datetime('now', '-30 minutes')"
_LC = "MAX(COALESCE(d.agent_beat, ''), COALESCE(d.last_inventory, ''))"
# aktualni chyba agenta: agent se o ni hlasi stale (posledni vyskyt mladsi nez 30 min; trvala chyba se opakuje kazdych 5 min).
# Starsi chyba = opraveno (stav v poradku; zustava jen v historii chyb). Prechodna chyba spojeni s agentem, ktery se znovu ozval, se nepocita.
_ERR_CUR = ("(COALESCE(d.agent_error, '') <> '' AND d.agent_error_at >= datetime('now', '-30 minutes') "
            "AND (%(trans)s = 0 OR NOT %(beat)s))" % {"trans": _TRANS, "beat": _BEAT_OK})
# kolik z poslednich __ERRD__ dnu (vcetne dneska) se u zarizeni objevila chyba agenta
_ERR_DAYS = ("(SELECT COUNT(DISTINCT l.day) FROM agent_error_log l WHERE l.device_id = d.id "
             "AND l.day >= date('now', '-' || (__ERRD__ - 1) || ' days'))")
# PC odpovida na siti, agent se ale neozval (bez agenta se sem nepocitaji PC, kde agent nikdy nebyl)
_SILENT_ON = "(d.online = 1 AND %(lc)s <> '' AND %(lc)s < datetime('now', '-30 minutes'))" % {"lc": _LC}
# "chyba" az kdyz problem trva vic nez nastaveny pocet dni; kratsi problem je jen varovani
_HEALTH_BAD = (
    "CASE WHEN %(err)s AND %(days)s >= __ERRD__ THEN 'chyba agenta (' || d.agent_error || '), opakuje se ' || %(days)s || ' dny; ' ELSE '' END || "
    "CASE WHEN %(son)s AND %(lc)s < datetime('now', '-__ERRD__ days') "
    "THEN 'PC je online, ale agent se nespojil déle než __ERRD__ dny (od ' || %(lc)s || ' UTC); ' ELSE '' END"
    % {"err": _ERR_CUR, "days": _ERR_DAYS, "son": _SILENT_ON, "lc": _LC})
_HEALTH_WARN = (
    "CASE WHEN %(err)s AND %(days)s < __ERRD__ THEN 'chyba agenta (' || d.agent_error || '); ' ELSE '' END || "
    "CASE WHEN %(son)s AND %(lc)s >= datetime('now', '-__ERRD__ days') "
    "THEN 'PC je online, ale agent se nespojil od ' || %(lc)s || ' (UTC); ' ELSE '' END || "
    "CASE WHEN %(comp)s = 1 AND COALESCE(d.last_inventory, '') = '' AND (COALESCE(d.agent_version, '') <> '' OR COALESCE(d.agent_beat, '') <> '') "
    "THEN 'agent zatím neposlal inventuru; ' ELSE '' END || "
    "CASE WHEN COALESCE(d.last_inventory, '') <> '' AND d.last_inventory < datetime('now', '-__STALE__ hours') "
    "THEN 'agent neposlal data déle než __STALE__ h; ' ELSE '' END || "
    "CASE WHEN %(vs)s = 'zastaralý' THEN 'zastaralá verze agenta; ' WHEN %(vs)s = 'neznámá' THEN 'neznámá verze agenta; ' ELSE '' END || "
    "CASE WHEN COALESCE(d.last_inventory, '') <> '' AND COALESCE(d.agent_beat, '') >= datetime('now', '-30 minutes') "
    "AND d.last_inventory < datetime('now', '-__INVH__ hours') THEN 'stará inventura (agent žije); ' ELSE '' END || "
    "CASE WHEN json_extract(d.agent_info, '$.upd_state') = 'vraceno' "
    "THEN 'aktualizace agenta na ' || COALESCE(json_extract(d.agent_info, '$.upd_target'), '?') || ' selhala (vráceno); ' ELSE '' END || "
    "CASE WHEN %(skew)s > 300 THEN 'odchylka hodin oproti serveru; ' ELSE '' END || "
    "CASE WHEN json_extract(d.agent_info, '$.elevated') = 0 THEN 'agent běží bez práv správce; ' ELSE '' END || "
    "CASE WHEN json_extract(d.agent_info, '$.usb_watch') = 0 THEN 'USB sledování neběží; ' ELSE '' END || "
    "CASE WHEN COALESCE(json_array_length(json_extract(d.agent_info, '$.partial')), 0) > 0 "
    "THEN 'neúplná data (' || json_extract(d.agent_info, '$.partial[0]') || '...); ' ELSE '' END || "
    "CASE WHEN COALESCE(d.mac, '') <> '' AND EXISTS (SELECT 1 FROM devices o WHERE o.id <> d.id AND o.mac = d.mac "
    "AND COALESCE(o.agent_version, '') <> '') THEN 'duplicitní MAC (klon?); ' ELSE '' END"
    % {"vs": _VER_STATUS, "skew": _SKEW, "trans": _TRANS, "beat": _BEAT_OK, "err": _ERR_CUR, "days": _ERR_DAYS,
       "son": _SILENT_ON, "lc": _LC, "comp": _IS_COMPUTER})
# PC, kde agent nikdy nebyl: samostatny stav "bez agenta" (neni to chyba ani varovani)
_NOAGENT = "(%s = 1 AND NOT %s AND COALESCE(d.agent_beat, '') = '')" % (_IS_COMPUTER, _HAS_AGENT)
_HEALTH = ("CASE WHEN %(na)s THEN 'bez agenta' WHEN (%(bad)s) <> '' THEN 'chyba' WHEN (%(warn)s) <> '' THEN 'varování' "
           "WHEN %(has)s THEN 'v pořádku' ELSE '' END"
           % {"bad": _HEALTH_BAD, "warn": _HEALTH_WARN, "has": _HAS_AGENT, "na": _NOAGENT})
_HEALTH_REASON = ("CASE WHEN %(na)s THEN 'Agent na počítači není nainstalovaný nebo se ještě neozval' "
                  "ELSE rtrim((%(bad)s) || (%(warn)s), '; ') END" % {"bad": _HEALTH_BAD, "warn": _HEALTH_WARN, "na": _NOAGENT})
# poradi: nejhorsi prvni
_HEALTH_ORDER = ("CASE WHEN %(na)s THEN 3 WHEN (%(bad)s) <> '' THEN 0 WHEN (%(warn)s) <> '' THEN 1 WHEN %(has)s THEN 2 ELSE 4 END"
                 % {"bad": _HEALTH_BAD, "warn": _HEALTH_WARN, "has": _HAS_AGENT, "na": _NOAGENT})

# komunikace agenta: posledni kontakt = novejsi z heartbeatu a inventury; agent se hlasi nejmene kazdych 5 minut
_LAST_CONTACT = _LC
_COMM = ("CASE WHEN %(lc)s = '' THEN CASE WHEN %(comp)s = 1 THEN 'nikdy' ELSE '' END "
         "WHEN %(lc)s >= datetime('now', '-12 minutes') THEN 'komunikuje' ELSE 'mlčí' END"
         % {"lc": _LAST_CONTACT, "comp": _IS_COMPUTER})
_COMM_REASON = (
    "CASE WHEN %(lc)s = '' THEN CASE WHEN %(comp)s <> 1 THEN '' WHEN d.online = 1 "
    "THEN 'PC odpovídá na síti, ale agent se nikdy neozval: není nainstalovaný, nebo se instalace z GPO nespustila (skript z GPO běží jen při '"
    "|| 'skutečném startu Windows – restartujte PC, nebo nasaďte naplánovanou úlohu)' "
    "ELSE 'PC je vypnuté nebo mimo síť; agent se ozve po zapnutí, pokud je nainstalovaný' END "
    "WHEN %(lc)s >= datetime('now', '-12 minutes') THEN '' "
    "WHEN d.online = 1 THEN 'PC je zapnuté, ale agent mlčí od ' || %(lc)s || ' (UTC): agent neběží, nemá spojení se serverem nebo ho blokuje firewall' "
    "ELSE 'PC je vypnuté, uspané nebo mimo síť; agent se ozve po zapnutí' END"
    % {"lc": _LAST_CONTACT, "comp": _IS_COMPUTER})
_NEXT_BEAT = "CASE WHEN COALESCE(d.agent_beat, '') <> '' THEN datetime(d.agent_beat, '+5 minutes') ELSE '' END"

_GROUPS_TEXT = ("(SELECT GROUP_CONCAT(n, ', ') FROM (SELECT g.name AS n FROM device_group_members m "
                "JOIN device_groups g ON g.id = m.group_id WHERE m.device_id = d.id ORDER BY g.name COLLATE NOCASE))")
_GROUPS_JSON = ("(SELECT json_group_array(json_object('n', n, 'c', c)) FROM (SELECT g.name AS n, g.color AS c "
                "FROM device_group_members m JOIN device_groups g ON g.id = m.group_id WHERE m.device_id = d.id "
                "ORDER BY g.name COLLATE NOCASE))")

# dalsi udaje o zarizeni (vcetne ruchne zadanych) pouzitelne jako sloupce i filtry v ostatnich evidencich
_DEVICE_REF.update({
    "device_mac": ("MAC počítače", "d.mac", "text"),
    "device_manufacturer": ("Výrobce počítače", "d.manufacturer", "text"),
    "device_model": ("Model počítače", "d.model", "text"),
    "device_os": ("OS počítače", "d.os_name", "text"),
    "device_section": ("Sekce", _SECTION, "text"),
    "device_groups": ("Skupiny", _GROUPS_TEXT, "text"),
    "asset_tag": ("Inventární číslo", "d.asset_tag", "text"),
    "assigned_user": ("Přidělen komu", "d.assigned_user", "text"),
    "device_note": ("Poznámka k zařízení", "d.note", "text"),
})

# USB varovani: pripojeni uloziste s mediem nebo telefonu (ostatni zarizeni se neevidují)
USB_ALERT_SQL = ("(x.action IN ('připojeno', 'nalezeno') AND x.class IN ('úložiště', 'telefon / přenosné zařízení'))")
_USB_ALERT_X = ("(x.action IN ('připojeno', 'nalezeno') AND x.class IN ('úložiště', 'telefon / přenosné zařízení'))")

ENTITIES = {
    "devices": {
        "label": "Zařízení (HW a síť)",
        "from": "devices d LEFT JOIN ad_users u ON u.sam = d.user_sam",
        "device_id": "d.id",
        "id": "d.id",
        "columns": {
            "hostname": ("Název", "COALESCE(NULLIF(d.hostname, ''), d.ip)", "text"),
            "device_type": ("Typ", "d.device_type", "text"),
            "section": ("Sekce", _SECTION, "text"),
            "agent_state": ("Stav agenta", _AGENT_STATE, "text"),
            "is_computer": ("Je to počítač", _IS_COMPUTER, "bool"),
            "online": ("Online", "d.online", "bool"),
            "online_state": ("Online / offline", "CASE WHEN d.online = 1 THEN 'online' ELSE 'offline' END", "text"),
            "offline_min": ("Offline již (min)",
                            "CASE WHEN d.online = 0 AND COALESCE(d.last_seen, '') <> '' "
                            "THEN CAST(ROUND((julianday('now') - julianday(d.last_seen)) * 1440) AS INTEGER) END", "num"),
            "ip": ("IP adresa", "d.ip", "text"),
            "ip_conflict": ("Konflikt IP", _IP_CONFLICT, "bool"),
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
            "bios_date": ("Datum BIOSu", "COALESCE(json_extract(d.details, '$.system.bios_date'), '')", "text"),
            "os_build": ("Číslo sestavení Windows", "COALESCE(json_extract(d.details, '$.os.build'), '')", "text"),
            "os_install_date": ("Datum instalace OS", "COALESCE(json_extract(d.details, '$.os.install_date'), '')", "text"),
            "last_boot": ("Poslední restart", "COALESCE(json_extract(d.details, '$.os.last_boot'), '')", "text"),
            "uptime_days": ("Doba od restartu (dny)",
                            "CASE WHEN COALESCE(json_extract(d.details, '$.os.last_boot'), '') <> '' "
                            "THEN ROUND(julianday('now', 'localtime') - julianday(json_extract(d.details, '$.os.last_boot')), 1) END",
                            "num"),
            "sys_free_gb": ("Volné místo na systémovém disku (GB)",
                            "(SELECT json_extract(v.value, '$.free_gb') FROM json_each(d.details, '$.volumes') v "
                            "ORDER BY (json_extract(v.value, '$.drive') = 'C:') DESC LIMIT 1)", "num"),
            "logged_user": ("Přihlášený uživatel", "d.logged_user", "text"),
            "user_current": ("Uživatel je právě přihlášen", "d.user_current", "bool"),
            "last_login_at": ("Poslední přihlášení", "d.last_login_at", "date"),
            "groups": ("Skupiny", _GROUPS_TEXT, "text"),
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
            "sec_bitlocker": ("BitLocker (systémový disk)", "json_extract(d.details, '$.security.bitlocker_os')", "text"),
            "sec_antivirus": ("Antivirus", "json_extract(d.details, '$.security.antivirus_text')", "text"),
            "sec_firewall": ("Firewall", "json_extract(d.details, '$.security.firewall_text')", "text"),
            "sec_secure_boot": ("Secure Boot", "json_extract(d.details, '$.security.secure_boot_text')", "text"),
            "sec_tpm": ("TPM", "json_extract(d.details, '$.security.tpm_text')", "text"),
            "sec_boot_mode": ("Režim zavádění", "json_extract(d.details, '$.security.boot_mode')", "text"),
            "hotfix_age": ("Dnů od poslední aktualizace",
                           "CASE WHEN COALESCE(json_extract(d.details, '$.security.last_hotfix'), '') <> '' "
                           "THEN CAST(julianday('now') - julianday(json_extract(d.details, '$.security.last_hotfix')) AS INTEGER) END", "num"),
            "os_eol": ("Podpora OS skončila",
                       "CASE WHEN COALESCE(d.os_name, '') = '' THEN NULL "
                       "WHEN d.os_name LIKE '%LTSC%' OR d.os_name LIKE '%LTSB%' OR d.os_name LIKE '%IoT%' THEN 0 "
                       "WHEN d.os_name LIKE '%Windows XP%' OR d.os_name LIKE '%Vista%' OR d.os_name LIKE '%Windows 7%' "
                       "OR d.os_name LIKE '%Windows 8%' OR d.os_name LIKE '%Windows 10%' "
                       "OR d.os_name LIKE '%Server 2003%' OR d.os_name LIKE '%Server 2008%' OR d.os_name LIKE '%Server 2012%' THEN 1 "
                       "WHEN d.os_name LIKE '%Windows%' THEN 0 END", "bool"),
            "disk_type": ("Typ disku",
                          "(SELECT GROUP_CONCAT(DISTINCT CASE WHEN COALESCE(json_extract(v.value, '$.type'), '') IN ('', 'Unspecified') "
                          "THEN NULL ELSE json_extract(v.value, '$.type') END) FROM json_each(d.details, '$.disks') v)", "text"),
            "net_kind": ("Typ sítě",
                         "(SELECT GROUP_CONCAT(DISTINCT json_extract(v.value, '$.kind')) FROM json_each(d.details, '$.nics') v "
                         "WHERE COALESCE(json_extract(v.value, '$.gateway'), '') <> '')", "text"),
            "sec_last_hotfix": ("Poslední aktualizace Windows", "json_extract(d.details, '$.security.last_hotfix')", "date"),
            "sec_pending_reboot": ("Čeká na restart", "json_extract(d.details, '$.security.pending_reboot_text')", "text"),
            "disk_health": ("Stav disků", "json_extract(d.details, '$.security.disk_health_text')", "text"),
            "win_license": ("Licence Windows", "json_extract(d.details, '$.licenses.windows_text')", "text"),
            "local_admins": ("Počet místních administrátorů",
                             "json_array_length(json_extract(d.details, '$.accounts.admins'))", "num"),
            "monitors": ("Počet monitorů",
                         "(SELECT COUNT(*) FROM monitors m WHERE m.device_id = d.id AND m.connected = 1)", "num"),
            "software_count": ("Počet SW",
                               "(SELECT COUNT(*) FROM software s WHERE s.device_id = d.id)", "num"),
            "usb_count": ("Připojená USB",
                          "(SELECT COUNT(*) FROM usb_current c WHERE c.device_id = d.id)", "num"),
            "rdp": ("RDP zapnuto (vzdálená plocha, skutečný stav)",
                    "CASE WHEN json_extract(d.details, '$.remote.rdp_listening') IS NULL THEN NULL "
                    "WHEN json_extract(d.details, '$.remote.rdp_listening') IN (1, 'true') THEN 1 ELSE 0 END", "bool"),
            "winrm": ("Vzdálený PowerShell (WinRM)",
                      "CASE WHEN json_extract(d.details, '$.remote.winrm') IS NULL THEN NULL "
                      "WHEN json_extract(d.details, '$.remote.winrm') IN (1, 'true') THEN 1 ELSE 0 END", "bool"),
            "os_install_date": ("Datum instalace OS", "json_extract(d.details, '$.os.install_date')", "date"),
            "os_age_days": ("Stáří instalace OS (dny)",
                            "CASE WHEN COALESCE(json_extract(d.details, '$.os.install_date'), '') <> '' "
                            "THEN CAST(julianday('now') - julianday(json_extract(d.details, '$.os.install_date')) AS INTEGER) END", "num"),
            "monitor_age": ("Stáří nejstaršího monitoru (roky)",
                            "(SELECT CAST(strftime('%Y', 'now') AS INTEGER) - MIN(m.year) FROM monitors m "
                            "WHERE m.device_id = d.id AND m.connected = 1 AND COALESCE(m.year, 0) > 1990)", "num"),
            "sw_removed_30d": ("Odinstalováno za 30 dní",
                               "(SELECT COUNT(*) FROM sw_changes c WHERE c.device_id = d.id AND c.action = 'odebráno' "
                               "AND c.ts >= datetime('now', '-30 days'))", "num"),
            "sw_added_30d": ("Nainstalováno za 30 dní",
                             "(SELECT COUNT(*) FROM sw_changes c WHERE c.device_id = d.id AND c.action = 'nainstalováno' "
                             "AND c.ts >= datetime('now', '-30 days'))", "num"),
            "office_accounts": ("Office – přihlášené účty",
                                "(SELECT group_concat(DISTINCT json_extract(j.value, '$.email')) FROM json_each(d.details, '$.licenses.office_accounts') j "
                                "WHERE COALESCE(json_extract(j.value, '$.signed_out'), 0) IN (0, 'false'))", "text"),
            "office_state": ("Office – stav",
                             "CASE WHEN NOT EXISTS (SELECT 1 FROM json_each(d.details, '$.licenses.products') p "
                             "WHERE json_extract(p.value, '$.kind') = 'Office') THEN NULL "
                             "WHEN json_extract(d.details, '$.licenses.office_accounts') IS NULL THEN 'neznámo (starší agent)' "
                             "WHEN EXISTS (SELECT 1 FROM json_each(d.details, '$.licenses.office_accounts') j "
                             "WHERE COALESCE(json_extract(j.value, '$.signed_out'), 0) IN (0, 'false')) THEN 'aktivováno uživatelem' "
                             "ELSE 'nikdo není přihlášen' END", "text"),
            "sw_outdated": ("Software se zastaralou verzí (počet)", "(SELECT COUNT(*) FROM software s WHERE s.device_id = d.id AND " + _SW_OUTDATED + ")", "num"),
            "gpu": ("Grafická karta", "(SELECT GROUP_CONCAT(json_extract(v.value, '$.name'), ', ') FROM json_each(d.details, '$.gpus') v)", "text"),
            "gpu_vram": ("Paměť grafiky (MB)", "(SELECT MAX(json_extract(v.value, '$.vram_mb')) FROM json_each(d.details, '$.gpus') v)", "num"),
            "cpu_cores": ("Jádra CPU", "(SELECT SUM(json_extract(v.value, '$.cores')) FROM json_each(d.details, '$.cpu') v)", "num"),
            "cpu_threads": ("Vlákna CPU", "(SELECT SUM(json_extract(v.value, '$.threads')) FROM json_each(d.details, '$.cpu') v)", "num"),
            "ram_slots": ("Obsazené sloty RAM", "json_array_length(json_extract(d.details, '$.ram_modules'))", "num"),
            "ram_modules": ("Moduly RAM",
                            "(SELECT GROUP_CONCAT((CAST(json_extract(v.value, '$.size_mb') / 1024 AS INTEGER)) || ' GB ' || "
                            "COALESCE(json_extract(v.value, '$.slot'), ''), ', ') FROM json_each(d.details, '$.ram_modules') v)", "text"),
            "gateway": ("Brána", "(SELECT GROUP_CONCAT(DISTINCT json_extract(v.value, '$.gateway')) FROM json_each(d.details, '$.nics') v "
                        "WHERE COALESCE(json_extract(v.value, '$.gateway'), '') <> '')", "text"),
            "dns": ("DNS servery", "(SELECT GROUP_CONCAT(DISTINCT json_extract(v.value, '$.dns')) FROM json_each(d.details, '$.nics') v "
                    "WHERE COALESCE(json_extract(v.value, '$.dns'), '') <> '')", "text"),
            "dhcp_server": ("DHCP server", "(SELECT GROUP_CONCAT(DISTINCT json_extract(v.value, '$.dhcp_server')) FROM json_each(d.details, '$.nics') v "
                            "WHERE COALESCE(json_extract(v.value, '$.dhcp_server'), '') <> '')", "text"),
            "printers_n": ("Počet tiskáren", "json_array_length(json_extract(d.details, '$.printers'))", "num"),
            "printers": ("Tiskárny", "(SELECT GROUP_CONCAT(json_extract(v.value, '$.name'), ', ') FROM json_each(d.details, '$.printers') v)", "text"),
            "local_accounts": ("Místní účty (povolené)",
                               "(SELECT GROUP_CONCAT(json_extract(v.value, '$.name'), ', ') FROM json_each(d.details, '$.accounts.local') v "
                               "WHERE COALESCE(json_extract(v.value, '$.disabled'), 0) IN (0, 'false'))", "text"),
            "agent_problem_count": ("Problémy agenta (počet)",
                                    "(SELECT COUNT(*) FROM agent_problems p WHERE p.hostname = d.hostname COLLATE NOCASE)", "num"),
            "fqdn": ("Plný název (FQDN)", "d.fqdn", "text"),
            "ad_enabled": ("Účet v AD povolen", "d.ad_enabled", "bool"),
            "source": ("Zdroj dat", "d.source", "text"),
            "agent_version": ("Verze agenta", "d.agent_version", "text"),
            "agent_ver_status": ("Stav verze agenta", _VER_STATUS, "text"),
            "agent_target_eff": ("Cílová verze agenta", "CASE WHEN COALESCE(d.agent_version, '') = '' THEN '' ELSE " + _AGENT_TARGET + " END", "text"),
            "agent_pinned": ("Verze agenta připnuta", "CASE WHEN COALESCE(d.agent_target, '') <> '' THEN 1 ELSE 0 END", "bool"),
            "agent_health": ("Zdraví agenta", _HEALTH, "text"),
            "agent_health_reason": ("Důvod stavu agenta", _HEALTH_REASON, "text"),
            "agent_issue": ("Chyba agenta (nejzávažnější problém)",
                            "CASE WHEN " + _HEALTH + " IN ('chyba', 'varování') THEN " + _HEALTH_REASON + " ELSE '' END", "text"),
            "sec_level": ("Security: stav", "COALESCE((SELECT t.level FROM temp.sec_tmp t WHERE t.device_id = d.id), '')", "text"),
            "sec_problem": ("Security: nejzávažnější problém",
                            "COALESCE((SELECT t.problem FROM temp.sec_tmp t WHERE t.device_id = d.id), '')", "text"),
            "agent_error": ("Poslední chyba agenta", "d.agent_error", "text"),
            "agent_error_at": ("Čas poslední chyby agenta", "d.agent_error_at", "date"),
            "agent_beat": ("Poslední kontakt agenta", "d.agent_beat", "date"),
            "agent_comm": ("Komunikace agenta", _COMM, "text"),
            "agent_comm_reason": ("Diagnostika komunikace agenta", _COMM_REASON, "text"),
            "agent_next_beat": ("Očekávaný další kontakt agenta", _NEXT_BEAT, "date"),
            "agent_update": ("Stav aktualizace agenta",
                             "CASE WHEN COALESCE(d.agent_version, '') = '' THEN '' "
                             "WHEN json_extract(d.agent_info, '$.upd_state') = 'vraceno' THEN 'vráceno (' || COALESCE(json_extract(d.agent_info, '$.upd_target'), '?') || ')' "
                             "WHEN " + _VER_STATUS + " = 'zastaralý' THEN 'čeká na aktualizaci' ELSE 'v pořádku' END", "text"),
            "agent_elevated": ("Agent s právy správce", "json_extract(d.agent_info, '$.elevated')", "bool"),
            "first_seen": ("Poprvé viděn", "d.first_seen", "date"),
            "last_seen": ("Naposledy viděn", "d.last_seen", "date"),
            "last_inventory": ("Poslední inventura", "d.last_inventory", "date"),
            "note": ("Poznámka", "d.note", "text"),
        },
        "default": ["hostname", "agent_state", "device_type", "online", "ip", "manufacturer", "model",
                    "os_name", "logged_user", "last_seen"],
        "sort": ("hostname", "asc"),
        # skryte hodnoty radku (pro zobrazeni) a vlastni razeni
        "extra": {"_inv": "d.last_inventory", "_agent": "d.agent_version", "_host": "d.hostname",
                  "_vstat": _VER_STATUS, "_vtarget": _AGENT_TARGET, "_vpin": "COALESCE(d.agent_target, '')",
                  "_hreason": _HEALTH_REASON,
                  "_cur": "d.user_current", "_login": "d.last_login_at", "_groups": _GROUPS_JSON,
                  "_ipc": _IP_CONFLICT_WITH, "_ipold": _IP_OLD_WITH,
                  "_beat": "d.agent_beat", "_comm": _COMM, "_commr": _COMM_REASON,
                  "_offmin": "CASE WHEN d.online = 0 AND COALESCE(d.last_seen, '') <> '' "
                             "THEN CAST(ROUND((julianday('now') - julianday(d.last_seen)) * 1440) AS INTEGER) END"},
        "sort_expr": {"agent_state": _AGENT_STATE_ORDER, "ip": _ip_sort("d.ip"), "agent_health": _HEALTH_ORDER,
                      "agent_version": _ver_key("d.agent_version")},
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
            "source": ("Zdroj instalace", "x.source", "text"),
            "profile": ("Profil (kde je nainstalován)", "x.profile", "text"),
            "outdated": ("Zastaralá verze",
                         "CASE WHEN " + _SW_OUTDATED.replace("s.version", "x.version").replace("s2.", "s2.").replace("s.name", "x.name")
                         + " THEN 1 ELSE 0 END", "bool"),
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
            "latest": ("Nejvyšší verze", "COALESCE(" + _sw_version("DESC") + ", x.latest)", "text"),
            "pct": ("Podíl počítačů (%)",
                    "ROUND(100.0 * x.installs / MAX(1, (SELECT COUNT(*) FROM devices WHERE COALESCE(last_inventory, '') <> '')), 1)", "num"),
            "min_version": ("Nejnižší verze", _sw_version("ASC"), "text"),
            "installs_30d": ("Instalací za 30 dní",
                             "(SELECT COUNT(*) FROM sw_changes c WHERE c.name = x.name AND c.action = 'nainstalováno' "
                             "AND c.ts >= datetime('now', '-30 days'))", "num"),
            "licensed": ("Licencováno",
                         "CASE WHEN EXISTS (SELECT 1 FROM licenses l WHERE l.match_pattern <> '' AND x.name LIKE l.match_pattern) "
                         "THEN 1 ELSE 0 END", "bool"),
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
            "event_user_name": ("Jméno uživatele v čase události",
                                "(SELECT a.display_name FROM ad_users a WHERE a.sam = substr(x.logged_user, instr(x.logged_user, '\\') + 1) "
                                "COLLATE NOCASE LIMIT 1)", "text"),
            "drive": ("Jednotka", "x.drive", "text"),
            "label": ("Název svazku", "x.label", "text"),
            "delta_mb": ("Změna obsazeného místa (MB)", "x.delta_mb", "num"),
            "alert": ("Nepřevzaté varování", "CASE WHEN " + _USB_ALERT_X + " AND COALESCE(x.ack_at, '') = '' THEN 1 ELSE 0 END", "bool"),
            "ack_at": ("Převzato (čas)", "x.ack_at", "date"),
            "ack_by": ("Převzal", "x.ack_by", "text"),
            "files_to": ("Souborů na USB", "x.files_to", "num"),
            "files_from": ("Souborů z USB", "x.files_from", "num"),
            "mb_to": ("Data na USB (MB)", "x.mb_to", "num"),
            "mb_from": ("Data z USB (MB)", "x.mb_from", "num"),
        }, **_DEVICE_REF),
        "default": ["ts", "action", "name", "label", "serial", "files_to", "files_from", "hostname", "event_user"],
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
            "connected_at": ("Připojeno od / viděno poprvé", "x.connected_at", "date"),
            "source": ("Zdroj", "x.source", "text"),
            "state": ("Stav", "'připojeno'", "text"),
            "drive": ("Jednotka", "x.drive", "text"),
            "label": ("Název svazku", "x.label", "text"),
            "fs": ("Souborový systém", "x.fs", "text"),
            "size_gb": ("Velikost (GB)", "x.size_gb", "num"),
            "used_gb": ("Obsazeno (GB)", "x.used_gb", "num"),
            "free_gb": ("Volno (GB)", "ROUND(x.size_gb - x.used_gb, 2)", "num"),
            "delta_mb": ("Změna obsazení od připojení (MB)", "ROUND((x.used_gb - x.used_start_gb) * 1024, 1)", "num"),
            "encrypted": ("Šifrováno (BitLocker To Go)", "x.encrypted", "text"),
            "pc_count": ("Na kolika PC použito",
                         "CASE WHEN COALESCE(x.serial, '') = '' THEN NULL ELSE (SELECT COUNT(*) FROM ("
                         "SELECT e.device_id FROM usb_events e WHERE e.serial = x.serial UNION "
                         "SELECT c.device_id FROM usb_current c WHERE c.serial = x.serial)) END", "num"),
            "connected_hours": ("Doba připojení (h)",
                                "CASE WHEN COALESCE(x.connected_at, '') <> '' "
                                "THEN ROUND((julianday('now') - julianday(x.connected_at)) * 24, 1) END", "num"),
            "files_to": ("Souborů na USB od připojení",
                         "(SELECT COUNT(*) FROM usb_files f WHERE f.device_id = x.device_id AND f.pnp_id = x.pnp_id "
                         "AND f.direction = 'na USB' AND f.ts >= x.connected_at)", "num"),
            "files_from": ("Souborů z USB od připojení",
                           "(SELECT COUNT(*) FROM usb_files f WHERE f.device_id = x.device_id AND f.pnp_id = x.pnp_id "
                           "AND f.direction = 'z USB' AND f.ts >= x.connected_at)", "num"),
        }, **_DEVICE_REF),
        "default": ["state", "name", "label", "size_gb", "used_gb", "files_to", "files_from", "encrypted", "serial", "hostname", "logged_user",
                    "connected_at", "source"],
        "sort": ("connected_at", "desc"),
    },
    "usb_files": {
        "label": "USB – soubory na a z úložiště",
        "from": "usb_files x " + _DEV,
        "device_id": "x.device_id",
        "id": "x.id",
        "columns": dict({
            "ts": ("Čas", "x.ts", "date"),
            "direction": ("Směr", "x.direction", "text"),
            "action": ("Akce", "x.action", "text"),
            "path": ("Soubor", "x.path", "text"),
            "process": ("Program", "x.process", "text"),
            "usb_name": ("USB zařízení", "x.usb_name", "text"),
            "size_bytes": ("Velikost (B)", "x.size_bytes", "num"),
            "size_mb": ("Velikost (MB)", "ROUND(x.size_bytes / 1048576.0, 2)", "num"),
            "drive": ("Jednotka", "x.drive", "text"),
            "event_user": ("Uživatel", "x.logged_user", "text"),
        }, **_DEVICE_REF),
        "default": ["ts", "hostname", "event_user", "usb_name", "direction", "action", "path", "size_mb", "process"],
        "sort": ("ts", "desc"),
    },
    "agent_problems": {
        "label": "Agent – problémy",
        "from": "agent_problems x",
        "device_id": None,
        "id": "x.id",
        "columns": {
            "last_ts": ("Naposledy", "x.last_ts", "date"),
            "first_ts": ("Poprvé", "x.first_ts", "date"),
            "kind": ("Druh", "x.kind", "text"),
            "ip": ("IP adresa", "x.ip", "text"),
            "hostname": ("Počítač", "x.hostname", "text"),
            "detail": ("Podrobnosti", "x.detail", "text"),
            "count": ("Počet", "x.count", "num"),
        },
        "default": ["last_ts", "kind", "ip", "hostname", "detail", "count"],
        "sort": ("last_ts", "desc"),
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
            "days_left": ("Dnů do vypršení",
                          "CASE WHEN julianday(x.expires) IS NOT NULL THEN CAST(julianday(x.expires) - julianday('now') AS INTEGER) END", "num"),
            "status": ("Stav",
                       "CASE WHEN julianday(x.expires) IS NOT NULL AND julianday(x.expires) < julianday('now') THEN 'vypršela' "
                       "WHEN julianday(x.expires) IS NOT NULL AND julianday(x.expires) < julianday('now') + 30 THEN 'vyprší do 30 dní' "
                       "WHEN x.match_pattern <> '' AND x.seats > 0 AND " + _LIC_USED + " > x.seats THEN 'přečerpaná' ELSE 'platná' END", "text"),
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
    "in": "je jedno z (oddělte čárkou)",
    "gt": "větší než",
    "lt": "menší než",
    "older_h": "starší než (hodin)",
    "newer_h": "novější než (hodin)",
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


def stale_hours(conn):
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = 'agent_stale_hours'").fetchone()
        return min(8760, max(1, int(float(row["value"])))) if row else 72
    except Exception:
        return 72


def error_days(conn):
    """Po kolika dnech opakovani se chyba agenta povazuje za "chybu" (kratsi problem je varovani)."""
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = 'agent_error_days'").fetchone()
        return min(60, max(1, int(float(row["value"])))) if row else 3
    except Exception:
        return 3


def _agent_globals(conn):
    """Globalni cilova verze agenta (jako SQL retezec) a po kolika hodinach je inventura 'stara'."""
    from . import agentrel
    try:
        cfg = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
        target = agentrel.global_target(cfg)
        invh = str(max(2, 2 * int(float(cfg.get("agent_inventory_hours") or 6)) + 1))
    except Exception:
        target, invh = agentrel.current_version(), "13"
    return "'%s'" % target, invh


def _resolve(conn, ent):
    """Dosadi do SQL vyrazu hodnoty z Nastaveni (prah neaktivniho agenta)."""
    if not any("__" in v[1] for v in ent["columns"].values()) and not ent.get("sort_expr") \
            and not any("__" in v for v in (ent.get("extra") or {}).values()):
        return ent
    hours = str(stale_hours(conn))
    gtarget, invh = _agent_globals(conn)
    errd = str(error_days(conn))

    def sub(text):
        return (text.replace("__STALE__", hours).replace("__GTARGET__", gtarget).replace("__INVH__", invh)
                .replace("__ERRD__", errd))

    out = dict(ent)
    out["columns"] = {k: (v[0], sub(v[1]), v[2]) for k, v in ent["columns"].items()}
    out["sort_expr"] = {k: sub(v) for k, v in (ent.get("sort_expr") or {}).items()}
    out["extra"] = {k: sub(v) for k, v in (ent.get("extra") or {}).items()}
    # nazvy skupin porovnavame bez ohledu na velikost pismen i s diakritikou (SQLite to u "Ú"/"ú" neumi)
    try:
        out["group_ids"] = {r["name"].casefold(): r["id"] for r in conn.execute("SELECT id, name FROM device_groups")}
    except Exception:
        out["group_ids"] = {}
    return out


_GROUP_EXISTS = ("EXISTS (SELECT 1 FROM device_group_members m JOIN device_groups g ON g.id = m.group_id "
                 "WHERE m.device_id = d.id AND %s)")


def _group_filter(ent, op, value, params):
    items = [v.strip() for v in str(value).split(",") if v.strip()] if op == "in" else [str(value).strip()]
    if op in ("eq", "ne", "in"):
        ids = [ent["group_ids"][v.casefold()] for v in items if v.casefold() in ent.get("group_ids", {})]
        if not ids:
            cond = "1 = 0"
        else:
            cond = "g.id IN (%s)" % ",".join("?" * len(ids))
            params.extend(ids)
        sql = _GROUP_EXISTS % cond
        return "(NOT %s)" % sql if op == "ne" else "(%s)" % sql
    if op in ("contains", "not_contains"):
        cond = "g.name LIKE ? ESCAPE '\\'"
        params.append("%" + _like(value) + "%")
    elif op == "starts":
        cond = "g.name LIKE ? ESCAPE '\\'"
        params.append(_like(value) + "%")
    else:
        if not items:
            return "(1 = 0)"
        cond = "g.name COLLATE NOCASE IN (%s)" % ",".join("?" * len(items))
        params.extend(items)
    sql = _GROUP_EXISTS % cond
    return "(NOT %s)" % sql if op in ("ne", "not_contains") else "(%s)" % sql


def _filter_sql(ent, f, params):
    expr, typ = ent["columns"][f["col"]][1], ent["columns"][f["col"]][2]
    op, value = f["op"], f["value"]
    if f["col"] == "groups" and ent["columns"].get("is_computer") and op in ("eq", "ne", "in", "contains", "not_contains", "starts"):
        return _group_filter(ent, op, value, params)
    if op == "empty":
        return "(%s IS NULL OR %s = '' OR %s = 0)" % (expr, expr, expr) if typ in ("num", "bool") \
            else "(%s IS NULL OR %s = '')" % (expr, expr)
    if op == "not_empty":
        return "(%s IS NOT NULL AND %s <> '' AND %s <> 0)" % (expr, expr, expr) if typ in ("num", "bool") \
            else "(%s IS NOT NULL AND %s <> '')" % (expr, expr)
    if op in ("older_h", "newer_h"):
        try:
            hours = max(0.0, float(str(value).replace(",", ".")))
        except ValueError:
            hours = 0.0
        params.append("-%d minutes" % int(hours * 60))
        return "(COALESCE(%s, '') <> '' AND %s %s datetime('now', ?))" % (expr, expr, "<" if op == "older_h" else ">=")
    if op == "in":
        items = [v.strip() for v in str(value).split(",") if v.strip()][:50]
        if not items:
            return "(1 = 0)"
        if typ in ("num", "bool"):
            nums = []
            for v in items:
                low = v.lower()
                try:
                    nums.append(float(v.replace(",", ".")))
                except ValueError:
                    nums.append(1.0 if low in ("ano", "true", "yes", "a") else 0.0)
            params.extend(nums)
            return "(COALESCE(%s, 0) IN (%s))" % (expr, ",".join("?" * len(nums)))
        params.extend(items)
        return "(COALESCE(%s, '') COLLATE NOCASE IN (%s))" % (expr, ",".join("?" * len(items)))
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
    ent = _resolve(conn, ENTITIES[entity])
    cols = clean_columns(entity, columns)
    if entity == "devices" and (any(k.startswith("sec_") for k in cols) or str(sort).startswith("sec_")
                                or any(str((f or {}).get("col", "")).startswith("sec_") for f in (filters or []))):
        from . import security
        security.refresh_temp(conn)
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
    custom = (ent.get("sort_expr") or {}).get(sort)
    sort_expr = custom or ent["columns"][sort][1]
    order = " ORDER BY %s %s, %s ASC" % (
        sort_expr + (" COLLATE NOCASE" if not custom and ent["columns"][sort][2] == "text" else ""), direction, ent["id"])

    total = conn.execute("SELECT COUNT(*) FROM %s%s" % (ent["from"], where_sql), params).fetchone()[0]
    select = ["%s AS c%d" % (ent["columns"][k][1], i) for i, k in enumerate(cols)]
    extra = ent.get("extra") or {}
    for i, expr in enumerate(extra.values()):
        select.append("%s AS x%d" % (expr, i))
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
        for i, name in enumerate(extra):
            item[name] = r["x%d" % i]
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


def agent_summary(conn):
    """Pocty pro zalozky na strance Zarizeni."""
    ent = _resolve(conn, ENTITIES["devices"])
    state, comp = ent["columns"]["agent_state"][1], ent["columns"]["is_computer"][1]
    row = conn.execute(
        "SELECT COUNT(*) AS total, "
        "COALESCE(SUM(%s = 1), 0) AS computers, "
        "COALESCE(SUM(%s = 'odesílá'), 0) AS ok, "
        "COALESCE(SUM(%s = 'neaktivní'), 0) AS stale, "
        "COALESCE(SUM(%s = 'nikdy'), 0) AS never "
        "FROM devices d" % (comp, state, state, state)).fetchone()
    out = {k: int(row[k]) for k in ("total", "computers", "ok", "stale", "never")}
    sec = ent["columns"]["section"][1]
    counts = {r["s"]: r["n"] for r in conn.execute("SELECT %s AS s, COUNT(*) AS n FROM devices d GROUP BY 1" % sec)}
    out["sections"] = {name: int(counts.get(name, 0)) for name in SECTIONS}
    out["no_section"] = int(counts.get("", 0))
    out["stale_hours"] = stale_hours(conn)
    out["ip_conflicts"] = ip_conflict_count(conn)
    vs, health = ent["columns"]["agent_ver_status"][1], ent["columns"]["agent_health"][1]
    vrow = conn.execute("SELECT COALESCE(SUM(%s = 'aktuální'), 0) AS cur, COALESCE(SUM(%s IN ('zastaralý', 'neznámá')), 0) AS old, "
                        "COALESCE(SUM(%s = 'novější'), 0) AS newer, COALESCE(SUM(%s = 'v pořádku'), 0) AS h_ok, "
                        "COALESCE(SUM(%s = 'varování'), 0) AS h_warn, COALESCE(SUM(%s = 'chyba'), 0) AS h_bad, "
                        "COALESCE(SUM(%s = 'bez agenta'), 0) AS h_noagent "
                        "FROM devices d" % (vs, vs, vs, health, health, health, health)).fetchone()
    out.update({k: int(vrow[k]) for k in ("cur", "old", "newer", "h_ok", "h_warn", "h_bad", "h_noagent")})
    out["pinned"] = int(conn.execute("SELECT COUNT(*) FROM devices WHERE COALESCE(agent_target, '') <> ''").fetchone()[0])
    orow = conn.execute("SELECT COALESCE(SUM(online = 1), 0) AS on_n, COALESCE(SUM(online = 0), 0) AS off_n FROM devices").fetchone()
    out["online"], out["offline"] = int(orow["on_n"]), int(orow["off_n"])
    from . import security
    security.refresh_temp(conn)
    out["sec_bad"] = int(conn.execute("SELECT COUNT(*) FROM temp.sec_tmp WHERE level IN ('chyba', 'varování')").fetchone()[0])
    out["rdp"] = int(conn.execute("SELECT COUNT(*) FROM devices WHERE json_extract(details, '$.remote.rdp_listening') IN (1, 'true')").fetchone()[0])
    return out


def ip_conflict_count(conn):
    """Pocet zarizeni, ktera sdileji IP s jinym (nedavno aktivnim) zarizenim."""
    ent = _resolve(conn, ENTITIES["devices"])
    return int(conn.execute("SELECT COALESCE(SUM(%s), 0) FROM devices d" % ent["columns"]["ip_conflict"][1]).fetchone()[0])


def distinct_values(conn, entity, col, limit=100):
    """Navrhy hodnot pro filtr (jen textove/logicke sloupce)."""
    ent = _resolve(conn, ENTITIES[entity])
    if entity == "devices" and col == "groups":
        return [r["name"] for r in conn.execute("SELECT name FROM device_groups ORDER BY name COLLATE NOCASE")]
    if col not in ent["columns"] or ent["columns"][col][2] != "text":
        return []
    expr = ent["columns"][col][1]
    sql = ("SELECT DISTINCT %s AS v FROM %s WHERE %s IS NOT NULL AND %s <> '' ORDER BY v COLLATE NOCASE LIMIT ?"
           % (expr, ent["from"], expr, expr))
    return [str(r["v"]) for r in conn.execute(sql, (int(limit),))]
