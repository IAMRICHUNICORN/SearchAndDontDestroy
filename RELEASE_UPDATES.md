# RELEASE UPDATES

Seznam zlepseni, ktera si uzivatel zapsal k dalsimu vydani. Pred buildem se cely seznam vypise, potom se implementuje.
Vydani (commit, tag, push) az po slove "vydej". Hotove polozky se presunou do CHANGELOG.md.

## Cekaji na dalsi vydani

(zatim nic - vsechny polozky jsou ve verzi 1.7.0, ceka na "vydej")

## Hotovo ve verzi 1.7.0 (implementovano a otestovano lokalne, necommitnuto)
A1-A6 verze agenta, samoaktualizace, navrat, verze u PC, GPO postup; B1-B3 diagnostika a zdravi agenta;
C1-C4 USB (stranka, svazky, soubory); D1 sekce Sitove prvky / Tiskarny; D2 anglictina CZ/EN.

## Poznamky
- Zjisteni 2026-11-17 (logy QNAP za 24 h): server nevratil agentum zadnou chybu; ozvalo se 7 IP (.100, .42, .46, .55, .56, .64, .73),
  presne PC s daty. Zbylych 13 se k serveru nedostalo -> problem na strane PC (agent nenainstalovan / GPO neprovedeno /
  Fast Startup / sit). DELL3620-1 (192.168.10.68): WinRM 5985 odmita spojeni; vysledek kontroly pres RDP zatim chybi.
- Pravni: sledovani nazvu souboru zamestnancu na USB (vypnuto ve vychozim stavu) vyzaduje smernici o monitoringu (par. 316 zakoniku prace).

## Hotovo (vydano)
- 1.6.0: USB jen uloziste, hromadne mazani, evidence jako Zarizeni, snimky a cisty sken.
