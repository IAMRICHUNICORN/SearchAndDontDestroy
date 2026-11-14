# Zmeny

Format verzi: MAJOR.MINOR.PATCH (napr. 1.2.3). Kazde vydani ma na GitHubu znacku `vMAJOR.MINOR.PATCH`.

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
