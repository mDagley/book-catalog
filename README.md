This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Generating APP_PASSWORD_HASH

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" '<your-password>'
```

Every `$` in the resulting hash must be escaped as `\$` when pasted into
`.env` (e.g. `\$2b\$10\$...`), since Next.js's env loader does shell-style
`${VAR}` interpolation and will otherwise silently corrupt the hash (see
`.env.example`).

## Deploying with Docker (e.g. EasyPanel on a VPS)

The `Dockerfile` builds a self-contained production image (Next.js
[`output: "standalone"`](https://nextjs.org/docs/app/api-reference/config/next-config-js/output))
and runs database migrations automatically on container start via
`docker-entrypoint.sh`.

1. **Set environment variables** in your host's UI (EasyPanel's "Environment"
   tab, or equivalent) — see `.env.production.example` for the full list and
   how to generate each value. Do not bake secrets into the image.
2. **Mount a persistent volume at `/app/uploads`.** This is where scanned
   book covers are stored; without a volume, every redeploy wipes them.
3. **Point `DATABASE_URL` at a real Postgres** — either one hosted alongside
   this app (e.g. an EasyPanel Postgres service, using its internal service
   name as the host) or an external managed database.
4. **Attach a domain with HTTPS.** The barcode-scanning camera feature
   (`getUserMedia`) refuses to run outside a secure context — accessing the
   app over plain HTTP or a bare IP will break scanning, even though every
   other page works fine. EasyPanel provisions this automatically via
   Let's Encrypt once a domain is attached.
5. Build and run: EasyPanel (or any Docker host) just needs to build the
   repo's `Dockerfile` and run the resulting image on port `3000`. On first
   boot, `docker-entrypoint.sh` runs `prisma migrate deploy` (a no-op if the
   schema's already current) before starting the server — no separate
   migration step is needed.

To build and smoke-test locally before deploying:

```bash
docker build -t book-catalog .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  -e SESSION_SECRET="..." \
  -e APP_PASSWORD_HASH="..." \
  -e UPLOADS_DIR="/app/uploads" \
  -v book-catalog-uploads:/app/uploads \
  book-catalog
```

## Deploy on Vercel (not currently supported)

Vercel's serverless filesystem is ephemeral, so it's incompatible with this
app's local-disk cover-image storage (`UPLOADS_DIR`) as-is — cover images
would disappear between deploys/invocations. The Docker path above is the
supported route for this app; Vercel would need cover storage moved to an
object store (e.g. S3-compatible) first.
