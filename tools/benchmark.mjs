import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { ContactEngine } from '../public/js/core/engine.js';
import { largeLibrary } from './fixtures.mjs';
const count = Number(process.argv[2] || 10000);
if (!Number.isSafeInteger(count) || count < 1 || count > 50000)
    throw new Error('Choose 1 to 50,000 contacts.');
const text = largeLibrary(count), engine = new ContactEngine(), t0 = performance.now();
engine.open({ text, name: 'Benchmark.vcf' });
const parse = performance.now() - t0;
const t1 = performance.now(), query = engine.handle('query', { query: 'Contact 000123', limit: 80 }), firstSearch = performance.now() - t1;
const t2 = performance.now();
for (let i = 0; i < 100; i++)
    engine.handle('query', { offset: i % 2, query: 'Contact 000123', limit: 80 });
const cached = performance.now() - t2;
const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model,
    workload: { synthetic: true, contacts: count, sourceBytes: Buffer.byteLength(text) }, results: { parseAndIndexMs: parse, firstLiteralSearchMs: firstSearch, cached100WindowsMs: cached, matches: query.total, peakRssMiB: process.resourceUsage().maxRSS / 1024 },
    limitations: ['One Node run in this container.', 'No equivalent legacy benchmark.', 'Not a browser result or a memory-leak guarantee.', 'Generation is outside the parse timing. The complete opened source and records remain in worker memory.'] };
console.log(JSON.stringify(report, null, 2));
if (process.env.NEXUS_BENCHMARK_OUTPUT)
    await writeFile(process.env.NEXUS_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2) + '\n');
