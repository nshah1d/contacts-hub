# Contacts Hub Configuration

Contacts Hub has one browser preference and a private PHP configuration. `public/config.js` controls optional My Card discovery. A private `server/config.php`, copied from `server/config.example.php`, controls authentication, storage roots, session policy and service limits.

The PHP service merges the private file over the example defaults, then validates the complete result before serving a request (`server/common.php`, `nexus_config()`). Invalid configuration returns HTTP 503 without exposing the rejected value.

---

## Browser Configuration

### `MY_NAME`

| Property | Value |
|:--|:--|
| File | `public/config.js` |
| Type | JavaScript string |
| Default | Empty string |
| Effect | Pins one exact display-name match as My Card when the opened library contains exactly one match |
| Disable | Keep the value empty |

```javascript
export const MY_NAME = '';
```

The match is case-insensitive and runs only when no My Card bookmark is already stored. A query returning more than 100 results is not eligible for automatic pinning, and exactly one returned display name must equal the configured name (`public/js/app.js`, `openLibrary()`). The value is public browser configuration, not a credential.

The interface can also set or clear My Card manually. When preference storage is enabled, `localStorage` key `nexus.preferences.v2` holds the favourites array, the My Card hashed bookmark, the `remember` flag and the theme. Contact text and session tokens are excluded (`public/js/app.js`, `preferences()`, `storePreferences()` and `settingsDialog()`).

---

## Private PHP Configuration

Create the private configuration before starting the PHP service:

```bash
cp server/config.example.php server/config.php
```

`server/config.php` must be a regular non-symbolic-link file that returns an array. It contains deployment secrets and private paths and must stay outside version control. `tools/check.mjs` fails when a private configuration exists in the repository tree.

### Authentication settings

| Setting | Type | Default | Accepted value or constraint | Effect |
|:--|:--|:--|:--|:--|
| `auth_mode` | string | `'password'` | `'password'` or `'remote_user'` | Selects application password login or trusted web-server identity |
| `password_hash` | string | `''` | A hash recognised by `password_get_info()` when `auth_mode` is `password` | Verifies the submitted password and binds existing sessions to the current hash |
| `app_key` | string | `''` | Exactly 64 hexadecimal characters | Keys session naming and client-address HMACs for login throttling |
| `secure_cookie` | boolean | `true` | `true` or `false` | Sets the session cookie's Secure attribute |
| `idle_seconds` | integer | `3600` | At least 1 | Expires an authenticated session after this many seconds without a request |
| `absolute_seconds` | integer | `43200` | At least 1 | Expires an authenticated session after this total lifetime |

Generate the application key with a cryptographically secure random source:

```bash
php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
```

For password mode, create a PHP password hash instead of storing the password:

```bash
php -r 'echo password_hash("replace-this-password", PASSWORD_DEFAULT), PHP_EOL;'
```

Replace the quoted input before running the command, then place only the resulting hash in `password_hash`. When the current hash changes, `nexus_authenticated()` rejects sessions carrying the previous hash revision (`server/common.php`, `nexus_authenticated()`). A bcrypt hash limits submitted passwords to 72 bytes because PHP's bcrypt verification has that input limit (`server/common.php`, `nexus_login()`).

Remote-user mode requires the web server or upstream authentication layer to set a non-empty `REMOTE_USER` for authorised requests. The application does not verify that identity itself (`server/common.php`, `nexus_authenticated()`).

Keep `secure_cookie` enabled on HTTPS. Set it to `false` only for a plain-HTTP loopback development service; a Secure cookie is not returned over plain HTTP.

### Storage roots

| Setting | Type | Default | Constraint | Effect |
|:--|:--|:--|:--|:--|
| `contacts_root` | path string | `dirname(__DIR__) . '/sources'` | Existing, readable, writable, regular directory; no URL wrapper or symbolic link | Holds VCF and CSV libraries |
| `backups_root` | path string | `dirname(__DIR__) . '/var/backups'` | Existing writable private directory | Holds exact pre-write VCF backups |
| `locks_root` | path string | `dirname(__DIR__) . '/var/locks'` | Existing writable private directory | Holds hashed advisory lock files and the password-attempt state file |
| `sessions_root` | path string | `dirname(__DIR__) . '/var/sessions'` | Existing writable private directory | Holds PHP session files |

All four paths resolve through `realpath()`. They must be distinct and cannot contain one another. Backup, lock and session roots must stay outside the public document root. The contacts root may equal the site root when direct library requests are denied by the shipped Apache `public/.htaccess` or by equivalent web-server access control (`server/common.php`, `nexus_config()`; `public/.htaccess`).

The service does not create these directories. Create them before the first request and grant the PHP process read and write access. Private directories should be owner-accessible only where the host permits it:

```bash
mkdir -p var/backups var/locks var/sessions sources
chmod 700 var var/backups var/locks var/sessions sources
```

File ownership and permission values depend on the web-server account. The required condition is narrower than the example: PHP must read and write `contacts_root`, and write the other three roots.

### Service limits

