<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';
nexus_run(function (array $config): void {
    $files = [];
    $ignored = 0;
    $seen = [];
    foreach (new DirectoryIterator($config['contacts_root']) as $file) {
        if ($file->isDot() || !preg_match('/\.(vcf|csv)$/i', $file->getFilename())) continue;
        if ($file->isLink() || !$file->isFile() || !nexus_valid_name($file->getFilename())) {
            $ignored++;
            continue;
        }
        // Names differing only in case would be one file on a case-insensitive filesystem.
        $key = function_exists('mb_strtolower') ? mb_strtolower($file->getFilename(), 'UTF-8') : strtolower($file->getFilename());
        if (isset($seen[$key])) nexus_fail(409, 'Two source filenames differ only by letter case. Rename one before opening Contacts Hub.');
        $seen[$key] = true;
        $files[] = ['name' => $file->getFilename(), 'bytes' => $file->getSize(),
            'modified' => gmdate('c', $file->getMTime())];
        if (count($files) > $config['max_libraries']) nexus_fail(413, 'The directory exceeds the library limit. Narrow the configured directory.');
    }
    usort($files, fn(array $a, array $b): int => strnatcasecmp($a['name'], $b['name']));
    nexus_json(['schemaVersion' => 1, 'files' => $files, 'ignored' => $ignored, 'truncated' => false]);
}, 'GET');
