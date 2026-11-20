# Zmeny

Format verzi: MAJOR.MINOR.PATCH (napr. 1.2.3). Kazde vydani ma na GitHubu znacku `vMAJOR.MINOR.PATCH`.

## 1.11.0
- **Agent 2.4.0** (cíl „Nejnovější“ ho rozešle do 5 minut od aktualizace serveru; chcete-li ho nejdřív vyzkoušet, nastavte cíl 2.3.0 a 2.4.0 připněte jednomu PC).
  Nově hlásí účty přihlášené v Office (Microsoft 365) a verzi Office. Server funguje i se staršími agenty (údaje o Office pak chybí).
- **Nová sekce Security** (menu Evidence → Security), schéma 12:
  - **Přehled:** „v pořádku X z Y“, karty s počtem problémů u 8 zásadních kontrol (šifrování disku, antivirus, firewall, aktualizace Windows, podpora OS, RDP/NLA, disk S.M.A.R.T., agent), seznam „Co je špatně“ seřazený podle závažnosti.
  - **Matice:** zařízení pod sebou, kontroly ve sloupcích (barva + krátký text, na mobilu barevné tečky), součty problémů, hledání, filtry (problémové / jen chyby / stanice / servery / skupina / jedna kontrola), řazení, export CSV. Filtr se ukládá do adresy, takže ho lze přidat do záložek prohlížeče.
  - **Karta PC → Zabezpečení** ukazuje stejných 8 kontrol s doporučením.
  - Šifrování disku: u notebooku chyba, u stolního PC a serveru varování. Prahy (aktualizace 30/60 dní, předstih před koncem podpory OS) jsou v Nastavení → Security.
  - **Výjimky:** u PC a kontroly lze nastavit výjimku s poznámkou; kontrola se pak označí **OK-V** (anglicky OK-E) a počítá se jako v pořádku.
- **Stáří ve formátu L M D:** stáří instalace OS a dnů od poslední aktualizace se zobrazuje jako `25D`, `3M 12D`, `2L 3M 12D` (anglicky Y M D); plný text po najetí myší. Řazení a filtry dál podle dnů.
- **Datum instalace OS:** nový sloupec (počítače i servery); v kartě PC datum + stáří.
- **Office (předplatné):** záložka Licence systému ukazuje stav podle přihlášeného účtu v Office („aktivováno uživatelem“ + e-mail, nebo „nikdo není přihlášen“) místo zavádějícího „upozornění / Grace“; nové sloupce „Office – přihlášené účty“ a „Office – stav“.
- NEOVĚŘENO na skutečném Windows: čtení přihlášených účtů Office z registru profilů (agent 2.4.0).

## 1.10.1
- **Změny SW od nuly:** při aktualizaci se jednorázově vymaže historie změn softwaru (obsahovala falešné „instalace“ po změně zdrojů dat agenta; schéma 11,
  před aktualizací se dělá záloha). Seznam nainstalovaného softwaru u PC se nemění.
- **Opravený agent je „v pořádku“:** chyba agenta se počítá, jen když se o ní agent stále hlásí (poslední výskyt mladší než 30 minut). Starší chyba znamená opraveno a zůstává jen v historii chyb (u zařízení → Agent je řádek „Stav chyby“). „Chyba“ (červeně) je jen trvalá chyba, která se opakuje 3 dny a déle. Zrušeno varování „přechodná chyba spojení“.
- **Pravidlo „stav 0“:** první inventura po změně verze agenta (a první inventura nového PC) je jen výchozí stav a změny se nezapisují. Dál se zapisuje jen
  skutečná instalace a odinstalace.

## 1.10.0
- **Agent 2.3.0** (cíl „Nejnovější“ ho rozešle do 5 minut od aktualizace serveru; chcete-li ho nejdřív vyzkoušet, nastavte cíl 2.2.0 a 2.3.0 připněte jednomu PC).
- **Software do hodiny:** výchozí interval úplné inventury je 1 h (dřív 6 h). Hodnota 6 se při aktualizaci sama změní na 1 (schéma 9), ručně nastavená jiná zůstává.
- **Software v profilech uživatelů:** agent čte i programy nainstalované do profilu (např. WhatsApp ze stránek přes admin účet), i když je uživatel odhlášený
  (registr profilu se dočasně načte a uvolní), a složky `AppData\Local\Programs`. U softwaru přibyl „Zdroj instalace“ (registr / profil / složka v profilu / Microsoft Store)
  a „Profil“, ve kterém je nainstalovaný (schéma 10).
