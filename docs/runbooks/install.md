# Installing Foxalora on a Linux server

For test and pilot installs. Foxalora is **not release-ready**: the separate render origin and the independent penetration test are still missing (CLAUDE.md rules 5 and Phase 6). Use test mailboxes or your own, keep access restricted (section 5), and do not offer it to customers yet.

Foxalora does not host mail. It connects to mail servers you already have (a hosting server, Gmail, Microsoft 365), so the server below needs no mail ports open, only 80 and 443.

## 1. What you need

- A Linux server (Ubuntu 24.04 and 26.04 tested; any distribution with Docker works), 1 to 2 CPU and 4 GB RAM recommended (2 GB works but the first build is tight), 30 GB disk, x86-64 or ARM64.
- **Fast storage.** The first install builds Docker images, which is disk-heavy. On a throttled disk it can take hours or freeze the server: on AceCloud, "NVME General purpose" storage made a fresh server unusable, while "NVMe based High IOPS Storage" installed in minutes. Pick SSD/NVMe with normal or high IOPS.
- Docker Engine with the Compose v2 plugin.
- Two host names pointing at the server (DNS A records): the webmail, e.g. `webmail.yourdomain.com`, and a second one that shows email content, by default `content.webmail.yourdomain.com`. Incoming email is shown from that second address so that a malicious message can never run on the webmail's own address or reach its cookies (CLAUDE.md rule 5). Another name: `RENDER_DOMAIN=name ./deploy/install.sh ...`.
- Ports 80 and 443 open to the internet (80 is needed for Let's Encrypt).

**Cloud firewall:** allow inbound TCP 22, 80 and 443 in the provider's security group or firewall (create a new group rather than editing a shared `default` one). Outbound must allow the mail ports (993, 465/587) so Foxalora can reach your mail server.

**DNS on Cloudflare:** set both records to **DNS only** (grey cloud) so Let's Encrypt can reach the server directly.

**Free option:** Oracle Cloud "Always Free" ARM instance (Ampere A1, up to 4 OCPU / 24 GB). Open ports 80 and 443 in both the VCN security list and the instance firewall. Free offers change; check the current terms when signing up.

## 2. Prepare the server

```bash
# Docker Engine + Compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker
docker compose version

# Ubuntu images on Oracle Cloud ship with iptables rules that block 80/443:
sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Get the code

```bash
sudo mkdir -p /opt/foxalora && sudo chown "$USER" /opt/foxalora
git clone --branch dev https://github.com/graphicweave/Foxalora.git /opt/foxalora
# Without GitHub access, copy it from your machine instead (a git clone is needed for automatic deploys):
#   git archive HEAD | ssh user@server 'tar -x -C /opt/foxalora'
cd /opt/foxalora
```

## 4. Install

```bash
./deploy/install.sh webmail.yourdomain.com --letsencrypt you@yourdomain.com
# or without an email address (no expiry warnings from Let's Encrypt; renewal below still works):
./deploy/install.sh webmail.yourdomain.com --letsencrypt
```

The installer generates `deploy/.env` with random secrets (and `RENDER_DOMAIN`), gets one certificate for both host names, builds the images (a few minutes on the first run), starts Nginx, the API, PostgreSQL and Valkey, runs migrations, and prints a **setup link**:

```
https://webmail.yourdomain.com/setup#token=<64 hex characters>
```

It can be run again safely; it prints the link again while setup is not finished.

## 4a. Setup wizard (in the browser)

Open the setup link. The wizard has five steps:

1. **Check**: HTTPS, database, session store, encryption key, production mode and site address. Continue is blocked while a check fails.
2. **Administrator**: company name, administrator email and password (at least 12 characters). This account is for the admin console, not for reading mail.
3. **Mail server**: the IMAP and SMTP host and security (SSL/TLS 993 or STARTTLS 143; SSL/TLS 465 or STARTTLS 587/25). **Test connection** checks the connection, TLS and certificate; with an optional test mailbox it also checks the login (the test password is used once and not stored). Advanced: "Mail server is on a private network" (only if it really is), "The server saves sent mail itself" (Gmail, Microsoft 365, Zoho). If IMAP and SMTP have different host names, untick "Outgoing mail (SMTP) uses the same server" and enter both.
4. **Domains**: the email domains whose users sign in through this server, one per line.
5. **Review and finish**: everything is saved in one step; if anything fails, nothing is saved.

After finishing, the setup page answers "not found" for good, with or without the token. Customers sign in at `https://webmail.yourdomain.com`.

- Keep the setup link private until setup is done: whoever opens it first sets up the server.
- Lost the link: `grep SETUP_TOKEN deploy/.env`, then open `https://webmail.yourdomain.com/setup#token=` followed by the value.
- More servers and domains later: in the **admin console** (next section), or with the CLI:

```bash
./deploy/cli.sh tenant:list
./deploy/cli.sh server:add <tenantId> main --imap mail.yourdomain.com:993:tls --smtp mail.yourdomain.com:465:tls
./deploy/cli.sh domain:map <tenantId> yourdomain.com main
./deploy/cli.sh server:list <tenantId>
```

- Port 587 with STARTTLS: `--smtp mail.yourdomain.com:587:starttls`.
- Gmail: `--imap imap.gmail.com:993:tls --smtp smtp.gmail.com:465:tls --saves-sent`, map `gmail.com`; users sign in with an app password.
- Unencrypted connections (`none-dev-only`) are refused in production.

Settings for common providers:

| Provider | IMAP | SMTP | Saves sent mail itself |
|---|---|---|---|
| cPanel / Plesk hosting | `mail.yourdomain.com` 993 SSL/TLS | same host, 465 SSL/TLS | no |
| Zoho Mail (India) | `imappro.zoho.in` 993 SSL/TLS | `smtppro.zoho.in` 465 SSL/TLS | yes (if "Save copy of sent emails" is on) |
| Zoho Mail (global) | `imappro.zoho.com` 993 SSL/TLS | `smtppro.zoho.com` 465 SSL/TLS | yes |
| Gmail | `imap.gmail.com` 993 SSL/TLS | `smtp.gmail.com` 465 SSL/TLS | yes; users need an app password |

**Zoho: IMAP is off by default for every mailbox.** Until it is turned on, the test connection shows "the server was reached, but the test mailbox could not sign in" while SMTP signs in fine, and users get the generic sign-in failure. The API log shows `login failed (imap_auth:ALERT)`. Each user turns it on in Zoho Mail: Settings → All Settings → Mail Accounts → their address → **IMAP Access**; or a Zoho admin does it under Users → the user → Mail Settings → IMAP/POP Access. Accounts with two-factor login sign in with a Zoho app password.

Why a user cannot sign in: the login page always shows the same generic message (on purpose). The reason is in the API log: `./deploy/compose.sh logs api | grep -i login`.

## 4b. Admin console

`https://webmail.yourdomain.com/admin`, with the administrator email and password from the setup wizard. Mailbox users never see it; it has its own sign-in and session (15 minutes idle, 8 hours at most).

- **Two-step verification is required.** At the first sign-in, scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password …), enter its 6-digit code, and store the 10 backup codes shown once. Each code works only once; 5 wrong codes lock code entry for 15 minutes.
- **Domains:** add a customer domain to a mail server, or remove one (its users can no longer sign in).
- **Mail servers:** add, edit, delete (only when no domain uses it), and test the connection, as in the setup wizard.
- **Audit log:** filter by event, date and text; export as CSV. Entries never contain passwords or mail content.
- **Lost phone and backup codes:** on the server, `./deploy/cli.sh admin:reset-2fa admin@yourdomain.com`; the administrator sets up two-step again at the next sign-in.
- **Forgotten administrator password:** on the server, `./deploy/cli.sh admin:reset-password admin@yourdomain.com`. It prints a new random password once, signs that administrator out everywhere and records the reset in the audit log. Two-step verification stays as it was.
- The two-step keys are encrypted with `MASTER_KEYS` in `deploy/.env` (added automatically by `install.sh`). Back it up with the database: without it, every administrator has to set up two-step again.

