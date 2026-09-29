# Contacts Hub

![PHP](https://img.shields.io/badge/PHP-8.2+-777BB4?style=for-the-badge&logo=php&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Zero Dependencies](https://img.shields.io/badge/Runtime_Dependencies-Zero-4FC08D?style=for-the-badge)
![Licence](https://img.shields.io/badge/Licence-MIT_%2B_OFL_1.1-0078D4?style=for-the-badge)

Contacts Hub is a private contact workspace for VCF and CSV libraries. It opens local files directly in the browser or connects to a self-hosted PHP service for authenticated reads, revision-checked writes and exact pre-write backups.

The parser keeps original source text, unknown vCard properties, line ranges and record hashes beside the fields shown in the interface. Ordinary edits patch only the properties that changed. CSV files stay read-only until an explicit VCF conversion or selected-row import, and shared phone or email details remain review signals instead of automatic merges.

---

## What It Does

- Opens several VCF and CSV libraries while keeping each source separate.
- Reads editable vCard 3.0 and 4.0 files. Unsupported or incomplete cards remain visible and block in-place writes.
- Reads comma, semicolon and tab-delimited CSV exports with inferred or explicit column mapping.
- Searches names, organisations, roles, notes, phone numbers, email addresses and addresses with accent-folded literal matching. Compact phone digits and in-order letters within individual short fields provide two additional match paths.
- Flags missing names, missing contact methods, malformed phones or email addresses, and read-only cards.
- Groups records that share a normalised phone number or email address for human review. Records are never merged automatically.
- Adds, edits and deletes VCF contacts through a review step that reparses the complete proposed library before persistence.
- Creates an exact VCF copy or converts a CSV into a new VCF with source-row evidence.
- Imports explicitly selected CSV rows into a writable VCF without dropping same-name or shared-detail records.
- Exports the original source, one vCard, a formula-guarded inspection CSV or complete evidence JSON.
- Keeps local-file changes in the browser session until download. Server mode saves through authentication, CSRF checks, source revisions, advisory locks, backups and independent read-back.
- Uses a module worker and a virtualised list so opened libraries can reach 100,000 contacts while the DOM keeps at most 80 contact rows mounted.
- Provides All contacts, Favourites, Shared details and Needs attention views, with optional search across the current library or every open library.
- Keeps favourites and My Card as hashed browser bookmarks, with automatic My Card discovery available through `MY_NAME`.
- Adds validated quick actions for calling, WhatsApp on international numbers, email and native sharing or VCF download.
- Supports arrow, Home, End, Page Up, Page Down and Enter navigation in the contact list, alphabet jumps, `/` to focus search and Escape to clear it.
- Includes dark and light themes, a three-pane desktop layout and a mobile layout that shows one pane at a time.
- Loads scripts, styles and bundled Inter and JetBrains Mono fonts from the same origin. The application has no runtime package dependencies.

---

## Architecture

The browser is split into the interface, storage adapters, a worker client and a pure contact engine. The engine parses and indexes libraries, answers bounded queries and produces complete proposed files without writing them. Local and PHP adapters share the same commit path, which reads saved bytes back before the worker accepts a new snapshot.

The PHP service handles authentication, sessions, request protection, catalogue discovery, guarded source reads and VCF publication. Mutable service state sits behind explicit private directory boundaries.

Full architecture reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## Requirements

Application runtime:

- a modern browser with JavaScript modules and module workers;
- 64-bit PHP 8.2 or later for persistent server mode;
- HTTPS for hosted use with secure cookies;
- writable private storage for backups, locks and sessions.

Development and verification:

- Node.js 22 or later;
- PHP 8.2 or later for PHP lint and the service gate;
- optional Playwright and Chromium supplied outside the repository for browser and performance gates;
- Python 3 for the optional SQLite evidence snapshot tool.

No `npm install` step is required for the application, unit tests, static gate, PHP gate or Node benchmark. Browser gates resolve Playwright from an external tools directory when the repository has no local package installation.

---

## Quick Start

1. Clone the repository.

   ```bash
   git clone https://github.com/nshah1d/contacts-hub.git
   cd contacts-hub
   ```

2. Create the private storage layout.

   ```text
   contacts-hub/
   ├── public/                 # Web document root
   ├── server/
   │   ├── common.php
   │   ├── config.example.php
   │   └── config.php          # Private, never commit
   ├── sources/                # VCF and CSV libraries
   └── var/
       ├── backups/
       ├── locks/
       └── sessions/
   ```

   ```bash
   mkdir -p sources var/backups var/locks var/sessions
   chmod 700 sources var var/backups var/locks var/sessions
   cp server/config.example.php server/config.php
   ```

3. Generate the private application key and password hash.

   ```bash
   php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
   php -r 'echo password_hash("replace-this-password", PASSWORD_DEFAULT), PHP_EOL;'
   ```

   Replace the quoted password before running the second command. Put the generated key and hash into `server/config.php`. Confirm that its directory paths match the created storage.

4. Add VCF or CSV libraries to `sources/`. Use plain filenames ending in `.vcf` or `.csv`.

5. Start the PHP development service.

   ```bash
   php -S 127.0.0.1:8000 -t public
   ```

   Set `secure_cookie` to `false` only in the private configuration used for this plain-HTTP loopback service.

6. Open `http://127.0.0.1:8000/`, sign in and open a library.

7. Run the standard gates.

   ```bash
   npm test
   npm run check
   npm run test:php
   ```

For session-only local files, run `npm start`, open `http://127.0.0.1:8080/` and choose **Open a source**. The static server does not execute PHP or persist changes to the selected originals.

---

## Directory Layout

```text
contacts-hub/
├── public/
│   ├── .htaccess               # Apache access and response rules
│   ├── assets/
│   │   ├── .htaccess           # Static-asset revalidation
│   │   ├── fonts/              # Bundled fonts and OFL 1.1 texts
│   │   ├── app.css             # Responsive WebOS-style interface
│   │   └── nexus.svg           # Application icon
│   ├── js/
│   │   ├── .htaccess           # Module revalidation
│   │   ├── core/               # VCF, CSV, indexing and change engine
│   │   ├── ui/
│   │   │   ├── about.js        # About credit and external profile links
│   │   │   ├── dom.js          # Safe DOM and download helpers
│   │   │   ├── editor.js       # Contact editor
│   │   │   ├── photo.js        # Bounded embedded-photo preview
│   │   │   └── virtual-list.js # Windowed contact list and navigation
│   │   ├── adapters.js         # Local and PHP storage adapters
│   │   ├── app.js              # Workspace, dialogs, Settings and About coordinator
│   │   ├── client.js           # Worker request client
│   │   └── worker.js           # Contact-engine worker bridge
│   ├── bootstrap.php           # Private service discovery
│   ├── config.js               # Optional My Card name
│   ├── index.html              # Application shell and CSP
│   ├── read.php                # Guarded source read endpoint
│   ├── robots.txt              # Crawler exclusion
│   ├── scan.php                # Guarded source catalogue
│   ├── session.php             # Session status, login and logout
│   └── write.php               # Revision-checked VCF publication
├── server/
│   ├── .htaccess               # Deny HTTP access to the private service
│   ├── common.php              # Authentication, validation, locks and storage
│   └── config.example.php      # Private configuration template
├── tools/                      # Inspection, evidence, SQLite and verification tools
├── tests/                      # Unit, PHP, browser and performance gates
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CONFIGURATION.md
│   └── DEPLOYMENT.md
├── LICENSE
├── README.md
├── SECURITY.md
└── package.json
```

---

## Supported Inputs and Outputs

VCF reading retains cards from any declared version, while in-place editing requires a complete VCF 3.0 or 4.0 interpretation. Space or tab folding, quoted-printable legacy values, structured names and addresses, grouped labels, custom properties and unknown vendor fields are retained. Embedded PNG and JPEG photos can be previewed within strict limits; remote and SVG photos remain source data without being rendered.

CSV parsing follows quoted RFC 4180 fields with comma, semicolon or tab delimiters. Common contact-export headings are inferred, numbered contact-method columns are recognised, and explicit mapping can replace inference. Malformed rows remain diagnostic evidence and prevent conversion where source interpretation is incomplete.

Output paths include original source download, single-card VCF, inspection CSV, complete evidence JSON and a verified SQLite snapshot built by `tools/sqlite.py`. Content-bearing CLI export is explicit and never overwrites an existing output.

---

## Configuration

`public/config.js` contains the optional `MY_NAME` display-name hint. Server mode uses a private `server/config.php` copied from the example. It selects password or `REMOTE_USER` authentication, session lifetime, secure-cookie behaviour, four storage roots and all service limits.

Full configuration reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

---

## Deployment

Local static mode uses the repository's Node server and local file selection. Persistent deployment serves `public/` through PHP, keeps `server/config.php` private and places backup, lock and session directories outside the document root. Contact libraries may also stay private. For a site-root contact directory, Apache can use the shipped `public/.htaccess` to block direct `.vcf` and `.csv` requests; another web server needs an equivalent deny rule or authentication that protects direct library paths.

Full deployment reference: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## Security

Server mode uses file-backed authenticated sessions, CSRF tokens, same-origin checks, strict filename validation, guarded regular-file reads, revision conflicts, advisory locks, exact backups, owner-only temporary files and post-write verification. Contact content renders as text, outbound URLs are scheme-checked, remote photos stay unloaded and CSV output guards spreadsheet formula prefixes.

Local mode sends no contact data to an application server. Server mode sends data only to the configured same-origin PHP service. Opened contacts still exist in browser memory, and every exported file inherits the security of its destination.

Full security reference: [SECURITY.md](SECURITY.md)

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
