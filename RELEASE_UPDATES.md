# RELEASE UPDATES

Seznam zlepseni, ktera si uzivatel zapsal k dalsimu vydani. Pred buildem se cely seznam vypise, potom se implementuje.
Vydani (commit, tag, push) az po slove "vydej". Hotove polozky se presunou do CHANGELOG.md.

## Cekaji na dalsi vydani

(zatim nic; navrh do budoucna: Datum nakupu / zaruka - rucni pole, vyzaduje migraci; odlozene sloupce z polozky 6; upozorneni "po zmene tokenu aktualizujte GPO" je jiz v kartě Spojeni)

## Hotovo ve verzi 1.8.0 (implementovano a otestovano lokalne, necommitnuto; agent 2.1.0)
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
