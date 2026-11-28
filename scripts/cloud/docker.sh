#!/bin/bash
# Image builds and the local stack behind the cloud box's TLS-intercepting proxy, with the repo's Dockerfiles unchanged:
#   scripts/cloud/docker.sh prepare          base images from mirror.gcr.io, oven/bun with the proxy CA added
#   scripts/cloud/docker.sh build <args>     docker build with host networking and the proxy
#   scripts/cloud/docker.sh compose <args>   docker-compose.local.yml with the cloud override, e.g. compose up -d --build
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CA="${HLM_PROXY_CA:-/root/.ccr/ca-bundle.crt}"
ENV_FILE="${HLM_ENV_FILE:-$HOME/.config/homelab-manager/.env}"
PIN="$(cat "$REPO/.bun-version")"
export HTTPS_PROXY https_proxy="${https_proxy:-$HTTPS_PROXY}"

base_images() {
  grep -h '^FROM ' "$REPO/Dockerfile" "$REPO/agent/Dockerfile" | awk '{print $2}' |
    sed "s/\${BUN_VERSION}/$PIN/" | grep ':' | sort -u
}

# The local tag shadows the Docker Hub image, so a build that pulls (--pull) gets an image without the CA again.
prepare() {
  local ca_sum image mirror ctx
  ca_sum="$(sha256sum <"$CA" | cut -c1-16)"
  for image in $(base_images); do
    case "$image" in */*) mirror="mirror.gcr.io/$image" ;; *) mirror="mirror.gcr.io/library/$image" ;; esac
    case "$image" in
      oven/bun:*)
        [ "$(docker image inspect -f '{{index .Config.Labels "hlm.proxy-ca"}}' "$image" 2>/dev/null)" = "$ca_sum" ] && continue
        docker pull -q "$mirror" >/dev/null || return 1
        ctx="$(mktemp -d)"
        cp "$CA" "$ctx/proxy-ca.crt"
        cat >"$ctx/Dockerfile" <<EOF
FROM $mirror
COPY proxy-ca.crt /usr/local/share/ca-certificates/hlm-proxy-ca.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/hlm-proxy-ca.crt
RUN sed -i 's#http://deb.debian.org#https://deb.debian.org#g' /etc/apt/sources.list.d/debian.sources && \\
    echo 'Acquire::https::CaInfo "/usr/local/share/ca-certificates/hlm-proxy-ca.crt";' >/etc/apt/apt.conf.d/90hlm-proxy-ca
LABEL hlm.proxy-ca=$ca_sum
EOF
        docker build -q -t "$image" "$ctx" >/dev/null
        local status=$?
        rm -rf "$ctx"
        [ "$status" -eq 0 ] || return 1
        ;;
      *)
        docker image inspect "$image" >/dev/null 2>&1 && continue
        docker pull -q "$mirror" >/dev/null && docker tag "$mirror" "$image" || return 1
        ;;
    esac
  done
}

ensure_env_file() {
  [ -f "$ENV_FILE" ] && return
  mkdir -p "$(dirname "$ENV_FILE")"
  sed -e "s#^MASTER_KEY=.*#MASTER_KEY=\"$(openssl rand -base64 32)\"#" \
      -e 's#^HOMELAB_DEV_SEED=.*#HOMELAB_DEV_SEED="true"#' "$REPO/.env.example" >"$ENV_FILE"
  [ -e "$REPO/.env" ] || ln -s "$ENV_FILE" "$REPO/.env"
}

command="$1"
shift
case "$command" in
  prepare) prepare ;;
  build) prepare && exec docker build --network host --build-arg HTTPS_PROXY --build-arg https_proxy "$@" ;;
  compose)
    prepare && ensure_env_file && exec docker compose --env-file "$ENV_FILE" \
      -f "$REPO/docker-compose.local.yml" -f "$REPO/scripts/cloud/docker-compose.cloud.yml" \
      --profile management --profile oidc "$@"
    ;;
  *) sed -n '2,5p' "${BASH_SOURCE[0]}" >&2; exit 64 ;;
esac
