<?php
declare(strict_types=1);
// Finds the private service: NEXUS_PRIVATE_PATH, then server/ beside this folder, then server/ inside it.
define('NEXUS_PUBLIC_ROOT', realpath(__DIR__) ?: __DIR__);
header('Cache-Control: private, no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Robots-Tag: noindex, nofollow');
$candidates = array_filter([
    getenv('NEXUS_PRIVATE_PATH') ?: null,
    dirname(__DIR__) . '/server',
    __DIR__ . '/server',
]);
$private = null;
foreach ($candidates as $candidate) {
    if (is_string($candidate) && is_file($candidate . '/common.php')) {
        $private = $candidate;
        break;
    }
}
if ($private === null) {
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Contacts Hub private service files have not been configured.']);
    exit;
}
require_once $private . '/common.php';
