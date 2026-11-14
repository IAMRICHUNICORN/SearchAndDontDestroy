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
$TaskName = 'HWSW Agent'
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

function Get-UsbList {
    $all = Wmi 'Win32_PnPEntity' "PNPDeviceID LIKE 'USB%'"
    $storage = @{}
    foreach ($d in $all) {
        $id = [string]$d.PNPDeviceID
        if ($id -like 'USBSTOR\*') {
            $serial = ((($id -split '\\')[-1]) -split '&')[0]
            if ($serial) { $storage[$serial.ToUpper()] = [string]$d.Name }
        }
    }
    $services = @{
        'hidusb' = 'vstupni zarizeni (HID)'; 'usbstor' = 'uloziste'; 'uaspstor' = 'uloziste';
        'usbccgp' = 'slozene USB zarizeni'; 'usbprint' = 'tiskarna'; 'usbvideo' = 'kamera';
        'usbaudio' = 'zvuk'; 'usbaudio2' = 'zvuk'; 'bthusb' = 'Bluetooth'; 'wudfwpdmtp' = 'telefon / prenosne zarizeni';
        'wpdusb' = 'telefon / prenosne zarizeni'; 'usbser' = 'seriovy port'; 'usbscan' = 'skener';
        'winusb' = 'USB zarizeni'; 'wudfrd' = 'USB zarizeni'
    }
    $classes = @{
        'DiskDrive' = 'uloziste'; 'HIDClass' = 'vstupni zarizeni (HID)'; 'Keyboard' = 'klavesnice'; 'Mouse' = 'mys';
        'Image' = 'kamera / skener'; 'Camera' = 'kamera'; 'Printer' = 'tiskarna'; 'Bluetooth' = 'Bluetooth';
        'Net' = 'sitovy adapter'; 'MEDIA' = 'zvuk'; 'AudioEndpoint' = 'zvuk'; 'WPD' = 'telefon / prenosne zarizeni';
        'SmartCardReader' = 'ctecka karet'; 'Ports' = 'seriovy port'; 'Biometric' = 'ctecka otisku';
        'Modem' = 'modem'
    }
    $list = @()
    foreach ($d in $all) {
        $id = [string]$d.PNPDeviceID
        if ($id -notmatch '^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})\\(.+)$') { continue }
        $usbVid = $Matches[1]; $usbPid = $Matches[2]; $instance = $Matches[3]
        $service = (Text $d.Service).ToLower()
        if ($service -match '^(usbhub|usbhub3|iusb3hub)$') { continue }
        if ((Text $d.Name) -match 'Root Hub|USB Hub|Rozbo') { continue }
        $serial = ''
        if ($instance -notmatch '&') { $serial = $instance }
        $name = Text $d.Name
        if ($serial -and $storage.ContainsKey($serial.ToUpper())) { $name = $storage[$serial.ToUpper()] }
        $class = ''
        $pnpClass = ''
        try { $pnpClass = Text $d.PNPClass } catch {}
        if ($services.ContainsKey($service)) { $class = $services[$service] }
        elseif ($pnpClass -and $classes.ContainsKey($pnpClass)) { $class = $classes[$pnpClass] }
        elseif ($pnpClass) { $class = $pnpClass }
        else { $class = 'USB zarizeni' }
        $list += @{
            pnp_id = $id.ToUpper(); name = $name; manufacturer = (Text $d.Manufacturer)
            vid = $usbVid.ToUpper(); pid = $usbPid.ToUpper(); serial = $serial; class = $class
        }
    }
    return ,$list
}

