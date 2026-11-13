FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HWSW_DATA=/data \
    HWSW_PORT=8580 \
    TZ=Europe/Prague

# ping pro sken IP rozsahu, tzdata pro spravny cas dennich zaloh
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

# Vsechna data (databaze, zalohy, sifrovaci klic, certifikat) jsou jen zde - image je bezstavovy.
VOLUME /data
EXPOSE 8580

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -m app.healthcheck

# Jeden proces: planovac uloh a zive udalosti drzi stav v pameti.
# HTTPS s vlastnim certifikatem v /data/tls; HWSW_TLS=off ho vypne (za reverzni proxy).
CMD ["python", "-m", "app"]
