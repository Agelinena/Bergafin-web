# Imagem do Bergafin: o Jellyfin oficial com o nosso web por cima.
# O web é compilado do mesmo jeito que o Jellyfin oficial faz
# (jellyfin-packaging/docker/Dockerfile) e substitui /jellyfin/jellyfin-web.
#
# Build (na raiz do repositório):
#   docker build -f bergafin/Dockerfile --build-arg JELLYFIN_VERSION=12.4 -t bergafin .

ARG JELLYFIN_VERSION
ARG NODEJS_VERSION=24

FROM node:${NODEJS_VERSION}-alpine AS web
RUN apk add --no-cache autoconf g++ make libpng-dev gifsicle alpine-sdk automake libtool gcc musl-dev nasm python3 git
WORKDIR /src
COPY . .
RUN npm ci --no-audit --unsafe-perm \
 && npm run build:production

FROM jellyfin/jellyfin:${JELLYFIN_VERSION}
COPY --from=web /src/dist /jellyfin/jellyfin-web
LABEL org.opencontainers.image.source="https://github.com/Agelinena/Bergafin-web" \
      org.opencontainers.image.description="Jellyfin oficial com o Bergafin-web (login pelo Authentik)" \
      org.opencontainers.image.licenses="GPL-2.0-or-later"
