# Contacts Hub Security

Contacts Hub is designed for a private, owner-controlled deployment. The browser can also open local files without a server, keeping source content and session changes on the device until download.

This document describes controls implemented by the repository. Web-server policy, operating-system access, TLS, backups outside the application and account security remain deployment responsibilities.

---

## Threat Model

The protected assets are contact-library contents, source integrity, private configuration, password material, application sessions, backups and change evidence.

The relevant hostile or accidental actions are:

- unauthenticated discovery or reading of contact libraries;
- cross-site or forged state changes;
- stale, concurrent or partial writes;
- path traversal, symbolic-link substitution and unsupported file types;
- malformed or oversized source data exhausting the browser or service;
- contact values becoming executable HTML, URLs or spreadsheet formulae;
- a parser discarding data it does not understand;
- private paths, configuration or contact data appearing in error responses or the repository.

The application does not defend against a compromised host, browser, PHP process, upstream authentication service or authorised account. It also cannot make a public contact directory private. Deploy behind authentication and TLS, with private service-state directories outside the document root.

---

## Trust Boundaries

### Browser boundary

Opened contact text is untrusted input. Parsing runs in a module worker and is bounded by byte, contact, property, field, column, diagnostic and grouping limits (`public/js/core/primitives.js`, `LIMITS`; `public/js/worker.js`). The interface builds contact content with text nodes or `textContent`, never HTML construction (`public/js/ui/dom.js`, `el()`).

The browser holds opened libraries, CSRF state and change receipts in memory. Optional `localStorage` preferences contain only theme, the remember flag and hashed bookmarks for favourites and My Card (`public/js/app.js`, `preferences()` and `storePreferences()`).

### HTTP boundary

`PHPAdapter` uses same-origin credentials, disables request caching and aborts a request after 45 seconds. State-changing requests carry the session CSRF token (`public/js/adapters.js`, `PHPAdapter.request()` and `save()`).

`public/index.html` restricts scripts, styles, fonts, connections and workers to the same origin. Images are limited to the same origin, blobs and data URLs. Objects are disabled, the base URI is self-only and forms may submit only to the same origin.

### Filesystem boundary

The PHP service resolves four configured directories: contacts, backups, locks and sessions. All must exist, be regular directories rather than links, be separate and remain outside one another. Backups, locks and sessions must stay outside the document root (`server/common.php`, `nexus_config()`).

The contacts root may be the site root only when the web server protects direct library requests. That deployment transfers direct-read protection to the host configuration.

---

## Authentication and Sessions

Two authentication modes are implemented (`server/config.example.php`; `server/common.php`, `nexus_authenticated()`):

- `password`: PHP verifies a private `password_hash` and binds the authenticated session to that hash's SHA-256 revision. Replacing the hash signs existing sessions out.
- `remote_user`: the service trusts a non-empty `REMOTE_USER` supplied by the web server or upstream authentication layer.

Sessions are stored in the private `sessions_root`. Strict cookie mode and cookie-only sessions are enabled; URL session identifiers are disabled. The session cookie is scoped to the application path, HttpOnly and SameSite Strict. The `secure_cookie` configuration controls the Secure attribute (`server/common.php`, `nexus_start_session()`).

The default session limits are one hour idle and twelve hours absolute. Expiry clears the session and regenerates its identifier. Successful password login also regenerates the identifier and creates a fresh CSRF token.

Password attempts are limited to ten per client address in a 15-minute window. The address is stored only as an HMAC keyed by `app_key`, expired windows are removed, and the table refuses new addresses at 5,000 entries (`server/common.php`, `nexus_rate_attempt()`). A correct password attempt still consumes one slot; the limiter is an attempt counter, not a failed-attempt counter.

---

## Request Protection

Every endpoint enforces its HTTP method. Authenticated catalogue and read requests require an active session. Writes and login or logout actions require the session CSRF token in `X-Nexus-CSRF` (`server/common.php`, `nexus_method()`, `nexus_run()` and `nexus_require_csrf()`; `public/session.php`).

State changes are rejected when Fetch Metadata declares a cross-site request. When an `Origin` header is present, it must exactly match the request scheme and host after a trailing slash is removed (`server/common.php`, `nexus_require_csrf()`).

