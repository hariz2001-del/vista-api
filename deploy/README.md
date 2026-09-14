# Deploying Vista

```
Tablet / owner's browser
        │ HTTPS
        ▼
   Cloudflare ── pos.vistahub.my, rms.vistahub.my  → Cloudflare Pages (static)
        │
        │ HTTPS (Origin Certificate, SSL mode Full (strict))
        ▼
   EC2 · Nginx :443 ── api.vistahub.my
        │ http://127.0.0.1:3000
        ▼
   PM2 · vista-api (Node 24)
        │ 127.0.0.1:5432
        ▼
   Docker · Postgres 16  →  nightly pg_dump → Cloudflare R2 (write-only token)
```

Only 443 (from Cloudflare) and 22 (from you) are open. Postgres and the API
itself never listen on a public address.

---

## 1. AWS — once

- **Security group:** inbound **22** from your own IP only; inbound **443** from
  [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) only. Nothing else —
  not 80, not 3000, not 5432.
- **Elastic IP** attached, so the address survives a reboot.

## 2. Server — once (Ubuntu 24.04, as `ubuntu`)

```bash
# Packages
sudo apt-get update && sudo apt-get install -y git nginx unzip ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker ubuntu
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pm2
# AWS CLI, used only to copy backups to R2
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
  && unzip -q /tmp/awscli.zip -d /tmp && sudo /tmp/aws/install
# log out and back in so the docker group applies

# Code
sudo mkdir -p /opt/vista && sudo chown ubuntu:ubuntu /opt/vista
git clone git@github.com:hariz2001-del/vista-api.git /opt/vista/api   # needs a deploy key
cd /opt/vista/api

# Secrets — generated here, never copied from anywhere
cp .env.production.example .env
nano .env        # fill POSTGRES_PASSWORD (twice) and JWT_SECRET from `openssl rand -hex …`
chmod 600 .env

# Database
mkdir -p /opt/vista/db_data
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d

# API
npm ci --no-audit --no-fund
npx prisma generate
npx prisma migrate deploy
npx tsx prisma/seed.ts                 # menu, brands, partners, the one account
npx tsx scripts/set-credentials.ts you@example.com 'a-long-real-password' 1234
#   ^ REQUIRED. The seed's demo password is written in the README.
pm2 start deploy/ecosystem.config.cjs && pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu   # run the command it prints
curl -s http://127.0.0.1:3000/healthz            # {"ok":true}
```

## 3. Cloudflare — HTTPS to the origin

1. **SSL/TLS → Overview:** mode **Full (strict)**.
2. **Origin certificate**, keeping the private key on the server:
   ```bash
   sudo mkdir -p /etc/ssl/cloudflare && cd /etc/ssl/cloudflare
   sudo openssl req -new -newkey rsa:2048 -nodes \
     -keyout api.vistahub.my.key -out api.vistahub.my.csr -subj "/CN=api.vistahub.my"
   sudo chmod 600 api.vistahub.my.key
   cat api.vistahub.my.csr
   ```
   **SSL/TLS → Origin Server → Create Certificate → "Use my private key and CSR"**,
   paste the CSR, hostname `api.vistahub.my`. Save the certificate it returns as
   `/etc/ssl/cloudflare/api.vistahub.my.pem`.
3. **Nginx:**
   ```bash
   sudo cp /opt/vista/api/deploy/nginx/api.vistahub.my.conf /etc/nginx/sites-available/
   sudo ln -sf /etc/nginx/sites-available/api.vistahub.my.conf /etc/nginx/sites-enabled/
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. **DNS:** `A  api  <Elastic IP>`, **Proxied** (orange cloud).
5. Check from anywhere: `https://api.vistahub.my/healthz` → `{"ok":true}`.

## 4. Cloudflare Pages — the two apps

For each of `vista-pos` → `pos.vistahub.my` and `vista-rms` → `rms.vistahub.my`:

- **Workers & Pages → Create → Pages → Connect to Git**, pick the repo.
- Production branch: `master` (or the branch being tested).
- Build command `npm run build` · output directory `dist`.
- Environment variable `VITE_API_BASE_URL = https://api.vistahub.my`.
  **Never** set `VITE_DEMO` in production.
- Node version comes from the repo's `.node-version` (24).
- **Custom domains:** add `pos.vistahub.my` / `rms.vistahub.my`.

## 5. Backups — once

Create an R2 bucket `vista-backups` and an R2 API token with **Object Write**
only on that bucket. Then on the server:

```bash
cat > /opt/vista/backup.env <<'ENV'
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=vista-backups
AWS_ACCESS_KEY_ID=<token access key>
AWS_SECRET_ACCESS_KEY=<token secret>
ENV
chmod 600 /opt/vista/backup.env
chmod +x /opt/vista/api/deploy/backup.sh && /opt/vista/api/deploy/backup.sh   # try once
( crontab -l 2>/dev/null; echo "30 21 * * * /opt/vista/api/deploy/backup.sh >> /var/log/vista-backup.log 2>&1" ) | crontab -
```

**Restore once before trusting it:** download a dump from R2 and load it into a
scratch database (`docker exec -i vista-db createdb -U vista restore_test`, then
`gunzip -c dump.sql.gz | docker exec -i vista-db psql -U vista -d restore_test`).

## Updating

```bash
/opt/vista/api/deploy/deploy.sh               # master
/opt/vista/api/deploy/deploy.sh some-branch   # a branch
```

The frontends redeploy themselves on every push to their Pages branch.

## Guarantees worth knowing

- **Guessing limits:** 10 sign-in and 10 PIN attempts per 15 minutes per client,
  keyed on Cloudflare's `CF-Connecting-IP`. Held in memory, so a restart resets
  them — which is why PM2 runs exactly one process.
- **Browsers:** only `CORS_ORIGINS` sites can call the API from a page.
- **Sessions:** the counter's session never expires and is revoked from the RMS
  (Settings → Counter tablet). Owner sessions last 12 hours.
