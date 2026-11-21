# RELEASE UPDATES

Seznam zlepseni, ktera si uzivatel zapsal k dalsimu vydani. Pred buildem se cely seznam vypise, potom se implementuje.
Vydani (commit, tag, push) az po slove "vydej". Hotove polozky se presunou do CHANGELOG.md.

## Cekaji na dalsi vydani

(zatim nic)

## Hotovo (implementovano, ceka na vydej) ve verzi 1.11.2 (bez noveho agenta, bez zmeny schematu)
1. Stari ve dnech. 2. Mistni cas (Praha). 3. Security podle karty PC + nove kontroly. 4. Seznam Zarizeni: vychozi pohled, Instalace OS, klikani. 5. CZ/EN. 6. Oprava grafiky karty Agent.

## ToDo (pozdeji - az bude odladen zaklad; neimplementovat bez pokynu)
- Moderni a mobilni rozhrani celeho programu: responzivni (automaticky podle sirky), menu do ikony a spodni lista na telefonu,
  karty misto tabulek (Zarizeni, Software, USB, Licence), filtry a pohledy jako priorita (cipy, panel filtru zespodu),
  volitelne ikona na plochu (PWA). Mobilni podobu zatim ma jen sekce Security. Doporuceni: po castech, zacit seznamem Zarizeni.
- Volitelne: automaticke smazani starych falesnych USB udalosti od ctecek karet; oznameni mimo aplikaci (e-mail/chat) pri USB varovani.

## Hotovo (implementovano, ceka na vydej) ve verzi 1.11.1 (agent 2.4.1, bez zmeny schematu)
1. Agent 2.4.1: RDP podle skutecneho stavu (sluzba, port, firewall, NLA), ne podle nastaveni/GPO. Starsi agent = "neovereno".
2. Karta PC: odstranena horni karta, stav a vyjimky v karte Stav zabezpeceni.
3. Seznam Zarizeni: kompaktni radky, sloupce IP, Chyba agenta, Security zvlast, hlavni filtry + Dalsi filtry, mobil jako karty.

## Hotovo (vydano) ve verzi 1.11.0 (agent 2.4.0, schema 12)
1. Format stari: CS "L M D" / EN "Y M D", velkymi pismeny (25D, 3M 12D, 2L 3M 12D), plny text po najeti mysi; razeni/filtry dle dni (os_age_days, hotfix_age).
2. Datum instalace OS: sloupec (servery i stanice) + stari v kartě PC.
3. Sekce Security: Prehled + Matice (8 kontrol), karta PC shodna, notebook sifrovani = chyba / stolni PC a server = varovani,
   prahy v Nastaveni (30/60 dni, 183 dni), vyjimky OK-V / OK-E, mobil (tecky), export CSV, filtr v adrese.
4. Office predplatne: agent 2.4.0 hlasi ucty prihlasene v Office; stav "aktivovano uzivatelem" / "nikdo neni prihlasen"; sloupce Office - ucty a stav.
NEOVERENO na skutecnem Windows: cteni uctu Office z registru profilu (agent 2.4.0).

## Hotovo (vydano) ve verzi 1.10.1 ( bez noveho agenta, schema 11)
1. Zmeny SW od nuly: migrace smaze historii sw_changes; "stav 0" - prvni inventura po zmene verze agenta/noveho PC zmeny nezapisuje. ODSOUHLASENO ("po nasazeni smaz").
2. Stav agenta: opraveny agent = "v poradku": chyba je aktualni jen kdyz se agent o ni hlasi (posledni vyskyt < 30 min), starsi = opraveno, jen historie;
   "chyba" jen trvala aktualni chyba >= 3 dny; zruseno varovani "prechodna chyba spojeni"; radek "Stav chyby" u zarizeni. ODSOUHLASENO ("implementuj").