- **Aplikace z Microsoft Store** se hlásí jako software (bez systémových součástí a knihoven). Vypíná se v Nastavení → Agent.
- **Vzdálený přístup:** nový údaj, filtr a sloupec „RDP zapnuto“ a „Vzdálený PowerShell (WinRM)“; návod na WinRM přes GPO na stránce Agent.
- **USB varování: kdy, kdo, kde.** Varování na Přehledu i okno ukazují čas, uživatele (jméno z AD a účet) a počítač s IP adresou a umístěním. V USB → Historie přibyl sloupec „Jméno uživatele v čase události“.
- **USB:** neznámá USB zařízení (např. „Device Descriptor Request Failed“) se zapisují do historie jako informace, bez varování.
- **Nové sloupce:** stáří instalace OS, stáří nejstaršího monitoru, odinstalováno / nainstalováno za 30 dní, software se zastaralou verzí, grafická karta a její paměť,
  jádra a vlákna CPU, sloty a moduly RAM, brána, DNS, DHCP server, tiskárny, místní účty, počet problémů agenta; u softwaru „Zastaralá verze“.
  Cena licence už je ve sloupci „Cena“ v Licencích.

## 1.9.0
- **Agent 2.2.0:** nasazuje se stejně jako dřív (cíl „Nejnovější" přepne agenty 2.0.0 a 2.1.0 do 5 minut od aktualizace serveru; chcete-li ho nejdřív vyzkoušet, nastavte
  před aktualizací v *Nastavení → Agent* cíl 2.1.0 a 2.2.0 připněte jednomu PC).
- **USB – přesnější hlášení:** hlásí se jen úložiště s médiem (disk, flash, vložená karta) a telefony / přenosná zařízení. Myš, klávesnice, dongle, Bluetooth, zvuk, kamera, tiskárna,
  hub a prázdná čtečka nebo kabel bez úložiště se nehlásí. Agent správně pozná písmeno disku i u disků přes UASP/SCSI a po připojení počká na přidělení písmene.
- **USB – varování:** po připojení úložiště nebo telefonu se na Přehledu zobrazí trvalé varování (dokud ho správce nepřevezme), trvalé upozornění v okně a záložka *USB → Varování*.
- **USB – přenos dat:** soubory **na USB** (název USB, uživatel, program, velikost) i soubory **z USB** (z auditu Windows, vyžaduje GPO *Audit Removable Storage*; návod je na stránce Agent
  a zapíná se v *Nastavení → Agent*). U odpojení je souhrn: počet souborů a MB tam a zpět. Oprava: sledování souborů se dřív nespustilo, když se nepodařilo zjistit písmeno disku.
  Do stavu agenta přibyla diagnostika (sledované disky, zachycené události).
- **Stav agenta:** „chyba" jen když se problém opakuje alespoň 3 dny (nastavitelné) nebo se agent 3 dny nespojil, přestože je PC online; kratší problém je varování.
  Počítač bez agenta má vlastní stav *bez agenta*. Historie chyb se uchovává a je vidět po rozkliknutí stavu (schéma databáze 8, tabulka `agent_error_log`).
