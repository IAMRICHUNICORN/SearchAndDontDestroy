# RELEASE UPDATES

Seznam zlepseni, ktera si uzivatel zapsal k dalsimu vydani. Pred buildem se cely seznam vypise, potom se implementuje.
Vydani (commit, tag, push) az po slove "vydej". Hotove polozky se presunou do CHANGELOG.md.

## Cekaji na dalsi vydani

(zatim nic; navrh do budoucna: sloupec Datum nakupu / zaruka - rucni pole, vyzaduje migraci)

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
- Pravni: sledovani nazvu souboru zamestnancu na USB (vypnuto ve vychozim stavu) vyzaduje smernici o monitoringu (par. 316 zakoniku prace).

## Hotovo (vydano)
- 1.6.0: USB jen uloziste, hromadne mazani, evidence jako Zarizeni, snimky a cisty sken.