## Hotovo (vydano) ve verzi 1.10.0 ( agent 2.3.0, schema 10)
1. [A1] Zmeny softwaru do hodiny: interval inventury 1 h, migrace prepise 6 -> 1 (schema 9).
2. [B1-B3] Software v profilech (i odhlasene profily pres NTUSER.DAT, slozky AppData\Local\Programs); sloupce Zdroj instalace a Profil (schema 10).
3. [B4] Aplikace z Microsoft Store; nastaveni "agent_store_apps" (vychozi zapnuto).
4. [B5] Sloupec a filtr RDP zapnuto; sloupec WinRM.
5. [B6] Navod na WinRM pres GPO na strance Agent.
6. [C1] Neznama USB zarizeni jako informace v historii (bez varovani).
7. [C4] Nove sloupce (stari OS/monitoru, odinstalace/instalace za 30 dni, zastarale verze SW, GPU, jadra, RAM sloty a moduly, brana/DNS/DHCP,
   tiskarny, mistni ucty, problemy agenta); cena licence uz existuje ("Cena").
8. USB varovani ukazuje KDY, KDO (jmeno z AD + ucet) a KDE (PC, IP, umisteni); sloupec jmeno uzivatele v historii.
NEOVERENO na skutecnem Windows: nacitani NTUSER.DAT, Get-AppxPackage, registr RDP, rozpoznani neznameho USB.

## Hotovo (vydano) ve verzi 1.9.0 (agent 2.2.0)
1. USB - prepracovat detekci (navrh k odsouhlaseni): hlasit jen skutecne uloziste s medii a telefony/prenosna zarizeni (MTP/PTP/Apple/ADB),
   okamzite varovani (trvale upozorneni v aplikaci, ne jen mizici toast); prazdna ctecka/dock/kabel bez uloziste se nehlasi jako uloziste;
   povolene zarizeni (mys, klavesnice, dongle, Bluetooth, audio, kamera, tiskarna, hub) se nehlasi. Agent 2.2.0.
2. Zarizeni: filtr ONLINE / OFFLINE (rychla volba ve filtrech a v zalozkach seznamu) a u offline zarizeni udaj, jak dlouho je offline
   (od posledniho online, napr. "offline 3 h 20 min" / "offline 5 dni"); novy sloupec "Offline od / delka offline", razeni podle delky.
   Zakladem je existujici sloupec Online a cas posledniho videni (last_seen); online = videno v limitu "Povazovat za offline po (min)".
3. Stav agenta - prisnejsi pravidla pro "chyba" (navrh k odsouhlaseni):
   - CHYBA az kdyz problem trva nepretrzite/opakovane vic nez 3 dny (nastavitelne v Nastaveni, vychozi 3 dny).
   - Kratsi problem (chyba agenta mladsi nez 3 dny; agent se nespojil, ale PC je online) = VAROVANI, ne chyba.
   - Duvody se uchovavaji (historie chyb u zarizeni: text, prvni a posledni vyskyt, pocet opakovani, uchovani dle "agent_problems_days")
     a jsou k videni po rozkliknuti stavu agenta, i kdyz se agent mezitim opravil.
   Tabulka agent_error_log (schema 8) + upravene zdravi v entities.py + okno chyby v app.js.
   ODSOUHLASENO: "opakovane po 3 dnech" = chyba se objevuje aspon 1x denne po 3 dny, nebo se agent 3 dny neozval i kdyz je PC online.
   PC, kde se agent nikdy neozval, NENI "chyba" ale ma vlastni stav "BEZ AGENTA" (NO AGENT) - u nich se nehlasi chyba ani varovani.
4. USB - prenos dat (navrh k odsouhlaseni): u kazdeho pripojeni zapsat nazev USB, uzivatele (kdo ho pripojil) a soubory
   NA USB (zapis, prejmenovani) i Z USB (cteni/kopirovani na PC): nazev, cesta, velikost, cas, uzivatel, program. Zdroj "Z USB":
   audit vymennych medii z Windows (udalost 4663, zapina GPO "Audit Removable Storage"), agent ji cte ze Security logu.
   Sledovani souboru je dnes vychozi VYPNUTE (Nastaveni) a hlasi jen zapis NA USB - proto se nic nezaznamenava.
   Souhrn u pripojeni: pocet souboru a MB tam / zpet; zalozka "Soubory na USB" se smerem (na USB / z USB).
   ODSOUHLASENO + doplneno: (a) uzivatel ma sledovani souboru zapnute, ale nic se nezapisuje -> opravit zjisteni pismena USB
   (disky pres UASP/SCSI se dnes nepoznaji a watcher se nespusti) a pridat diagnostiku do stavu agenta (kolik watcheru, kolik udalosti,
   posledni udalost); (b) nove nastaveni "Sledovat i soubory Z USB (audit Windows)" (smer se nastavuje zde); (c) navod na GPO
   (Audit Removable Storage) v karte Agent a v README.


