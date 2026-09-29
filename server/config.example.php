<?php
declare(strict_types=1);
return [
    'auth_mode' => 'password',
    'password_hash' => '',
    'app_key' => '',
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
