<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';
nexus_run(function (array $config): void {
    $name = $_GET['file'] ?? null;
    if (!is_string($name) || !nexus_valid_name($name)) nexus_fail(400, 'Use a plain VCF or CSV filename.');
    $lock = nexus_lock($config, 'source:' . strtolower($name), LOCK_SH);
    try {
        $content = nexus_read_source($config, $name);
        if ($content === null) nexus_fail(404, 'Source not found.');
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Length: ' . strlen($content));
        // ASCII fallback avoids interpreting a user filename as a response header.
        header('Content-Disposition: inline; filename="source.txt"');
        echo $content;
    } finally {
        nexus_unlock($lock);
    }
}, 'GET');
