# Operations runbook

How CS Virtual Lab runs on its VPS, and what to do when something needs attention.
Everything here assumes the layout created by `scripts/ops/setup-vps.sh`.

## 1. What runs where

```
Internet ──443/80──▶ caddy (TLS, gzip)  ──▶ app (Node: API + built web app, port 8787)  ──▶ db (Postgres 16)
                                                                                          volume: dbdata
Host: Ubuntu, Docker Compose, ufw (22, 80, 443), unattended security upgrades
Checkout: /opt/cs-virtual-lab      Secrets: /opt/cs-virtual-lab/.env (mode 600)
Backups:  /var/backups/cs-virtual-lab (encrypted) + off-site copy
```

| Piece | Where | Notes |
| --- | --- | --- |
| Compose stack | `docker-compose.yml` | services `db`, `app`, `caddy`; `docker compose ps` shows state |
| App image | built from `Dockerfile` | multi-stage; migrations in `apps/api/migrations` run automatically when `app` starts |
| TLS | Caddy | obtains and renews the certificate for `DOMAIN` by itself; data in the `caddy_data` volume |
| Database | Postgres in `db`, volume `dbdata` | never exposed on a host port |
| Logs | `docker compose logs <service>` | JSON request logs, rotated by Docker (5 × 10 MB per service) |

## 2. Environment variables (`.env`)

| Variable | Meaning |
| --- | --- |
| `POSTGRES_PASSWORD` | database password, generated at setup; only reachable inside Docker |
| `DOMAIN` | the public hostname Caddy serves; `http://<ip>` while there is no domain |
| `RESEARCH_SALT` | derives research ids from account ids. **Never change it**: learners' analytics histories would split. Back it up separately (the backup job encrypts `.env` nightly). |
| `BACKUP_KEEP_DAYS` | how many days of backups to keep locally and off-site (30) |
| `BACKUP_AGE_RECIPIENT` | public key backups are encrypted to; set by `install-backups.sh` |
| `BACKUP_SSH_TARGET` | off-site destination, `user@host:/path`; the root user's SSH key must be installed there |

## 3. First deployment

1. On the VPS as root: `bash setup-vps.sh <repo url> <domain>` (fetch the script from the repository first).
2. `cd /opt/cs-virtual-lab && docker compose up -d --build` (first build takes a few minutes).
3. `bash scripts/ops/install-backups.sh`, store the printed private key off the server, set `BACKUP_SSH_TARGET` in `.env`, run `scripts/ops/backup.sh` once and check the log.
4. Point the domain's DNS A record at the server; open `https://<domain>/` and `https://<domain>/api/health`.
5. Create an account, pass a lab, sign out and in again on another device to confirm sync.
6. Do a test restore: `scripts/ops/restore.sh /var/backups/cs-virtual-lab/<latest>.sql.gz.age <identity file>`.

## 4. Routine tasks

| Task | Command |
| --- | --- |
| Update to the latest commit | `scripts/ops/update.sh` (backs up, pulls, rebuilds, restarts app, health-checks) |
| Check health | `curl -s https://<domain>/api/health` → `{"ok":true,...}` |
| See what is running | `docker compose ps`; `docker stats --no-stream` |
| Tail logs | `docker compose logs -f --tail=100 app` (or `caddy`, `db`) |
| Backup now | `scripts/ops/backup.sh`; log in `/var/log/cslab-backup.log` |
| Monthly restore test | `scripts/ops/restore.sh <file> <identity>` (loads into a scratch database and drops it) |
| Disk | `df -h /`; `docker system df`; `docker image prune -f` |
| Memory on a 2 GB host | `free -m`; if `app` is OOM-killed, add swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` and add it to `/etc/fstab` |
| Host reboot after kernel updates | `needrestart` or `/var/run/reboot-required`; `reboot` at a quiet hour; Docker restarts the stack |

## 5. Secrets

- `POSTGRES_PASSWORD` can be rotated: change it in `.env`, then `docker compose exec db psql -U cslab -c "alter user cslab password '<new>';"`, then `docker compose up -d app`.
- `RESEARCH_SALT` is never rotated. If it is lost, analytics histories cannot be linked to accounts again; the backup job keeps an encrypted copy of `.env`.
- The backup private key lives only in the operator's password manager. Losing it makes every backup unreadable; generate a new key pair with `install-backups.sh` after removing `BACKUP_AGE_RECIPIENT` from `.env`, and take a fresh backup at once.

## 6. When things go wrong

**The site is down.** `docker compose ps` shows which service stopped; `docker compose logs --tail=100 <service>`; `docker compose up -d` restarts everything. If the host is out of disk, prune images and old logs first.

**Certificate errors.** Caddy needs ports 80 and 443 reachable and the DNS A record pointing here. `docker compose logs caddy` shows the ACME error. After fixing DNS, `docker compose restart caddy`.

**The app will not start after an update.** Logs usually show a failed migration. Roll back the code: `git log --oneline -5`, `git checkout <previous commit>`, `scripts/ops/update.sh` will refuse a non-fast-forward pull, so run `docker compose build app && docker compose up -d app` directly. If the database must go back too, use `restore.sh --replace` with the backup taken before the update.

**Database corruption or accidental deletion.** `scripts/ops/restore.sh <backup> <identity> --replace`. The previous database is kept as `cslab_old` until you drop it.

**Suspected breach.** Rotate `POSTGRES_PASSWORD` and every SSH key, review `docker compose logs caddy` for the window, export `analytics.access_log`, and follow the incident steps in `docs/05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md` (section 5) including notification duties under Act 843.

## 7. Off-site backups

Backups are `pg_dump | gzip | age` with public-key encryption, so the server holds only the public key. `BACKUP_SSH_TARGET` can be any host that accepts SSH from the VPS: another VPS, a home machine with a static address, or a storage box. Verify once a month that the off-site copy exists and that a restore test passes.