(navrh do budoucna: Datum nakupu / zaruka - rucni pole, vyzaduje migraci; odlozene sloupce z polozky 6; upozorneni "po zmene tokenu aktualizujte GPO" je jiz v kartě Spojeni)

## Hotovo (vydano) ve verzi 1.8.0 (agent 2.1.0)
1. Chyba agenta klikatelna: klik na "chyba"/"varovani" otevre okno s duvodem (text chyby, cas, kdy naposledy komunikoval, verze, cil)
   a s akcemi: "Zkusit znovu" (vynuti okamzity kontakt/inventuru agenta pri nejblizsim pollu), "Znovu spojit" (smaze zapamatovanou vadnou verzi
   a chybu, aby agent zkusil aktualizaci znovu), pripadne navod/prikaz pro rucni opravu. Vyzaduje novy prikaz v odpovedi na poll
   (agent verze >= 2.1.0).
2. Stav agenta musi ukazovat posledni KOMUNIKACI (poll/heartbeat), ne jen posledni inventuru: nyni "pred 1 h" je cas posledni inventury,
   proto pri bezicim agentu nevidime, ze komunikuje. Zobrazit "komunikoval pred X min" + "inventura pred Y h" a stav spojeni
   (komunikuje / mlci / nikdy), aby bylo jasne, v jakem je agent stavu.
3. Diagnostika "proc se agent nespojil v okne 5 min": u PC ukazat, kdy byl posledni poll, kdy se ocekaval dalsi a proc chybi
   (PC vypnuto / uspano / Fast Startup / aktualizace rozdelana "mezi" verzemi - nepotvrzena nova verze, stav ve state.json).
   Pridat do hlaseni agenta stav aktualizace (ceka / stahuje / ceka na potvrzeni / vraceno) a zobrazit ho u PC.
   Poznamka: CTU je ve stavu chyba i s agentem 2.0.0 - mozne, ze aktualizace nebyla dokoncena (chybi restart procesu/ulohy).
4. Prechodne chyby spojeni (napr. "Ke vzdalenemu serveru se nelze pripojit") se oznaci jako "prechodne" a neobarvi zdravi agenta na cerveno,
   pokud se agent do nekolika minut znovu spojil (CTU dnes svitilo "chyba", ale funguje).
5. Kontrolni radek na strance Agent (spojeni agentu se serverem): adresa serveru, port, HTTPS ano/ne, otisk certifikatu (SHA-1), platnost
   certifikatu do, jmena v certifikatu; varovani, kdyz je adresa prazdna/odlisna od adresy prohlizece, certifikat brzy vyprsi nebo se
   otisk zmenil proti poslednimu zname hodnote (agenti by prestali overovat server). Upozorneni na zalohu /data/tls.
6. Dalsi sloupce (ODSOUHLASENA doporucena sada; ostatni z navrhu zatim ne):
   - Software souhrn: Pocet zarizeni, % pocitacu, Instalaci za 30 dni, Nejnizsi verze, Licencovano.
   - Zarizeni: Dnu od posledni aktualizace, Podpora OS skoncila (Windows 7/10), Typ disku (SSD/HDD), Typ site (kabel/Wi-Fi).
   - USB (prave pripojena): Na kolika PC bylo pouzito (podle serioveho cisla), Doba pripojeni.
   - Licence: Dnu do vyprseni, Stav (platna / vyprsi do 30 dni / vyprsela / precerpana).
   Odlozeno na pozdeji: stari instalace/monitoru, odinstalace za 30 dni, zastarale verze SW, GPU, jadra CPU, brana/DNS/DHCP, tiskarny,
   mistni ucty, sloty RAM, agent problemy (verze agenta, sekce), cena za licenci.

