"""Spusteni serveru: python -m app  (HTTPS s vlastnim certifikatem, pokud neni HWSW_TLS=off)."""
import os

import uvicorn

from app import tls


def main():
    host = os.environ.get("HWSW_HOST", "0.0.0.0")
    port = int(os.environ.get("HWSW_PORT", "8580"))
    kwargs = {}
    if tls.enabled():
        cert, key = tls.ensure()
        kwargs = {"ssl_certfile": cert, "ssl_keyfile": key}
        print("HWSW Monitor - HTTPS zapnuto, otisk certifikatu: %s" % tls.thumbprint(), flush=True)
    else:
        print("HWSW Monitor - HTTPS vypnuto (HWSW_TLS=off)", flush=True)
    uvicorn.run("app.main:app", host=host, port=port, **kwargs)


if __name__ == "__main__":
    main()
