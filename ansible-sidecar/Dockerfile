FROM python:3.13-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/sidecar

COPY requirements.txt requirements.yml ./
RUN pip install --no-cache-dir -r requirements.txt \
    && ansible-galaxy collection install -r requirements.yml -p /usr/share/ansible/collections

COPY ansible.cfg /etc/ansible/ansible.cfg
COPY app ./app
COPY project /runner/project

RUN mkdir -p /runner/inventory /runner/artifacts /runner/ssh \
    && cp /runner/project/inventory/hlm_inventory.py /runner/inventory/hlm_inventory.py \
    && chmod +x /runner/inventory/hlm_inventory.py \
    && rm -rf /runner/project/inventory

ENV ANSIBLE_PRIVATE_DATA_DIR=/runner \
    ANSIBLE_SIDECAR_PORT=9095 \
    PYTHONUNBUFFERED=1

EXPOSE 9095

HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=5s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9095/health', timeout=3).status == 200 else 1)"

CMD ["python", "-m", "app.server"]
