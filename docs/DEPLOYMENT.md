# Contacts Hub Deployment

Contacts Hub can run as a static local inspection interface or as an authenticated PHP application with persistent contact libraries. Static mode opens local files and keeps changes in the browser session. Hosted mode adds catalogue discovery, guarded reads, exact backups and revision-checked VCF writes.

---

## Requirements

Hosted deployment requires:

- 64-bit PHP 8.2 or later;
- a web server capable of serving the files under `public/` and executing its PHP endpoints;
- four existing storage directories with the access described below;
- HTTPS when `secure_cookie` is enabled;
- a modern browser with JavaScript modules, module workers, `TextEncoder`, `TextDecoder`, `Blob`, `File`, `dialog` and `localStorage`.

Development and verification tools require Node.js 22 or later (`package.json`, `engines`). Browser gates additionally require Playwright and Chromium, installed locally or supplied through the external tools route described below.

---

## Local Static Inspection

Install no packages. Start the repository's static server:

```bash
npm start
```

Open `http://127.0.0.1:8080/`. Set `PORT` to choose another port:

```bash
PORT=9000 npm start
```

The static server binds to `127.0.0.1`, serves `GET` and `HEAD` from `public/`, refuses dotfiles, path traversal and PHP files, and never executes a service endpoint (`tools/serve.mjs`, `staticServer()`). Its MIME allow-list omits WOFF2, so this inspection route uses the CSS system-font fallbacks. Use **Open a source** to select local VCF or CSV files. Original files remain untouched. Download an edited or converted VCF before closing the workspace.

This mode is suitable for interface inspection and session-only local work. It does not provide persistent writes, server authentication or backups.

---

## Development PHP Layout

The source tree already matches one supported service layout:

```text
contacts-hub/
├── public/                 # Web document root
├── server/
│   ├── common.php
│   ├── config.example.php
│   └── config.php          # Private, create locally and never commit
├── sources/                # Contact libraries
└── var/
    ├── backups/
    ├── locks/
    └── sessions/
```

Create storage and private configuration:

```bash
mkdir -p sources var/backups var/locks var/sessions
chmod 700 sources var var/backups var/locks var/sessions
cp server/config.example.php server/config.php
```

Edit `server/config.php` according to [CONFIGURATION.md](CONFIGURATION.md). Generate `app_key` and the password hash before starting the service.

Run PHP with `public/` as the document root:

```bash
php -S 127.0.0.1:8000 -t public
```

For plain loopback HTTP, set `secure_cookie` to `false` in the private development configuration. Restore `true` for HTTPS deployment.

---

## Hosted Layouts

### Separated public and private directories

The preferred layout serves only `public/` and keeps the service and mutable data outside the document root:

```text
private-application/
├── server/
│   ├── common.php
│   ├── config.example.php
│   └── config.php
├── sources/
└── var/
    ├── backups/
    ├── locks/
    └── sessions/

public-document-root/
├── .htaccess                # Apache access and response rules
├── assets/
│   ├── .htaccess            # Revalidate static assets
│   ├── fonts/               # Inter, JetBrains Mono and OFL texts
│   ├── app.css
│   └── nexus.svg
├── js/
│   ├── .htaccess            # Revalidate modules
│   ├── core/                # Parser and contact engine
│   ├── ui/                  # Interface modules
│   ├── adapters.js
│   ├── app.js
│   ├── client.js
│   └── worker.js
├── bootstrap.php
├── config.js
├── index.html
├── read.php
├── robots.txt
├── scan.php
├── session.php
└── write.php
```

Set `NEXUS_PRIVATE_PATH` to the private `server/` directory. `public/bootstrap.php` loads `common.php` from that path before checking the two bundled fallback locations.

### Site-root libraries

Some shared hosts require contact exports beside the deployed application. `contacts_root` may point at the public site root. On Apache, the shipped `public/.htaccess` denies direct requests for `.vcf` and `.csv` files. Another web server must apply an equivalent deny rule or authentication that protects direct library paths. Backups, locks and sessions still must remain outside the document root (`server/common.php`, `nexus_config()`; `public/.htaccess`).

The PHP gate verifies this layout with VCF and CSV libraries beside the application and the three service-state directories outside it (`tests/php_gate.mjs`).

---

## Authentication

Choose one mode in `server/config.php`.

### Password mode

Set `auth_mode` to `password`, generate `app_key`, and store a PHP password hash in `password_hash`. The application presents its own sign-in request and stores authentication in its private file-backed session directory.

Password attempts are limited to ten per client-address HMAC in a 15-minute window. The state table contains HMACs rather than plain client addresses and is capped at 5,000 entries (`server/common.php`, `nexus_rate_attempt()`).

### Web-server mode

Set `auth_mode` to `remote_user` and configure the web server or upstream access layer to provide a non-empty `REMOTE_USER` only after authentication. The application trusts that value. Closing the Contacts Hub session does not sign out of the upstream service (`server/common.php`, `nexus_authenticated()` and `nexus_logout()`).

---

## Permissions and Public Reachability

The PHP process needs:

- read and write access to `contacts_root`;
- write access to `backups_root`, `locks_root` and `sessions_root`;
- permission to create owner-only files and same-filesystem temporary files inside `contacts_root`;
- permission to rename a temporary file over an existing VCF.

The four configured roots must be distinct and non-nested. Backups, locks, sessions and `server/config.php` must never be reachable over HTTP. `tools/check.mjs` also requires `server/config.php`, `sources/` content and `var/` content to be absent from the repository.