Sign in at `https://webmail.yourdomain.com` with a mailbox on one of the domains. **Write down how long the install took** (adoption target: 15 minutes).

Certificate renewal (daily; it renews only when needed). It must run as **root**: the certificate files belong to root, and the log goes to `/var/log`. In a normal user's crontab it fails silently and the certificate expires after 90 days.

```bash
( sudo crontab -l 2>/dev/null; echo "17 3 * * * /opt/foxalora/deploy/renew-cert.sh >> /var/log/foxalora-cert.log 2>&1" ) | sudo crontab -
sudo /opt/foxalora/deploy/renew-cert.sh && echo "renewal works"
```

Automatic deploys from GitHub on every push: `docs/runbooks/auto-deploy.md`.

### Turning on the content address for an install from before it existed

Installs made before 2026-11-23 show email content in a sandboxed frame on the webmail address itself; the API log and the setup checks say so. To switch:

1. Add a DNS A record `content.webmail.yourdomain.com` pointing at the server (Cloudflare: DNS only) and wait until it resolves.
2. Re-run the installer with the new name; with Let's Encrypt it extends the certificate to cover both names:
   ```bash
   RENDER_DOMAIN=content.webmail.yourdomain.com ./deploy/install.sh webmail.yourdomain.com --letsencrypt
   ```
   With your own certificate, put one that covers both names in `deploy/certs/` first and leave out `--letsencrypt`.