JSON inputs are length-bounded before decoding. Login bodies are capped at 4 KiB by `nexus_read_json_body()`. Write bodies are capped by `max_request_bytes`, with a 64 MiB default (`server/common.php`, `nexus_read_json_body()`; `public/write.php`).

All PHP responses carry:

- `Cache-Control: private, no-store, max-age=0, no-transform`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- `X-Frame-Options: DENY`;
- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`.

PHP warning display is disabled and warnings become exceptions. Unexpected errors log only the exception class and return a generic response, so filesystem paths, configuration and contact data do not enter the client error body (`server/common.php`).

---

## File and Path Handling

Library names must be plain VCF or CSV filenames. `nexus_valid_name()` rejects empty or oversized names, leading dots, surrounding whitespace, path separators, control characters and reserved filename characters. The browser applies the matching contract through `safeFilename()` (`server/common.php`; `public/js/core/primitives.js`).

Catalogue enumeration includes supported regular files only. Symbolic links, special files and invalid names are ignored. Two filenames differing only by letter case stop the catalogue with HTTP 409 because they would collide on a case-insensitive filesystem (`public/scan.php`).

`nexus_read_source()` refuses symbolic links and non-regular files, opens the target read-only, enforces the source limit, and compares device, inode, size, modification time and change time across the handle and named path before and after reading. A replacement or modification during the read returns HTTP 409 (`server/common.php`, `nexus_read_source()`).

The static development server resolves paths beneath `public/`, refuses dot-prefixed segments, backslashes, NUL, traversal and PHP, and serves only a fixed extension allow-list (`tools/serve.mjs`, `staticServer()`).

Apache deployments can use `public/.htaccess` to disable indexes, deny direct requests for VCF, CSV, backup, lock, temporary and environment files, and set response protections. `server/.htaccess` denies all HTTP access to the private service. Equivalent controls are required on other web servers.

---

## Write Integrity

Persistent writes accept VCF targets only. The request must contain `action: "save"`, a valid plain VCF filename, string content and a `baseRevision` that is either null for creation or a 64-character lower-case SHA-256 revision (`public/write.php`).

The complete VCF is validated before a lock is taken. It must be valid UTF-8 without NUL bytes, remain within the source limit, contain closed non-nested cards, declare exactly one VCF 3.0 or 4.0 version per card, stay within 2,048 properties and 1 MiB per card, and remain within the configured contact count (`server/common.php`, `nexus_validate_vcf()`).

Each library uses an advisory lock whose filename is a SHA-256 hash of the lock key. Lock acquisition retries every 25 ms until `lock_timeout_seconds` expires, then returns HTTP 423 (`server/common.php`, `nexus_lock()`). Advisory locks coordinate this application. An unrelated external writer can bypass them.

Under the exclusive lock, the endpoint:

1. reads the current source through the guarded read path;
2. compares its SHA-256 revision with `baseRevision`;
3. rejects case-colliding creation names;
4. returns immediately when the proposed bytes already match;
5. writes an exact backup of an existing source;
6. creates an owner-only temporary file in the contacts root and flushes it;
7. rechecks the target revision;
8. publishes through same-filesystem rename;
9. reads the published source back and compares its revision with the proposal.

These steps live in `public/write.php`, with file creation and backup enforcement in `server/common.php`, `nexus_write_new()` and `nexus_backup()`.

The browser performs another read-back through the active adapter. Only matching bytes are reopened in the engine. A lost HTTP response can therefore recover as a verified save; failed read-back or different bytes return an unresolved result and block more edits until reload (`public/js/adapters.js`, `commitPlan()`; `public/js/app.js`, `previewPlan()`).

---

## Backups and Retention

Every changed existing VCF receives an exact backup before publication. The file is mode `0600` and flushed before the write continues. Backup filenames contain a UTC timestamp, fragments derived from the library name and old revision, and random bytes; the plain source name is not exposed (`server/common.php`, `nexus_backup()` and `nexus_write_new()`).

The service counts every entry in `backups_root`. A link or non-regular entry makes the backup directory invalid. When `max_backup_files` or `max_backup_bytes` would be exceeded, the write stops with HTTP 507. No automatic pruning occurs.

Backups protect the immediately prior bytes of application writes. They are not a substitute for off-host backups, versioned storage or a tested recovery policy.

---

## Source Preservation

The VCF parser retains raw cards, offsets, original property text and unknown fields. A card becomes read-only when interpretation is incomplete. Ordinary edits rewrite only named supported properties and splice them into the original card (`public/js/core/vcard.js`, `parseVCard()` and `patchCard()`).

CSV is always read-only. Conversion creates a new VCF and records source-row evidence. Selective import requires explicit row selection and retains source filename, source revision, record number, line range and record hash. Shared phone or email values never cause an automatic merge or dropped row (`public/js/core/engine.js`, `convertLibrary()` and `planChange()`).

Evidence exports include complete contact data and the original source. Treat them as sensitive copies. The inspection CLI requires `--include-content` before writing an evidence, table or original export and refuses an existing output (`tools/nexus.mjs`; `tools/io.mjs`, `writeNew()`).

---

## Browser Content Safety

Contact content reaches the DOM as text nodes. The static gate rejects `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and the `Function` constructor in browser JavaScript (`tools/check.mjs`; `public/js/ui/dom.js`, `el()`).