The application may be mounted below a site path. Session cookies derive their path from the endpoint's script directory (`server/common.php`, `nexus_start_session()`). Keep all public files together so relative JavaScript, CSS, endpoint and font paths continue to resolve.

---

## Web-Server Headers

`public/index.html` supplies a self-only Content Security Policy through a meta element. PHP responses add private no-store caching, MIME sniffing protection, no-referrer policy, frame denial and robot exclusion (`server/common.php`).

Apache deployments can use the shipped `public/.htaccess`, which disables indexes, blocks direct requests for library and service-state extensions, and adds response protections. `server/.htaccess` denies HTTP access to the private service. The dotfiles under `public/js/` and `public/assets/` require browser revalidation after an update. Other web servers need equivalent rules. Preserve same-origin access for `session.php`, `scan.php`, `read.php`, `write.php`, the module worker and bundled fonts.

`robots.txt` and robot metadata ask compliant crawlers to stay away. They are visibility controls, not authentication.

---

## Contact Library Placement

The catalogue accepts regular non-symbolic-link files whose plain names:

- contain 1 to 180 UTF-16 code units and at most 540 UTF-8 bytes;
- do not begin with a dot or contain path separators, control characters or reserved filename characters;
- have no surrounding whitespace;
- end in `.vcf` or `.csv`, case-insensitively.

Names differing only by letter case make the catalogue fail with HTTP 409. Unsupported, hidden, linked or non-regular VCF and CSV entries are counted as ignored and omitted (`server/common.php`, `nexus_valid_name()`; `public/scan.php`).

Writes create or replace VCF files only. CSV files remain original read-only sources and require explicit conversion or selected-row import into a VCF (`public/write.php`; `public/js/core/engine.js`, `convertLibrary()` and `planChange()`).

---

## Verification Before Service

Run the dependency-free gates available on the deployment machine:

```bash
npm test
npm run check
npm run test:php
```

`npm run check` reports whether PHP lint ran. A passing result with `phpExecuted: false` proves the JavaScript and repository checks only; run the PHP gate on a machine with PHP 8.2 or later.

Where externally installed browser tools are available:

```bash
NEXUS_BROWSER_TOOLS=/path/to/browser-tools \
NEXUS_CHROMIUM=/path/to/chromium \
npm run test:browser

NEXUS_BROWSER_TOOLS=/path/to/browser-tools \
NEXUS_CHROMIUM=/path/to/chromium \
npm run test:performance
```

`NEXUS_CHROMIUM` is optional when Playwright can find its own executable. Keep those dependencies outside this repository.

---

## Deployment Verification

After deployment:

1. Request `session.php` without a session and confirm that it returns JSON rather than configuration or filesystem detail.
2. Confirm that an unauthenticated `scan.php` request returns HTTP 401.
3. Sign in through the chosen authentication mode.
4. Confirm that the catalogue lists only intended VCF and CSV libraries.
5. Open one VCF and one CSV, inspect source diagnostics, and confirm that CSV editing stays disabled.
6. Create a disposable VCF or make a reversible VCF edit. Confirm that the interface reports a verified save and that an exact backup appears in the private backup directory.
7. Confirm that a stale browser tab receives a conflict after another writer changes the same source.
8. Confirm that backup, lock, session and configuration paths return no public content.
9. Confirm that direct contact-file requests are blocked whenever `contacts_root` is public.
10. Confirm that logout removes application password authority. In remote-user mode, confirm separately that upstream logout works as intended.

Use non-sensitive test data for deployment acceptance. Do not expose a real contact library merely to prove the route.

---

## Updating an Installation

1. Back up the current public files, private service files, `server/config.php`, contact libraries and private backup directory.
2. Put the application into a maintenance state that prevents writes.
3. Replace `public/`, `server/.htaccess`, `server/common.php` and `server/config.example.php` with the new release files.
4. Compare `server/config.example.php` with the private `server/config.php` and add any new required setting. Keep existing secrets and deployment-owned paths private.
5. Run the repository gates against the release files.
6. Restore service and complete the deployment verification sequence above.

Contact libraries, `server/config.php`, backups, locks and sessions are deployment state. Do not overwrite them with repository copies.

---

## Backup Retention and Recovery

Each changed existing VCF receives an exact byte-for-byte backup before publication. Backup filenames contain a UTC timestamp, a hash fragment of the library name, a fragment of the previous revision and random bytes. They deliberately do not expose the plain library filename (`server/common.php`, `nexus_backup()`).

Retention is manual. Archive or remove backups under deployment policy before `max_backup_bytes` or `max_backup_files` is reached. A full quota refuses the next write with HTTP 507.

Recovery is an operator action:

1. stop writes to the affected library;
2. identify the intended backup using its timestamp and revision evidence;
3. preserve the current source separately;
4. restore the selected bytes under the original plain VCF filename;
5. reopen the library and inspect its revision, count and diagnostics.

The application does not expose a backup restore button and never deletes retained backups automatically.

---

<div align="center">
<br>

**_Architected by Nauman Shahid_**

<br>

[![Portfolio](https://img.shields.io/badge/Portfolio-nauman.cc-000000?style=for-the-badge&logo=googlechrome&logoColor=white)](https://www.nauman.cc)
[![GitHub](https://img.shields.io/badge/GitHub-nshah1d-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/nshah1d)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/nshah1d/)

</div>
<br>

Licensed under the [MIT Licence](../LICENSE). Bundled Inter and JetBrains Mono fonts are licensed under the SIL Open Font License 1.1: [Inter licence](../public/assets/fonts/Inter-LICENSE.txt) and [JetBrains Mono licence](../public/assets/fonts/JetBrainsMono-LICENSE.txt).
