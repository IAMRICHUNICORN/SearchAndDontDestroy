#HWSW-AGENT __VERSION__
# HWSW Monitor - agent pro Windows (Windows PowerShell 3.0+, Windows 7 az 11 / Server 2008 R2+).
# Rezimy: once      = jedna inventura a konec (bez instalace)
#         watch     = trvaly beh: inventura, heartbeat, USB v realnem case
#         install   = ulozi agenta do ProgramData a zaregistruje naplanovanou ulohu (SYSTEM)
#         uninstall = odstrani ulohu i soubory
#         test      = jen vypise, co se na pocitaci podarilo zjistit (nic neodesila)
# Soubor je generovan serverem; adresa serveru a token jsou vlozeny pri stazeni.

$ServerUrl = '__SERVER_URL__'
$Token = '__TOKEN__'
$Mode = '__MODE__'
$AgentVersion = '__VERSION__'
if ($args.Count -gt 0 -and $args[0]) { $Mode = [string]$args[0] }

$InstallDir = Join-Path $env:ProgramData 'HWSW-Agent'
$ScriptPath = Join-Path $InstallDir 'hwsw-agent.ps1'
$LogPath = Join-Path $InstallDir 'agent.log'
$StatePath = Join-Path $InstallDir 'state.json'
$StartedPath = Join-Path $InstallDir 'started.txt'
$RunPath = $MyInvocation.MyCommand.Path
$TaskName = 'HWSW Agent'
$script:LastError = $null
$script:Partial = @()
$script:UsbWatch = $false
$script:FilesEnabled = $false
$script:InvMs = 0
$script:ForceInv = $false
$script:Watchers = @{}
$script:FileBuf = @{}
$script:DriveMap = @{}
$script:AuditEnabled = $false
$script:AuditLast = (Get-Date).AddMinutes(-1)
$script:AuditState = ''
$script:AuditEvents = 0
$script:FileEvents = 0
$script:FileLast = ''
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}