- **Zařízení:** rychlé filtry *Online* / *Offline*; u offline zařízení je vidět, jak dlouho je offline (např. „offline · 3 h 20 min"); sloupce *Online / offline* a *Offline již (min)*.

## 1.8.0
- **Agent 2.1.0:** příkazy ze serveru (*Zkusit znovu*, *Znovu spojit*) a hlášení stavu aktualizace (probíhá / proběhla / vráceno). Nasazuje se stejně jako 2.0.0:
  **Pozor:** při cíli „Nejnovější" se agenti 2.0.0 přepnou na 2.1.0 do 5 minut od aktualizace serveru. Chcete-li novou verzi nejdřív vyzkoušet, nastavte před aktualizací
  v *Nastavení → Agent: verze a aktualizace* cíl 2.0.0 a 2.1.0 připněte jednomu PC.
- **Klikatelná chyba agenta:** okno s důvodem, poslední komunikací a tlačítky *Zkusit znovu* / *Znovu spojit* (schéma databáze 7, sloupec `agent_cmd`).
- **Stav agenta ukazuje poslední komunikaci** (kontakt) a zvlášť poslední inventuru; nové sloupce *Komunikace agenta*, *Diagnostika komunikace agenta*,
  *Očekávaný další kontakt agenta*, *Stav aktualizace agenta* (proč PC mlčí: vypnuto / agent neběží / nikdy nenainstalován, nutný restart pro GPO).
- **Přechodné chyby spojení** se serverem nebarví zdraví agenta na červeno, pokud se agent znovu spojil.
- **Karta „Spojení agentů se serverem"** na stránce Agent: adresa, port, HTTPS, otisk a platnost certifikátu, varování o změně otisku a zálohování `/data/tls`.
- **Nové sloupce:** Software – souhrn (Podíl počítačů, Nejnižší verze, Instalací za 30 dní, Licencováno; *Nejvyšší verze* se nově počítá číselně); Zařízení (Dnů od poslední
  aktualizace, Podpora OS skončila, Typ disku, Typ sítě); USB – právě připojená (Na kolika PC použito, Doba připojení); Licence (Dnů do vypršení, Stav).
  *Podpora OS skončila* nezohledňuje placené rozšířené aktualizace (ESU).

## 1.7.1
- **Oprava:** v Nastavení → Agent se pod tabulkou verzí zobrazoval text „null".
- **Konflikt IP:** hlásí se jen tehdy, když jsou oba záznamy se stejnou IP online a mají různou MAC. Starší offline záznam (např. po výměně serveru) má
  u IP šedý štítek „starší záznam" místo falešného konfliktu.
- **Aktuální názvy:** zařízení ze skenu sítě/AD se při změně názvu (stejná MAC) přejmenuje, nevzniká duplicita.
- **Výběr sloupců:** nabídka „+ přidat sloupec" a filtry jsou řazeny abecedně podle jazyka (česky / anglicky).
- **Nové sloupce v Zařízeních:** Datum BIOSu, Číslo sestavení Windows, Datum instalace OS, Poslední restart, Doba od restartu (dny),
  Volné místo na systémovém disku (GB). Agent je posílá už od 2.0.0, nová verze agenta není potřeba.

## 1.7.0
- **Verze agenta:** agent má vlastní číslo verze (2.0.0) nezávislé na aplikaci. V Zařízení je sloupec *Verze agenta* se stavem (aktuální / zastaralý /
  novější / neznámá), u stavu agenta se zobrazuje verze, rychlé filtry *Zastaralý agent* a *Verze připnuta*, na Přehledu souhrn agentů.
- **Samoaktualizace bez restartu:** trvale zapnutá, kontrola při každém heartbeatu (do 5 minut). Ověření SHA-256, záloha předchozí verze a automatický
  návrat, pokud se nová verze do 2 minut neohlásí; vadná verze se pak nezkouší znovu, dokud administrátor nezmění cíl.
- **Návrat na starší verzi:** archiv verzí agenta (vč. 1.5.1 a 1.6.0), globální cílová verze v Nastavení (nejnovější / konkrétní = návrat a zamknutí),
  připnutí verze k jednomu PC (detail zařízení, hromadně v seznamu), přehled počtu počítačů podle verze.
- **Diagnostika agenta:** místní log (`agent.log`, rotace), hlášení poslední chyby serveru, sekce *Agent – problémy* (odmítnuté požadavky s IP adresou,
  chyby nahlášené agenty), sloupec *Zdraví agenta* (v pořádku / varování / chyba s důvodem) a filtry: zastaralá verze, stará inventura, odchylka hodin,
  bez práv správce, USB sledování neběží, neúplná data, duplicitní MAC.
- **USB:** jedna řada záložek (Právě připojená / Historie / Soubory na USB), událost „nalezeno při první inventuře", sloupec Stav; údaje o svazku
  (jednotka, název, souborový systém, velikost, obsazení, BitLocker To Go) a změna obsazeného místa za dobu připojení; volitelný seznam souborů zapsaných
  na USB (v Nastavení, výchozí stav vypnuto, uchování ve dnech).
- **Sekce:** „Síť a tiskárny" se dělí na *Síťové prvky* a *Tiskárny* (ruční zařazení do staré sekce se při migraci vrací na automatické podle typu).
- **Angličtina:** přepínač CZ / EN (ukládá se ke každému uživateli); data, čísla, datum a jednotky zůstávají české.
- **Instalace přes GPO bez restartu:** postup naplánované úlohy přímo na stránce Agent pro Windows.
- **Bezpečné první nasazení:** server, který už má agenty, se po aktualizaci nastaví na cílovou verzi 1.6.0 (agenti se nepřepnou sami na 2.0.0).
  Novou verzi vyzkoušíte na jednom PC (stránka Agent pro Windows: výběr verze v příkazech, pak připnutí v detailu PC) a potom v Nastavení přepnete na
  „Nejnovější". Čerstvá instalace míří rovnou na nejnovější.
- Databáze: schéma verze 6 (agent_problems, usb_files, sloupce agenta a USB svazků, jazyk uživatele); před migrací vznikne ověřená záloha.

## 1.6.0
- USB: evidují se jen zařízení pro ukládání dat (disky, flash). Agent ostatní (klávesnice, myši, čtečky...) nehlásí
  a server je při příjmu zahazuje i od starších agentů. Při aktualizaci se z databáze jednorázově smažou dosavadní
  záznamy ostatních USB tříd (aktuální i historie).
- Hromadné mazání: tlačítko Smazat na liště po označení řádků (Zařízení, Monitory, Licence, USB události, Změny SW),
  i "všechna odpovídající filtru". Před smazáním se vytvoří záloha databáze (posledních 10 se ponechává).
- Evidence jako Zařízení: Software, Monitory, USB a Licence mají záložky s počty, rychlé filtry, filtr podle všech
  parametrů, přetahování sloupců a výběr řádků. Jako sloupce a filtry je dostupná i MAC, výrobce, model, OS, sekce,
  skupiny, inventární číslo, přidělený uživatel a poznámka zařízení.
- Čistý sken (Skenování): uloží snímek stavu a zálohu DB, smaže údaje nalezené jen skenem (zařízení bez agenta, ručních
  údajů, skupiny a SW), vynuluje online stav a porty ostatních a prohledá rozsah znovu.
- Snímky stavu a porovnání: ruční snímek i snímek před čistým skenem; porovnání se současností ukáže nová, zmizelá
  a změněná zařízení (název, IP, MAC, typ, OS, sekce, online; změny SW, USB úložišť a monitorů).
- Databáze: schéma verze 5 (tabulky snímků); před migrací vznikne ověřená záloha.
- Agent: hlásí jen USB úložiště (nový agent se na počítače dostane přes GPO / samoaktualizaci).

## 1.5.1
- Razeni podle IP adresy je ciselne (.2, .11, .12, .100), ne textove.
- Konflikt IP: kdyz ma stejnou IP vice zarizeni, ktera se obe nedavno ozvala (v rozmezi prahu z Nastaveni, vychozi 72 h),
  zobrazi se u adresy znacka "konflikt" s nazvem druheho zarizeni, rychly filtr "Konflikt IP" s poctem, sloupec/filtr
  "Konflikt IP" a upozorneni na Prehledu. Stejna neprazdna MAC se bere jako duplicita, ne konflikt.
- Databaze beze zmeny (schema 4).

## 1.5.0
- Sekce zarizeni: Pocitace, Servery, IoT, Sit a tiskarny a Vse. Zarizeni se zarazuji automaticky podle typu, ale rucni
  presun ma prednost (sloupec Sekce). "Odebrat ze sekce" nechava zarizeni jen ve Vse; "Automaticky podle typu" vraci puvodni zarazeni.
- Stavy "Bez agenta", "Neaktivni agent" a "Bez sekce" jsou rychla tlacitka s pocty, kombinovatelna se sekci i skupinou.
- Novy vzhled vyberu: vetsi zaskrtavatka, podbarveny vybrany radek, vyber rozsahu Shift+klik, pripnuta akcni lista
  (Presunout do sekce, Skupiny, Odebrat ze sekce), Esc zrusi vyber.
- Databaze: schema verze 4 (jeden novy sloupec u zarizeni; pred migraci vznikne overena zaloha).
- Pozor: zarizeni bez typu nebo s typem "neznamé"/"Linux zarizeni" uz nespadaji do "Sit a tiskarny", ale zustanou bez sekce (jen ve Vse).

## 1.4.0
- Skupiny zarizeni: tlacitko Skupiny na strance Zarizeni (vytvorit, prejmenovat, barva stitku, smazat);
  oznacovani radku zaskrtavatky a hromadne "Pridat do skupiny" / "Odebrat ze skupiny" (i "oznacit vsechna odpovidajici filtru");
  sloupec Skupiny, filtr podle skupiny (i v sablonach pohledu), vyber skupiny nad tabulkou, skupiny v detailu zarizeni.
- Posledni prihlaseni: kdyz u pocitace nikdo neni prihlasen, zobrazi se posledni zname uzivatel s casem ("naposledy ...");
  u noveho pocitace se zjisti z profilu Windows. Nove sloupce: Uzivatel je prave prihlasen, Posledni prihlaseni.
- Databaze: schema verze 3 (nove tabulky skupin, dva sloupce u zarizeni); pred migraci se vytvori overena zaloha.
- Agent se funkcne nemeni (jen cislo verze); pri zapnute samoaktualizaci si ho agenti stahnou znovu.

## 1.3.0
- Stranka Zarizeni: zalozky (Pocitace, Bez agenta, Neaktivni agent, Sit a tiskarny, Vse) s pocty; sloupec "Stav agenta"
  (zelena = data do limitu, zluta = agent neposlal data dele nez limit, cervena = nikdy) a cas poslednich dat.
  Limit (vychozi 72 h) je v Nastaveni. Prazdny nazev se nahradi IP adresou.
- Sloupce tabulek jdou pridat, odebrat a presouvat mysi (v okne Sloupce i primo v zahlavi).
- Filtry: operatory podle typu sloupce, "je jedno z", "starsi/novejsi nez (hodin)", nabidka existujicich hodnot,
  nove sloupce (FQDN, Je to pocitac, Ucet v AD povolen).
- Agent: vzdalena plocha (RDP) se cte i ze zasady GPO (drive hlasil "vypnuta", i kdyz bezela);
  BitLocker a TPM bez prav spravce hlasi "nezjisteno" misto "ne"; rezim test vypisuje cas jednotlivych casti zabezpeceni.
- Bez zmeny databaze. Samoaktualizace agentu je dale volitelna v Nastaveni (vychozi: vypnuto).

## 1.2.3
- Opraveno pocitani v rezimu test; BitLocker a TPM maji zalozni zjisteni (Get-BitLockerVolume, Get-Tpm); TPM "nezjisteno" misto "ne".

## 1.2.2
- Rezim agenta "test": nic neodesila, jen vypise, ktere udaje se na pocitaci podarilo zjistit (stranka Agent pro Windows).

## 1.2.1
- Oprava monitoru: kdyz WMI monitory nevrati (napr. Alienware Aurora R13), cte se EDID z registru podle prave pritomnych zarizeni Windows.

## 1.2.0
- Bez zmeny funkci: vydani pro vyzkouseni postupu aktualizace z GitHubu (zaloha a migrace databaze se provedou stejne jako vzdy).

## 1.1.1
- Hotovy pohled "Zabezpeceni pocitacu" (pridava se pri aktualizaci databaze, schema verze 2).

## 1.1.0
- Agent navic zjistuje: zabezpeceni (BitLocker, antivirus, firewall, Secure Boot, TPM, aktualizace, vzdalena plocha),
  zdravi disku (S.M.A.R.T., opotrebeni), licence Windows a Office (stav aktivace, klic z BIOSu), sit (rychlost,
  Wi-Fi, otevrene porty, sdilene slozky), BIOS a zakladni desku, ucty (mistni administratori, profily uzivatelu).
- Monitory se cteji z registru, kdyz je WMI nevrati.
- Nove sloupce pro sablony pohledu (BitLocker, antivirus, firewall, stav disku, ...). Bez zmeny databaze.

## 1.0.0
- Evidence HW a SW (AD, sken IP rozsahu, agent pro Windows), monitory, USB v realnem case.
- Licence, sablony pohledu, administratorska a uzivatelska cast.
- Databaze SQLite s automatickou zalohou pred aktualizaci a bezpecnymi migracemi.
- HTTPS s vlastnim certifikatem, agent overuje otisk certifikatu.
- Zalohy databaze i cele aplikace, nasazeni v Dockeru (QNAP Container Station).