| Setting | Type | Default | Accepted range | Effect |
|:--|--:|--:|:--|:--|
| `max_source_bytes` | integer | `20 * 1024 * 1024` | 1 to 20 MiB | Maximum bytes read from or written to one library |
| `max_request_bytes` | integer | `64 * 1024 * 1024` | At least 1 | Maximum JSON request body for `write.php` |
| `max_libraries` | integer | `2000` | 1 to 2,000 | Maximum supported files returned by `scan.php` |
| `max_contacts` | integer | `50000` | 1 to 50,000 | Maximum vCards accepted in one written library |
| `max_backup_bytes` | integer | `1024 * 1024 * 1024` | At least 1 | Total byte quota for private backups |
| `max_backup_files` | integer | `10000` | At least 1 | Total file-count quota for private backups |
| `lock_timeout_seconds` | integer | `5` | At least 1 | Time spent attempting an advisory lock before HTTP 423 |

Every limit must be a positive PHP integer. `max_source_bytes`, `max_libraries` and `max_contacts` cannot exceed the matching browser ceilings because the server must never publish a source the browser contract refuses (`server/common.php`, `nexus_config()`; `public/js/core/primitives.js`, `LIMITS`).

`max_request_bytes` includes JSON encoding overhead as well as VCF content. It therefore needs room above `max_source_bytes`. The defaults leave that margin.

Backup quotas are strict retention ceilings. When either ceiling is full, `nexus_backup()` returns HTTP 507 and leaves the source unchanged. The application never removes an old backup automatically (`server/common.php`, `nexus_backup()`).

---

## Complete Example

```php
<?php
declare(strict_types=1);

return [
    'auth_mode' => 'password',
    'password_hash' => '$2y$...',
    'app_key' => '64 hexadecimal characters',
    'secure_cookie' => true,
    'idle_seconds' => 3600,
    'absolute_seconds' => 43200,
    'contacts_root' => dirname(__DIR__) . '/sources',
    'backups_root' => dirname(__DIR__) . '/var/backups',
    'locks_root' => dirname(__DIR__) . '/var/locks',
    'sessions_root' => dirname(__DIR__) . '/var/sessions',
    'max_source_bytes' => 20 * 1024 * 1024,
    'max_request_bytes' => 64 * 1024 * 1024,
    'max_libraries' => 2000,
    'max_contacts' => 50000,
    'max_backup_bytes' => 1024 * 1024 * 1024,
    'max_backup_files' => 10000,
    'lock_timeout_seconds' => 5,
];
```

The placeholder values above are descriptive. Use the generated application key and a real password hash in the private file.

---

## Service Discovery

`public/bootstrap.php` checks these private-service locations in order:

1. the directory named by the `NEXUS_PRIVATE_PATH` environment variable;
2. `server/` beside `public/`;
3. `server/` inside the deployed public directory.

The first directory containing `common.php` wins. A missing private service returns HTTP 503. `NEXUS_PRIVATE_PATH` is useful when the public document root and private service are deployed separately:

```apache
SetEnv NEXUS_PRIVATE_PATH /private/path/to/contacts-hub-server
```

The example shows the variable shape only. Use a deployment-owned private path and prevent that directory from being served over HTTP.

---

## Browser Interpretation Settings

CSV interpretation is selected in the interface and lasts for the current open snapshot. Supported delimiters are comma, semicolon and tab. The engine accepts fifteen internal mapping keys by zero-based column index (`public/js/core/csv.js`, `parseContactCSV()`):

- `fn`, `given`, `family`, `org`, `title`, `note`, `bday`, `nickname`;
- `phone`, `email`, `street`, `city`, `region`, `postal`, `country`.

The current mapping dialog exposes eight of them: `fn` as Full name, `given` as Given name, `family` as Family name, `org` as Organisation, `title` as Job title, `note` as Notes, `phone` as Primary phone and `email` as Primary email (`public/js/app.js`, `mappingDialog()`). The remaining engine keys can still arrive through inferred headers or a direct engine caller; they have no dedicated control in the browser dialog.

Changing the delimiter reparses the header before a mapping is applied. Neither delimiter nor mapping changes the CSV file. Both values travel inside an evidence export so a later relational verification can reproduce the same interpretation (`public/js/app.js`, `mappingDialog()`; `public/js/core/engine.js`, `exportEvidence()`).

---

## Validation and Failure Behaviour

Configuration failures stop the request with HTTP 503. The service checks the application key, authentication mode, password hash, directory topology, permissions and every integer limit before starting application work (`server/common.php`, `nexus_config()`).

Common failures have direct causes:

| Message or status | Cause |
|:--|:--|
| HTTP 503, private configuration missing | `server/config.php` is absent or is a symbolic link |
| HTTP 503, application key not configured | `app_key` is not exactly 64 hexadecimal characters |
| HTTP 503, password hash not configured | Password mode uses an unrecognised or empty hash |
| HTTP 503, private directory unavailable | A root does not exist, uses a URL wrapper, is a symbolic link or cannot resolve |
| HTTP 503, directories must be separate | Two roots resolve to the same directory |
| HTTP 503, directories cannot contain one another | One configured root is nested inside another |
| HTTP 503, permissions unavailable | PHP lacks required access to a root |
| HTTP 503, limit invalid | A configured limit is missing, non-integer or below 1 |
| HTTP 503, browser contract exceeded | Source, library or contact ceiling is above the browser maximum |
| HTTP 423 | A required advisory lock was unavailable for `lock_timeout_seconds` |
| HTTP 507 | Backup retention or storage could not accept the write |

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
