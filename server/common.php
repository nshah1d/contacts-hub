<?php
declare(strict_types=1);

/** An expected failure with the HTTP status to answer with. Its message is safe to show to the client. */
final class NexusProblem extends RuntimeException {
    public function __construct(public readonly int $status, string $message) { parent::__construct($message); }
}
function nexus_fail(int $status, string $message): never { throw new NexusProblem($status, $message); }
function nexus_json(array $data): void {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
}
function nexus_method(string $method): void {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== $method) {
        header('Allow: ' . $method);
        nexus_fail(405, 'Method not allowed.');
    }
}
/**
 * Accepts a plain library filename. Length is counted in UTF-16 code units so the rule
 * matches safeFilename() in public/js/core/primitives.js exactly.
 */
function nexus_valid_name(string $name): bool {
    if (preg_match('//u', $name) !== 1) return false;
    $characters = preg_split('//u', $name, -1, PREG_SPLIT_NO_EMPTY);
    $units = 0;foreach ($characters as $character) $units += strlen($character) === 4 ? 2 : 1;
    if ($units < 1 || $units > 180 || preg_match('/^[\s\p{Z}\x{FEFF}]|[\s\p{Z}\x{FEFF}]$/u', $name)) return false;
    return strlen($name) <= 540 && preg_match('//u', $name) === 1
        && preg_match('/^[^.][^\x00-\x1f\x7f\/\\\\<>:"|?*]*\.(vcf|csv)$/iuD', $name) === 1
        && trim($name) === $name;
}
function nexus_inside(string $path, string $root): bool {
    return $path === $root || str_starts_with($path, rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR);
}
/**
 * Loads the private configuration over the defaults in config.example.php and refuses to
 * serve (503) unless the key, authentication mode and limits are valid and the four
 * directories exist, are separate and do not contain one another.
 *
 * @return array<string, mixed>
 */
function nexus_config(): array {
    $file = __DIR__ . '/config.php';
    if (!is_file($file) || is_link($file)) nexus_fail(503, 'Copy and configure the private config.example.php as config.php.');
    $config = require $file;
    if (!is_array($config)) nexus_fail(503, 'The private configuration is invalid.');
    $config += require __DIR__ . '/config.example.php';
    if (!preg_match('/^[a-f0-9]{64}$/Di', (string)$config['app_key'])) nexus_fail(503, 'The private application key is not configured.');
    if (!in_array($config['auth_mode'], ['password', 'remote_user'], true)) nexus_fail(503, 'Choose a supported authentication mode.');
    if ($config['auth_mode'] === 'password' && password_get_info((string)$config['password_hash'])['algoName'] === 'unknown') nexus_fail(503, 'The private password hash is not configured.');
    $documentRoot = realpath(NEXUS_PUBLIC_ROOT);
    foreach (['contacts_root', 'backups_root', 'locks_root', 'sessions_root'] as $key) {
        $value = $config[$key] ?? null;
        if (!is_string($value) || str_contains($value, '://') || !is_dir($value) || is_link($value)) nexus_fail(503, 'A private service directory is unavailable.');
        $resolved = realpath($value);
        if ($resolved === false) nexus_fail(503, 'A private service directory is unavailable.');
        // Libraries may live in the site root, where the host's own login protects them and where new
        // exports are uploaded. Backups, locks and sessions hold service state and must never be served.
        if ($key !== 'contacts_root' && $documentRoot && nexus_inside($resolved, $documentRoot)) nexus_fail(503, 'Backup, lock and session directories must be outside the web document root.');
        $config[$key] = $resolved;
    }
    if (count(array_unique([$config['contacts_root'], $config['backups_root'], $config['locks_root'], $config['sessions_root']])) !== 4) nexus_fail(503, 'Private service directories must be separate.');
    foreach (['contacts_root', 'backups_root', 'locks_root', 'sessions_root'] as $left)
        foreach (['contacts_root', 'backups_root', 'locks_root', 'sessions_root'] as $right)
            if ($left !== $right && nexus_inside($config[$left], $config[$right])) nexus_fail(503, 'Private service directories cannot contain one another.');
    if (!is_readable($config['contacts_root']) || !is_writable($config['contacts_root']) || !is_writable($config['backups_root']) || !is_writable($config['locks_root']) || !is_writable($config['sessions_root'])) nexus_fail(503, 'The private service directories do not have the required permissions.');
    foreach (['idle_seconds', 'absolute_seconds', 'max_source_bytes', 'max_request_bytes', 'max_libraries', 'max_contacts', 'max_backup_bytes', 'max_backup_files', 'lock_timeout_seconds'] as $key) {
        if (!isset($config[$key]) || !is_int($config[$key]) || $config[$key] < 1) nexus_fail(503, 'A private service limit is invalid.');
    }
    if ($config['max_source_bytes'] > 20971520 || $config['max_libraries'] > 2000 || $config['max_contacts'] > 50000) nexus_fail(503, 'Server limits exceed the browser contract.');
    return $config;
}
/**
 * Starts the file-backed session in sessions_root. The cookie is HttpOnly, SameSite=Strict
 * and scoped to the application's path; a session ends after idle_seconds without use or
 * absolute_seconds in total.
 */
