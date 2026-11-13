"""HTTPS: vlastni certifikat serveru v /data/tls a otisk, podle ktereho ho overuje agent.

Vychozi stav je HTTPS zapnute. Pri prvnim startu se vytvori certifikat podepsany sam sebou
(plati 10 let). Vlastni certifikat = nahradit soubory cert.pem a key.pem ve slozce /data/tls.
HWSW_TLS=off vypne HTTPS (napr. za reverzni proxy, ktera sifruje sama).
"""
import datetime
import hashlib
import ipaddress
import os
import socket
import ssl

DATA_DIR = os.environ.get("HWSW_DATA", "/data")
TLS_DIR = os.path.join(DATA_DIR, "tls")
CERT_PATH = os.path.join(TLS_DIR, "cert.pem")
KEY_PATH = os.path.join(TLS_DIR, "key.pem")


def enabled():
    return os.environ.get("HWSW_TLS", "on").strip().lower() not in ("off", "0", "no", "false")


def _names():
    """Jmena a adresy do certifikatu: localhost, jmeno stroje a HWSW_TLS_NAMES (oddelene carkou)."""
    names = ["localhost", "127.0.0.1", "::1"]
    try:
        names.append(socket.gethostname())
    except OSError:
        pass
    names += [n.strip() for n in os.environ.get("HWSW_TLS_NAMES", "").split(",")]
    seen, out = set(), []
    for n in names:
        if n and n.lower() not in seen and len(n) < 250:
            seen.add(n.lower())
            out.append(n)
    return out


def _generate():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "HWSW Monitor")])
    alt = []
    for n in _names():
        try:
            alt.append(x509.IPAddress(ipaddress.ip_address(n)))
        except ValueError:
            try:
                alt.append(x509.DNSName(n))
            except Exception:
                pass
    now = datetime.datetime.utcnow()
    cert = (x509.CertificateBuilder()
            .subject_name(subject).issuer_name(subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(x509.SubjectAlternativeName(alt), critical=False)
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(key, hashes.SHA256()))
    os.makedirs(TLS_DIR, exist_ok=True)
    try:
        os.chmod(TLS_DIR, 0o700)
    except OSError:
        pass
    key_tmp, cert_tmp = KEY_PATH + ".tmp", CERT_PATH + ".tmp"
    fd = os.open(key_tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                  serialization.NoEncryption()))
    with open(cert_tmp, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    os.replace(key_tmp, KEY_PATH)
    os.replace(cert_tmp, CERT_PATH)


def ensure():
    """Vrati (cert, key); pokud certifikat chybi, vytvori ho."""
    if not (os.path.isfile(CERT_PATH) and os.path.isfile(KEY_PATH)):
        _generate()
    return CERT_PATH, KEY_PATH


def _der():
    with open(CERT_PATH, "r", encoding="ascii", errors="ignore") as f:
        pem = f.read()
    start = pem.index("-----BEGIN CERTIFICATE-----")
    end = pem.index("-----END CERTIFICATE-----") + len("-----END CERTIFICATE-----")
    return ssl.PEM_cert_to_DER_cert(pem[start:end])


def thumbprint():
    """Otisk SHA-1 certifikatu serveru (stejny udaj ukazuje Windows jako "Kryptograficky otisk").

    Prazdny retezec, kdyz HTTPS nebezi nebo certifikat neni.
    """
    if not enabled():
        return ""
    try:
        return hashlib.sha1(_der()).hexdigest().upper()
    except (OSError, ValueError):
        return ""


def cert_pem():
    with open(CERT_PATH, "rb") as f:
        return f.read()


def bootstrap_ps(script_url, pin=""):
    """PowerShell prikazy, ktere stahnou a spusti agenta.

    S otiskem (pin) se pri stazeni overuje certifikat serveru: projde jen duveryhodny certifikat
    nebo presne ten s danym otiskem. Znak dolaru je zapsan jako [char]36, aby prikaz fungoval
    stejne z cmd.exe, z PowerShellu, z GPO i pres WinRM.
    """
    parts = ["[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072"]
    if pin and script_url.lower().startswith("https://"):
        parts.append("[Net.ServicePointManager]::ServerCertificateValidationCallback=[scriptblock]::Create("
                     "[char]36+'args[3] -eq 0 -or '+[char]36+'args[1].GetCertHashString() -eq ''%s''')" % pin)
    parts.append("iex ((New-Object Net.WebClient).DownloadString('%s'))" % script_url)
    return "; ".join(parts)
