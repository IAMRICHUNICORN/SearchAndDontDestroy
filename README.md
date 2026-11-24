# HWSW Monitor

Evidence a monitorování hardwaru a softwaru firmy. Webová aplikace v jednom Docker kontejneru (určeno pro QNAP Container Station), databáze je součástí.

## Co umí

| Požadavek | Jak je řešen |
|---|---|
| Monitorování v rozsahu AD domény nebo IP rozsahu | Synchronizace počítačů a uživatelů z Active Directory (LDAP/LDAPS) + sken IP rozsahů (ping, porty, NetBIOS, SNMP, reverzní DNS) |
| Přesný popis HW | Agent na Windows: výrobce, model, sériové číslo, BIOS, CPU, paměťové moduly, disky, svazky, grafika, síťové adaptéry, tiskárny. Zařízení bez agenta (tiskárny, switche, NAS…) se rozpoznají podle SNMP a otevřených portů |
| Jaký uživatel zařízení má | Přihlášený uživatel z agenta, doplněný o jméno, e-mail a oddělení z AD; ručně lze doplnit „přidělen komu“ |
| Jaký SW na něm je | Nainstalovaný software z registru (64/32bit i uživatelské instalace), historie instalací a odinstalací |
| Licence | Ruční evidence + import z CSV; porovnání počtu zakoupených licencí se skutečnými instalacemi, upozornění na překročení a konec platnosti |
| ADMIN a USER část, šablony pohledů | Administrátor skládá pohledy (typ dat, sloupce, filtry, řazení) a přiděluje je uživatelům. Uživatel vidí jen své pohledy |
| Monitory | Výrobce, model, sériové číslo, rok výroby, úhlopříčka a typ připojení z EDID; monitor se sleduje i při přepojení k jinému PC |
| USB v reálném čase | Agent reaguje na systémovou událost připojení/odpojení a do ~2 s ji pošle na server; v prohlížeči se objeví okamžitě |
| Databáze součástí, bezpečná aktualizace | SQLite v datovém svazku. Při startu nové verze se **nejdříve** udělá ověřená záloha, pak teprve migrace v transakci |
| Záloha databáze i celého Dockeru | Denní automatické zálohy, ruční záloha/obnova z webu, kompletní záloha ke stažení, skript pro zálohu image + dat + konfigurace |

## Jak to funguje

```
 Windows PC ──(agent: HTTP POST inventura, USB události)──┐
                                                          ▼
 Active Directory ◄──LDAP──┐                     ┌────────────────────┐
 Síť (IP rozsah) ◄─sken────┼──────────────────── │  HWSW Monitor      │ ──► prohlížeč
 Windows PC ◄──WinRM───────┘                     │  (Docker na QNAPu) │     (admin / uživatel)
                                                 │  /data = SQLite DB │
                                                 └────────────────────┘
```

Tři zdroje dat se doplňují:

1. **Active Directory** – seznam počítačů a uživatelů domény. Samo neříká, co v počítači je.
2. **Sken IP rozsahu** – najde vše, co v síti odpovídá, včetně zařízení mimo doménu.
3. **Agent pro Windows** – jediný zdroj přesného HW/SW inventáře, monitorů a USB událostí. Je to jeden PowerShell skript běžící jako naplánovaná úloha pod účtem SYSTEM. Nasazuje se jedním příkazem (ručně, přes GPO, nebo ho server rozešle sám přes WinRM).

> USB v reálném čase a detailní inventura **vyžadují agenta** na počítači. Bez něj je o počítači známo jen to, co je v AD a co ukáže sken sítě.

## Instalace na QNAP

Potřebujete Container Station a přístup přes SSH (nebo sdílenou složku).

**Varianta A – sestavení přímo na QNAPu** (nejjednodušší):

```bash
# zkopírujte celou složku projektu na QNAP, např. do /share/Container/hwsw
cd /share/Container/hwsw
docker compose up -d --build
```

**Varianta B – hotový image jako soubor** (sestavení na jiném počítači s Dockerem):