function nexus_start_session(array $config): void {
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');
    ini_set('session.gc_maxlifetime', (string)$config['absolute_seconds']);
    session_save_path($config['sessions_root']);
    session_name('nexus_' . substr(hash('sha256', $config['app_key']), 0, 12));
    $scope = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/'));
    $scope = $scope === '/' || $scope === '.' ? '/' : rtrim($scope, '/') . '/';
    session_set_cookie_params(['lifetime' => 0, 'path' => $scope, 'secure' => (bool)$config['secure_cookie'], 'httponly' => true, 'samesite' => 'Strict']);
    if (!session_start()) nexus_fail(503, 'A private session could not be opened.');
    $now = time();
    if (isset($_SESSION['authenticated']) && ($now - (int)($_SESSION['last_seen'] ?? 0) > $config['idle_seconds'] || $now - (int)($_SESSION['started'] ?? 0) > $config['absolute_seconds'])) {
        $_SESSION = [];
        session_regenerate_id(true);
    }
    if (!isset($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    if (isset($_SESSION['authenticated'])) $_SESSION['last_seen'] = $now;
}
/**
 * In remote_user mode the web server's own login is trusted. A password session is bound to
 * the current password hash, so replacing the hash signs every session out.
 */
function nexus_authenticated(array $config): bool {
    if ($config['auth_mode'] === 'remote_user') return isset($_SERVER['REMOTE_USER']) && is_string($_SERVER['REMOTE_USER']) && $_SERVER['REMOTE_USER'] !== '';
    return ($_SESSION['authenticated'] ?? false) === true && hash_equals(hash('sha256', $config['password_hash']), (string)($_SESSION['auth_revision'] ?? ''));
}
/**
 * Guards a state-changing request: the session token must arrive in X-Nexus-CSRF, and Fetch
 * Metadata (https://www.w3.org/TR/fetch-metadata/) and Origin must not show another site.
 */
function nexus_require_csrf(): void {
    $token = $_SERVER['HTTP_X_NEXUS_CSRF'] ?? '';
    if (!is_string($token) || !hash_equals((string)($_SESSION['csrf'] ?? ''), $token)) nexus_fail(403, 'The request token is missing or expired. Reload Contacts Hub.');
    if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') nexus_fail(403, 'Cross-site changes are not accepted.');
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '') {
        if (!is_string($origin) || !isset($_SERVER['HTTP_HOST'])) nexus_fail(403, 'The request origin is invalid.');
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        if (!hash_equals($scheme . '://' . $_SERVER['HTTP_HOST'], rtrim($origin, '/'))) nexus_fail(403, 'The request origin is invalid.');
    }
}
function nexus_read_json_body(int $limit = 4096): array {
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) nexus_fail(413, 'The request is too large.');
    $raw = file_get_contents('php://input', false, null, 0, $limit + 1);
    if ($raw === false || strlen($raw) > $limit) nexus_fail(413, 'The request is too large.');
    try { $data = json_decode($raw, true, 16, JSON_THROW_ON_ERROR); }
    catch (JsonException) { nexus_fail(400, 'The request JSON is invalid.'); }
    if (!is_array($data)) nexus_fail(400, 'The request JSON is invalid.');
    return $data;
}
/** Replaces a private JSON state file through a temporary file and rename, so a reader never sees half a file. */
function nexus_atomic_json(string $path, array $data): void {
    if (is_link($path)) nexus_fail(503, 'Private state is unavailable.');
    $temp = tempnam(dirname($path), '.nexus-state-');
    if ($temp === false) nexus_fail(503, 'Private state could not be created.');
    try {
        chmod($temp, 0600);
        $json = json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (file_put_contents($temp, $json, LOCK_EX) !== strlen($json) || !rename($temp, $path)) nexus_fail(503, 'Private state could not be committed.');
    } finally { if (is_file($temp)) unlink($temp); }
}
/**
 * Allows ten password attempts per client address in a 15-minute window. Addresses are
 * stored only as HMACs keyed by the application key, and the table is capped at 5,000 entries.
 */
