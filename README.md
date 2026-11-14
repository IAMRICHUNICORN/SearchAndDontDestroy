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
# vznikne dist/hwsw-monitor-1.2.2-amd64.tar -> přeneste na QNAP spolu s docker-compose.yml
docker load -i hwsw-monitor-1.2.2-amd64.tar
docker compose up -d --no-build
```

Soubor `.tar` lze také importovat v Container Station (Images → Import) a kontejner vytvořit klikáním: port `8580`, svazek `/data` namapovaný na složku na QNAPu.

Aplikace běží na `https://IP-QNAPu:8580` (vlastní certifikát – prohlížeč se poprvé zeptá na výjimku, viz [HTTPS](#https)). První přihlášení: **admin / admin** – aplikace si hned vynutí změnu hesla. (Vlastní počáteční heslo lze zadat proměnnou `HWSW_ADMIN_PASSWORD` v `docker-compose.yml`.)

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

Složka `data/tls/` není součástí kompletní zálohy stahované z webu; zálohuje ji skript `backup-full.sh` (celá složka `data`). Bez ní vznikne po obnově nový certifikát.

## Aktualizace

```bash
./scripts/update.sh                                   # sestaví novou verzi ze zdrojů
./scripts/update.sh hwsw-monitor-1.2.2-amd64.tar      # nebo nahraje hotový image
```

Co se děje s databází:

1. Skript udělá zálohu ještě před výměnou image.
2. Nová verze při startu zkontroluje integritu databáze. Pokud se liší verze aplikace nebo schéma, **vytvoří zálohu `hwsw-pre-update-STARÁ-to-NOVÁ-…db.gz` a ověří ji**. Když se záloha nepovede, migrace se nespustí.
3. Změny schématu běží v transakci – buď projdou celé, nebo se nezmění nic.
4. Po migraci se znovu kontroluje integrita.

Databáze leží ve svazku `./data`, nikdy v image – výměna image se jí nedotkne. Spuštění starší verze nad novější databází aplikace odmítne (nedojde k poškození); návrat ke starší verzi = obnovit zálohu „před aktualizací“.

Při vývoji další verze: zvyšte číslo v `app/VERSION` a změny tabulek přidávejte **jen na konec** seznamu `MIGRATIONS` v `app/db.py`.

## Zálohy

| Co | Kde | Obsah |
|---|---|---|
| Denní automatická | `data/backups/hwsw-auto-*.db.gz` | databáze (počet uchovávaných dní je v Nastavení) |
| Ruční | web → Zálohy → *Zálohovat databázi teď* | databáze |
| Před aktualizací / před obnovou | automaticky | databáze; nemažou se samy |
| Kompletní záloha dat | web → Zálohy → *Stáhnout kompletní zálohu* | databáze + šifrovací klíč (`.tar.gz`) |
| Celý Docker | `./scripts/backup-full.sh /share/Backup/hwsw` | image (`docker save`) + data + `docker-compose.yml` + návod `OBNOVA.txt` |

Všechny zálohy se dělají za běhu přes SQLite backup API (konzistentní snímek, žádné kopírování otevřeného souboru).

**Obnova**: web → Zálohy → *Obnovit* u vybrané zálohy, nebo *Obnovit ze souboru* (`.db`, `.db.gz` i kompletní `.tar.gz`). Před každou obnovou se současný stav sám zazálohuje.

**Obnova na novém stroji** ze zálohy celého Dockeru – viz `OBNOVA.txt` v záloze (načíst image, rozbalit data, `docker compose up -d`).

> `data/secret.key` šifruje uložená hesla k AD a WinRM. Bez něj se po obnově musí tato hesla zadat znovu. Kompletní záloha ho obsahuje – ukládejte ji proto na chráněné místo.

## Bezpečnost

- Role *administrátor* a *uživatel*; uživatel se dostane jen k přiděleným pohledům (kontroluje server, ne jen rozhraní).
- Hesla uživatelů: PBKDF2-SHA256. Hesla k AD/WinRM: šifrovaná klíčem v datovém svazku.
- Agenti se prokazují tokenem. Token je v instalačním příkazu – kdo ho zná, může posílat data. Na počítačích je skript čitelný jen pro SYSTEM a správce. Token lze kdykoli vyměnit (Agent → *Vygenerovat nový token*).
- Spojení prohlížeče i agentů je šifrované (HTTPS); agent ověřuje certifikát serveru podle otisku.
- Agent běží pod účtem SYSTEM. Automatická aktualizace agentů je proto ve výchozím stavu **vypnutá**.
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
app/agent/         agent pro Windows (PowerShell)
app/static/        webové rozhraní
scripts/           build, aktualizace, záloha celého Dockeru, ukázková data
```