```bash
./scripts/build-image.sh amd64        # nebo arm64 podle procesoru QNAPu
# vznikne dist/hwsw-monitor-1.11.4-amd64.tar -> přeneste na QNAP spolu s docker-compose.yml
docker load -i hwsw-monitor-1.11.4-amd64.tar
docker compose up -d --no-build
```

Soubor `.tar` lze také importovat v Container Station (Images → Import) a kontejner vytvořit klikáním: port `8580`, svazek `/data` namapovaný na složku na QNAPu.

Aplikace běží na `https://IP-QNAPu:8580` (vlastní certifikát – prohlížeč se poprvé zeptá na výjimku, viz [HTTPS](#https)). První přihlášení: uživatel **admin** a jednorázové heslo, viz níže. Aplikace si hned vynutí jeho změnu.

### První přihlášení (nová instalace)

Výchozí heslo `admin` už neexistuje. Při úplně prvním startu (prázdná složka `data`) vznikne účet `admin`:

1. **Bez nastavení** aplikace vygeneruje náhodné jednorázové heslo a **jednou** ho vypíše do logu kontejneru. Zobrazíte ho příkazem na QNAPu (SSH):
   ```bash
   docker logs hwsw-monitor 2>&1 | grep -A1 "Jednorázové heslo"
   ```
   Nebo v Container Station: *Containers → hwsw-monitor → Logs*. Heslo přepište při prvním přihlášení; po změně už z logu nic nezjistíte.
2. **Vlastní počáteční heslo**: odkomentujte v `docker-compose.yml` řádek `HWSW_ADMIN_PASSWORD: "…"` před prvním spuštěním. Heslo se použije jen při založení účtu a po prvním přihlášení se stejně musí změnit.
3. **Nestihli jste heslo zachytit** (kontejner už běžel, log se smazal): smažte složku `data` (je-li instalace nová a prázdná) a spusťte znovu, nebo nastavte `HWSW_ADMIN_PASSWORD` a spusťte s prázdnou složkou `data`.

Stávající instalace se nezmění, účty a hesla zůstávají.

## První nastavení

1. **Nastavení → Server**: vyplňte adresu, na které aplikaci uvidí počítače v síti (např. `https://192.168.1.10:8580`).
2. **Nastavení → Active Directory**: řadič domény, účet pro čtení (běžný doménový účet stačí), tlačítko *Vyzkoušet připojení*.
3. **Nastavení → Sken IP rozsahu**: zadejte rozsahy (`192.168.1.0/24`, `10.0.5.10-10.0.5.80`).
4. **Skenování**: spusťte obě úlohy ručně a zkontrolujte výsledek.
5. **Agent pro Windows**: zkopírujte instalační příkaz a spusťte ho na jednom PC jako správce. Po ověření ho nasaďte hromadně:
   - **GPO**: *Konfigurace počítače → Zásady → Nastavení systému Windows → Skripty → Spuštění* – stejný příkaz, nebo
   - **WinRM**: v Nastavení zapněte „Inventura přes WinRM“ s volbou *nainstalovat trvalého agenta*.
6. **Šablony pohledů**: upravte připravené pohledy nebo vytvořte vlastní a přidělte je uživatelům (**Uživatelé** → nový účet s rolí *uživatel*).

### Síťový režim

Výchozí je běžné mapování portu. Pro přesnější zjišťování MAC adres zařízení bez agenta lze v `docker-compose.yml` přepnout na `network_mode: host` (kontejner pak vidí ARP tabulku QNAPu).

### HTTPS

Aplikace běží rovnou na HTTPS. Při prvním startu si vytvoří vlastní certifikát (platí 10 let) do `data/tls/`.

- **Agenti** certifikát ověřují podle otisku, který je součástí instalačního příkazu. Na počítače se nic neinstaluje a spojení nejde podvrhnout jiným certifikátem.
- **Prohlížeč** zobrazí při první návštěvě varování, protože certifikát nevydala známá autorita. Buď potvrďte výjimku, nebo si certifikát stáhněte (stránka *Agent pro Windows*) a přidejte ho mezi důvěryhodné. Aby pak seděla adresa, uveďte ji před prvním startem v `HWSW_TLS_NAMES` v `docker-compose.yml`.
- **Vlastní certifikát** (např. z firemní autority): nahraďte soubory `data/tls/cert.pem` a `data/tls/key.pem` a restartujte kontejner. Agenti, kteří certifikátu důvěřují přes Windows, fungují dál; ostatní je potřeba nainstalovat znovu, protože se změnil otisk.
- **Nový certifikát**: smažte `data/tls/` a restartujte. Agenty je pak nutné nainstalovat znovu.
- **Za reverzní proxy**, která šifruje sama, lze vlastní HTTPS vypnout proměnnou `HWSW_TLS: "off"`.

Složka `data/tls/` není součástí zálohy stahované z webu (stránka Zálohy). Zálohuje ji skript `backup-full.sh`: vedle `data.tar.gz` (databáze a klíč pro hesla) uloží soubor `tls.tar` s certifikátem a jeho soukromým klíčem. Oba soubory jsou tajné (oprávnění jen pro vlastníka), uchovejte je na bezpečném místě. Při obnově (návod `OBNOVA.txt` ve složce zálohy) se `tls.tar` rozbalí do `data/`; bez něj by vznikl nový certifikát a všechny agenty by bylo nutné nainstalovat znovu.

## Aktualizace

```bash
./scripts/update.sh                                   # sestaví novou verzi ze zdrojů
./scripts/update.sh hwsw-monitor-1.11.4-amd64.tar      # nebo nahraje hotový image
```

Co se děje s databází:

1. Skript udělá zálohu ještě před výměnou image.
2. Nová verze při startu zkontroluje integritu databáze. Pokud se liší verze aplikace nebo schéma, **vytvoří zálohu `hwsw-pre-update-STARÁ-to-NOVÁ-…db.gz` a ověří ji**. Když se záloha nepovede, migrace se nespustí.
3. Změny schématu běží v transakci – buď projdou celé, nebo se nezmění nic.
4. Po migraci se znovu kontroluje integrita.

Databáze leží ve svazku `./data`, nikdy v image – výměna image se jí nedotkne. Spuštění starší verze nad novější databází aplikace odmítne (nedojde k poškození); návrat ke starší verzi = obnovit zálohu „před aktualizací“.

Při vývoji další verze: zvyšte číslo v `app/VERSION` a změny tabulek přidávejte **jen na konec** seznamu `MIGRATIONS` v `app/db.py`.

## Agent: verze, aktualizace a návrat

- Agent má **vlastní číslo verze** nezávislé na aplikaci (`app/agent/AGENT_VERSION`, nyní 2.1.0). Mění se jen tehdy, když se změní agent.
- Agenti se **udržují aktuální sami**: při každém spojení se serverem (nejpozději do 5 minut) zjistí svou cílovou verzi. Když se liší od jejich, stáhnou ji, ověří SHA-256, zálohují předchozí soubor a přepnou se – bez restartu počítače.
- **Pojistka:** pokud se nová verze do 2 minut neohlásí, původní proces vrátí předchozí soubor, zapamatuje si „vadnou verzi" a běží dál. Vadnou verzi už nezkouší, dokud administrátor nezmění cíl.
- **Návrat na starší verzi:** *Nastavení → Agent: verze a aktualizace*. Výběr konkrétní verze = návrat a zároveň zamknutí (nové verze se nerozesílají, dokud nevrátíte „Nejnovější"). U jednoho PC jde verzi připnout v detailu zařízení (záložka Agent) nebo hromadně v seznamu Zařízení (*Verze agenta*). Připnutí k jednomu PC funguje jen pro agenty od 2.0.0; starší agent (1.x) následuje globální cíl.
- **Příkazy agentovi (od agenta 2.1.0):** klik na *chyba* / *varování* ve sloupci *Zdraví agenta* otevře okno s důvodem. *Zkusit znovu* donutí agenta poslat inventuru při nejbližším kontaktu (do 5 minut), *Znovu spojit* navíc zapomene vadné verze a zkusí aktualizaci znovu. Příkaz se doručí v odpovědi serveru na další hlášení agenta.
- **Komunikace:** sloupce *Komunikace agenta*, *Diagnostika komunikace agenta* a *Stav aktualizace agenta* ukazují, kdy se agent naposledy ozval (heartbeat do 5 minut), jestli komunikuje, a proč ne. Jednorázové chyby spojení se serverem jsou „přechodné" a zdraví nebarví na červeno, pokud se agent znovu spojil.
- Stránka *Agent pro Windows* má kartu **Spojení agentů se serverem**: adresa, port, HTTPS, otisk a platnost certifikátu a varování (změna otisku, brzké vypršení, adresa liší od adresy prohlížeče).
- Agent zapisuje **místní log** (`C:\ProgramData\HWSW-Agent\agent.log`, rotace po 512 KB) a chyby hlásí serveru (sekce *Agent – problémy*, sloupec *Zdraví agenta*).

**Vydání nové verze agenta (postup pro vývoj):**
1. Upravte `app/agent/hwsw-agent.ps1` a zvyšte číslo v `app/agent/AGENT_VERSION`.
2. Zkopírujte skript jako `app/agent/releases/hwsw-agent-<verze>.ps1` a přidejte řádek do `app/agent/releases/releases.json` (verze, datum, poznámka). Starší verze v archivu se nikdy nemažou – jsou cílem pro návrat.
3. Zvyšte i verzi aplikace, doplňte `CHANGELOG.md` a vydejte jako obvykle.

**Instalace přes GPO bez restartu:** startup skript počítače se spouští jen při skutečném startu Windows (rychlé spuštění / Fast Startup ho přeskočí). Doporučená je proto navíc naplánovaná úloha v GPO – postup je přímo na stránce *Agent pro Windows* v aplikaci.

## USB

Hlásí se jen **úložiště s médiem** (disk, flash, vložená karta) a **telefony / přenosná zařízení**. Myš, klávesnice, dongle, Bluetooth, zvuk, kamera, tiskárna, hub a prázdná čtečka nebo kabel bez úložiště se nehlásí. Po připojení úložiště nebo telefonu se na Přehledu zobrazí **varování**, které zůstane, dokud ho správce nepřevezme (*USB → Varování*). U úložiště agent hlásí písmeno jednotky, název svazku, souborový systém, velikost, obsazení a stav BitLocker To Go; při odpojení se uloží změna obsazeného místa a souhrn přenosu (počet souborů a MB na USB a z USB).

**Soubory na USB a z USB** (*Nastavení → Agent*, výchozí stav **vypnuto**): soubory zapsané **na** USB agent zachytí sám (název USB, uživatel, program, velikost). Soubory čtené **z** USB (kopírování na počítač) agent zjistí z auditu Windows (událost 4663), který se zapíná v GPO: *Computer Configuration → Policies → Windows Settings → Security Settings → Advanced Audit Policy Configuration → Audit Policies → Object Access → Audit Removable Storage = Success* (postup je i na stránce *Agent pro Windows*), a v Nastavení zapnout *Sledovat i soubory čtené Z USB*. Zvětšete Security log (např. 256 MB). Sledování jmen souborů zaměstnanců vyžaduje vnitřní směrnici o monitoringu (§ 316 zákoníku práce). Prevenci (zákaz zápisu na výměnné disky, povinné BitLocker To Go) řešte v GPO: *Computer Configuration → Administrative Templates → System → Removable Storage Access → Removable Disks: Deny write access*.

## Jazyk rozhraní

Rozhraní je česky a anglicky (přepínač **CZ / EN** v levém menu a na přihlašovací stránce, volba se ukládá ke každému uživateli). Data, čísla, datum a jednotky zůstávají české. Překlady jsou v `app/static/lang-en.js` (česká věta → anglická); věta bez překladu se zobrazí česky.

## Zálohy

| Co | Kde | Obsah |
|---|---|---|
| Denní automatická | `data/backups/hwsw-auto-*.db.gz` | databáze (počet uchovávaných dní je v Nastavení) |
| Ruční | web → Zálohy → *Zálohovat databázi teď* | databáze |
| Před aktualizací / před obnovou | automaticky | databáze; nemažou se samy |
| Kompletní záloha dat | web → Zálohy → *Stáhnout kompletní zálohu* | databáze + šifrovací klíč (`.tar.gz`) |
| Celý Docker | `./scripts/backup-full.sh /share/Backup/hwsw` | image (`docker save`) + data (`data.tar.gz`: databáze a klíč) + certifikát (`tls.tar`) + `docker-compose.yml` + návod `OBNOVA.txt` |

Všechny zálohy se dělají za běhu přes SQLite backup API (konzistentní snímek, žádné kopírování otevřeného souboru).

**Obnova**: web → Zálohy → *Obnovit* u vybrané zálohy, nebo *Obnovit ze souboru* (`.db`, `.db.gz` i kompletní `.tar.gz`). Před každou obnovou se současný stav sám zazálohuje (databáze i původní šifrovací klíč, soubor `…db.gz.key` vedle zálohy). Obnova se nejdřív vyzkouší na kopii; když cokoli selže, vrátí se původní databáze i klíč.

**Obnova na novém stroji** ze zálohy celého Dockeru – viz `OBNOVA.txt` v záloze (načíst image, rozbalit data, `docker compose up -d`).

> `data/secret.key` šifruje uložená hesla k AD a WinRM. Bez něj se po obnově musí tato hesla zadat znovu. Kompletní záloha ho obsahuje – ukládejte ji proto na chráněné místo.

## Bezpečnost

- Role *administrátor* a *uživatel*; uživatel se dostane jen k přiděleným pohledům (kontroluje server, ne jen rozhraní).
- Hesla uživatelů: PBKDF2-SHA256. Hesla k AD/WinRM: šifrovaná klíčem v datovém svazku.
- Agenti se prokazují tokenem. Token je v instalačním příkazu – kdo ho zná, může posílat data. Na počítačích je skript čitelný jen pro SYSTEM a správce. Token lze kdykoli vyměnit (Agent → *Vygenerovat nový token*).
- Spojení prohlížeče i agentů je šifrované (HTTPS); agent ověřuje certifikát serveru podle otisku.
- Agent běží pod účtem SYSTEM. Aktualizace agentů je trvale zapnutá (ověření SHA-256, automatický návrat); cílovou verzi řídí administrátor v Nastavení.
- Licenční klíče vidí celé jen administrátor.

## Vyzkoušení bez Dockeru a bez Windows

```bash
./scripts/run-local.sh
```

```bash
python3 scripts/demo_data.py https://localhost:8580 TOKEN
```

Token najdete ve webu na stránce *Agent pro Windows*. Skript nahraje 14 ukázkových počítačů s monitory, softwarem a USB událostmi.

## Známá omezení verze 1.0

- Detailní inventura a USB jsou jen pro **Windows** (Windows 7 / Server 2008 R2 a novější). Linux a macOS se objeví ve skenu sítě, ale bez detailů.
- Monitory hlásí jen to, co mají v EDID – některé levné modely nemají sériové číslo; monitory přes některé dokovací stanice a KVM přepínače se nemusí ohlásit.
- Sken přes více VLAN: NetBIOS a ARP fungují jen ve stejném segmentu; za routerem se zařízení najdou podle pingu, portů, DNS a SNMP.
- Jeden kontejner = jeden proces; počítáno pro stovky až nízké tisíce zařízení.

## Struktura projektu

```
app/main.py        web a API (FastAPI)
app/db.py          SQLite, migrace, zálohy a obnova
app/entities.py    definice pohledů a bezpečné skládání dotazů
app/ingest.py      zpracování dat z agentů a skenů
app/discovery.py   Active Directory, sken sítě, WinRM, plánovač
app/agent/         agent pro Windows (PowerShell), AGENT_VERSION a archiv verzí v releases/
app/agentrel.py    verze agenta, cílová verze a vykreslení skriptu
app/snapshots.py   snímky stavu a porovnání
app/static/        webové rozhraní
scripts/           build, aktualizace, záloha celého Dockeru, ukázková data
```
