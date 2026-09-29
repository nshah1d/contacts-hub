import { readSource, writeNew } from './io.mjs';
import { parseLibrary, summaryOf, exportEvidence, exportTable } from '../public/js/core/engine.js';
import { invariant } from '../public/js/core/primitives.js';
const help = `Nexus inspection CLI

node tools/nexus.mjs contacts.vcf
node tools/nexus.mjs contacts.csv --format evidence --output evidence.json --include-content

Default output: counts, source hash and source findings. Content export is explicit.
Formats: evidence, table, original. Output files are never overwritten.
Options: --delimiter comma|semicolon|tab
`;
try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || !args.length) {
        console.log(help);
    }
    else {
        const filename = args.shift(), options = {};
        let format = null, output = null, include = false;
        while (args.length) {
            const flag = args.shift();
            if (flag === '--include-content')
                include = true;
            else if (flag === '--format')
                format = args.shift();
            else if (flag === '--output')
                output = args.shift();
            else if (flag === '--delimiter') {
                const delimiter = { comma: ',', semicolon: ';', tab: '\t' }[args.shift()];
                invariant(delimiter, 'Unknown delimiter.');
                options.delimiter = delimiter;
            }
            else
                throw new Error(`Unknown argument: ${flag}`);
        }
        const source = await readSource(filename), lib = parseLibrary(source.text, source.name, source.name, options);
        if (format || output) {
            invariant(include, 'Content export requires --include-content.');
            invariant(format && output, 'Choose both --format and --output.');
            invariant(['evidence', 'table', 'original'].includes(format), 'Unknown export format.');
            const data = format === 'evidence' ? exportEvidence(lib) : format === 'table' ? exportTable(lib) : lib.text;
            await writeNew(output, data);
            console.log(JSON.stringify({ created: output, format, records: lib.contacts.length }));
        }
        else {
            const summary = summaryOf(lib);
            console.log(JSON.stringify({ schemaVersion: 1, format: lib.format, bytes: lib.bytes, records: summary.count, writable: summary.writable,
                issues: summary.issueCount, sharedDetailGroups: summary.sharedGroups, coverage: summary.coverage }, null, 2));
        }
    }
}
catch (error) {
    console.error(error.code === 'EEXIST' ? 'Output already exists. Choose a new filename.' : error.message);
    process.exitCode = 1;
}