3. Open a message: its body now loads from `https://content.webmail.yourdomain.com/api/v1/render/...`. Check from your machine: `curl -sI https://content.webmail.yourdomain.com/` answers 404 (it serves nothing else).

## 5. Test server for testers

### Option A: testers use Gmail test accounts

Each tester creates a new Gmail account just for testing (not a personal one), turns on 2-Step Verification and creates an app password. Then:

```bash
./deploy/cli.sh server:add <tenantId> gmail --imap imap.gmail.com:993:tls --smtp smtp.gmail.com:465:tls --saves-sent
./deploy/cli.sh domain:map <tenantId> gmail.com gmail
./deploy/testing/gate.sh enable    # password gate in front of the site; prints the login
```

Testers sign in to Foxalora with their Gmail address and the app password. Mail is really delivered.

### Option B: private test mail server (testing add-on)

For a test install that several testers use, turn on the testing add-on right after section 4:

```bash
./deploy/testing/enable.sh 5      # 5 tester mailboxes
```

It adds, on the same server:
- a **private test mail server** for `@foxalora.test` mailboxes (a reserved name that can never be real). It has no ports open to the internet: only Foxalora can reach it, over TLS with a certificate from a private CA that may only sign `foxalora.test` names (its key is deleted after use);
- **Mailpit** at `https://<domain>/mailpit/`, which catches mail sent to any outside address. Nothing reaches the internet;
- a **shared password gate** (HTTP basic auth) in front of the whole site, so only people with the gate login can reach it. The gate credentials are removed before requests reach the API.

It prints the gate login and the mailbox passwords. Then send testers `docs/runbooks/testing.md` with their mailbox and the gate login. You do not need to map any other mail server.

| Task | Command |
|---|---|
| Add a tester mailbox | `./deploy/testing/tester.sh add <name>` |
| New mailbox password | `./deploy/testing/tester.sh password <name>` |
| Remove a mailbox (and its mail) | `./deploy/testing/tester.sh remove <name>` |
| List mailboxes | `./deploy/testing/tester.sh list` |
| Add or change a gate login | `./deploy/testing/gate.sh set <user>` |
| Remove a gate login | `./deploy/testing/gate.sh remove <user>` |

