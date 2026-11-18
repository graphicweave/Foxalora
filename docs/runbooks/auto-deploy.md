# Automatic deploys to the test server

Every push to `dev` runs CI. When CI passes, the **Deploy** workflow (`.github/workflows/deploy.yml`) logs in to the test server and runs `deploy/update.sh` for that exact commit: fetch, check the commit is on `dev`, rebuild, migrate, restart. Data, `deploy/.env` and certificates are kept. A failed CI run deploys nothing.

Anyone who can push to `dev` can change what runs on the server (the installer runs as a user in the `docker` group, which is root-equivalent). Keep push access to `dev` to trusted people, and use branch protection if the team grows.

## One-time setup

### 1. Server: make the install a git checkout

On the server, in an install made with `deploy/install.sh` (keeps `deploy/.env`, certificates and data):

```bash
cd /opt/foxalora
git init -q && git remote add origin https://github.com/graphicweave/Foxalora.git
git fetch -q origin dev && git reset -q --hard origin/dev
git status --short     # should print nothing (secrets and certificates are gitignored)
```

### 2. Deploy key that may only run the update script

On your own machine:

```bash
ssh-keygen -t ed25519 -N '' -C foxalora-deploy -f foxalora-deploy
```

On the server, add the **public** key to `~/.ssh/authorized_keys` with a forced command, so it cannot open a shell or forward ports:

```
command="/opt/foxalora/deploy/update.sh",restrict ssh-ed25519 AAAA... foxalora-deploy
```

Test it from your machine; it should deploy the current `dev` commit:

```bash
ssh -i foxalora-deploy ubuntu@<server-ip> "$(git rev-parse origin/dev)"
```

### 3. GitHub settings

Repository → **Settings → Environments → New environment** `test-server` (optionally restrict it to the `dev` branch). In that environment add:

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_SSH_KEY` | contents of the private key file `foxalora-deploy` |
| Secret | `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <server-ip>` (check the fingerprint against the server) |
| Variable | `DEPLOY_HOST` | server IP or host name |
| Variable | `DEPLOY_USER` | `ubuntu` |
| Variable | `DEPLOY_URL` | `https://webmail.yourdomain.com` |

Then delete the private key file from your machine (or keep it in a password manager).

## Day-to-day

- See deploys: repository → **Actions → Deploy**. Each run shows the commit and the installer output.
- Deploy by hand (same thing the workflow does): `./deploy/update.sh <commit id>` on the server.
- Roll back: `git revert` the bad commit and push; the revert is deployed like any other commit.
- Stop automatic deploys: disable the Deploy workflow in the Actions tab, or remove the key line from `authorized_keys`.
- A deploy restarts the containers: expect a few seconds of downtime, and users stay signed in only if Valkey keeps running (it does unless its image changed).
