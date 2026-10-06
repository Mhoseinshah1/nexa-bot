<?php
/**
 * SYNTHETIC archive fixtures for scripts/legacy-archive-inspect.mjs. NOT EVIDENCE.
 *
 * Produced with PHP's ext-zip (libzip) — the encoder MirzaBot itself uses — so the
 * inspector's AES decoder is tested against an encoder this repository did not write.
 * The evidenced revision (mahdiMGF2/mirza_pro e4966ff, cronbot/backupbot.php) does:
 *
 *   $zip->open('backup_Y-m-d.zip', ZipArchive::CREATE);
 *   $zip->addFile('backup_Y-m-d.sql', 'backup_Y-m-d.sql');
 *   $zip->setEncryptionName('backup_Y-m-d.sql', ZipArchive::EM_AES_256, <password>);
 *
 * and this script does the same with a TEST-ONLY password. MirzaBot's own hardcoded
 * password is public, and is deliberately NOT in this repository: an operator supplies
 * the real one through an environment variable at run time.
 *
 * The inner dump of every positive fixture is tests/fixtures/legacy/synthetic-legacy.sql
 * byte for byte (a unit test pins that), so a regenerated synthetic dataset shows up as a
 * stale archive fixture rather than as a silent difference.
 *
 * Regenerate (AES salts are random, so the bytes — and the pinned sha256 values in
 * tests/unit/legacy-archive-inspect.test.ts — change on every run):
 *
 *   php tests/fixtures/legacy/archive/make-fixtures.php
 *
 * Needs PHP >= 8.0 with ext-zip built on a libzip that supports encryption
 * (ZipArchive::isEncryptionMethodSupported(ZipArchive::EM_AES_256) === true).
 */
declare(strict_types=1);

const TEST_ONLY_PASSWORD = 'nexa-synthetic-archive-test-only';

$here = __DIR__;
$dump = file_get_contents($here . '/../synthetic-legacy.sql');
if ($dump === false) {
    fwrite(STDERR, "cannot read ../synthetic-legacy.sql\n");
    exit(1);
}
foreach ([ZipArchive::EM_AES_256, ZipArchive::EM_AES_128, ZipArchive::EM_TRAD_PKWARE] as $m) {
    if (!ZipArchive::isEncryptionMethodSupported($m)) {
        fwrite(STDERR, "this libzip cannot encrypt with method $m\n");
        exit(1);
    }
}

/** @param array<string, string> $entries name => content */
function make(string $path, array $entries, ?int $encryption, ?int $compression = null): void
{
    @unlink($path);
    $zip = new ZipArchive();
    if ($zip->open($path, ZipArchive::CREATE) !== true) {
        throw new RuntimeException("cannot create $path");
    }
    foreach ($entries as $name => $content) {
        $zip->addFromString($name, $content);
        if ($compression !== null) {
            $zip->setCompressionName($name, $compression);
        }
        if ($encryption !== null) {
            $zip->setEncryptionName($name, $encryption, TEST_ONLY_PASSWORD);
        }
    }
    if ($zip->close() !== true) {
        throw new RuntimeException("cannot write $path");
    }
    echo basename($path), ' ', hash_file('sha256', $path), "\n";
}

// Positive: the evidenced shape (one entry, AES-256, deflated), and the same stored.
make("$here/backup_2026-01-01.zip", ['backup_2026-01-01.sql' => $dump], ZipArchive::EM_AES_256);
make("$here/backup_2026-01-02.zip", ['backup_2026-01-02.sql' => $dump], ZipArchive::EM_AES_256, ZipArchive::CM_STORE);
// Positive: no encryption at all (an operator's own re-zip of a fresh dump).
make("$here/backup_2026-01-03.zip", ['backup_2026-01-03.sql' => $dump], null);
// Negative: shapes no MirzaBot revision produced.
make("$here/two-entries.zip", ['backup_2026-01-01.sql' => $dump, 'notes.txt' => "x\n"], ZipArchive::EM_AES_256);
make("$here/wrong-entry-name.zip", ['dump.sql' => $dump], ZipArchive::EM_AES_256);
make("$here/zipcrypto.zip", ['backup_2026-01-01.sql' => $dump], ZipArchive::EM_TRAD_PKWARE);
make("$here/aes128.zip", ['backup_2026-01-01.sql' => $dump], ZipArchive::EM_AES_128);
