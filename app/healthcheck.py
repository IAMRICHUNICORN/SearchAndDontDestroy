"""Kontrola stavu pro Docker HEALTHCHECK: python -m app.healthcheck"""
import os
import ssl
import sys
import urllib.request

from app import tls


def main():
    port = os.environ.get("HWSW_PORT", "8580")
    if tls.enabled():
        # vlastni certifikat serveru: overujeme primo proti nemu, jmeno v nem byt nemusi
        ctx = ssl.create_default_context(cafile=tls.CERT_PATH)
        ctx.check_hostname = False
        urllib.request.urlopen("https://127.0.0.1:%s/healthz" % port, timeout=4, context=ctx)
    else:
        urllib.request.urlopen("http://127.0.0.1:%s/healthz" % port, timeout=4)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(exc)
        sys.exit(1)
