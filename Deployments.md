# Opygen Cleaning CRM — AWS Deployment Guide

> **Backend API:** `https://43.205.126.45.sslip.io`  
> **Frontend App:** `https://cleaningcrm.opygen.com`  
> **AWS Instance:** EC2 · `43.205.126.45` · Ubuntu 24.04 LTS  
> **Stack:** Node.js 20 · Express · Socket.IO · Prisma · Redis · Docker · Caddy

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [AWS EC2 Instance Setup](#2-aws-ec2-instance-setup)
3. [Security Group Rules](#3-security-group-rules)
4. [Install Required Software on the Server](#4-install-required-software-on-the-server)
5. [Clone the Repository](#5-clone-the-repository)
6. [Configure Environment Variables](#6-configure-environment-variables)
7. [Build & Launch with Docker Compose](#7-build--launch-with-docker-compose)
8. [Verify the Deployment](#8-verify-the-deployment)
9. [Common Management Commands](#9-common-management-commands)
10. [Updating the Application (Re-deploy)](#10-updating-the-application-re-deploy)
11. [Logs & Monitoring](#11-logs--monitoring)
12. [Troubleshooting](#12-troubleshooting)
13. [File Reference](#13-file-reference)

---

## 1. Architecture Overview

```
Internet (opygen.com  →  43.205.126.45)
          │
          ▼
   ┌─────────────────────────────────────────────┐
   │  AWS EC2  ·  Ubuntu 24.04  ·  43.205.126.45 │
   │                                             │
   │  ┌──────────────────────────────────────┐   │
   │  │  Docker Network: crm_network         │   │
   │  │                                      │   │
   │  │  ┌─────────────────────────────────┐ │   │
   │  │  │  Caddy :80 / :443              │ │   │
   │  │  │  • TLS via sslip.io            │ │   │
   │  │  │  • Reverse proxy → app:3000    │ │   │
   │  │  │  • Handles WebSocket upgrade   │ │   │
   │  │  └──────────────┬──────────────────┘ │   │
   │  │                 │                    │   │
   │  │  ┌──────────────▼──────────────────┐ │   │
   │  │  │  Node.js App :3000             │ │   │
   │  │  │  Express + Socket.IO           │ │   │
   │  │  │  Prisma → Neon PostgreSQL      │ │   │
   │  │  └──────────────┬──────────────────┘ │   │
   │  │                 │                    │   │
   │  │  ┌──────────────▼──────────────────┐ │   │
   │  │  │  Redis :6379  (cache/sessions) │ │   │
   │  │  └─────────────────────────────────┘ │   │
   │  └──────────────────────────────────────┘   │
   └─────────────────────────────────────────────┘
```

**Key points:**

- **Caddy** handles TLS automatically using `43.205.126.45.sslip.io` (free Let's Encrypt via sslip.io — no real domain needed).
- **Node.js app** runs internally on port `3000`, never exposed directly to the internet.
- **Redis** is isolated in the private Docker network.
- **Neon PostgreSQL** is a managed cloud database — no local DB needed.
- **CORS** is enforced inside Node.js (`server.ts`), not Caddy.

---

## 2. AWS EC2 Instance Setup

### Instance details (already created)

| Field      | Value                |
| ---------- | -------------------- |
| Public IP  | `43.205.126.45`      |
| OS         | Ubuntu 24.04 LTS     |
| Elastic IP | Not required         |
| SSH Key    | Your `.pem` key file |

### Connect to the instance via SSH

```bash
# Replace ~/your-key.pem and the IP as needed
ssh -i ~/your-key.pem ubuntu@43.205.126.45
```

> **Tip:** If permission is denied run: `chmod 400 ~/your-key.pem`

---

## 3. Security Group Rules

Ensure the following rules are set in your EC2 Security Group.

### Inbound Rules

| Type  | Protocol | Port | Source    |
| ----- | -------- | ---- | --------- |
| SSH   | TCP      | 22   | 0.0.0.0/0 |
| HTTP  | TCP      | 80   | 0.0.0.0/0 |
| HTTPS | TCP      | 443  | 0.0.0.0/0 |

### Outbound Rules

| Type        | Protocol | Port | Destination |
| ----------- | -------- | ---- | ----------- |
| All traffic | All      | All  | 0.0.0.0/0   |

> Port 3000 is **not** exposed — Caddy proxies all external requests internally.

---

## 4. Install Required Software on the Server

SSH into the server, then run the following commands **one block at a time**.

### 4.1 Update the OS

```bash
sudo apt update && sudo apt upgrade -y
```

### 4.2 Install Node.js 20 (via NodeSource)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should print v20.x.x
npm -v
```

### 4.3 Install Docker Engine

```bash
# Add Docker's official GPG key and repository
sudo apt install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
                    docker-buildx-plugin docker-compose-plugin
```

### 4.4 Add your user to the docker group (avoid `sudo` every time)

```bash
sudo usermod -aG docker $USER
newgrp docker          # apply immediately without logout
docker --version       # e.g. Docker version 26.x.x
docker compose version # e.g. Docker Compose version v2.x.x
```

### 4.5 Install Git

```bash
sudo apt install -y git
git --version
```

---

## 5. Clone the Repository

```bash
# Go to a good working directory
cd /home/ubuntu

# Clone the repo (replace with your actual repository URL)
git clone https://github.com/YOUR_ORG/cleaning-crm-backends.git

# Enter the project folder
cd cleaning-crm-backends
```

> If the repository is private, you will be prompted for GitHub credentials or need to set up an SSH key / personal access token.

---

## 6. Configure Environment Variables

The `.env` file is **not** committed to Git (it's in `.gitignore`). You must create it manually on the server.

```bash
# Create the .env file from the example template
cp .env.example .env

# Open with nano and fill in the production values
nano .env
```

### Required production values

Edit the file so it contains the correct production settings:

```dotenv
NODE_ENV=production
BACKEND_IP=0.0.0.0
PORT=3000

# ── Database (Neon PostgreSQL — already cloud-hosted) ──────────
DATABASE_URL=postgresql://neondb_owner:<PASSWORD>@<HOST>.neon.tech/neondb?sslmode=require

# ── BetterAuth ────────────────────────────────────────────────
BETTER_AUTH_SECRET=<your-secret>
BETTER_AUTH_URL=https://43.205.126.45.sslip.io

# ── Frontend URLs (for CORS whitelist) ────────────────────────
APP_URL=https://cleaningcrm.opygen.com
FRONTEND_URL=https://cleaningcrm.opygen.com

# ── JWT ───────────────────────────────────────────────────────
ACCESS_TOKEN_SECRET=<strong-random-string>
REFRESH_TOKEN_SECRET=<strong-random-string>
ACCESS_TOKEN_EXPIRES_IN=1d
REFRESH_TOKEN_EXPIRES_IN=30d

# ── Super Admin seed ──────────────────────────────────────────
SUPER_ADMIN_EMAIL=superadmin@gmail.com
SUPER_ADMIN_PASSWORD=Cleaning@123

# ── Email (Gmail SMTP) ────────────────────────────────────────
SMTP_EMAIL=opygen.info@gmail.com
SMTP_PASSWORD=<app-password>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465

# ── Redis (Docker container — use service name, not localhost) ─
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# ── Stripe ────────────────────────────────────────────────────
STRIPE_SECRET_KEY=<your-stripe-key>

# ── Cloudinary ────────────────────────────────────────────────
CLOUDINARY_CLOUD_NAME=dr6linfry
CLOUDINARY_API_KEY=<key>
CLOUDINARY_API_SECRET=<secret>
```

> **Important:** `REDIS_HOST=redis` — this must match the Redis service name in `docker-compose.yml`, not `localhost`.

Save and exit: `Ctrl+X` → `Y` → `Enter`

---

## 7. Build & Launch with Docker Compose

### 7.1 Build the Docker images

```bash
# Inside the project directory
docker compose build --no-cache
```

This compiles TypeScript, generates the Prisma client, and creates a minimal production image. The first build may take **3–5 minutes**.

### 7.2 Start all containers

```bash
docker compose up -d
```

This starts three containers in the background:

- `cleaning_crm_app` — your Node.js backend
- `cleaning_crm_redis` — Redis cache
- `cleaning_crm_caddy` — Caddy reverse proxy + TLS

### 7.3 Check container status

```bash
docker compose ps
```

All three containers should show status **Up** (healthy):

```
NAME                  STATUS          PORTS
cleaning_crm_app      Up (healthy)
cleaning_crm_redis    Up (healthy)
cleaning_crm_caddy    Up            0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
```

### 7.4 Watch the startup logs

```bash
docker compose logs -f
```

Look for these lines:

```
cleaning_crm_app | Server is running at http://0.0.0.0:3000
cleaning_crm_caddy | ... certificate obtained successfully
```

Press `Ctrl+C` to exit log following.

---

## 8. Verify the Deployment

### 8.1 Test over HTTP (redirects to HTTPS)

```bash
curl -I http://43.205.126.45
# Expected: 301 Moved Permanently → https://43.205.126.45.sslip.io
```

### 8.2 Test the API over HTTPS

```bash
curl https://43.205.126.45.sslip.io/
# Expected JSON:
# {"success":true,"message":"Cleaning CRM API is running...."}
```

### 8.3 Test a real API endpoint

```bash
curl https://43.205.126.45.sslip.io/api/v1/...
```

### 8.4 Browser check

Open in your browser: `https://43.205.126.45.sslip.io`

You should see a valid HTTPS padlock with a Let's Encrypt certificate.

---

## 9. Common Management Commands

### View logs

```bash
# All containers
docker compose logs -f

# App only
docker compose logs -f app

# Caddy only
docker compose logs -f caddy

# Caddy access log (structured JSON)
docker compose exec caddy cat /var/log/caddy/access.log | tail -50
```

### Restart a container

```bash
docker compose restart app
docker compose restart caddy
docker compose restart redis
```

### Stop everything

```bash
docker compose down
```

### Stop and delete volumes (⚠️ deletes Redis data)

```bash
docker compose down -v
```

### Shell into the app container

```bash
docker compose exec app sh
```

### Check Redis

```bash
docker compose exec redis redis-cli ping
# Expected: PONG
```

---

## 10. Updating the Application (Re-deploy)

When you push new code to Git, follow these steps on the server:

```bash
# 1. Enter the project directory
cd /home/ubuntu/cleaning-crm-backends

# 2. Pull the latest code
git pull origin main

# 3. Rebuild the app image with no cache
docker compose build --no-cache app

# 4. Restart only the app container (zero-downtime — Redis and Caddy keep running)
docker compose up -d --no-deps app
```

> **Note:** Caddy and Redis keep running during re-deploys, so there is no TLS certificate disruption.

### Running Prisma migrations after update

If your update includes new database migrations:

```bash
# Shell into the app container
docker compose exec app sh

# Inside the container
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.\$connect().then(() => console.log('DB OK')).catch(console.error);
"
exit
```

> For production, migrations should ideally be run through a migration script before restarting.

---

## 11. Logs & Monitoring

### Application logs (Winston)

Logs are written inside the container. To persist them on the host, optionally add a volume in `docker-compose.yml`:

```yaml
# In the app service:
volumes:
  - ./logs:/app/logs
```

### Caddy access logs

```bash
docker compose exec caddy cat /var/log/caddy/access.log | python3 -m json.tool | head -100
```

### Docker stats (CPU / Memory)

```bash
docker stats
```

### Disk usage

```bash
df -h
docker system df
```

---

## 12. Troubleshooting

### ❌ Caddy can't get a TLS certificate

**Cause:** Port 80 or 443 is blocked, or the sslip.io hostname can't be reached.

**Fix:**

1. Verify Security Group inbound rules allow TCP 80 and 443 from `0.0.0.0/0`.
2. Confirm `43.205.126.45.sslip.io` resolves to your IP: `nslookup 43.205.126.45.sslip.io`
3. Check Caddy logs: `docker compose logs caddy`

---

### ❌ CORS errors from opygen.com

**Cause:** `FRONTEND_URL` in `.env` or `docker-compose.yml` doesn't match the origin.

**Fix:**

1. Confirm `.env` has `FRONTEND_URL=https://cleaningcrm.opygen.com`
2. Confirm `server.ts` includes `https://cleaningcrm.opygen.com` in the `cors()` origin array.
3. Restart the app: `docker compose restart app`

---

### ❌ "Connection refused" on port 3000

**Cause:** The app container crashed at startup.

**Fix:**

```bash
docker compose logs app --tail=50
# Look for error messages, then fix the .env or code and rebuild
docker compose build --no-cache app
docker compose up -d
```

---

### ❌ Redis connection error (`ECONNREFUSED redis:6379`)

**Cause:** `REDIS_HOST` is set to `localhost` instead of `redis`.

**Fix:** Edit `.env` and set `REDIS_HOST=redis`, then restart: `docker compose restart app`

---

### ❌ Prisma: "Can't reach database server"

**Cause:** `DATABASE_URL` is incorrect or Neon is unreachable.

**Fix:**

1. Verify the `DATABASE_URL` in `.env` is correct (copy from Neon dashboard).
2. Confirm `?sslmode=require` is appended.
3. Restart: `docker compose restart app`

---

### ❌ "Permission denied" building Docker image

**Fix:** Add your user to the docker group:

```bash
sudo usermod -aG docker $USER && newgrp docker
```

---

## 13. File Reference

| File                 | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `Dockerfile`         | Multi-stage build: base → deps → build → production |
| `docker-compose.yml` | Orchestrates app, redis, and caddy containers       |
| `Caddyfile`          | Caddy config: TLS, reverse proxy, compression, logs |
| `.dockerignore`      | Files excluded from the Docker build context        |
| `.env`               | Secret environment variables (never commit to Git)  |
| `.env.example`       | Template with all required variable names           |
| `src/index.ts`       | App entry point: HTTP server + Socket.IO            |
| `src/server.ts`      | Express app: CORS, routes, middleware               |
| `src/config/ENV.ts`  | Environment variable exports                        |
| `prisma/schema/`     | Prisma data models                                  |

---

> Last updated: June 2026  
> Maintained by: Opygen Engineering