## Hotovo (vydano) ve verzi 1.7.1
1. Vyber sloupcu (+ pridat sloupec...) ve vsech tabulkach: polozky razene abecedne podle ceskeho razeni (cs, diakritika a "ch") v CZ rezimu
   a podle anglickych nazvu v EN rezimu; razeni se musi zachovat i po pridani novych sloupcu (radit v kodu pri sestaveni nabidky, ne rucne).
   IMPLEMENTOVANO lokalne (necommitnuto): razeni CZ/EN (Intl.Collator) v nabidce sloupcu i ve filtrech + nove sloupce
   Datum BIOSu, Cislo sestaveni Windows, Datum instalace OS, Posledni restart, Doba od restartu (dny), Volne misto na systemovem disku (GB).
   Nezahrnuto: Datum nakupu/zaruka (rucni pole, vyzaduje migraci).
2. OPRAVA (1.7.1): v Nastaveni -> Agent se pod tabulkou verzi zobrazoval text "null" (replaceChildren zapisuje null jako text).
   Opraveno v app.js globalne (null/false se vyrazuji); necommitnuto, ceka na vydej.
3. Aktualni nazvy a konflikt IP (nalezeno u ERA/ESMC 192.168.10.12 - starý záznam ERA + nový ESMC):
   - Sken (upsert_scanned) nikdy neprepise jiz ulozeny hostname a pri zmene nazvu zalozi dalsi zaznam -> duplicity a stare nazvy.
     Navrh: u zaznamu ze skenu/AD se pri shodne MAC nazev aktualizuje (prejmenovani = jeden zaznam); agent ma prednost.
   - Pri shodne IP, ale jine MAC i jinem nazvu se starsi zaznam (neviden > N h) oznaci jako "zastaraly" a nabidne se smazani.
   - Konflikt IP se hlasi jen kdyz jsou OBA zaznamy nedavno videny (vychozi 72 h, nastavitelne) a maji ruznou MAC;
     jinak jen seda poznamka "stejna IP jako stary zaznam X" / "duplicita" (stejna MAC).
   - ODSOUHLASENO, IMPLEMENTOVANO lokalne (necommitnuto): konflikt jen kdyz jsou oba zaznamy online; starsi offline zaznam = sedy stitek
     "starsi zaznam" u IP; prejmenovani podle MAC u zaznamu ze skenu/AD. Poznamka: pravidlo 72 h + ruzna MAC uz bylo v 1.5.1.

## Hotovo (vydano) ve verzi 1.7.0
A1-A6 verze agenta, samoaktualizace, navrat, verze u PC, GPO postup; B1-B3 diagnostika a zdravi agenta;
C1-C4 USB (stranka, svazky, soubory); D1 sekce Sitove prvky / Tiskarny; D2 anglictina CZ/EN.

## Poznamky
- Zjisteni 2026-11-17 (logy QNAP za 24 h): server nevratil agentum zadnou chybu; ozvalo se 7 IP (.100, .42, .46, .55, .56, .64, .73),
  presne PC s daty. Zbylych 13 se k serveru nedostalo -> problem na strane PC (agent nenainstalovan / GPO neprovedeno /
  Fast Startup / sit). DELL3620-1 (192.168.10.68): WinRM 5985 odmita spojeni; vysledek kontroly pres RDP zatim chybi.
- Potvrzeno 2026-11-18: ALIEN-HP-06 (GPO HWSW-AGENT, startup skript hwsw-install.cmd) se po restartu ozval -> pricina 13 mlcicich PC je
  to, ze startup skript z GPO bezi jen pri skutecnem startu Windows (ne pri Fast Startup/uspani). Reseni: GPO Immediate Task / naplanovana uloha.
- Pravni: sledovani nazvu souboru zamestnancu na USB (vypnuto ve vychozim stavu) vyzaduje smernici o monitoringu (par. 316 zakoniku prace).

## Hotovo (vydano)
- 1.6.0: USB jen uloziste, hromadne mazani, evidence jako Zarizeni, snimky a cisty sken.