function nexus_rate_attempt(array $config): void {
    $path = $config['locks_root'] . DIRECTORY_SEPARATOR . 'auth-limits.json';
    $lock = nexus_lock($config, 'auth-limits', LOCK_EX);
    try {
        $entries = [];
        if (is_file($path) && !is_link($path) && filesize($path) <= 2097152) {
            try { $read = json_decode((string)file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);if (is_array($read)) $entries = $read; }
            catch (JsonException) { $entries = []; }
        }
        $now = time();
        foreach ($entries as $key => $entry) if (!is_array($entry) || $now - (int)($entry['start'] ?? 0) >= 900) unset($entries[$key]);
        $key = hash_hmac('sha256', (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'), hex2bin($config['app_key']));
        if (count($entries) >= 5000 && !isset($entries[$key])) nexus_fail(429, 'The sign-in service is busy. Try again later.');
        $entry = $entries[$key] ?? ['start' => $now, 'count' => 0];
        if ($entry['count'] >= 10) { header('Retry-After: 900');nexus_fail(429, 'Too many sign-in attempts. Try again in 15 minutes.'); }
        $entry['count']++;$entries[$key] = $entry;nexus_atomic_json($path, $entries);
    } finally { nexus_unlock($lock); }
}
function nexus_login(array $config): never {
    if ($config['auth_mode'] !== 'password') nexus_fail(403, 'Sign in through the configured web-server authentication service.');
    nexus_rate_attempt($config);
    $password = nexus_read_json_body()['password'] ?? null;
    if (!is_string($password) || strlen($password) > 1024 || str_contains($password, "\0")) nexus_fail(400, 'The password value is invalid.');
    if (password_get_info($config['password_hash'])['algoName'] === 'bcrypt' && strlen($password) > 72) nexus_fail(400, 'This password configuration accepts at most 72 bytes.');
    if (!password_verify($password, $config['password_hash'])) { usleep(200000);nexus_fail(401, 'The library password is incorrect.'); }
    session_regenerate_id(true);
    $_SESSION = ['authenticated' => true, 'auth_revision' => hash('sha256', $config['password_hash']), 'started' => time(), 'last_seen' => time(), 'csrf' => bin2hex(random_bytes(32))];
    nexus_json(['authenticated' => true, 'csrf' => $_SESSION['csrf']]);
    exit;
}
function nexus_logout(array $config): never {
    $_SESSION = [];
    $params = session_get_cookie_params();
    setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => $params['path'], 'secure' => $params['secure'], 'httponly' => true, 'samesite' => 'Strict']);
    session_destroy();
    nexus_json(['authenticated' => false, 'externalAuthenticationRemains' => $config['auth_mode'] === 'remote_user']);
    exit;
}
/**
 * Runs one endpoint: configuration, method, session, authentication and CSRF checks, then the
 * handler. The session is released before the handler runs so long reads do not block the
 * user's other requests. Unexpected errors are logged by class name only.
 *
 * @param callable(array): void $handler
 */
function nexus_run(callable $handler, string $method, bool $write = false, bool $requireAuth = true): void {
    try {
        if (PHP_VERSION_ID < 80200 || PHP_INT_SIZE < 8) nexus_fail(503, 'Contacts Hub requires 64-bit PHP 8.2 or later.');
        $config = nexus_config();
        nexus_method($method);
        nexus_start_session($config);
        if ($requireAuth && !nexus_authenticated($config)) nexus_fail(401, 'Sign in to open this private address book.');
        if ($write) nexus_require_csrf();
        if ($requireAuth) session_write_close();
        $handler($config);
    } catch (NexusProblem $error) {
        if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
        http_response_code($error->status);nexus_json(['error' => $error->getMessage()]);
    } catch (Throwable $error) {
        if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
        // The client never receives filesystem paths, configuration or contact data.
        error_log('Contacts Hub service failure: ' . get_class($error));
        http_response_code(500);nexus_json(['error' => 'The service could not complete this operation. Check the private server logs and source before retrying.']);
    }
}
/**
 * Takes an advisory lock, waiting up to lock_timeout_seconds before answering 423. Lock files
 * are named by hash, so a library name never becomes part of a path.
 *
 * @return resource
 */
