<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method === 'GET') {
    nexus_run(function (array $config): void {
        nexus_json(['authenticated' => nexus_authenticated($config), 'csrf' => $_SESSION['csrf'], 'authMode' => $config['auth_mode']]);
    }, 'GET', false, false);
    exit;
}
if ($method === 'POST') {
    nexus_run(function (array $config): void {
        $action = $_GET['action'] ?? '';
        if (!is_string($action)) nexus_fail(400, 'Invalid session action.');
        nexus_require_csrf();
        if ($action === 'login') nexus_login($config);
        if ($action === 'logout') nexus_logout($config);
        nexus_fail(404, 'Unknown session action.');
    }, 'POST', false, false);
    exit;
}
http_response_code(405);
header('Allow: GET, POST');
nexus_json(['error' => 'Method not allowed.']);
