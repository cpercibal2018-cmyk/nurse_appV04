# HTTPS browser test of the session cookies (B-03)

The backend tests prove the server rotates refresh tokens, rejects a replayed one and revokes sessions. They cannot prove what a **browser** does with the cookies over **HTTPS**. This test does: a real Chromium signs in to the three release images running exactly as in production, behind TLS.

```bash
ops/e2e/run.sh            # builds nurseapp/{api,migrate,web}:e2e, runs the test, removes everything
TAG=ci ops/e2e/run.sh     # uses images already built with that tag (CI)
```

Needs Docker with Compose, Node 22 and `openssl`. The first run installs Playwright in `ops/e2e/node_modules`; the browser comes from `npx playwright install chromium` (CI) or an existing Playwright browser directory. Behind a TLS-inspecting proxy, pass its CA to the image builds with `BUILD_CA=/path/to/ca.pem`. It takes about a minute after the images are built. Nothing stays running and no port is opened beyond `127.0.0.1:8443` and `127.0.0.1:8081` during the run.

## What runs

| Service | Image | As in production? |
| :--- | :--- | :--- |
| `db` | `postgres:15-alpine`, data in memory | Fresh installation order from [ops/db](../db/README.md): roles, passwords, grants |
| `migrate` | `nurseapp/migrate` | Yes — `prisma migrate deploy` as `nurseapp_migration` |
| `grants` | `postgres:15-alpine` | Yes — `02_grants.sql` again, then `verify.sql`: every check must PASS or the run stops |
| `bootstrap` | `nurseapp/api` | The first administrators, as the runtime role (the CLI itself only reads a terminal) |
| `api` | `nurseapp/api` | Yes — `NODE_ENV=production`, runtime role, read-only root, `TRUST_PROXY`, KSA residency, ClamAV configured. Two differences: `ACCESS_TOKEN_TTL_SECONDS=20` so an expiry happens during the test, and no jobs or ClamAV container (nothing is uploaded) |
| `web` | `nurseapp/web` | Yes — the release nginx configuration |
| `tls` | `nginx:1.28-alpine` | Stands in for the load balancer: TLS with a throwaway self-signed certificate for `nurse.e2e.test`, client address in `X-Client-Ip`. It also opens a **test-only** plain-HTTP port so the test can show the cookies are never sent without TLS |

Passwords, the JWT key, the MFA, document and PDPL keys and the certificate are generated for each run and deleted afterwards.

## What it checks ([`https-session.test.mjs`](https-session.test.mjs))

| # | Check | Spec |
| :--- | :--- | :--- |
| 1 | The site answers over HTTPS with HSTS, CSP and `X-Frame-Options: DENY` | §3.4 |
| 2 | The HR account gets **no session from its password alone**: it must set up an authenticator (the test reads the key, computes the codes like an app, and sees ten recovery codes) — spec §3.5, D-51. After sign-in the refresh cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, path `/api/v1/auth`; the CSRF cookie is `Secure` and readable by the app; page scripts cannot see the refresh cookie; no access token in `localStorage` / `sessionStorage` | §3.3, §3.4 |
| 3 | A page reload keeps the user signed in and rotates the refresh cookie | §3.3 |
| 4 | Over plain HTTP the browser sends neither cookie; over HTTPS it does (a probe the server refuses, so nothing is consumed) | §3.4 |
| 5 | When the access token expires while the app is in use, the next request renews it silently and the refresh cookie rotates again | §3.3, §3.4 |
| 6 | Replaying an already-used refresh cookie gets 401 and ends the whole session: the browser's current cookie stops working and the next reload lands on the sign-in page | §3.3 "replay is rejected" |
| 7 | Signing in again takes the password and a fresh authenticator code. Sign-out clears both cookies; a reload stays on the sign-in page; the pre-sign-out refresh cookie gets 401 | §3.4 |

CI runs it in the `images` job on every pull request ([ci.yml](../../.github/workflows/ci.yml)).
