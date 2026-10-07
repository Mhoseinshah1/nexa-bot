#!/usr/bin/env node
/**
 * The rehearsal harness's reader for P7's machine-readable report (Item 16).
 *
 *   node scripts/legacy-rehearsal-report-check.mjs validate SCHEMA.json REPORT.json
 *   node scripts/legacy-rehearsal-report-check.mjs get REPORT.json dotted.path
 *
 * `validate` checks the report against docs/legacy-migration/final-report.schema.json (or
 * final-report-v2.schema.json, which carries version 1 by a `$ref` to that file) and
 * prints one line per violation (exit 1 if any). It implements exactly the JSON Schema
 * keywords that schema uses — type, const, enum, pattern, maxLength, minimum, required,
 * properties, additionalProperties, propertyNames, items, uniqueItems, oneOf, $ref — and
 * REFUSES a schema that uses any other keyword, so a schema change cannot silently weaken
 * the check. (No validator library is a dependency of this repository.)
 *
 * `get` prints one value (`absent` when the path does not exist), for the harness's checks.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const KNOWN = new Set([
  '$schema',
  '$id',
  '$defs',
  'title',
  'description',
  'format',
  'type',
  'const',
  'enum',
  'pattern',
  'maxLength',
  'minimum',
  'required',
  'properties',
  'additionalProperties',
  'propertyNames',
  'items',
  'uniqueItems',
  'oneOf',
  '$ref',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(want, value) {
  const got = typeOf(value);
  return want === got || (want === 'number' && got === 'integer');
}

/**
 * Every violation of `schema` (a sub-schema of `root`, by default `root` itself). A `$ref`
 * is either `#/$defs/NAME` inside the schema being walked, or the FILE NAME of a sibling
 * schema given in `refs` (`final-report-v2.schema.json` carries version 1 as `core` that
 * way); inside a referenced file its own `$defs` apply.
 */
export function validate(root, value, schema = root, refs = {}) {
  const errors = [];
  const resolve = (schema, at) => {
    if (schema.$ref === undefined) return [schema, at];
    if (schema.$ref.startsWith('#/$defs/')) {
      const name = schema.$ref.slice('#/$defs/'.length);
      const target = at.$defs?.[name];
      if (target === undefined) throw new Error(`unresolvable $ref ${schema.$ref}`);
      return resolve(target, at);
    }
    if (schema.$ref.startsWith('#')) throw new Error(`unsupported $ref ${schema.$ref}`);
    const external = refs[schema.$ref];
    if (external === undefined) throw new Error(`unresolvable $ref ${schema.$ref}`);
    return resolve(external, external);
  };
  const walk = (raw, v, path, at) => {
    const [s, base] = resolve(raw, at);
    for (const key of Object.keys(s)) {
      if (!KNOWN.has(key)) throw new Error(`schema keyword "${key}" at ${path} is not supported`);
    }
    const fail = (why) => errors.push(`${path || '<root>'}: ${why}`);
    if (s.oneOf !== undefined) {
      const ok = s.oneOf.filter((option) => validate(base, v, option, refs).length === 0).length;
      if (ok !== 1) fail(`matches ${String(ok)} of the oneOf options, not exactly one`);
      return;
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeMatches(t, v))) {
        fail(`is ${typeOf(v)}, not ${types.join('|')}`);
        return;
      }
    }
    if (s.const !== undefined && v !== s.const) fail(`must be ${JSON.stringify(s.const)}`);
    if (s.enum !== undefined && !s.enum.includes(v)) fail(`must be one of ${s.enum.join(', ')}`);
    if (typeof v === 'string') {
      if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v))
        fail(`does not match ${s.pattern}`);
      if (s.maxLength !== undefined && v.length > s.maxLength) fail(`longer than ${s.maxLength}`);
    }
    if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum)
      fail(`below ${s.minimum}`);
    if (Array.isArray(v)) {
      if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length)
        fail('items are not unique');
      if (s.items !== undefined) v.forEach((item, i) => walk(s.items, item, `${path}[${i}]`, base));
    }
    if (typeOf(v) === 'object') {
      for (const key of s.required ?? []) if (!(key in v)) fail(`missing required "${key}"`);
      for (const [key, child] of Object.entries(v)) {
        const at2 = path ? `${path}.${key}` : key;
        if (
          s.propertyNames?.pattern !== undefined &&
          !new RegExp(s.propertyNames.pattern, 'u').test(key)
        )
          fail(`property name "${key}" does not match ${s.propertyNames.pattern}`);
        if (s.properties?.[key] !== undefined) walk(s.properties[key], child, at2, base);
        else if (s.additionalProperties === false) fail(`unexpected property "${key}"`);
        else if (typeof s.additionalProperties === 'object')
          walk(s.additionalProperties, child, at2, base);
      }
    }
  };
  walk(schema, value, '', root);
  return errors;
}

/** Every external `$ref` of a schema file, loaded from the schema's own directory. */
export function loadRefs(schemaPath, schema, refs = {}) {
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const ref = node.$ref;
    if (typeof ref === 'string' && !ref.startsWith('#') && refs[ref] === undefined) {
      if (!/^[a-z0-9][a-z0-9.-]{0,127}\.json$/u.test(ref))
        throw new Error(`unsupported $ref ${ref}`);
      const path = join(dirname(schemaPath), ref);
      refs[ref] = JSON.parse(readFileSync(path, 'utf8'));
      loadRefs(path, refs[ref], refs);
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(schema);
  return refs;
}

function get(value, path) {
  let at = value;
  for (const part of path.split('.')) {
    if (at === null || typeof at !== 'object' || !(part in at)) return 'absent';
    at = at[part];
  }
  return typeof at === 'object' ? JSON.stringify(at) : String(at);
}

function main(argv) {
  const [command, a, b] = argv;
  if (command === 'validate' && a && b) {
    const schema = JSON.parse(readFileSync(a, 'utf8'));
    const errors = validate(
      schema,
      JSON.parse(readFileSync(b, 'utf8')),
      schema,
      loadRefs(a, schema),
    );
    for (const error of errors) process.stdout.write(`${error}\n`);
    return errors.length === 0 ? 0 : 1;
  }
  if (command === 'get' && a && b) {
    process.stdout.write(`${get(JSON.parse(readFileSync(a, 'utf8')), b)}\n`);
    return 0;
  }
  process.stderr.write(
    'usage: legacy-rehearsal-report-check.mjs validate SCHEMA REPORT | get REPORT PATH\n',
  );
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