# HTTPS s vlastnim certifikatem serveru: projde jen duveryhodny certifikat nebo presne ten,
# jehoz otisk (SHA-1) server vlozil pri stazeni. Trida v C# - overeni pak funguje z kazdeho vlakna.
$CertPin = '__CERT_PIN__'
if ($CertPin -match '^[0-9A-Fa-f]{40}$') {
    try {
        if (-not ('HwswTls' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class HwswTls {
    public static string Pin = "";
    public static bool Check(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors) {
        if (errors == SslPolicyErrors.None) { return true; }
        if (cert == null || Pin.Length == 0) { return false; }
        return String.Equals(cert.GetCertHashString(), Pin, StringComparison.OrdinalIgnoreCase);
    }
    public static void Enable(string pin) {
        Pin = pin;
        ServicePointManager.ServerCertificateValidationCallback = new RemoteCertificateValidationCallback(Check);
    }
}
'@
        }
        [HwswTls]::Enable($CertPin)
    } catch {
        # prekladac C# neni k dispozici - nahradni overeni primo v PowerShellu
        $pinCheck = [scriptblock]::Create('$args[3] -eq 0 -or $args[1].GetCertHashString() -eq ''' + $CertPin + '''')
        [Net.ServicePointManager]::ServerCertificateValidationCallback = $pinCheck
    }
}

function Send-Json([string]$Path, $Data) {
    $json = $Data | ConvertTo-Json -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $req = [Net.HttpWebRequest]::Create($ServerUrl + $Path)
    $req.Method = 'POST'
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Headers.Add('X-Agent-Token', $Token)
    $req.Timeout = 60000
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $resp = $req.GetResponse()
    try {
        $reader = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
    } finally { $resp.Close() }
    return ($text | ConvertFrom-Json)
}

function Write-AgentLog([string]$Text) {
    # mistni log (jen kdyz je agent nainstalovan); po 512 KB se prepne na agent.log.1
    try {
        if (-not (Test-Path $InstallDir)) { return }
        if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 524288)) {
            Move-Item -Path $LogPath -Destination ($LogPath + '.1') -Force
        }
        Add-Content -Path $LogPath -Value ('{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $AgentVersion, $Text)
    } catch {}
}

function Set-AgentError([string]$Where, $Err) {
    # zapamatuje posledni chybu (odesle se serveru pri dalsim uspesnem spojeni) a zapise ji do logu
    $msg = ''
    try { $msg = [string]$Err.Exception.Message } catch {}
    if (-not $msg) { try { $msg = [string]$Err } catch {} }
    $msg = ('{0}: {1}' -f $Where, ($msg -replace '\s+', ' '))
    if ($msg.Length -gt 250) { $msg = $msg.Substring(0, 250) }
    $script:LastError = @{ msg = $msg; at = ([DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss')) }
    Write-AgentLog ('CHYBA ' + $msg)
}

function Get-AgentInfo {
    $st = Read-State
    return @{
        elevated = (Test-Elevated)
        usb_watch = [bool]$script:UsbWatch
        usb_files = [bool]$script:FilesEnabled
        usb_audit = [bool]$script:AuditEnabled
        watch_drives = @($script:Watchers.Keys | Sort-Object)
        file_events = [int]$script:FileEvents
        file_last = [string]$script:FileLast
        audit_events = [int]$script:AuditEvents
        audit_state = [string]$script:AuditState
        partial = @($script:Partial)
        inv_ms = [int]$script:InvMs
        clock = ([DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss'))
        ps = [string]$PSVersionTable.PSVersion
        upd_state = [string]$st.upd_state
        upd_target = [string]$st.upd_target
        upd_at = [string]$st.upd_at
        bad = @($st.bad)
    }
}

function Read-State {
    $st = @{ gen = 0; bad = @(); upd_state = ''; upd_target = ''; upd_at = '' }
    try {
        if (Test-Path $StatePath) {
            $o = Get-Content -Path $StatePath -Raw | ConvertFrom-Json
            $st.gen = [int]$o.gen
            $st.bad = @($o.bad | Where-Object { $_ })
            if ($o.upd_state) { $st.upd_state = [string]$o.upd_state }
            if ($o.upd_target) { $st.upd_target = [string]$o.upd_target }
            if ($o.upd_at) { $st.upd_at = [string]$o.upd_at }
        }
    } catch {}
    return $st
}

function Write-State($St) {
    try {
        if (Test-Path $InstallDir) {
            $json = (@{ gen = [int]$St.gen; bad = @($St.bad); upd_state = [string]$St.upd_state; upd_target = [string]$St.upd_target; upd_at = [string]$St.upd_at } | ConvertTo-Json -Compress)
            [IO.File]::WriteAllText($StatePath, $json)
        }
    } catch {}
}

function Set-UpdateState([string]$State, [string]$Target) {
    # stav posledni aktualizace (stahuje / ok / vraceno) se uklada do state.json a hlasi serveru
    $st = Read-State
    $st.upd_state = $State
    $st.upd_target = $Target
    $st.upd_at = ([DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss'))
    Write-State $st
}

function Wmi([string]$Class, [string]$Filter = '', [string]$Namespace = 'root\cimv2') {
    try {
        if ($Filter) { return @(Get-WmiObject -Namespace $Namespace -Class $Class -Filter $Filter -ErrorAction Stop) }
        return @(Get-WmiObject -Namespace $Namespace -Class $Class -ErrorAction Stop)
    } catch { return @() }
}

function Text($Value) {
    if ($null -eq $Value) { return '' }
    return ([string]$Value).Trim()
}

function Decode-Chars($Codes) {
    if ($null -eq $Codes) { return '' }
    return (-join ($Codes | Where-Object { $_ -gt 0 } | ForEach-Object { [char][int]$_ })).Trim()
}

function Get-LoggedUser {
    $cs = Wmi 'Win32_ComputerSystem' | Select-Object -First 1
    if ($cs -and $cs.UserName) { return [string]$cs.UserName }
    foreach ($p in (Wmi 'Win32_Process' "Name='explorer.exe'")) {
        try {
            $o = $p.GetOwner()
            if ($o.User) { return ('{0}\{1}' -f $o.Domain, $o.User) }
        } catch {}
    }
    return ''
}

function Get-VolumeEncrypted([string]$Drive) {
    # BitLocker To Go: ano = chraneno, ne = nechraneno, prazdne = nezjisteno
    try {
        $v = Get-WmiObject -Namespace 'root\cimv2\security\microsoftvolumeencryption' -Class Win32_EncryptableVolume -Filter ("DriveLetter='" + $Drive + "'") -ErrorAction Stop
        if ($v) { if ([int]$v.ProtectionStatus -eq 1) { return 'ano' } else { return 'ne' } }
    } catch {}
    return ''
}

function Get-UsbDisks {
    # vsechny disky na sbernici USB (i USB disky pres UASP / SCSI, ktere maji InterfaceType SCSI): pismena, velikost, serial
    $nums = @{}
    foreach ($md in (Wmi 'MSFT_Disk' 'BusType=7' 'root\Microsoft\Windows\Storage')) {
        try { $nums[[int]$md.Number] = $true } catch {}
    }
    $out = @()
    foreach ($dd in (Wmi 'Win32_DiskDrive')) {
        $pnp = [string]$dd.PNPDeviceID
        $isUsb = $false
        try { $isUsb = ((Text $dd.InterfaceType) -eq 'USB') -or ($pnp -like 'USBSTOR*') -or $nums.ContainsKey([int]$dd.Index) } catch {}
        if (-not $isUsb) { continue }
        $serials = @()
        if ($pnp) { $s1 = ((($pnp -split '\\')[-1]) -split '&')[0]; if ($s1) { $serials += $s1.ToUpper() } }
        $s2 = (Text $dd.SerialNumber).ToUpper()
        if ($s2) { $serials += $s2 }
        $list = @()
        try {
            $diskId = ([string]$dd.DeviceID).Replace('\', '\\')
            $parts = @(Get-WmiObject -Query ("ASSOCIATORS OF {Win32_DiskDrive.DeviceID='" + $diskId + "'} WHERE AssocClass=Win32_DiskDriveToDiskPartition") -ErrorAction Stop)
            foreach ($part in $parts) {
                $lds = @(Get-WmiObject -Query ("ASSOCIATORS OF {Win32_DiskPartition.DeviceID='" + [string]$part.DeviceID + "'} WHERE AssocClass=Win32_LogicalDiskToPartition") -ErrorAction Stop)
                foreach ($ld in $lds) {
                    $list += @{
                        drive = [string]$ld.DeviceID; label = (Text $ld.VolumeName); fs = (Text $ld.FileSystem)
                        size_gb = [math]::Round([double]$ld.Size / 1GB, 2); free_gb = [math]::Round([double]$ld.FreeSpace / 1GB, 2)
                        encrypted = (Get-VolumeEncrypted ([string]$ld.DeviceID))
                    }
                }
            }
        } catch {}
        $size = 0
        try { $size = [math]::Round([double]$dd.Size / 1GB, 2) } catch {}
        $out += @{ name = (Text $dd.Caption); manufacturer = (Text $dd.Manufacturer); serials = @($serials); vols = @($list); size_gb = $size; pnp = $pnp; index = [int]$dd.Index; used = $false }
    }
    return $out
}

function Get-UsbList {
    # Hlasi jen to, co se ma hlidat: uloziste S MEDIEM (disk, flash, vlozena karta) a telefony / prenosna zarizeni.
    # Mys, klavesnice, dongle, Bluetooth, zvuk, kamera, tiskarna, hub a prazdna ctecka / kabel se nehlasi.
    $all = Wmi 'Win32_PnPEntity' "PNPDeviceID LIKE 'USB%'"
    $disks = @(Get-UsbDisks)
    $storSvc = @('usbstor', 'uaspstor')
    $phoneSvc = @('wudfwpdmtp', 'wpdusb', 'usbaapl', 'usbaapl64', 'appleusb', 'mtpusb')
    $phoneName = 'iphone|ipad|apple mobile|android|adb interface|galaxy|pixel|smartphone|mobile phone'
    $cands = @()
    foreach ($d in $all) {
        $id = [string]$d.PNPDeviceID
        if ($id -notmatch '^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(&MI_[0-9A-F]{2})?\\(.+)$') { continue }
        $usbVid = $Matches[1]; $usbPid = $Matches[2]; $isMi = [bool]$Matches[3]; $instance = $Matches[4]
        $service = (Text $d.Service).ToLower()
        $name = Text $d.Name
        $pnpClass = ''
        try { $pnpClass = Text $d.PNPClass } catch {}
        $kind = ''
        if ($storSvc -contains $service -or $pnpClass -eq 'DiskDrive') { $kind = 'uloziste' }
        elseif ($phoneSvc -contains $service -or $pnpClass -eq 'WPD' -or $name.ToLower() -match $phoneName) { $kind = 'telefon' }
        elseif ($name -match 'nezn.m|unknown usb|descriptor request failed|device descriptor') { $kind = 'neznamo' }
        else {
            $cm = 0
            try { $cm = [int]$d.ConfigManagerErrorCode } catch {}
            if ($cm -in 28, 43) { $kind = 'neznamo' }
        }
        if (-not $kind) { continue }
        $serial = ''
        if (-not $isMi -and $instance -notmatch '&') { $serial = $instance }
        $cands += @{ id = $id.ToUpper(); vid = $usbVid.ToUpper(); pid = $usbPid.ToUpper(); mi = $isMi; serial = $serial; kind = $kind; name = $name; manufacturer = (Text $d.Manufacturer) }
    }
    # slozena zarizeni (MI_xx) se pocitaji jen kdyz neexistuje zaznam samotneho zarizeni; jeden kus na VID/PID a druh
    $direct = @{}
    foreach ($c in $cands) { if (-not $c.mi) { $direct[$c.vid + ':' + $c.pid + ':' + $c.kind] = $true } }
    $keep = @(); $miSeen = @{}
    foreach ($c in $cands) {
        if (-not $c.mi) { $keep += $c; continue }
        $k = $c.vid + ':' + $c.pid + ':' + $c.kind
        if ($direct.ContainsKey($k) -or $miSeen.ContainsKey($k)) { continue }
        $miSeen[$k] = $true
        $keep += $c
    }
    # telefon: jeden zaznam na VID/PID
    $final = @(); $phones = @{}
    foreach ($c in $keep) {
        if ($c.kind -eq 'telefon') {
            $k = $c.vid + ':' + $c.pid
            if ($phones.ContainsKey($k)) { continue }
            $phones[$k] = $true
        }
        $final += $c
    }
    # uloziste: sparovat s disky podle serioveho cisla
    foreach ($c in $final) {
        if ($c.kind -ne 'uloziste') { continue }
        $c.disks = @()
        if ($c.serial) {
            foreach ($dk in $disks) { if (-not $dk.used -and ($dk.serials -contains $c.serial.ToUpper())) { $c.disks += $dk; $dk.used = $true } }
        }
    }
    $unStor = @($final | Where-Object { $_.kind -eq 'uloziste' -and @($_.disks).Count -eq 0 })
    $unDisk = @($disks | Where-Object { -not $_.used })
    if ($unStor.Count -eq 1 -and $unDisk.Count -eq 1) { $unStor[0].disks = @($unDisk[0]); $unDisk[0].used = $true }
    $list = @()
    foreach ($c in $final) {
        if ($c.kind -eq 'neznamo') {
            $list += @{ pnp_id = $c.id; name = $c.name; manufacturer = $c.manufacturer; vid = $c.vid; pid = $c.pid; serial = $c.serial
                        class = 'neznama zarizeni'; volumes = @(); media = $true }
            continue
        }
        if ($c.kind -eq 'telefon') {
            $list += @{ pnp_id = $c.id; name = $c.name; manufacturer = $c.manufacturer; vid = $c.vid; pid = $c.pid; serial = $c.serial
                        class = 'telefon / prenosne zarizeni'; volumes = @(); media = $true }
            continue
        }
        $vols = @(); $media = $false; $dname = $c.name
        foreach ($dk in @($c.disks)) {
            $vols += @($dk.vols)
            if (@($dk.vols).Count -gt 0 -or $dk.size_gb -gt 0) { $media = $true }
            if ($dk.name) { $dname = $dk.name }
        }
        if (-not $media) { continue }   # prazdna ctecka, dock nebo kabel bez uloziste
        $list += @{ pnp_id = $c.id; name = $dname; manufacturer = $c.manufacturer; vid = $c.vid; pid = $c.pid; serial = $c.serial
                    class = 'uloziste'; volumes = @($vols); media = $true }
    }
    # disky na USB, ke kterym se nenaslo zarizeni (napr. UASP): hlasi se samostatne
    foreach ($dk in $disks) {
        if ($dk.used) { continue }
        if (-not (@($dk.vols).Count -gt 0 -or $dk.size_gb -gt 0)) { continue }
        $sn = ''
        if (@($dk.serials).Count -gt 0) { $sn = [string]$dk.serials[0] }
        $key = $sn
        if (-not $key) { $key = 'DISK' + $dk.index }
        $list += @{ pnp_id = ('USBDISK\' + $key).ToUpper(); name = $dk.name; manufacturer = $dk.manufacturer; vid = ''; pid = ''; serial = $sn
                    class = 'uloziste'; volumes = @($dk.vols); media = $true }
    }
    return ,$list
}

function Get-UsbSignature($List) {
    # zmena = jiny seznam zarizeni nebo jina pismena svazku (karta vlozena do cteky)
    return (($List | ForEach-Object { [string]$_.pnp_id + '=' + ((@($_.volumes) | ForEach-Object { $_.drive }) -join ',') } | Sort-Object) -join '|')
}

function Get-EdidInfo([byte[]]$E) {
    # Rozebere 128bajtovy blok EDID (data, ktera si monitor pamatuje o sobe).
    if ($E.Length -lt 128) { return $null }
    $m = ([int]$E[8] -shl 8) -bor [int]$E[9]
    $maker = ''
    foreach ($shift in 10, 5, 0) { $maker += [char](64 + (($m -shr $shift) -band 31)) }
    $model = ''; $serialText = ''
    foreach ($o in 54, 72, 90, 108) {
        if ($E[$o] -eq 0 -and $E[$o + 1] -eq 0 -and $E[$o + 2] -eq 0) {
            $txt = ''
            foreach ($i in 5..17) { if ($E[$o + $i] -eq 10) { break }; $txt += [char]$E[$o + $i] }
            if ($E[$o + 3] -eq 252) { $model = $txt.Trim() }
            if ($E[$o + 3] -eq 255) { $serialText = $txt.Trim() }
        }
    }
    $serialNum = [int64]$E[12] + ([int64]$E[13] * 256) + ([int64]$E[14] * 65536) + ([int64]$E[15] * 16777216)
    $serial = $serialText
    if (-not $serial -and $serialNum -gt 0) { $serial = [string]$serialNum }
    $size = $null
    if ($E[21] -gt 0 -and $E[22] -gt 0) {
        $size = [math]::Round([math]::Sqrt([double]$E[21] * $E[21] + [double]$E[22] * $E[22]) / 2.54, 1)
    }
    $year = 0
    if ($E[17] -gt 0) { $year = 1990 + [int]$E[17] }
    return @{ manufacturer = $maker; model = $model; serial = $serial; year = $year; size_inch = $size
              product_code = ('{0:X4}' -f (([int]$E[11] -shl 8) -bor [int]$E[10])); connection = '' }
}

function Get-MonitorsFromRegistry {
    # Zaloha, kdyz WMI monitory nevrati: EDID primo z registru Windows.
    # Prave pripojene monitory zna seznam zarizeni Windows (obsahuje jen pritomna zarizeni);
    # kdyz ho nelze nacist, vezmou se vsechny zaznamy krome obecnych "Default_Monitor".
    $root = 'HKLM:\SYSTEM\CurrentControlSet\Enum'
    $paths = @()
    foreach ($d in (Wmi 'Win32_PnPEntity' "PNPClass='Monitor'")) {
        $id = [string]$d.PNPDeviceID
        if ($id -like 'DISPLAY\*') { $paths += ($root + '\' + $id) }
    }
    if ($paths.Count -eq 0) {
        foreach ($model in @(Get-ChildItem ($root + '\DISPLAY') -ErrorAction SilentlyContinue)) {
            if ($model.PSChildName -match '^Default_Monitor') { continue }
            foreach ($inst in @(Get-ChildItem $model.PSPath -ErrorAction SilentlyContinue)) { $paths += $inst.PSPath }
        }
    }
    $list = @()
    foreach ($path in $paths) {
        try {
            $edid = (Get-ItemProperty -Path ($path + '\Device Parameters') -Name EDID -ErrorAction Stop).EDID
            $info = Get-EdidInfo ([byte[]]$edid)
            if ($info) { $list += $info }
        } catch {}
    }
    return ,$list
}

function Get-Monitors {
    $list = @()
    $ids = Wmi 'WmiMonitorID' '' 'root\wmi'
    $sizes = Wmi 'WmiMonitorBasicDisplayParams' '' 'root\wmi'
    $conns = Wmi 'WmiMonitorConnectionParams' '' 'root\wmi'
    foreach ($m in $ids) {
        $inst = [string]$m.InstanceName
        $size = $null
        $p = $sizes | Where-Object { $_.InstanceName -eq $inst } | Select-Object -First 1
        if ($p -and $p.MaxHorizontalImageSize -gt 0) {
            $h = [double]$p.MaxHorizontalImageSize; $v = [double]$p.MaxVerticalImageSize
            $size = [math]::Round([math]::Sqrt($h * $h + $v * $v) / 2.54, 1)
        }
        $c = $conns | Where-Object { $_.InstanceName -eq $inst } | Select-Object -First 1
        $connection = ''
        if ($c) { $connection = [string]$c.VideoOutputTechnology }
        $list += @{
            manufacturer = (Decode-Chars $m.ManufacturerName); model = (Decode-Chars $m.UserFriendlyName)
            serial = (Decode-Chars $m.SerialNumberID); year = [int]$m.YearOfManufacture
            size_inch = $size; connection = $connection; product_code = (Decode-Chars $m.ProductCodeID)
        }
    }
    if ($list.Count -eq 0) { $list = Get-MonitorsFromRegistry }
    return ,$list
}

function Read-UninstallKeys([string]$Path, [string]$Source, [string]$Prof, $Index, $List) {
    # cte zaznamy "Odinstalovat nebo zmenit program" z jedne vetve registru
    $items = @(Get-ItemProperty -Path $Path -ErrorAction SilentlyContinue)
    foreach ($i in $items) {
        $name = Text $i.DisplayName
        if (-not $name) { continue }
        if ($i.SystemComponent -eq 1 -or $i.ParentKeyName) { continue }
        if ((Text $i.ReleaseType) -match '^(Update|Hotfix|Security Update)$') { continue }
        if ($name -match '^(Security Update|Update|Hotfix) for ') { continue }
        $version = Text $i.DisplayVersion
        $key = ($name + '|' + $version).ToLower()
        if ($Index.ContainsKey($key)) {
            # stejny program v dalsim profilu: profil se jen pripise (celosystemova instalace se nemeni)
            $e = $Index[$key]
            if ($e.source -eq 'profil' -and $Prof -and (($e.profile -split ', ') -notcontains $Prof)) {
                $e.profile = ($e.profile + ', ' + $Prof).Trim(', ')
            }
            continue
        }
        $date = Text $i.InstallDate
        if ($date -match '^(\d{4})(\d{2})(\d{2})$') { $date = '{0}-{1}-{2}' -f $Matches[1], $Matches[2], $Matches[3] }
        else { $date = '' }
        $e = @{ name = $name; version = $version; publisher = (Text $i.Publisher); install_date = $date; source = $Source; profile = $Prof }
        $Index[$key] = $e
        $List.Add($e) | Out-Null
    }
}

function Get-ProfileList {
    # profily uzivatelu na PC: SID, slozka a jmeno profilu
    $out = @()
    try {
        foreach ($k in @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction Stop)) {
            $sid = $k.PSChildName
            if ($sid -notmatch '^S-1-(5-21|12-1)-') { continue }
            $path = Text ((Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue).ProfileImagePath)
            if (-not $path) { continue }
            $out += @{ sid = $sid; path = $path; name = (Split-Path -Leaf $path) }
        }
    } catch {}
    return $out
}

function Get-ProfileSoftware($Index, $List) {
    # software nainstalovany do profilu uzivatele (napr. WhatsApp, Teams, Chrome pro jednoho uzivatele)
    # prihlaseny uzivatel: registr je nacteny v HKEY_USERS; odhlaseny: docasne se nacte jeho NTUSER.DAT
    $uninst = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
    foreach ($p in @(Get-ProfileList)) {
        $loaded = Test-Path -LiteralPath ('Registry::HKEY_USERS\' + $p.sid)
        if ($loaded) {
            Read-UninstallKeys ('Registry::HKEY_USERS\' + $p.sid + '\' + $uninst) 'profil' $p.name $Index $List
            continue
        }
        $hive = Join-Path $p.path 'NTUSER.DAT'
        if (-not (Test-Path -LiteralPath $hive)) { continue }
        $tmp = 'HWSWTMP_' + ([Guid]::NewGuid().ToString('N').Substring(0, 8))
        $ok = $false
        try {
            & reg.exe load ('HKU\' + $tmp) $hive 2>$null | Out-Null
            $ok = ($LASTEXITCODE -eq 0)
        } catch {}
        if (-not $ok) { continue }
        try {
            Read-UninstallKeys ('Registry::HKEY_USERS\' + $tmp + '\' + $uninst) 'profil' $p.name $Index $List
        } catch {}
        # uvolneni: bez toho zustane soubor zamceny a profil nelze odhlasit/smazat
        for ($t = 0; $t -lt 5; $t++) {
            [GC]::Collect(); [GC]::WaitForPendingFinalizers()
            & reg.exe unload ('HKU\' + $tmp) 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Get-ProfileFolderSoftware($Index, $List) {
    # programy v %LocalAppData%\Programs bez zaznamu v registru (rozbalene / prenosne instalace)
    $names = @($List | ForEach-Object { $_.name.ToLower() })
    foreach ($p in @(Get-ProfileList)) {
        $dir = Join-Path $p.path 'AppData\Local\Programs'
        foreach ($d in @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue)) {
            $n = $d.Name
            $low = $n.ToLower()
            $hit = $false
            foreach ($x in $names) { if ($x.Contains($low) -or $low.Contains($x)) { $hit = $true; break } }
            if ($hit) { continue }
            $key = ($n + '|').ToLower()
            if ($Index.ContainsKey($key)) { continue }
            $date = ''
            try { $date = $d.CreationTime.ToString('yyyy-MM-dd') } catch {}
            $e = @{ name = $n; version = ''; publisher = ''; install_date = $date; source = 'slozka v profilu'; profile = $p.name }
            $Index[$key] = $e
            $List.Add($e) | Out-Null
        }
    }
}

function Get-StoreSoftware($Index, $List) {
    # aplikace z Microsoft Store (nejsou v registru "Odinstalovat program"); bez systemovych soucasti a knihoven
    $skip = '^(Microsoft\.Windows\.|MicrosoftWindows\.|Windows\.|windows\.|Microsoft\.NET|Microsoft\.VCLibs|Microsoft\.UI\.|Microsoft\.Services\.|Microsoft\.WindowsStore|Microsoft\.StorePurchaseApp|Microsoft\.DesktopAppInstaller|Microsoft\.AAD|Microsoft\.AccountsControl|Microsoft\.LockApp|Microsoft\.Win32WebViewHost|Microsoft\.BioEnrollment|Microsoft\.CredDialogHost|Microsoft\.ECApp|Microsoft\.Advertising|Microsoft\.MicrosoftEdge|Microsoft\.XboxGameCallableUI|Microsoft\.SecHealthUI|Microsoft\.WidgetsPlatformRuntime|Microsoft\.WebMediaExtensions|Microsoft\.HEIFImageExtension|Microsoft\.VP9VideoExtensions|Microsoft\.WebpImageExtension|Microsoft\.RawImageExtension|Microsoft\.MPEG2VideoExtension|NcsiUwpApp|InputApp|ParentalControls|1527c705-|c5e2524a-|E2A4F912-|F46D4000-|[0-9a-f]{8}-[0-9a-f]{4}-)'
    $seen = @{}
    $pkgs = @()
    try { $pkgs = @(Get-AppxPackage -AllUsers -ErrorAction Stop) } catch { $pkgs = @(Get-AppxPackage -ErrorAction SilentlyContinue) }
    foreach ($p in $pkgs) {
        $n = Text $p.Name
        if (-not $n -or $n -match $skip) { continue }
        if ($p.IsFramework -or $p.IsResourcePackage -or $p.IsBundle) { continue }
        $sk = ''
        try { $sk = Text $p.SignatureKind } catch {}
        if ($sk -eq 'System') { continue }
        try { if ($p.NonRemovable) { continue } } catch {}
        if ($seen.ContainsKey($n)) { continue }
        $seen[$n] = 1
        $disp = ''; $pub = ''
        try {
            $mf = Join-Path (Text $p.InstallLocation) 'AppxManifest.xml'
            if (Test-Path -LiteralPath $mf) {
                $x = [xml](Get-Content -LiteralPath $mf -ErrorAction Stop)
                $disp = Text $x.Package.Properties.DisplayName
                $pub = Text $x.Package.Properties.PublisherDisplayName
            }
        } catch {}
        if (-not $disp -or $disp -match '^ms-resource:') { $disp = ($n -replace '^[0-9A-Za-z]{8,16}\.', '') }
        if ($pub -match '^ms-resource:') { $pub = '' }
        if (-not $pub) { $pub = ((Text $p.Publisher) -replace '^CN=([^,]+).*$', '$1') }
        $version = Text $p.Version
        $key = ($disp + '|' + $version).ToLower()
        if ($Index.ContainsKey($key)) { continue }
        $e = @{ name = $disp; version = $version; publisher = $pub; install_date = ''; source = 'Microsoft Store'; profile = '' }
        $Index[$key] = $e
        $List.Add($e) | Out-Null
    }
}

function Get-Software {
    $index = @{}
    $list = New-Object System.Collections.ArrayList
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($path in $paths) { Read-UninstallKeys $path 'registr' '' $index $list }
    try { Get-ProfileSoftware $index $list } catch { Write-AgentLog ('software v profilech: ' + $_.Exception.Message) }
    try { Get-ProfileFolderSoftware $index $list } catch {}
    if ($null -eq $script:StoreApps -or $script:StoreApps) {
        try { Get-StoreSoftware $index $list } catch { Write-AgentLog ('aplikace Store: ' + $_.Exception.Message) }
    }
    return ,@($list)
}

function Get-RemoteInfo {
    # skutecny stav vzdalene plochy (RDP): bezi sluzba a skutecne se posloucha na portu RDP? (ne jen nastaveni v registru / GPO)
    # a vzdaleneho PowerShellu (WinRM)
    $out = @{}
    $port = 3389
    try {
        $deny = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -ErrorAction Stop).fDenyTSConnections
        $out.rdp_cfg = ([int]$deny -eq 0)
    } catch {}
    try {
        $pn = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -ErrorAction Stop).PortNumber
        if ($pn) { $port = [int]$pn }
    } catch {}
    $listenAll = @()
    try { $listenAll = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { [int]$_.Port }) } catch {}
    $svcOk = $null
    try { $svcOk = ((Get-Service -Name TermService -ErrorAction Stop).Status -eq 'Running') } catch {}
    $out.rdp_port = $port
    $out.rdp_service = $svcOk
    $out.rdp_listening = ($listenAll -contains $port)
    # skutecne chovani = poslouchani na portu (pri nezjistitelnem seznamu portu se nic netvrdi)
    if ($listenAll.Count -gt 0) { $out.rdp = [bool]$out.rdp_listening }
    # je port povolen ve firewallu (pravidlo pro prichozi RDP)?
    try {
        $rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction Stop | Where-Object { $_.DisplayGroup -match 'Remote Desktop|Vzd.len. plocha' -or $_.DisplayName -match 'Remote Desktop|Vzd.len. plocha' })
        $out.rdp_fw = ($rules.Count -gt 0)
    } catch {}
    try {
        $nla = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' 'UserAuthentication'
        if ($null -eq $nla) { $nla = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -ErrorAction Stop).UserAuthentication }
        if ($null -ne $nla) { $out.rdp_nla = ([int]$nla -eq 1) }
    } catch {}
    try {
        $svc = Get-Service -Name WinRM -ErrorAction Stop
        $listen = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { [int]$_.Port })
        $out.winrm = (($svc.Status -eq 'Running') -and ($listen -contains 5985 -or $listen -contains 5986))
    } catch {}
    return $out
}

function Get-Disks {
    $list = @()
    $done = $false
    try {
        $phys = @(Get-PhysicalDisk -ErrorAction Stop)
        foreach ($d in $phys) {
            if ((Text $d.BusType) -eq 'USB') { continue }
            $item = @{
                model = (Text $d.FriendlyName); serial = (Text $d.SerialNumber)
                size_gb = [math]::Round([double]$d.Size / 1GB); type = (Text $d.MediaType); interface = (Text $d.BusType)
                health = (Text $d.HealthStatus); status = ((@($d.OperationalStatus) | ForEach-Object { [string]$_ }) -join ', ')
            }
            try {
                $rel = $d | Get-StorageReliabilityCounter -ErrorAction Stop
                if ($rel) {
                    if ($null -ne $rel.Temperature) { $item.temp_c = [int]$rel.Temperature }
                    if ($null -ne $rel.Wear) { $item.wear_pct = [int]$rel.Wear }
                    if ($null -ne $rel.PowerOnHours) { $item.power_on_hours = [int]$rel.PowerOnHours }
                }
            } catch {}
            $list += $item
        }
        $done = $true
    } catch {}
    if (-not $done) {
        foreach ($d in (Wmi 'Win32_DiskDrive')) {
            if ((Text $d.InterfaceType) -eq 'USB') { continue }
            $list += @{
                model = (Text $d.Model); serial = (Text $d.SerialNumber)
                size_gb = [math]::Round([double]$d.Size / 1GB); type = ''; interface = (Text $d.InterfaceType)
                health = (Text $d.Status)
            }
        }
    }
    return ,$list
}

function Get-RegValue([string]$Path, [string]$Name) {
    try { return (Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop).$Name } catch { return $null }
}

function Invoke-Safe([scriptblock]$Block, $Default, [string]$Name = '') {
    # chyba v jedne casti inventury nesmi zabranit odeslani ostatnich dat; selhana cast se nahlasi jako neuplna data
    try { return (& $Block) } catch {
        if ($Name) { $script:Partial = @($script:Partial) + $Name; Write-AgentLog ('inventura - cast ' + $Name + ' selhala: ' + $_.Exception.Message) }
        return $Default
    }
}

function Test-Elevated {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Get-Security {
    $sec = @{}
    $elevated = Test-Elevated
    # cas jednotlivych casti (vypisuje je rezim test)
    $script:SecTimes = New-Object System.Collections.ArrayList
    $swStep = [Diagnostics.Stopwatch]::StartNew()
    $mark = { param([string]$Name) [void]$script:SecTimes.Add(@{ name = $Name; ms = $swStep.ElapsedMilliseconds }); $swStep.Restart() }
    # BitLocker (WMI, funguje i na starsich Windows)
    $bl = @()
    foreach ($v in (Wmi 'Win32_EncryptableVolume' '' 'root\CIMV2\Security\MicrosoftVolumeEncryption')) {
        $bl += @{ drive = (Text $v.DriveLetter); protected = ([int]$v.ProtectionStatus -eq 1) }
    }
    if ($bl.Count -eq 0) {
        try {
            foreach ($v in @(Get-BitLockerVolume -ErrorAction Stop)) {
                $bl += @{ drive = (Text $v.MountPoint); protected = (([string]$v.ProtectionStatus) -match '^(On|1)$') }
            }
        } catch {}
    }
    $sec.bitlocker = $bl
    $sec.bitlocker_os = ''
    if ($bl.Count -gt 0) {
        $sysDrive = $env:SystemDrive
        $osVol = $bl | Where-Object { $_.drive -eq $sysDrive } | Select-Object -First 1
        if ($osVol) { if ($osVol.protected) { $sec.bitlocker_os = 'ano' } else { $sec.bitlocker_os = 'ne' } }
    }
    & $mark 'BitLocker'
    # antivirus: Centrum zabezpeceni (jen stanice) a Windows Defender
    $av = @()
    foreach ($a in (Wmi 'AntiVirusProduct' '' 'root\SecurityCenter2')) {
        $state = 0
        try { $state = [int]$a.productState } catch {}
        $av += @{ name = (Text $a.displayName); enabled = ((($state -shr 8) -band 16) -ne 0); up_to_date = (($state -band 255) -eq 0) }
    }
    $sec.antivirus = $av
    & $mark 'Antivirus (Centrum zabezpeceni)'
    try {
        $mp = Get-MpComputerStatus -ErrorAction Stop
        $sig = ''
        if ($mp.AntivirusSignatureLastUpdated) { $sig = $mp.AntivirusSignatureLastUpdated.ToString('yyyy-MM-dd') }
        $sec.defender = @{ enabled = [bool]$mp.AntivirusEnabled; realtime = [bool]$mp.RealTimeProtectionEnabled
                           signatures = $sig; version = (Text $mp.AMProductVersion) }
    } catch {}
    $avText = ''
    $active = @($av | Where-Object { $_.enabled } | ForEach-Object { $_.name })
    if ($active.Count -gt 0) { $avText = ($active -join ', ') }
    elseif ($sec.defender -and $sec.defender.enabled) { $avText = 'Windows Defender' }
    elseif ($av.Count -gt 0 -or $sec.defender) { $avText = 'vypnuto' }
    $sec.antivirus_text = $avText
    & $mark 'Windows Defender'
    # firewall
    $fw = @{}
    $base = 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy'
    foreach ($pair in @(@('domain', 'DomainProfile'), @('private', 'StandardProfile'), @('public', 'PublicProfile'))) {
        $v = Get-RegValue ($base + '\' + $pair[1]) 'EnableFirewall'
        if ($null -ne $v) { $fw[$pair[0]] = ([int]$v -eq 1) }
    }
    $sec.firewall = $fw
    $sec.firewall_text = ''
    if ($fw.Count -gt 0) {
        $off = @($fw.Keys | Where-Object { -not $fw[$_] })
        if ($off.Count -eq 0) { $sec.firewall_text = 'zapnuto' } elseif ($off.Count -eq $fw.Count) { $sec.firewall_text = 'vypnuto' } else { $sec.firewall_text = 'castecne' }
    }
    & $mark 'Firewall'
    # zavadeni systemu, Secure Boot, TPM
    $sb = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' 'UEFISecureBootEnabled'
    if ($null -ne $sb) {
        $sec.boot_mode = 'UEFI'
        if ([int]$sb -eq 1) { $sec.secure_boot_text = 'ano' } else { $sec.secure_boot_text = 'ne' }
    } else { $sec.boot_mode = 'Legacy BIOS'; $sec.secure_boot_text = 'ne' }
    $tpm = Wmi 'Win32_Tpm' '' 'root\CIMV2\Security\MicrosoftTpm' | Select-Object -First 1
    if ($tpm) {
        $ver = ''
        try { $ver = Text ((([string]$tpm.SpecVersion) -split ',')[0]) } catch {}
        $sec.tpm = @{ enabled = [bool]$tpm.IsEnabled_InitialValue; activated = [bool]$tpm.IsActivated_InitialValue; version = $ver }
        if ($sec.tpm.enabled) { $sec.tpm_text = 'ano ' + $ver } else { $sec.tpm_text = 'vypnuto' }
    } else {
        $sec.tpm_text = 'nezjisteno'
        try {
            $gt = Get-Tpm -ErrorAction Stop
            if ($gt.TpmPresent) {
                $sec.tpm = @{ enabled = [bool]$gt.TpmEnabled; activated = [bool]$gt.TpmReady; version = '' }
                if ($gt.TpmEnabled) { $sec.tpm_text = 'ano' } else { $sec.tpm_text = 'vypnuto' }
            } else { $sec.tpm_text = 'ne' }
        } catch {}
    }
    & $mark 'Secure Boot a TPM'
    # UAC, vzdalena plocha
    $uac = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'EnableLUA'
    if ($null -ne $uac) { $sec.uac = ([int]$uac -eq 1) }
    # Zasada (GPO) ma pred lokalnim nastavenim prednost - jinak by agent u pocitacu s RDP zapnutym zasadou hlasil "vypnuta"
    $rdp = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' 'fDenyTSConnections'
    if ($null -eq $rdp) { $rdp = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' 'fDenyTSConnections' }
    if ($null -ne $rdp) { $sec.rdp_enabled = ([int]$rdp -eq 0) }
    $nla = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' 'UserAuthentication'
    if ($null -eq $nla) { $nla = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' 'UserAuthentication' }
    if ($null -ne $nla) { $sec.rdp_nla = ([int]$nla -eq 1) }
    & $mark 'UAC a vzdalena plocha'
    # aktualizace
    $last = $null; $count = 0
    foreach ($h in (Wmi 'Win32_QuickFixEngineering')) {
        $count++
        try {
            $dt = [datetime]$h.InstalledOn
            if ($null -eq $last -or $dt -gt $last) { $last = $dt }
        } catch {}
    }
    & $mark 'Nainstalovane opravy (Win32_QuickFixEngineering)'
    $sec.hotfix_count = $count
    $sec.last_hotfix = ''
    if ($last) { $sec.last_hotfix = $last.ToString('yyyy-MM-dd') }
    $wu = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\Results\Install' 'LastSuccessTime'
    $sec.last_update_success = Text $wu
    $reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
              (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
    $sec.pending_reboot = $reboot
    if ($reboot) { $sec.pending_reboot_text = 'ano' } else { $sec.pending_reboot_text = 'ne' }
    & $mark 'Aktualizace a cekani na restart'
    # predpoved selhani disku podle S.M.A.R.T.
    $fail = $false
    foreach ($f in (Wmi 'MSStorageDriver_FailurePredictStatus' '' 'root\wmi')) { if ($f.PredictFailure) { $fail = $true } }
    $sec.disk_failure_predicted = $fail
    & $mark 'S.M.A.R.T. (predpoved selhani disku)'
    # Bez prav spravce BitLocker, TPM ani S.M.A.R.T. nelze spolehlive zjistit - radeji "nezjisteno" nez zavadejici "ne"
    $sec.elevated = $elevated
    if (-not $elevated) {
        if ($sec.bitlocker_os -ne 'ano') { $sec.bitlocker_os = 'nezjisteno' }
        if ($sec.tpm_text -ne 'ano' -and -not ($sec.tpm_text -like 'ano *')) { $sec.tpm_text = 'nezjisteno' }
    }
    return $sec
}

function Get-DiskHealthText($Disks, $Predicted) {
    if ($Predicted) { return 'hrozi selhani' }
    $bad = @($Disks | Where-Object { $_.health -and $_.health -notmatch '^(Healthy|OK)$' })
    if ($bad.Count -gt 0) { return 'varovani' }
    $worn = @($Disks | Where-Object { $null -ne $_.wear_pct -and $_.wear_pct -ge 80 })
    if ($worn.Count -gt 0) { return 'opotrebeny' }
    if (@($Disks).Count -gt 0) { return 'v poradku' }
    return ''
}

function Read-OfficeIdentities($Root, $Name) {
    # ucty prihlasene v Office (Microsoft 365) v jednom profilu: e-mail a priznak odhlaseni
    $res = @()
    $base = $Root + '\Software\Microsoft\Office\16.0\Common\Identity\Identities'
    foreach ($k in @(Get-ChildItem -Path $base -ErrorAction SilentlyContinue)) {
        $v = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
        if (-not $v) { continue }
        $mail = Text $v.EmailAddress
        if (-not $mail) { continue }
        $so = 0
        try { $so = [int]$v.SignedOut } catch {}
        $res += @{ profile = $Name; email = $mail; signed_out = ($so -eq 1) }
    }
    return $res
}

function Get-OfficeAccounts {
    # kdo je prihlasen v Office: prihlaseny profil primo z HKEY_USERS, odhlaseny pres docasne nacteny NTUSER.DAT
    $list = @()
    foreach ($p in @(Get-ProfileList)) {
        $loaded = Test-Path -LiteralPath ('Registry::HKEY_USERS\' + $p.sid)
        if ($loaded) {
            $list += @(Read-OfficeIdentities ('Registry::HKEY_USERS\' + $p.sid) $p.name)
            continue
        }
        $hive = Join-Path $p.path 'NTUSER.DAT'
        if (-not (Test-Path -LiteralPath $hive)) { continue }
        $tmp = 'HWSWTMP_' + ([Guid]::NewGuid().ToString('N').Substring(0, 8))
        $ok = $false
        try {
            & reg.exe load ('HKU\' + $tmp) $hive 2>$null | Out-Null
            $ok = ($LASTEXITCODE -eq 0)
        } catch {}
        if (-not $ok) { continue }
        try {
            $list += @(Read-OfficeIdentities ('Registry::HKEY_USERS\' + $tmp) $p.name)
        } catch {}
        for ($t = 0; $t -lt 5; $t++) {
            [GC]::Collect(); [GC]::WaitForPendingFinalizers()
            & reg.exe unload ('HKU\' + $tmp) 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
    }
    return @($list | Select-Object -First 30)
}

function Get-Licenses {
    $out = @{ oem_key = ''; oem_description = ''; windows_text = '' }
    $svc = Wmi 'SoftwareLicensingService' | Select-Object -First 1
    if ($svc) {
        $out.oem_key = Text $svc.OA3xOriginalProductKey
        $out.oem_description = Text $svc.OA3xOriginalProductKeyDescription
    }
    $status = @{ 0 = 'nelicencovano'; 1 = 'licencovano'; 2 = 'odklad (OOB)'; 3 = 'odklad (OOT)'; 4 = 'neoriginalni'; 5 = 'upozorneni'; 6 = 'prodlouzeny odklad' }
    $products = @()
    foreach ($p in (Wmi 'SoftwareLicensingProduct' 'PartialProductKey IS NOT NULL')) {
        $app = (Text $p.ApplicationID).ToLower()
        $kind = ''
        if ($app -eq '55c92734-d682-4d71-983e-d6ec3f16059f') { $kind = 'Windows' }
        elseif ($app -eq '0ff1ce15-a989-479d-af46-f275c6370663') { $kind = 'Office' }
        else { continue }
        $code = 0
        try { $code = [int]$p.LicenseStatus } catch {}
        $label = [string]$code
        if ($status.ContainsKey($code)) { $label = $status[$code] }
        $products += @{
            kind = $kind; name = (Text $p.Name); description = (Text $p.Description); status = $label; status_code = $code
            partial_key = (Text $p.PartialProductKey); channel = (Text $p.ProductKeyChannel); family = (Text $p.LicenseFamily)
            kms_server = (Text $p.KeyManagementServiceMachine)
        }
    }
    foreach ($p in (Wmi 'OfficeSoftwareProtectionProduct' 'PartialProductKey IS NOT NULL')) {
        $code = 0
        try { $code = [int]$p.LicenseStatus } catch {}
        $label = [string]$code
        if ($status.ContainsKey($code)) { $label = $status[$code] }
        $products += @{
            kind = 'Office'; name = (Text $p.Name); description = (Text $p.Description); status = $label; status_code = $code
            partial_key = (Text $p.PartialProductKey); channel = ''; family = ''; kms_server = ''
        }
    }
    $out.products = @($products | Select-Object -First 40)
    # Microsoft 365 / Office Click-to-Run: verze a ucty prihlasene v Office (predplatne je vazano na uzivatele, ne na PC)
    try {
        $c2r = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction Stop
        $out.office = @{ version = (Text $c2r.VersionToReport); products = (Text $c2r.ProductReleaseIds); channel = (Text $c2r.CDNBaseUrl) }
    } catch {}
    if ($out.office -or @($products | Where-Object { $_.kind -eq 'Office' }).Count -gt 0) {
        $out.office_accounts = @(Get-OfficeAccounts)
    }
    $win = $products | Where-Object { $_.kind -eq 'Windows' } | Select-Object -First 1
    if ($win) {
        $out.windows_text = $win.status
        if ($win.channel) { $out.windows_text = $win.status + ' (' + $win.channel + ')' }
    }
    return $out
}

function Get-Accounts {
    $out = @{}
    $local = @()
    foreach ($u in (Wmi 'Win32_UserAccount' 'LocalAccount=True')) {
        $local += @{
            name = (Text $u.Name); full_name = (Text $u.FullName); disabled = [bool]$u.Disabled; locked = [bool]$u.Lockout
            pw_required = [bool]$u.PasswordRequired; pw_expires = [bool]$u.PasswordExpires
        }
    }
    $out.local = $local
    $admins = @()
    try {
        $grp = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value
        $grp = ($grp -split '\\')[-1]
        $g = [ADSI]('WinNT://./' + $grp + ',group')
        foreach ($m in @($g.Invoke('Members'))) {
            $path = [string]$m.GetType().InvokeMember('ADsPath', 'GetProperty', $null, $m, $null)
            $admins += (($path -replace '^WinNT://', '') -replace '/', '\')
        }
    } catch {}
    $out.admins = $admins
    $profiles = @()
    foreach ($p in @(Wmi 'Win32_UserProfile' 'Special=False' | Select-Object -First 60)) {
        $name = [string]$p.SID
        try { $name = (New-Object Security.Principal.SecurityIdentifier ([string]$p.SID)).Translate([Security.Principal.NTAccount]).Value } catch {}
        $when = ''
        try { $when = [Management.ManagementDateTimeConverter]::ToDateTime($p.LastUseTime).ToString('yyyy-MM-dd HH:mm') } catch {}
        $profiles += @{ user = $name; last_use = $when; path = (Text $p.LocalPath); loaded = [bool]$p.Loaded }
    }
    $out.profiles = @($profiles | Sort-Object { $_.last_use } -Descending)
    return $out
}

function Get-NetworkExtra {
    $out = @{}
    $listen = @()
    try {
        $listen = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            ForEach-Object { [int]$_.Port } | Sort-Object -Unique | Select-Object -First 80)
    } catch {}
    $out.listening = $listen
    $shares = @()
    foreach ($sh in (Wmi 'Win32_Share' 'Type=0')) {
        if ((Text $sh.Name) -notmatch '\$$') {
            $shares += @{ name = (Text $sh.Name); path = (Text $sh.Path); description = (Text $sh.Description) }
        }
    }
    $out.shares = $shares
    $ssid = ''
    try {
        $line = & netsh.exe wlan show interfaces 2>$null | Select-String -Pattern '^\s*SSID\s*:' | Select-Object -First 1
        if ($line) { $ssid = (($line.ToString()) -replace '^\s*SSID\s*:\s*', '').Trim() }
    } catch {}
    $out.wifi_ssid = $ssid
    return $out
}

function Get-Inventory {
    $script:Partial = @()
    $cs = Wmi 'Win32_ComputerSystem' | Select-Object -First 1
    $bios = Wmi 'Win32_BIOS' | Select-Object -First 1
    $prod = Wmi 'Win32_ComputerSystemProduct' | Select-Object -First 1
    $encl = Wmi 'Win32_SystemEnclosure' | Select-Object -First 1
    $os = Wmi 'Win32_OperatingSystem' | Select-Object -First 1
    $board = Wmi 'Win32_BaseBoard' | Select-Object -First 1
    $adapters = @(Wmi 'Win32_NetworkAdapter' 'PhysicalAdapter=True')

    $release = ''
    try {
        $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
        if ($cv.DisplayVersion) { $release = [string]$cv.DisplayVersion } elseif ($cv.ReleaseId) { $release = [string]$cv.ReleaseId }
    } catch {}
    $osVersion = Text $os.Version
    if ($release) { $osVersion = '{0} ({1})' -f $release, $osVersion }
    $installDate = ''; $lastBoot = ''; $biosDate = ''
    try { $installDate = $os.ConvertToDateTime($os.InstallDate).ToString('yyyy-MM-dd') } catch {}
    try { $lastBoot = $os.ConvertToDateTime($os.LastBootUpTime).ToString('yyyy-MM-dd HH:mm') } catch {}
    try { $biosDate = $bios.ConvertToDateTime($bios.ReleaseDate).ToString('yyyy-MM-dd') } catch {}

    $cpus = @()
    foreach ($c in (Wmi 'Win32_Processor')) {
        $cpus += @{ name = (Text $c.Name); cores = [int]$c.NumberOfCores; threads = [int]$c.NumberOfLogicalProcessors }
    }
    $ram = @()
    foreach ($m in (Wmi 'Win32_PhysicalMemory')) {
        $ram += @{
            slot = (Text $m.DeviceLocator); size_mb = [math]::Round([double]$m.Capacity / 1MB); speed = [int]$m.Speed
            manufacturer = (Text $m.Manufacturer); part = (Text $m.PartNumber); serial = (Text $m.SerialNumber)
        }
    }
    $volumes = @()
    foreach ($v in (Wmi 'Win32_LogicalDisk' 'DriveType=3')) {
        $volumes += @{
            drive = (Text $v.DeviceID); fs = (Text $v.FileSystem)
            size_gb = [math]::Round([double]$v.Size / 1GB, 1); free_gb = [math]::Round([double]$v.FreeSpace / 1GB, 1)
        }
    }
    $gpus = @()
    foreach ($g in (Wmi 'Win32_VideoController')) {
        $vram = 0
        try { $vram = [math]::Round([double]$g.AdapterRAM / 1MB) } catch {}
        $gpus += @{ name = (Text $g.Name); vram_mb = $vram; driver = (Text $g.DriverVersion) }
    }
    $nics = @(); $primaryIp = ''; $primaryMac = ''
    foreach ($n in (Wmi 'Win32_NetworkAdapterConfiguration' 'IPEnabled=True')) {
        $ips = @($n.IPAddress | Where-Object { $_ })
        $ad = $adapters | Where-Object { $_.MACAddress -and $_.MACAddress -eq $n.MACAddress } | Select-Object -First 1
        $kind = 'kabel'
        if ((Text $n.Description) -match 'Wireless|Wi-?Fi|802\.11|WLAN') { $kind = 'Wi-Fi' }
        elseif ((Text $n.Description) -match 'Bluetooth') { $kind = 'Bluetooth' }
        $speed = 0; $conn = ''
        if ($ad) {
            try { $speed = [math]::Round([double]$ad.Speed / 1000000) } catch {}
            $conn = Text $ad.NetConnectionID
        }
        $nics += @{
            name = (Text $n.Description); mac = (Text $n.MACAddress); ips = $ips; dhcp = [bool]$n.DHCPEnabled
            gateway = (@($n.DefaultIPGateway | Where-Object { $_ }) -join ', ')
            dns = (@($n.DNSServerSearchOrder | Where-Object { $_ }) -join ', ')
            dhcp_server = (Text $n.DHCPServer); dns_suffix = (Text $n.DNSDomain); kind = $kind; speed_mbps = $speed; connection = $conn
        }
        if (-not $primaryIp -and $n.DefaultIPGateway) {
            $primaryIp = [string]($ips | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1)
            $primaryMac = Text $n.MACAddress
        }
    }
    if (-not $primaryIp -and $nics.Count -gt 0) {
        $primaryIp = [string]($nics[0].ips | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1)
        $primaryMac = $nics[0].mac
    }
    $printers = @()
    foreach ($p in (Wmi 'Win32_Printer')) {
        $printers += @{ name = (Text $p.Name); driver = (Text $p.DriverName); port = (Text $p.PortName); is_default = [bool]$p.Default }
    }
    $domain = ''
    if ($cs -and $cs.PartOfDomain) { $domain = Text $cs.Domain }
    $fqdn = $env:COMPUTERNAME
    if ($domain) { $fqdn = '{0}.{1}' -f $env:COMPUTERNAME, $domain }
    $diskList = Get-Disks
    $security = Invoke-Safe { Get-Security } @{} 'zabezpeceni'
    $security.disk_health_text = Get-DiskHealthText $diskList $security.disk_failure_predicted

    return @{
        agent_version = $AgentVersion
        hostname = $env:COMPUTERNAME
        domain = $domain
        fqdn = $fqdn
        user = (Get-LoggedUser)
        primary_ip = $primaryIp
        primary_mac = $primaryMac
        system = @{
            manufacturer = (Text $cs.Manufacturer); model = (Text $cs.Model); serial = (Text $bios.SerialNumber)
            uuid = (Text $prod.UUID); sku = (Text $cs.SystemSKUNumber); chassis = @($encl.ChassisTypes)
            bios_version = (Text $bios.SMBIOSBIOSVersion); bios_date = $biosDate; asset_tag = (Text $encl.SMBIOSAssetTag)
            bios_vendor = (Text $bios.Manufacturer); smbios = ('{0}.{1}' -f $bios.SMBIOSMajorVersion, $bios.SMBIOSMinorVersion)
            board_manufacturer = (Text $board.Manufacturer); board_model = (Text $board.Product); board_serial = (Text $board.SerialNumber)
        }
        os = @{
            name = (Text $os.Caption); version = $osVersion; build = (Text $os.BuildNumber)
            arch = (Text $os.OSArchitecture); install_date = $installDate; last_boot = $lastBoot
        }
        cpu = $cpus
        ram_mb = [math]::Round([double]$cs.TotalPhysicalMemory / 1MB)
        ram_modules = $ram
        disks = $diskList
        volumes = $volumes
        gpus = $gpus
        nics = $nics
        printers = $printers
        security = $security
        licenses = (Invoke-Safe { Get-Licenses } @{} 'licence')
        accounts = (Invoke-Safe { Get-Accounts } @{} 'ucty')
        network = (Invoke-Safe { Get-NetworkExtra } @{} 'sit')
        remote = (Invoke-Safe { Get-RemoteInfo } @{} 'vzdaleny pristup')
        monitors = (Get-Monitors)
        software = (Get-Software)
        usb = (Get-UsbList)
    }
}

function Send-Inventory {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $inv = Get-Inventory
    $script:InvMs = $sw.ElapsedMilliseconds
    $inv.info = Get-AgentInfo
    $sentError = $script:LastError
    if ($sentError) { $inv.last_error = $sentError }
    $reply = Send-Json '/api/agent/inventory' $inv
    if ($sentError) { $script:LastError = $null }
    Write-AgentLog ('inventura odeslana ({0} ms, neuplne casti: {1})' -f $script:InvMs, (@($script:Partial) -join ','))
    return @{ reply = $reply; usb = (Get-UsbSignature $inv.usb) }
}

function Get-AgentFileHash([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [IO.File]::ReadAllBytes($Path)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Save-AgentFile([string]$Version = '', [string]$Sha = '', [string]$Dest = '') {
    # stahne agenta (dane verze) vedle ciloveho souboru, over konec souboru a SHA-256 a az potom ho vrati
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    # jen SYSTEM a Administrators - skript bezi jako SYSTEM a obsahuje token
    & icacls.exe $InstallDir /inheritance:r /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if (-not $Dest) { $Dest = $ScriptPath }
    $tmp = $Dest + '.new'
    $url = $ServerUrl + '/agent/hwsw-agent.ps1?token=' + $Token + '&mode=watch'
    if ($Version) { $url = $url + '&version=' + $Version }
    $client = New-Object Net.WebClient
    $client.DownloadFile($url, $tmp)
    $content = [IO.File]::ReadAllText($tmp)
    if (-not $content.TrimEnd().EndsWith('#HWSW-AGENT' + '-END')) {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw 'Stazeny soubor agenta neni kompletni'
    }
    if ($Sha) {
        $got = Get-AgentFileHash $tmp
        if ($got -ne $Sha.ToLower()) {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            throw 'Kontrolni soucet (SHA-256) stazeneho agenta nesouhlasi'
        }
    }
    return $tmp
}

function Install-Agent {
    $tmpFile = Save-AgentFile $AgentVersion
    Move-Item -Path $tmpFile -Destination $ScriptPath -Force
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" watch' -f $ScriptPath
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>HWSW Monitor - inventura HW/SW a sledovani USB</Description></RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled><Delay>PT1M</Delay></BootTrigger>
    <TimeTrigger>
      <Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>powershell.exe</Command><Arguments>$([Security.SecurityElement]::Escape($arguments))</Arguments></Exec>
  </Actions>
</Task>
"@
    $xmlPath = Join-Path $InstallDir 'task.xml'
    [IO.File]::WriteAllText($xmlPath, $xml, [Text.Encoding]::Unicode)
    & schtasks.exe /End /TN $TaskName 2>$null | Out-Null
    & schtasks.exe /Create /TN $TaskName /XML $xmlPath /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Registrace naplanovane ulohy selhala (je potreba spustit jako spravce)' }
    Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
    & schtasks.exe /Run /TN $TaskName | Out-Null
    Write-Output 'HWSW agent nainstalovan a spusten.'
}

function Uninstall-Agent {
    & schtasks.exe /End /TN $TaskName 2>$null | Out-Null
    & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
    Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output 'HWSW agent odinstalovan.'
}

function Get-UpdateTarget($Reply) {
    # cilova verze od serveru (pro tento PC), nebo $null kdyz neni co delat
    if (-not $RunPath -or ($RunPath -ne $ScriptPath)) { return $null }   # jen nainstalovany agent se aktualizuje
    $target = ''
    try { $target = [string]$Reply.target_version } catch {}
    if (-not $target) { try { $target = [string]$Reply.agent_version } catch {} }
    if (-not $target -or $target -eq $AgentVersion) { return $null }
    $st = Read-State
    $gen = 0
    try { $gen = [int]$Reply.target_gen } catch {}
    if ($gen -ne $st.gen) { $st.gen = $gen; $st.bad = @(); Write-State $st }   # administrator zmenil cil: vadne verze se zapominaji
    if (@($st.bad) -contains $target) { return $null }
    return $target
}

function Invoke-AgentUpdate($Reply, $Mutex) {
    # Prepnuti na cilovou verzi (nahoru i dolu). Puvodni proces zustava jako dohled: kdyz se nova verze do 2 minut
    # neohlasi (soubor started.txt), vrati predchozi soubor, zapamatuje si vadnou verzi a bezi dal.
    $target = Get-UpdateTarget $Reply
    if (-not $target) { return }
    $sha = ''
    try { $sha = [string]$Reply.sha256 } catch {}
    $prev = $ScriptPath + '.prev'
    $tmp = $null
    try {
        Write-AgentLog ('aktualizace na verzi ' + $target + ' - stahuji')
        Set-UpdateState 'stahuje' $target
        $tmp = Save-AgentFile $target $sha
        Copy-Item -Path $ScriptPath -Destination $prev -Force
        Remove-Item $StartedPath -Force -ErrorAction SilentlyContinue
        Move-Item -Path $tmp -Destination $ScriptPath -Force
    } catch {
        Set-AgentError ('aktualizace na ' + $target) $_
        Set-UpdateState 'vraceno' $target
        if ($tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
        return
    }
    $arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" watch' -f $ScriptPath
    try { if ($Mutex) { $Mutex.ReleaseMutex(); $Mutex.Close() } } catch {}
    $proc = $null
    try { $proc = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList $arg } catch {}
    $legacy = $true
    try { $legacy = ([version]$target).Major -lt 2 } catch {}
    $ok = $false
    $waited = 0
    while ($waited -lt 120) {
        Start-Sleep -Seconds 2
        $waited += 2
        if (Test-Path $StartedPath) {
            $seen = ''
            try { $seen = (Get-Content -Path $StartedPath -Raw).Trim() } catch {}
            if ($seen -eq $target) { $ok = $true; break }
        }
        if ((-not $proc) -or $proc.HasExited) { break }
        if ($legacy -and $waited -ge 60) { $ok = $true; break }   # starsi agent nezapisuje started.txt
    }
    if ($ok) { Write-AgentLog ('aktualizace na ' + $target + ' dokoncena'); exit 0 }
    # navrat k predchozi verzi
    Write-AgentLog ('nova verze ' + $target + ' se neohlasila - vracim predchozi')
    try { if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } } catch {}
    try { Copy-Item -Path $prev -Destination $ScriptPath -Force } catch {}
    $st = Read-State
    $st.bad = @($st.bad) + $target
    $st.upd_state = 'vraceno'
    $st.upd_target = $target
    $st.upd_at = ([DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss'))
    Write-State $st
    try { Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $arg } catch {}
    exit 0
}

# ---- sledovani souboru zapsanych na USB (volitelne, zapina server)
function Update-UsbWatchers($Usb) {
    # pro kazdy pripojeny svazek jeden watcher; odpojene / vypnute se zrusi
    $wanted = @{}
    $map = @{}
    foreach ($u in @($Usb)) {
        foreach ($v in @($u.volumes)) {
            if ($v -and $v.drive) { $map[([string]$v.drive).ToUpper()] = [string]$u.pnp_id }
        }
    }
    $script:DriveMap = $map
    if ($script:FilesEnabled) { $wanted = $map }
    foreach ($drive in @($script:Watchers.Keys)) {
        if (-not $wanted.ContainsKey($drive)) {
            $w = $script:Watchers[$drive]
            foreach ($id in $w.ids) { Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue }
            try { $w.w.EnableRaisingEvents = $false; $w.w.Dispose() } catch {}
            $script:Watchers.Remove($drive)
        }
    }
    foreach ($drive in @($wanted.Keys)) {
        if ($script:Watchers.ContainsKey($drive)) { continue }
        try {
            $fsw = New-Object IO.FileSystemWatcher (($drive + '\'), '*')
            $fsw.IncludeSubdirectories = $true
            $fsw.InternalBufferSize = 65536
            $fsw.NotifyFilter = [IO.NotifyFilters]'FileName, DirectoryName, LastWrite, Size'
            $ids = @()
            foreach ($ev in @('Created', 'Changed', 'Renamed')) {
                $sid = 'HWSWFile' + $ev + $drive.Replace(':', '')
                Register-ObjectEvent -InputObject $fsw -EventName $ev -SourceIdentifier $sid | Out-Null
                $ids += $sid
            }
            $fsw.EnableRaisingEvents = $true
            $script:Watchers[$drive] = @{ w = $fsw; ids = $ids; pnp = $wanted[$drive] }
            Write-AgentLog ('sleduji soubory na ' + $drive)
        } catch { Set-AgentError ('sledovani souboru ' + $drive) $_ }
    }
}

function Receive-UsbFileEvents {
    # prelozi udalosti watcheru do vyrovnavaci pameti (podle cesty; novejsi prebiji starsi)
    $n = 0
    foreach ($e in @(Get-Event | Where-Object { $_.SourceIdentifier -like 'HWSWFile*' })) {
        if ($n -ge 500) { break }
        $n++
        try {
            $a = $e.SourceEventArgs
            $path = [string]$a.FullPath
            $type = [string]$a.ChangeType
            Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
            if ($path -like '*System Volume Information*' -or $path -like '*$RECYCLE.BIN*') { continue }
            $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            if (-not $item -or $item.PSIsContainer) { continue }
            $action = 'zapis'
            if ($type -eq 'Renamed') { $action = 'prejmenovani' }
            if ($script:FileBuf.Count -lt 2000 -or $script:FileBuf.ContainsKey($path)) {
                $drive = $path.Substring(0, 2)
                $pnp = ''
                if ($script:Watchers.ContainsKey($drive)) { $pnp = $script:Watchers[$drive].pnp }
                $script:FileBuf[$path] = @{ key = $path; path = $path; size = [int64]$item.Length; action = $action; drive = $drive; pnp_id = $pnp; direction = 'na USB' }
                $script:FileEvents++
                $script:FileLast = [DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss')
            }
        } catch {}
    }
}

function Receive-UsbAudit {
    # soubory Z USB: cteni souboru na vymennem disku z auditu Windows (udalost 4663, GPO "Audit Removable Storage")
    if (-not $script:AuditEnabled -or $script:DriveMap.Count -eq 0) { return }
    $since = $script:AuditLast.AddSeconds(-5)
    $script:AuditLast = Get-Date
    $evs = @()
    try {
        $evs = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4663; StartTime = $since } -MaxEvents 400 -ErrorAction Stop)
        $script:AuditState = 'ok'
    } catch {
        if ([string]$_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $script:AuditState = 'ok'; return }
        $script:AuditState = 'nelze cist Security log'
        return
    }
    foreach ($e in $evs) {
        try {
            $x = [xml]$e.ToXml()
            $f = @{}
            foreach ($n in $x.Event.EventData.Data) { $f[[string]$n.Name] = [string]$n.'#text' }
            $path = [string]$f['ObjectName']
            if ($path.Length -lt 4 -or [string]$f['ObjectType'] -ne 'File') { continue }
            $drive = $path.Substring(0, 2).ToUpper()
            if (-not $script:DriveMap.ContainsKey($drive)) { continue }
            if ($path -like '*System Volume Information*' -or $path -like '*$RECYCLE.BIN*') { continue }
            $mask = 0
            try { $mask = [Convert]::ToInt32(([string]$f['AccessMask']).Replace('0x', ''), 16) } catch {}
            if (($mask -band 1) -eq 0) { continue }   # neni to cteni souboru
            if (($mask -band 6) -ne 0) { continue }   # zapis hlida sledovani souboru; zde jen ciste cteni
            $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            if ($item -and $item.PSIsContainer) { continue }
            $size = $null
            if ($item) { $size = [int64]$item.Length }
            $proc = ''
            try { $proc = Split-Path -Leaf ([string]$f['ProcessName']) } catch {}
            $who = ''
            if ($f['SubjectUserName'] -and $f['SubjectUserName'] -notlike '*$') { $who = ([string]$f['SubjectDomainName'] + '\' + [string]$f['SubjectUserName']) }
            $key = 'R|' + $path
            if ($script:FileBuf.Count -lt 2000 -or $script:FileBuf.ContainsKey($key)) {
                $script:FileBuf[$key] = @{ key = $key; path = $path; size = $size; action = 'cteni'; drive = $drive; pnp_id = [string]$script:DriveMap[$drive]; direction = 'z USB'; process = $proc; user = $who }
                $script:AuditEvents++
            }
        } catch {}
    }
}

function Get-UsbFilePayload {
    $files = @($script:FileBuf.Values | Select-Object -First 500)
    return $files
}

function Clear-SentFiles($Files) {
    foreach ($f in @($Files)) { $script:FileBuf.Remove([string]$f.key) }
}

function Read-Reply($Reply) {
    # zapamatuje si nastaveni ze serveru (interval inventury, sledovani souboru USB)
    try { if ($Reply.inventory_hours) { $script:InventoryHours = [int]$Reply.inventory_hours } } catch {}
    try { $script:FilesEnabled = [bool]$Reply.usb_files } catch {}
    try { $script:AuditEnabled = [bool]$Reply.usb_audit } catch {}
    try { if ($null -ne $Reply.store_apps) { $script:StoreApps = [bool]$Reply.store_apps } } catch {}
    $cmd = ''
    try { $cmd = [string]$Reply.cmd } catch {}
    if ($cmd -eq 'retry') {
        Write-AgentLog 'prikaz ze serveru: zkusit znovu (inventura ihned)'
        $script:ForceInv = $true
    } elseif ($cmd -eq 'reconnect') {
        Write-AgentLog 'prikaz ze serveru: znovu spojit (vadne verze zapomenuty, inventura ihned, nova aktualizace)'
        $st = Read-State
        $st.bad = @()
        $st.upd_state = ''
        Write-State $st
        $script:ForceInv = $true
    }
}

function Watch-Loop {
    $created = $false
    $mutex = New-Object Threading.Mutex($true, 'Global\HWSWMonitorAgent', [ref]$created)
    if (-not $created) { return }

    # potvrzeni startu pro dohled pri aktualizaci (soubor started.txt s cislem verze)
    try { if (Test-Path $InstallDir) { [IO.File]::WriteAllText($StartedPath, $AgentVersion) } } catch {}
    Write-AgentLog 'agent spusten'
    try {
        $stNow = Read-State
        if ($stNow.upd_state -eq 'stahuje' -and $stNow.upd_target -eq $AgentVersion) { Set-UpdateState 'ok' $AgentVersion }
    } catch {}

    $usbSig = $null
    $script:InventoryHours = 6
    $lastInventory = [DateTime]::MinValue
    $lastBeat = Get-Date
    try {
        Register-WmiEvent -Query 'SELECT * FROM Win32_DeviceChangeEvent WHERE EventType = 2 OR EventType = 3' -SourceIdentifier 'HWSWUsb' -ErrorAction Stop
        $script:UsbWatch = $true
    } catch {
        $script:UsbWatch = $false
        Set-AgentError 'sledovani USB (WMI)' $_
    }

    while ($true) {
        $now = Get-Date
        if ($script:ForceInv -or (($now - $lastInventory).TotalHours -ge $script:InventoryHours)) {
            $script:ForceInv = $false
            try {
                $result = Send-Inventory
                $usbSig = $result.usb
                $lastInventory = $now
                Read-Reply $result.reply
                Invoke-AgentUpdate $result.reply $mutex
            } catch {
                # server nedostupny nebo chyba inventury - zkusime to znovu za 5 minut
                Set-AgentError 'inventura/odeslani' $_
                $lastInventory = $now.AddHours(-$script:InventoryHours).AddMinutes(5)
            }
        }

        $fired = Wait-Event -SourceIdentifier 'HWSWUsb' -Timeout 30
        $changed = $false
        if ($fired) {
            Start-Sleep -Milliseconds 1500
            Get-Event -SourceIdentifier 'HWSWUsb' -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
            $changed = $true
        }
        try { Receive-UsbFileEvents } catch {}
        try { Receive-UsbAudit } catch {}
        $beat = ((Get-Date) - $lastBeat).TotalMinutes -ge 5
        if ($changed -or $beat) {
            try {
                $usb = Get-UsbList
                # po pripojeni nemusi mit svazek hned pismeno disku - par kratkych opakovani
                if ($changed) {
                    for ($try = 0; $try -lt 3; $try++) {
                        $noLetter = @(@($usb) | Where-Object { $_.class -eq 'uloziste' -and @($_.volumes).Count -eq 0 }).Count
                        if ($noLetter -eq 0) { break }
                        Start-Sleep -Seconds 3
                        $usb = Get-UsbList
                    }
                }
                $sig = Get-UsbSignature $usb
                $connected = (@($usb).Count -gt 0)
                if (($sig -ne $usbSig) -or ($beat -and $connected)) {
                    # soubory zapsane pred odpojenim se odeslou jeste pred zrusenim watcheru
                    try { Receive-UsbFileEvents } catch {}
                    try { Receive-UsbAudit } catch {}
                    $payload = @{ hostname = $env:COMPUTERNAME; user = (Get-LoggedUser); agent_version = $AgentVersion; usb = $usb; info = (Get-AgentInfo) }
                    $files = @(Get-UsbFilePayload)
                    if ($files.Count -gt 0) { $payload.files = $files }
                    $reply = Send-Json '/api/agent/usb' $payload
                    Clear-SentFiles $files
                    $usbSig = $sig
                    Read-Reply $reply
                    if (-not $reply.known) { $lastInventory = [DateTime]::MinValue }
                }
                Update-UsbWatchers $usb
            } catch { Set-AgentError 'USB' $_ }
        }
        if ($beat) {
            $lastBeat = Get-Date
            try {
                $payload = @{ hostname = $env:COMPUTERNAME; user = (Get-LoggedUser); agent_version = $AgentVersion; info = (Get-AgentInfo) }
                $sentError = $script:LastError
                if ($sentError) { $payload.last_error = $sentError }
                $files = @(Get-UsbFilePayload)
                if ($files.Count -gt 0) { $payload.files = $files }
                $reply = Send-Json '/api/agent/heartbeat' $payload
                if ($sentError) { $script:LastError = $null }
                Clear-SentFiles $files
                Read-Reply $reply
                if (-not $reply.known) { $lastInventory = [DateTime]::MinValue }
                Invoke-AgentUpdate $reply $mutex
            } catch { Set-AgentError 'heartbeat' $_ }
        }
    }
}

function Test-Agent {
    # Rezim "test": nic se neodesila ani neinstaluje. Vypise, co se na tomto pocitaci podarilo zjistit.
    Write-Host ''
    Write-Host ('HWSW agent {0} - TEST (nic se neodesila)' -f $AgentVersion)
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $adminText = 'ne - BitLocker a TPM se bez prav spravce nezjisti, spustte PowerShell jako spravce'
    if ($isAdmin) { $adminText = 'ano' }
    Write-Host ('PowerShell {0}, uzivatel {1}, spravce: {2}' -f $PSVersionTable.PSVersion, $id.Name, $adminText)
    Write-Host ''
    $script:okCount = 0; $script:badCount = 0
    $report = {
        param([string]$Name, [scriptblock]$Block)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            $res = & $Block
            $sw.Stop()
            if ($res) { $script:okCount++; $tag = 'OK     ' } else { $script:badCount++; $tag = 'PRAZDNE' }
            Write-Host ('[{0}] {1,-30} {2}  ({3} ms)' -f $tag, $Name, $res, $sw.ElapsedMilliseconds)
        } catch {
            $script:badCount++
            Write-Host ('[CHYBA  ] {0,-30} {1}' -f $Name, $_.Exception.Message)
        }
    }
    & $report 'Pocitac (vyrobce, model)' { $cs = Wmi 'Win32_ComputerSystem' | Select-Object -First 1; ((Text $cs.Manufacturer) + ' ' + (Text $cs.Model)).Trim() }
    & $report 'BIOS (verze, serial)' { $b = Wmi 'Win32_BIOS' | Select-Object -First 1; if ($b) { (Text $b.SMBIOSBIOSVersion) + ' / ' + (Text $b.SerialNumber) } }
    & $report 'Zakladni deska' { $b = Wmi 'Win32_BaseBoard' | Select-Object -First 1; if ($b) { (Text $b.Manufacturer) + ' ' + (Text $b.Product) } }
    & $report 'Operacni system' { $o = Wmi 'Win32_OperatingSystem' | Select-Object -First 1; Text $o.Caption }
    & $report 'Prihlaseny uzivatel' { Get-LoggedUser }
    & $report 'Procesor' { $c = @(Wmi 'Win32_Processor'); if ($c.Count) { Text $c[0].Name } }
    & $report 'Pametove moduly' { $m = @(Wmi 'Win32_PhysicalMemory'); if ($m.Count) { '{0} ks' -f $m.Count } }
    & $report 'Disky' { $d = Get-Disks; $d = @($d); if ($d.Count) { ($d | ForEach-Object { '{0} ({1})' -f $_.model, $_.health }) -join '; ' } }
    & $report '  disk: opotrebeni / teplota' { $d = Get-Disks; $d = @($d) | Where-Object { $null -ne $_.wear_pct -or $null -ne $_.temp_c } | Select-Object -First 1; if ($d) { 'opotrebeni {0} %, teplota {1} C' -f $d.wear_pct, $d.temp_c } }
    & $report 'Svazky' { $v = @(Wmi 'Win32_LogicalDisk' 'DriveType=3'); if ($v.Count) { '{0} ks' -f $v.Count } }
    & $report 'Grafika' { $g = @(Wmi 'Win32_VideoController'); if ($g.Count) { Text $g[0].Name } }
    & $report 'Sitove adaptery' { $n = @(Wmi 'Win32_NetworkAdapterConfiguration' 'IPEnabled=True'); if ($n.Count) { '{0} ks' -f $n.Count } }
    & $report 'Tiskarny' { $p = @(Wmi 'Win32_Printer'); if ($p.Count) { '{0} ks' -f $p.Count } }
    & $report 'Monitory (WMI)' { $m = @(Wmi 'WmiMonitorID' '' 'root\wmi'); if ($m.Count) { '{0} ks' -f $m.Count } }
    & $report 'Monitory (registr/EDID)' { $m = Get-MonitorsFromRegistry; $m = @($m); if ($m.Count) { ($m | ForEach-Object { '{0} {1} {2}"' -f $_.manufacturer, $_.model, $_.size_inch }) -join '; ' } }
    & $report 'Monitory (vysledek agenta)' { $m = Get-Monitors; $m = @($m); if ($m.Count) { ($m | ForEach-Object { '{0} {1}' -f $_.manufacturer, $_.model }) -join '; ' } }
    & $report 'Software' { $s = Get-Software; $s = @($s); if ($s.Count) { '{0} polozek' -f $s.Count } }
    & $report 'USB uloziste' { $u = Get-UsbList; $u = @($u); '{0} ks' -f $u.Count }
    & $report '  USB svazky (pismeno, system, velikost)' { $u = @(Get-UsbList); $v = @($u | ForEach-Object { $_.volumes } | Where-Object { $_ }); if ($v.Count) { ($v | ForEach-Object { '{0} {1} {2} GB, sifrovano: {3}' -f $_.drive, $_.fs, $_.size_gb, $_.encrypted }) -join '; ' } }
    & $report 'Agent: nainstalovan, log' { if (Test-Path $InstallDir) { if (Test-Path $LogPath) { 'ano, log ' + [math]::Round((Get-Item $LogPath).Length / 1024) + ' KB' } else { 'ano, bez logu' } } }
    & $report 'Agent: verze, spusten z instalace' { $AgentVersion + ' / ' + [bool]($RunPath -and ($RunPath -eq $ScriptPath)) }
    $sec = $null
    & $report 'Zabezpeceni (celkem)' { $script:sec = Get-Security; if ($script:sec) { 'zjisteno' } }
    if ($script:sec) {
        $s = $script:sec
        foreach ($t in $script:SecTimes) { Write-Host ('          cas: {0,-52} {1} ms' -f $t.name, $t.ms) }
        & $report '  BitLocker (systemovy disk)' { $s.bitlocker_os }
        & $report '  Antivirus' { $s.antivirus_text }
        & $report '  Firewall' { $s.firewall_text }
        & $report '  Secure Boot / rezim' { $s.secure_boot_text + ' / ' + $s.boot_mode }
        & $report '  TPM' { $s.tpm_text }
        & $report '  Posledni aktualizace' { $s.last_hotfix }
        & $report '  Zdravi disku (S.M.A.R.T.)' { if ($s.disk_failure_predicted) { 'hrozi selhani' } else { 'bez varovani' } }
    }
    $lic = $null
    & $report 'Licence (celkem)' { $script:lic = Get-Licenses; if ($script:lic) { 'zjisteno' } }
    if ($script:lic) {
        $l = $script:lic
        & $report '  Klic z BIOSu' { if ($l.oem_key) { 'nalezen (' + $l.oem_key.Length + ' znaku)' } }
        & $report '  Aktivace Windows' { $l.windows_text }
        & $report '  Produkty (Windows, Office)' { if (@($l.products).Count) { '{0} ks' -f @($l.products).Count } }
    }
    $acc = $null
    & $report 'Ucty (celkem)' { $script:acc = Get-Accounts; if ($script:acc) { 'zjisteno' } }
    if ($script:acc) {
        $a = $script:acc
        & $report '  Mistni administratori' { if (@($a.admins).Count) { @($a.admins) -join '; ' } }
        & $report '  Mistni ucty' { if (@($a.local).Count) { '{0} ks' -f @($a.local).Count } }
        & $report '  Profily uzivatelu' { if (@($a.profiles).Count) { '{0} ks' -f @($a.profiles).Count } }
    }
    $net = $null
    & $report 'Sit - dalsi (celkem)' { $script:net = Get-NetworkExtra; if ($script:net) { 'zjisteno' } }
    if ($script:net) {
        $n = $script:net
        & $report '  Naslouchajici porty' { if (@($n.listening).Count) { '{0} portu' -f @($n.listening).Count } }
        & $report '  Sdilene slozky' { if (@($n.shares).Count) { '{0} ks' -f @($n.shares).Count } }
    }
    & $report 'Cela inventura (velikost)' { $j = Get-Inventory | ConvertTo-Json -Depth 8 -Compress; '{0} KB' -f [math]::Round($j.Length / 1024) }
    Write-Host ''
    Write-Host ('Hotovo: {0} v poradku, {1} prazdnych nebo s chybou. PRAZDNE neni vzdy chyba (napr. stroj bez Wi-Fi nema SSID).' -f $script:okCount, $script:badCount)
}

switch ($Mode) {
    'install' { Install-Agent }
    'uninstall' { Uninstall-Agent }
    'watch' { Watch-Loop }
    'test' { Test-Agent }
    default {
        $null = Send-Inventory
        Write-Output 'HWSW inventura odeslana.'
    }
}
#HWSW-AGENT-END