function nexus_lock(array $config, string $key, int $kind) {
    $path = $config['locks_root'] . DIRECTORY_SEPARATOR . hash('sha256', $key) . '.lock';
    if (is_link($path)) nexus_fail(503, 'The service lock is unavailable.');
    $handle = fopen($path, 'c+b');
    if ($handle === false) nexus_fail(503, 'The service lock could not be opened.');
    @chmod($path, 0600);
    $until = microtime(true) + $config['lock_timeout_seconds'];
    do {
        if (flock($handle, $kind | LOCK_NB)) return $handle;
        usleep(25000);
    } while (microtime(true) < $until);
    fclose($handle);nexus_fail(423, 'This library is busy. Wait and retry.');
}
function nexus_unlock($handle): void { flock($handle, LOCK_UN);fclose($handle); }
/**
 * Reads one library from contacts_root. Links and non-regular files are refused, and the read
 * fails with 409 if the file is replaced or modified while it is read: device, inode, size and
 * times are compared on the open handle and on the path, before and after.
 *
 * @return string|null null when the file does not exist.
 */
function nexus_read_source(array $config, string $name): ?string {
    $path = $config['contacts_root'] . DIRECTORY_SEPARATOR . $name;
    clearstatcache(true, $path);
    if (is_link($path)) nexus_fail(403, 'Symbolic-link sources are not accepted.');
    if (!file_exists($path)) return null;
    if (!is_file($path) || realpath(dirname($path)) !== $config['contacts_root']) nexus_fail(403, 'This source is not a regular library file.');
    $handle = fopen($path, 'rb');
    if ($handle === false) nexus_fail(403, 'This source could not be read.');
    try {
        $before = fstat($handle);$named = lstat($path);
        if ($before === false || $named === false || ($before['mode'] & 0170000) !== 0100000
            || $before['ino'] !== $named['ino'] || $before['dev'] !== $named['dev']) nexus_fail(409, 'The source changed while it was being opened.');
        if ($before['size'] > $config['max_source_bytes']) nexus_fail(413, 'This source exceeds the byte limit.');
        $content = stream_get_contents($handle, $config['max_source_bytes'] + 1);
        if ($content === false || strlen($content) > $config['max_source_bytes']) nexus_fail(413, 'This source exceeds the byte limit.');
        clearstatcache(true, $path);
        $after = fstat($handle);$namedAfter = lstat($path);
        foreach (['dev', 'ino', 'size', 'mtime', 'ctime'] as $key)
            if ($after === false || $namedAfter === false || $after[$key] !== $before[$key] || $namedAfter[$key] !== $before[$key]) nexus_fail(409, 'The source changed while it was being read.');
        return $content;
    } finally { fclose($handle); }
}
/**
 * Checks a proposed VCF before it is written: valid UTF-8, no NUL, every card closed with
 * exactly one VERSION of 3.0 or 4.0, and the same card, property and contact limits as the
 * browser parser. The server therefore never publishes a file the browser would refuse to edit.
 */
