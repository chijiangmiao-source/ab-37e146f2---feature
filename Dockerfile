FROM node:20-alpine

WORKDIR /app

# Zero external npm dependencies — only the Node.js standard library is used.
COPY server ./server
COPY web ./web
COPY verify ./verify

# Build the review page into web/dist during image build (fails the image on
# page build errors).
RUN node web/build.js --check

ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIR=/app/web/dist

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --retries=12 --start-period=2s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
