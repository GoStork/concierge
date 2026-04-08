#!/bin/bash
set -e
npm install
rm -rf /home/runner/.npm/_npx/2778af9cee32ff87 2>/dev/null || true
npx --yes prisma@7.4.0 db push
npx --yes prisma@7.4.0 generate
