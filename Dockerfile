FROM node:22-slim

# typst renders the tailored resume to PDF. Falls back to HTML if absent.
ARG TYPST_VERSION=v0.12.0
RUN apt-get update && apt-get install -y curl xz-utils ca-certificates \
 && curl -fsSL "https://github.com/typst/typst/releases/download/${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
    | tar -xJ -C /tmp \
 && mv /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
 && rm -rf /var/lib/apt/lists/* /tmp/typst-*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "src/index.js"]