Without the add-on, keep a test install private another way: allow only your own IP on ports 80/443 in the cloud firewall (open 80 to all while Let's Encrypt issues or renews), or put it behind Cloudflare Tunnel with Cloudflare Access.

## Stopgap: run on your own machine with a Cloudflare quick tunnel

Before a server exists, `./deploy/testing/quick-tunnel.sh up` runs the same stack on the current machine with plain `docker` (no Compose needed), maps Gmail, turns on the password gate and publishes it at a random `https://<name>.trycloudflare.com` link. The machine must stay on, and the link changes whenever the tunnel restarts. `./deploy/testing/quick-tunnel.sh down` stops it (database kept). Nginx trusts the visitor address Cloudflare sends (`CF-Connecting-IP`) only from the private Docker network, so login throttling stays per visitor.

## 6. Day-to-day

| Task | Command (from `/opt/foxalora`) |
|---|---|
| Status | `./deploy/compose.sh ps` |
| API logs | `./deploy/compose.sh logs -f api` |
| Update | `git pull && ./deploy/install.sh webmail.yourdomain.com` (rebuilds, migrates, keeps data and the add-on) |
| Stop | `./deploy/compose.sh down` (data is kept) |
| Back up | `deploy/.env`, and `./deploy/compose.sh exec -T postgres pg_dump -U foxalora foxalora > backup.sql` |

`deploy/compose.sh` is `docker compose` with the right files for this install (it includes the testing add-on when it is on).

What is stored: PostgreSQL holds tenants, mail server settings, contacts, preferences, signatures and audit events, never mail or mailbox passwords. Valkey holds encrypted sessions in memory only; restarting it signs users out.

## 7. Tested so far (2026-11-16 to 2026-11-18)

On a development machine with plain `docker` (no Compose plugin there), the same images and settings as `docker-compose.prod.yml`: images build; migrations run as the schema owner; the API runs read-only as the least-privilege role; the CLI creates a tenant and refuses `none-dev-only`; Nginx serves HTTPS with HSTS, CSP and `nosniff`, redirects HTTP to the configured domain only, rejects TLS 1.1 and unknown host names; login failures are generic; the cookie is `HttpOnly; Secure; SameSite=Strict`; a request without the CSRF header gets 403; send and receive work and the copy is saved to Sent; no password or session id appears in any container log.

Testing add-on, same way: certificates and gate login created by `enable.sh`; test mail server healthy with mailboxes created through `setup`; Foxalora connects to it over verified TLS; the CA's name constraint makes Node and OpenSSL reject a certificate for any other name; the site, API and Mailpit answer 401 without the gate login and work with it; ACME challenges on port 80 are not gated; tester-to-tester mail is delivered and saved to Sent; outside mail lands in Mailpit; the gate password, mailbox passwords and session ids never appear in the API log.

Setup wizard (2026-11-16), on a fresh production-mode stack with plain `docker` and an empty database, driven in headless Chrome: all six checks green; 404 without or with a wrong token; the connection test refused 127.0.0.1 and 10.1.2.3 (SSRF) with a plain explanation and passed against imap.gmail.com:993 and smtp.gmail.com:465 (TLS and certificate, no login); finishing created the tenant, the owner (scrypt hash), the server, the domain and audit entries; afterwards every setup route returned 404 and the page showed "Setup is not available"; no password or token in the API log; phone layout checked.

Fresh-server install (2026-11-17), following sections 2 to 4a on a clean Ubuntu 24.04 machine (a privileged container with its own Docker data disk, so Docker runs as on a real server, but no systemd and no public DNS): `get.docker.com` installed Docker with Compose 98 s after start; `./deploy/install.sh webmail.foxalora.test --self-signed` generated the secrets and certificate, built both images, ran migrations, waited for a healthy API and printed the setup link; **bare machine to setup link: 178 s**. The wizard, opened at the real host name, showed all six checks green, the connection test first failed SMTP with "same server" ticked and offered smtp.gmail.com, then passed both; finishing saved tenant, owner, server (with "saves sent mail itself"), domain and audit, and the setup routes then answered 404. HTTP redirects to HTTPS, an unknown host name is refused, a Gmail login with a wrong password reaches Gmail and gets the generic failure; no admin password, setup token or mailbox password in the API log. `install.sh` needs a host name with a dot (`localhost` is refused).

Real server on the internet (2026-11-18), AceCloud Mumbai, 1 vCPU / 4 GB, NVMe High IOPS disk, Ubuntu 26.04, Cloudflare DNS (DNS only), Zoho Mail: Docker installed in 62 s; Let's Encrypt certificate issued (without an email address, the command `--letsencrypt` alone now runs); `install.sh` built, migrated and printed the setup link; **bare server to setup link about 6.5 minutes**. The wizard's connection test against `imappro.zoho.in:993` and `smtppro.zoho.in:465` with a real mailbox first failed IMAP (Zoho had IMAP off for the mailbox) while SMTP signed in, then passed both once IMAP Access was on. Sign-in, receiving mail from Gmail, sending to Gmail and the sent copy in Sent all worked. A second employee's sign-in failed with `imap_auth:ALERT` for the same Zoho reason. Renewal: `renew-cert.sh` as root, and a Let's Encrypt `renew --dry-run` through the running Nginx succeeded; in a normal user's crontab it failed (root-owned certificate folder), now documented. A first attempt on a server with "NVME General purpose" storage stalled at `apt-get update` with the disk 99% busy and the server stopped answering. Automatic deploys from GitHub (`auto-deploy.md`) deployed a commit in about 1 minute, keeping PostgreSQL and Valkey running.

Separate render origin (FOX-045, 2026-11-23), on the dev stack: 11 new backend tests (one-time and expiring links, content stored encrypted under a hash of the token, strict policy, no cookies, each host serves only its own routes) and a headless-Chrome check, `node dev/checks/render-isolation.mjs`, against the real app: the frame loads from the other origin in its own browser process, has an opaque origin, and code running inside it cannot read cookies, localStorage, sessionStorage, IndexedDB, the parent page or its storage (all SecurityError); the link works once; no cookie is set for the render host (15/15 checks). The Nginx template was checked with `nginx -t` in the production image with and without a render domain.

Not yet tested: `enable.sh`, `tester.sh` and `gate.sh` with `docker compose` end to end, an ARM64 build, a real certificate renewal at expiry (only the dry run), a cPanel or Plesk mail server.
