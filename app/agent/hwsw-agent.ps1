#HWSW-AGENT __VERSION__
# HWSW Monitor - agent pro Windows (Windows PowerShell 3.0+, Windows 7 az 11 / Server 2008 R2+).
# Rezimy: once      = jedna inventura a konec (bez instalace)
#         watch     = trvaly beh: inventura, heartbeat, USB v realnem case
#         install   = ulozi agenta do ProgramData a zaregistruje naplanovanou ulohu (SYSTEM)
#         uninstall = odstrani ulohu i soubory
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
            $list += @{
                model = (Text $d.FriendlyName); serial = (Text $d.SerialNumber)
                size_gb = [math]::Round([double]$d.Size / 1GB); type = (Text $d.MediaType); interface = (Text $d.BusType)
            }
        }
        $done = $true
    } catch {}
    if (-not $done) {
        foreach ($d in (Wmi 'Win32_DiskDrive')) {
            if ((Text $d.InterfaceType) -eq 'USB') { continue }
            $list += @{
                model = (Text $d.Model); serial = (Text $d.SerialNumber)
                size_gb = [math]::Round([double]$d.Size / 1GB); type = ''; interface = (Text $d.InterfaceType)
            }
        }
    }
    return ,$list
}

function Get-Inventory {
    $cs = Wmi 'Win32_ComputerSystem' | Select-Object -First 1
    $bios = Wmi 'Win32_BIOS' | Select-Object -First 1
    $prod = Wmi 'Win32_ComputerSystemProduct' | Select-Object -First 1
    $encl = Wmi 'Win32_SystemEnclosure' | Select-Object -First 1
    $os = Wmi 'Win32_OperatingSystem' | Select-Object -First 1

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
        $nics += @{
            name = (Text $n.Description); mac = (Text $n.MACAddress); ips = $ips; dhcp = [bool]$n.DHCPEnabled
            gateway = (@($n.DefaultIPGateway | Where-Object { $_ }) -join ', ')
            dns = (@($n.DNSServerSearchOrder | Where-Object { $_ }) -join ', ')
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
        }
        os = @{
            name = (Text $os.Caption); version = $osVersion; build = (Text $os.BuildNumber)
            arch = (Text $os.OSArchitecture); install_date = $installDate; last_boot = $lastBoot
        }
        cpu = $cpus
        ram_mb = [math]::Round([double]$cs.TotalPhysicalMemory / 1MB)
        ram_modules = $ram
        disks = (Get-Disks)
        volumes = $volumes
        gpus = $gpus
        nics = $nics
        printers = $printers
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

switch ($Mode) {
    'install' { Install-Agent }
    'uninstall' { Uninstall-Agent }
    'watch' { Watch-Loop }
    default {
        $null = Send-Inventory
        Write-Output 'HWSW inventura odeslana.'
    }
}
#HWSW-AGENT-END