function nexus_validate_vcf(string $content, array $config): void {
    if (strlen($content) > $config['max_source_bytes']) nexus_fail(413, 'The proposed source exceeds the byte limit.');
    if (str_contains($content, "\0") || preg_match('//u', $content) !== 1) nexus_fail(400, 'The proposed source must be valid UTF-8 without NUL bytes.');
    // Empty is a valid library after its last card is deliberately removed.
    if ($content === '' || $content === "\xEF\xBB\xBF") return;
    $lines = preg_split('/\r\n|\r|\n/', preg_replace('/^\xEF\xBB\xBF/', '', $content));
    $logical = [];
    foreach ($lines as $line) {
        $last = count($logical) - 1;
        $fold = $line !== '' && ($line[0] === ' ' || $line[0] === "\t");
        $qp = $last >= 0 && preg_match('/;ENCODING=QUOTED-PRINTABLE(?:;|:)/i', $logical[$last])
            && str_ends_with($logical[$last], '=') && !preg_match('/^(?:BEGIN|END):VCARD$/iD', $line);
        if ($last >= 0 && $qp) $logical[$last] = substr($logical[$last], 0, -1) . ($fold ? substr($line, 1) : $line);
        elseif ($last >= 0 && $fold) $logical[$last] .= substr($line, 1);
        else $logical[] = $line;
    }
    $lines = $logical;
    $active = false;$count = 0;$versions = 0;$version = '';$properties = 0;$cardBytes = 0;
    foreach ($lines as $line) {
        if ($active) {$cardBytes += strlen($line) + 2;if ($cardBytes > 1048576) nexus_fail(413, 'A card exceeds the size limit.');}
        if ($line !== '' && ($line[0] === ' ' || $line[0] === "\t")) { if (!$active) nexus_fail(400, 'A continuation occurs outside a vCard.');continue; }
        if (strcasecmp($line, 'BEGIN:VCARD') === 0) {
            if ($active) nexus_fail(400, 'Nested vCards are not accepted for writes.');
            $active = true;$versions = 0;$version = '';$properties = 0;$cardBytes = strlen($line) + 2;
        } elseif (strcasecmp($line, 'END:VCARD') === 0) {
            if (!$active || $versions !== 1 || !in_array($version, ['3.0', '4.0'], true)) nexus_fail(400, 'Each written card must declare one supported version.');
            $active = false;$count++;if ($count > $config['max_contacts']) nexus_fail(413, 'Too many contacts.');
        } elseif ($line !== '') {
            if (!$active) nexus_fail(400, 'Text outside a vCard is not accepted for writes.');
            if (++$properties > 2048) nexus_fail(413, 'A card has too many properties.');
            if (preg_match('/^(?:[a-z0-9-]+\.)?VERSION(?:;[^:]*)?:(.*)$/iD', $line, $match)) {$versions++;$version = $match[1];}
            if (!preg_match('/^[a-z0-9.-]+(?:;.*)?:/i', $line)) nexus_fail(400, 'A property has no recognised header.');
        }
    }
    if ($active) nexus_fail(400, 'A vCard is missing its end marker.');
}
/** Creates a file that must not already exist, owner-only, and flushes it to storage before returning. */
function nexus_write_new(string $path, string $content): void {
    $handle = fopen($path, 'x+b');
    if ($handle === false) nexus_fail(500, 'A new private file could not be created.');
    try {
        if (!chmod($path, 0600)) nexus_fail(500, 'Private file permissions could not be set.');
        $length = strlen($content);$offset = 0;
        while ($offset < $length) {
            $written = fwrite($handle, substr($content, $offset, 1048576));
            if ($written === false || $written === 0) nexus_fail(507, 'Storage could not accept the complete file.');
            $offset += $written;
        }
        if (!fflush($handle) || (function_exists('fsync') && !fsync($handle))) nexus_fail(507, 'The file could not be flushed to storage.');
    } catch (Throwable $error) {
        fclose($handle);if (is_file($path)) unlink($path);throw $error;
    }
    fclose($handle);
}
/**
 * Keeps the exact prior bytes of a library before it is overwritten. When the retention quota
 * is full the write is refused (507) rather than any old backup being deleted.
 *
 * @return string The backup's file name.
 */
function nexus_backup(array $config, string $name, string $content, string $revision): string {
    $lock = nexus_lock($config, 'backup-quota', LOCK_EX);
    try {
        $bytes = 0;$count = 0;
        foreach (new DirectoryIterator($config['backups_root']) as $file) {
            if ($file->isDot()) continue;
            if ($file->isLink() || !$file->isFile()) nexus_fail(503, 'The backup directory contains an unsupported entry.');
            $bytes += $file->getSize();$count++;
        }
        if ($count >= $config['max_backup_files'] || $bytes + strlen($content) > $config['max_backup_bytes']) nexus_fail(507, 'Backup retention is full. Archive backups before retrying.');
        $id = gmdate('Ymd\THis\Z') . '-' . substr(hash('sha256', $name), 0, 12) . '-' . substr($revision, 0, 12) . '-' . bin2hex(random_bytes(8)) . '.vcf';
        nexus_write_new($config['backups_root'] . DIRECTORY_SEPARATOR . $id, $content);
        return $id;
    } finally { nexus_unlock($lock); }
}
function nexus_case_collision(array $config, string $name): ?string {
    foreach (new DirectoryIterator($config['contacts_root']) as $file) {
        if ($file->isDot() || $file->isLink() || !$file->isFile()) continue;
        if (strcasecmp($file->getFilename(), $name) === 0 && $file->getFilename() !== $name) return $file->getFilename();
    }
    return null;
}

// Every response is private and uncacheable, and PHP warnings become exceptions rather than output.
header('Cache-Control: private, no-store, max-age=0, no-transform');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: DENY');
header('X-Robots-Tag: noindex, nofollow, noarchive, nosnippet');
ini_set('display_errors', '0');
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) return false;
    throw new ErrorException($message, 0, $severity, $file, $line);
});
