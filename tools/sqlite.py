"""Create an inspectable relational snapshot from a Nexus evidence export.

The Node verifier reparses the embedded source and compares the whole evidence
object before producing rows. Database publication refuses an existing target.
The hashes establish internal consistency, not the identity of the source owner.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

SCHEMA='''
PRAGMA foreign_keys=ON;
CREATE TABLE sources (id TEXT PRIMARY KEY, filename TEXT NOT NULL, format TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), bytes INTEGER NOT NULL CHECK(bytes>=0),
 original_text TEXT NOT NULL, interpretation_json TEXT);
CREATE TABLE contacts (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
 ordinal INTEGER NOT NULL CHECK(ordinal>0), name TEXT NOT NULL, organisation TEXT NOT NULL,
 title TEXT NOT NULL, note TEXT NOT NULL, source_line_start INTEGER NOT NULL,
 source_line_end INTEGER NOT NULL, record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
 original_record TEXT NOT NULL, UNIQUE(source_id,ordinal));
CREATE TABLE contact_values (contact_id TEXT NOT NULL REFERENCES contacts(id), kind TEXT NOT NULL,
 ordinal INTEGER NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, components_json TEXT,
 PRIMARY KEY(contact_id,kind,ordinal));
CREATE TABLE source_properties (contact_id TEXT NOT NULL REFERENCES contacts(id), ordinal INTEGER NOT NULL,
 name TEXT NOT NULL, property_group TEXT NOT NULL, value TEXT NOT NULL, original_property TEXT NOT NULL,
 source_line INTEGER NOT NULL, PRIMARY KEY(contact_id,ordinal));
CREATE TABLE shared_groups (id TEXT PRIMARY KEY, kind TEXT NOT NULL, normalised_key TEXT NOT NULL);
CREATE TABLE shared_members (group_id TEXT NOT NULL REFERENCES shared_groups(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
 PRIMARY KEY(group_id,contact_id));
CREATE TABLE findings (source_id TEXT NOT NULL REFERENCES sources(id), ordinal INTEGER NOT NULL,
 code TEXT NOT NULL, message TEXT NOT NULL, source_line INTEGER NOT NULL, severity TEXT NOT NULL,
 PRIMARY KEY(source_id,ordinal));
CREATE INDEX contacts_name ON contacts(name COLLATE NOCASE);
CREATE INDEX values_kind_value ON contact_values(kind,value);
CREATE VIEW shared_detail_review AS
 SELECT g.kind,g.normalised_key,c.name,c.id,c.source_line_start,c.record_sha256
 FROM shared_groups g JOIN shared_members m ON m.group_id=g.id JOIN contacts c ON c.id=m.contact_id;
'''

def build(evidence:Path,output:Path):
    """Build a new SQLite database from an evidence export.

    Args:
        evidence: A JSON file written by the evidence export.
        output: The database to create. It must not exist.

    Returns:
        A summary of the created database.

    Raises:
        ValueError: The output exists, the evidence fails verification, or the
            integrity check fails.
    """
    if output.exists() or output.is_symlink():
        raise ValueError('Output already exists. Choose a new filename.')
    verification=subprocess.run(['node',str(Path(__file__).with_name('relational.mjs')),str(evidence)],capture_output=True,timeout=120,check=False)
    if verification.returncode:
        raise ValueError(verification.stderr.decode('utf-8','replace').strip())
    data=json.loads(verification.stdout)
    output.parent.resolve(strict=True)
    descriptor,tempname=tempfile.mkstemp(prefix='.nexus-sqlite-',suffix='.tmp',dir=output.parent)
    os.close(descriptor)
    temporary=Path(tempname)
    try:
        connection=sqlite3.connect(temporary)
        try:
            connection.executescript(SCHEMA)
            with connection:
                s=data['source']
                connection.execute('INSERT INTO sources VALUES (?,?,?,?,?,?,?)',(s['id'],s['name'],s['format'],s['sha256'],s['bytes'],s['text'],json.dumps(s['interpretation'],ensure_ascii=False)))
                connection.executemany('INSERT INTO contacts VALUES (?,?,?,?,?,?,?,?,?,?,?)',[(c['id'],c['source_id'],c['ordinal'],c['name'],c['organisation'],c['title'],c['note'],c['source_line_start'],c['source_line_end'],c['record_sha256'],c['raw']) for c in data['contacts']])
                connection.executemany('INSERT INTO contact_values VALUES (?,?,?,?,?,?)',[(v['contact_id'],v['kind'],v['ordinal'],v['label'],v['value'],json.dumps(v['components'],ensure_ascii=False)) for v in data['values']])
                connection.executemany('INSERT INTO source_properties VALUES (?,?,?,?,?,?,?)',[(v['contact_id'],v['ordinal'],v['name'],v['group'],v['value'],v['raw'],v['source_line']) for v in data['properties']])
                for group in data['groups']:
                    connection.execute('INSERT INTO shared_groups VALUES (?,?,?)',(group['id'],group['kind'],group['key']))
                    connection.executemany('INSERT INTO shared_members VALUES (?,?)',[(group['id'],member) for member in group['members']])
                connection.executemany('INSERT INTO findings VALUES (?,?,?,?,?,?)',[(s['id'],i+1,d['code'],d['message'],d['line'],d['severity']) for i,d in enumerate(data['findings'])])
            if connection.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or connection.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('The relational integrity check failed.')
        finally:
            connection.close()
        with temporary.open('rb') as handle:
            os.fsync(handle.fileno())
        # Hard-link publication is atomic and refuses a target that appears during
        # verification. The temporary file lives on the same filesystem.
        os.link(temporary,output)
        return {'created':str(output),'contacts':len(data['contacts']),'sourceSha256':s['sha256'],'sampledFindings':len(data['findings']),'totalFindings':data['issueCount']}
    finally:
        temporary.unlink(missing_ok=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='Create a new SQLite snapshot from an evidence export.')
    parser.add_argument('evidence',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    try:
        print(json.dumps(build(args.evidence,args.output)))
    except (ValueError,OSError,subprocess.SubprocessError,json.JSONDecodeError) as error:
        parser.exit(1,f'{error}\n')
