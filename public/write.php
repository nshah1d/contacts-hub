<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';
nexus_run(function (array $config): void {
    if (strtolower(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]) !== 'application/json') nexus_fail(415, 'Send application/json.');
    $input = fopen('php://input', 'rb');
    if ($input === false) nexus_fail(400, 'Request body could not be read.');
    try {
        $body = stream_get_contents($input, $config['max_request_bytes'] + 1);
    } finally { fclose($input); }
    if ($body === false || strlen($body) > $config['max_request_bytes']) nexus_fail(413, 'Request body exceeds the limit.');
    try { $request = json_decode($body, true, 32, JSON_THROW_ON_ERROR); }
    catch (JsonException $error) { nexus_fail(400, 'Request JSON is invalid.'); }
    if (!is_array($request) || ($request['action'] ?? null) !== 'save') nexus_fail(400, 'Unknown operation.');
    $name = $request['filename'] ?? null;
    $content = $request['vcfContent'] ?? null;
    if (!is_string($name) || !nexus_valid_name($name) || !preg_match('/\.vcf$/i', $name)) nexus_fail(400, 'Writes require a plain VCF filename.');
    if (!is_string($content) || !array_key_exists('baseRevision', $request)) nexus_fail(400, 'Content and baseRevision are required.');
    $base = $request['baseRevision'];
    if ($base !== null && (!is_string($base) || !preg_match('/^[a-f0-9]{64}$/D', $base))) nexus_fail(400, 'The source revision is invalid. Reload Contacts Hub.');
    // Until the rename, any failure leaves the library untouched. After it, a read-back that
    // differs is reported as uncertain, and the backup holds the prior bytes.
    nexus_validate_vcf($content, $config);
    $lock = nexus_lock($config, 'source:' . strtolower($name), LOCK_EX);
    $temp = null;
    try {
        $current = nexus_read_source($config, $name);
        $revision = $current === null ? null : hash('sha256', $current);
        if ($revision !== $base) nexus_fail(409, 'The source changed after the draft opened. Reload it before saving.');
        if ($base === null && nexus_case_collision($config, $name) !== null) nexus_fail(409, 'A source with the same name in different letter case already exists.');
        $next = hash('sha256', $content);
        if ($revision === $next) { nexus_json(['revision' => $next, 'backup' => null, 'unchanged' => true]); return; }
        $backup = $current === null ? null : nexus_backup($config, $name, $current, $revision);
        $path = $config['contacts_root'] . DIRECTORY_SEPARATOR . $name;
        if (is_link($path)) nexus_fail(409, 'A symbolic link cannot be replaced.');
        $temp = $config['contacts_root'] . DIRECTORY_SEPARATOR . '.nexus-' . bin2hex(random_bytes(16)) . '.tmp';
        nexus_write_new($temp, $content);
        // Both files are on the same filesystem. External writers must use the
        // same lock protocol; an advisory lock cannot control unrelated programs.
        clearstatcache(true, $path);
        if (is_link($path)) nexus_fail(409, 'The target changed while the draft was being saved.');
        $latest = nexus_read_source($config, $name);
        if (($latest === null ? null : hash('sha256', $latest)) !== $base) nexus_fail(409, 'An external writer changed the target.');
        if (!rename($temp, $path)) nexus_fail(500, 'The new source could not be published. The prior source was retained where the filesystem honours rename failure.');
        $temp = null;
        clearstatcache(true, $path);
        $written = nexus_read_source($config, $name);
        if ($written === null || hash('sha256', $written) !== $next) nexus_fail(500, 'Publication outcome is uncertain. Read the source and inspect the backup before retrying.');
        nexus_json(['revision' => $next, 'backup' => $backup, 'unchanged' => false]);
    } finally {
        if ($temp !== null && is_file($temp)) unlink($temp);
        nexus_unlock($lock);
    }
}, 'POST', true);
