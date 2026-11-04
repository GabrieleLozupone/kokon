# Kokon for NVIDIA GPUs (CUDA): kokon-service without a window, used from a browser.
# The same Linux build as the .deb/.rpm (Ubuntu 22.04, glibc 2.35). The engine (stable-diffusion.cpp)
# and the model are downloaded by Kokon's setup into /data, like in the desktop app, so the image
# stays small; the NVIDIA Container Toolkit provides the driver. Guide: docs/docker.md.
# Each release publishes it as ghcr.io/gabrielelozupone/kokon (.github/workflows/docker.yml).
# To build it yourself, from the repository root:
#
#   docker build -f docker/Dockerfile -t ghcr.io/gabrielelozupone/kokon:latest .

FROM ubuntu:22.04 AS build
ARG DEBIAN_FRONTEND=noninteractive
# g++-13: ONNX Runtime (AI watermark, stickers) needs GCC 13's libstdc++, linked into kokon-service
# statically (crates/qls-core/build.rs), so the runtime image below needs nothing new.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkg-config libssl-dev software-properties-common gpg-agent \
 && add-apt-repository -y ppa:ubuntu-toolchain-r/test \
 && apt-get install -y --no-install-recommends g++-13 \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The UI first: kokon-service embeds it (crates/qls-service/src/remote.rs).
RUN npm run build && cargo build -p qls-service --release

FROM ubuntu:22.04
ARG DEBIAN_FRONTEND=noninteractive
# What the .deb depends on (src-tauri/tauri.linux.conf.json), minus the window.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libgomp1 libssl3 libvulkan1 \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 kokon \
 && mkdir -p /data /config /gallery \
 && chown kokon:kokon /data /config /gallery
COPY --from=build /src/target/release/kokon-service /usr/local/bin/kokon-service
# Models, engine and gallery database in /data; settings in /config; saved images in /gallery.
ENV QLS_DATA_DIR=/data \
    QLS_CONFIG_DIR=/config \
    QLS_OUTPUT_DIR=/gallery \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    KOKON_CONTAINER=1
USER kokon
VOLUME ["/data", "/config", "/gallery"]
# The browser UI (password required). The token API on 39151 stays inside the container.
EXPOSE 39152
# --remote: open to other devices once a password is set
# (docker exec -it kokon kokon-service --set-password; applies without a restart).
CMD ["kokon-service", "--persistent", "--remote"]