Stored URLs become links only when they use HTTP or HTTPS and contain no embedded username or password (`public/js/core/primitives.js`, `safeURL()`). Telephone, email and WhatsApp actions require validated contact values (`public/js/app.js`, `externalValue()`).

Photo preview accepts embedded PNG or JPEG data only, with a 512 KiB byte ceiling and dimensions no larger than 2,048 pixels. Dimensions are read before browser decoding. Remote photos, SVG and unsupported formats remain in the source but are not fetched or rendered (`public/js/ui/photo.js`, `embeddedPhoto()`).

Inspection CSV cells beginning with spreadsheet formula characters, including after leading controls or whitespace, receive an apostrophe prefix (`public/js/core/primitives.js`, `csvCell()`).

---

## Privacy and Data Sovereignty

Local mode opens files through the browser's file input. Contact content is not uploaded by the application, and original device files are never overwritten. Download session edits before closing the workspace (`public/js/adapters.js`, `FileAdapter` and `MemoryAdapter`).

Server mode sends contact data only between the browser and the configured same-origin PHP service. The shipped HTML loads scripts, styles and fonts locally. No analytics or telemetry path exists in the shipped code (`public/index.html`; `public/assets/app.css`; `tools/check.mjs`).

Opened contact data remains in browser and worker memory until the workspace closes, the page is discarded or the browser releases it. Downloaded VCF, CSV, JSON and SQLite files leave the application's custody and inherit the security of their destination.

---

## Known Limits and Residual Risks

- `remote_user` mode is only as strong as the web server or upstream authentication that sets `REMOTE_USER`.
- `secure_cookie: false` permits session cookies over plain HTTP and is suitable only for controlled loopback development.
- An authenticated malicious user can read the configured contact libraries and propose changes within application limits.
- Advisory locks do not control unrelated external writers. Revision checks catch many races, while a writer that changes bytes and restores matching observed metadata can sit outside the intended contract.
- Same-filesystem rename provides atomic replacement on supported filesystems. Filesystem, storage or host failure after rename can still create an uncertain result; the service reports that uncertainty and retains the prior backup where backup creation succeeded.
- Backup retention is finite and manually managed. A full quota stops writes.
- The 200-entry diagnostic array is a display sample. `issueCount` carries the complete count.
- Shared-detail groups are review candidates. Common households, switchboards and recycled details can produce legitimate matches.
- Browser extensions, injected scripts, compromised dependencies outside the repository and a compromised host can access data available to that environment.
- Robot exclusions do not prevent access. Authentication and server routing provide the access boundary.

---

## Reporting a Vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting in the repository's Security tab. If that route is unavailable, use the contact route at [nauman.cc](https://www.nauman.cc). Do not open a public issue for an undisclosed vulnerability.

Include the affected file and function, the conditions required, the observed consequence and a minimal reproduction where safe. Keep credentials, live configuration and private data out of the report.

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

Licensed under the [MIT Licence](LICENSE). Bundled Inter and JetBrains Mono fonts are licensed under the SIL Open Font License 1.1: [Inter licence](public/assets/fonts/Inter-LICENSE.txt) and [JetBrains Mono licence](public/assets/fonts/JetBrainsMono-LICENSE.txt).