function Get-UsbSignature($List) {
    return (($List | ForEach-Object { $_.pnp_id } | Sort-Object) -join '|')
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

function Get-Software {
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'Registry::HKEY_USERS\*\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $seen = @{}
    $list = @()
    foreach ($path in $paths) {
        $items = @(Get-ItemProperty -Path $path -ErrorAction SilentlyContinue)
        foreach ($i in $items) {
            $name = Text $i.DisplayName
            if (-not $name) { continue }
            if ($i.SystemComponent -eq 1 -or $i.ParentKeyName) { continue }
            if ((Text $i.ReleaseType) -match '^(Update|Hotfix|Security Update)$') { continue }
            if ($name -match '^(Security Update|Update|Hotfix) for ') { continue }
            $version = Text $i.DisplayVersion
            $key = ($name + '|' + $version).ToLower()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = 1
            $date = Text $i.InstallDate
            if ($date -match '^(\d{4})(\d{2})(\d{2})$') { $date = '{0}-{1}-{2}' -f $Matches[1], $Matches[2], $Matches[3] }
            else { $date = '' }
            $list += @{ name = $name; version = $version; publisher = (Text $i.Publisher); install_date = $date }
        }
    }
    return ,$list
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

function Invoke-Safe([scriptblock]$Block, $Default) {
    # chyba v jedne casti inventury nesmi zabranit odeslani ostatnich dat
    try { return (& $Block) } catch { return $Default }
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
    $security = Invoke-Safe { Get-Security } @{}
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
        licenses = (Invoke-Safe { Get-Licenses } @{})
        accounts = (Invoke-Safe { Get-Accounts } @{})
        network = (Invoke-Safe { Get-NetworkExtra } @{})
        monitors = (Get-Monitors)
        software = (Get-Software)
        usb = (Get-UsbList)
    }
}

function Send-Inventory {
    $inv = Get-Inventory
    $reply = Send-Json '/api/agent/inventory' $inv
    return @{ reply = $reply; usb = (Get-UsbSignature $inv.usb) }
}

function Save-AgentFile {
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    # jen SYSTEM a Administrators - skript bezi jako SYSTEM a obsahuje token
    & icacls.exe $InstallDir /inheritance:r /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    $tmp = $ScriptPath + '.new'
    $client = New-Object Net.WebClient
    $client.DownloadFile(($ServerUrl + '/agent/hwsw-agent.ps1?token=' + $Token + '&mode=watch'), $tmp)
    $content = [IO.File]::ReadAllText($tmp)
    if (-not $content.TrimEnd().EndsWith('#HWSW-AGENT' + '-END')) {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw 'Stazeny soubor agenta neni kompletni'
    }
    Move-Item -Path $tmp -Destination $ScriptPath -Force
}

function Install-Agent {
    Save-AgentFile
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

function Update-Self($Mutex) {
    try {
        Save-AgentFile
        if ($Mutex) { $Mutex.ReleaseMutex(); $Mutex.Close() }
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" watch' -f $ScriptPath)
        exit 0
    } catch {}
}

function Watch-Loop {
    $created = $false
    $mutex = New-Object Threading.Mutex($true, 'Global\HWSWMonitorAgent', [ref]$created)
    if (-not $created) { return }

    $usbSig = $null
    $inventoryHours = 6
    $lastInventory = [DateTime]::MinValue
    $lastBeat = Get-Date
    try {
        Register-WmiEvent -Query 'SELECT * FROM Win32_DeviceChangeEvent WHERE EventType = 2 OR EventType = 3' -SourceIdentifier 'HWSWUsb' -ErrorAction Stop
    } catch {}

    while ($true) {
        $now = Get-Date
        if (($now - $lastInventory).TotalHours -ge $inventoryHours) {
            try {
                $result = Send-Inventory
                $usbSig = $result.usb
                $lastInventory = $now
                if ($result.reply.inventory_hours) { $inventoryHours = [int]$result.reply.inventory_hours }
                if ($result.reply.autoupdate -and $result.reply.agent_version -ne $AgentVersion) { Update-Self $mutex }
            } catch {
                # server nedostupny - zkusime to znovu za 5 minut
                $lastInventory = $now.AddHours(-$inventoryHours).AddMinutes(5)
            }
        }

        $fired = Wait-Event -SourceIdentifier 'HWSWUsb' -Timeout 30
        $changed = $false
        if ($fired) {
            Start-Sleep -Milliseconds 1500
            Get-Event -SourceIdentifier 'HWSWUsb' -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
            $changed = $true
        }
        $beat = ((Get-Date) - $lastBeat).TotalMinutes -ge 5
        if ($changed -or $beat) {
            try {
                $usb = Get-UsbList
                $sig = Get-UsbSignature $usb
                if ($sig -ne $usbSig) {
                    $reply = Send-Json '/api/agent/usb' @{ hostname = $env:COMPUTERNAME; user = (Get-LoggedUser); usb = $usb }
                    $usbSig = $sig
                    if (-not $reply.known) { $lastInventory = [DateTime]::MinValue }
                }
            } catch {}
        }
        if ($beat) {
            $lastBeat = Get-Date
            try {
                $reply = Send-Json '/api/agent/heartbeat' @{ hostname = $env:COMPUTERNAME; user = (Get-LoggedUser); agent_version = $AgentVersion }
                if (-not $reply.known) { $lastInventory = [DateTime]::MinValue }
                if ($reply.autoupdate -and $reply.agent_version -ne $AgentVersion) { Update-Self $mutex }
            } catch {}
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
    & $report 'USB zarizeni' { $u = Get-UsbList; $u = @($u); '{0} ks' -f $u.Count }
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
