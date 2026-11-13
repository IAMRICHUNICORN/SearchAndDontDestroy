# Zmeny

Format verzi: MAJOR.MINOR.PATCH (napr. 1.2.3). Kazde vydani ma na GitHubu znacku `vMAJOR.MINOR.PATCH`.

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
