import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A GitHub Actions job, run the way GitHub runs it, for the parts of GitHub
 * this repo's workflow leans on. Test utility, zero dependencies.
 *
 * Why it exists: the autofix job's safety properties live in its step `if:`
 * conditions and in how outputs flow between steps (a token minted only on
 * `decision=push`, a guard whose `proceed=false` must stop every later step).
 * A regex over the YAML proves only that the source says something; running
 * the steps proves what happens. `bash -n` and byte-parity see neither.
 *
 * Reads: a rendered workflow's text, a context (event, secrets), handlers for
 *        the `uses:` steps.
 * Writes: runs every `run:` block with bash exactly as GitHub does
 *         (`bash --noprofile --norc -eo pipefail`), in the caller's cwd.
 * Does NOT: fetch actions, talk to GitHub, or fake a `run:` block. A `uses:`
 *           step with no handler throws; so does any YAML or expression form it
 *           does not know. A silently skipped key or a guessed operator would
 *           make every assertion that depends on it vacuous.
 */

// ---- a loud parser for the YAML subset the workflow uses -------------------

const isSkippable = (l) => l.trim() === '' || /^\s*#/.test(l);
const indentOf = (l) => l.length - l.trimStart().length;

function parseScalar(raw, lineNo) {
  const s = raw.trim();
  if (s === '{}') return {};
  if (s === '[]') return [];
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(s);
    if (!m) throw new Error(`yaml subset: bad double-quoted scalar at line ${lineNo}: ${s}`);
    return m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(s);
    if (!m) throw new Error(`yaml subset: bad single-quoted scalar at line ${lineNo}: ${s}`);
    return m[1].replace(/''/g, "'");
  }
  if (/^[[{]/.test(s)) throw new Error(`yaml subset: flow collections are not supported (line ${lineNo}): ${s}`);
  // A plain scalar ends at a ` #` comment (the `# vX.Y.Z` beside a SHA pin).
  const hash = s.search(/\s#/);
  return (hash >= 0 ? s.slice(0, hash) : s).trim();
}

/**
 * Parse the `jobs:` mapping of a workflow. Only the jobs subtree is parsed:
 * the `on:` block uses flow sequences this parser deliberately does not know.
 */
export function parseJobs(workflowText) {
  const lines = workflowText.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) throw new Error('yaml subset: no top-level `jobs:` key');
  let i = start + 1;

  const skip = () => { while (i < lines.length && isSkippable(lines[i])) i++; };

  function parseNode(minIndent) {
    skip();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < minIndent) return null;
    return lines[i].trimStart().startsWith('- ') ? parseSeq(ind) : parseMap(ind);
  }

  function parseBlockScalar(keyIndent, style, chomp) {
    i++; // past the `key: |` line
    const body = [];
    let blockIndent = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { body.push(''); i++; continue; }
      const ind = indentOf(l);
      if (blockIndent === null) {
        if (ind <= keyIndent) break;
        blockIndent = ind;
      }
      if (ind < blockIndent) break;
      body.push(l.slice(blockIndent));
      i++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    let text;
    if (style === '|') {
      text = body.join('\n');
    } else {
      // Folded: a line break between two non-empty lines becomes a space; an
      // empty line becomes a newline.
      text = '';
      for (let k = 0; k < body.length; k++) {
        if (body[k] === '') text += '\n';
        else text += (k > 0 && body[k - 1] !== '' ? ' ' : '') + body[k];
      }
    }
    return chomp === '-' ? text : `${text}\n`;
  }

  function parseMap(indent) {
    const obj = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`yaml subset: unexpected indentation at line ${i + 1}: ${JSON.stringify(l)}`);
      if (l.trimStart().startsWith('- ')) break; // a sibling sequence item ends this item's mapping
      const m = /^ *([A-Za-z0-9_.-]+):(?:[ \t]+(.*?))?[ \t]*$/.exec(l);
      if (!m) throw new Error(`yaml subset: not a mapping entry at line ${i + 1}: ${JSON.stringify(l)}`);
      const [, key, raw] = m;
      if (key in obj) throw new Error(`yaml subset: duplicate key "${key}" at line ${i + 1}`);
      if (raw === undefined || raw === '') {
        i++;
        obj[key] = parseNode(indent + 1);
        continue;
      }
      const block = /^([|>])([-+]?)(?:\s+#.*)?$/.exec(raw);
      if (block) {
        obj[key] = parseBlockScalar(indent, block[1], block[2]);
        continue;
      }
      obj[key] = parseScalar(raw, i + 1);
      i++;
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent || !l.trimStart().startsWith('- ')) {
        throw new Error(`yaml subset: expected a sequence item at line ${i + 1}: ${JSON.stringify(l)}`);
      }
      // `- key: value` opens a mapping whose keys sit two columns in.
      lines[i] = ' '.repeat(indent + 2) + l.trimStart().slice(2);
      arr.push(parseMap(indent + 2));
    }
    return arr;
  }

  const jobs = parseMap(2);
  if (i < lines.length) throw new Error(`yaml subset: unparsed content from line ${i + 1}: ${JSON.stringify(lines[i])}`);
  return jobs;
}

// ---- GitHub's expression language (the parts the workflow uses) -----------

const STATUS_FNS = /\b(success|failure|cancelled|always)\s*\(/;

function tokenize(src) {
  const toks = [];
  let p = 0;
  while (p < src.length) {
    const c = src[p];
    if (/\s/.test(c)) { p++; continue; }
    const two = src.slice(p, p + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) { toks.push({ t: 'op', v: two }); p += 2; continue; }
    if ('!<>(),.[]'.includes(c)) { toks.push({ t: 'op', v: c }); p++; continue; }
    if (c === "'") {
      let s = '';
      p++;
      for (;;) {
        if (p >= src.length) throw new Error(`expression: unterminated string in: ${src}`);
        if (src[p] === "'") {
          if (src[p + 1] === "'") { s += "'"; p += 2; continue; }
          p++;
          break;
        }
        s += src[p++];
      }
      toks.push({ t: 'str', v: s });
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(src.slice(p));
    if (num) { toks.push({ t: 'num', v: Number(num[0]) }); p += num[0].length; continue; }
    // Identifiers may contain `-` after the first character (`app-slug`).
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(p));
    if (id) { toks.push({ t: 'id', v: id[0] }); p += id[0].length; continue; }
    throw new Error(`expression: unexpected character "${c}" in: ${src}`);
  }
  return toks;
}

const truthy = (v) => !(v === false || v === 0 || v === '' || v === null || v === undefined || Number.isNaN(v));

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v);
  return NaN;
}

// GitHub: strings compare case-insensitively; mismatched types coerce to
// numbers; objects are equal only to themselves.
function looseEquals(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') return a === b;
  if (typeof a === typeof b && a !== null && typeof a !== 'object') return a === b;
  return toNumber(a) === toNumber(b);
}

function property(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return null;
  if (Object.hasOwn(obj, key)) return obj[key] ?? null;
  const found = Object.keys(obj).find((k) => k.toLowerCase() === String(key).toLowerCase());
  return found === undefined ? null : obj[found] ?? null;
}

const CONTEXTS = new Set(['github', 'env', 'steps', 'secrets', 'inputs', 'vars', 'job', 'runner']);

export function evaluate(expression, ctx) {
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(expression);
  const src = whole && !whole[1].includes('${{') ? whole[1] : expression;
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const accept = (v) => (toks[p] && toks[p].t === 'op' && toks[p].v === v ? (p++, true) : false);
  const expect = (v) => { if (!accept(v)) throw new Error(`expression: expected "${v}" in: ${src}`); };

  const fns = {
    success: () => !ctx.jobFailed,
    failure: () => ctx.jobFailed,
    always: () => true,
    cancelled: () => false,
    startsWith: (s, x) => String(s ?? '').toLowerCase().startsWith(String(x ?? '').toLowerCase()),
    endsWith: (s, x) => String(s ?? '').toLowerCase().endsWith(String(x ?? '').toLowerCase()),
    contains: (s, x) => (Array.isArray(s)
      ? s.some((e) => looseEquals(e, x))
      : String(s ?? '').toLowerCase().includes(String(x ?? '').toLowerCase())),
  };

  function primary() {
    const t = peek();
    if (!t) throw new Error(`expression: unexpected end of: ${src}`);
    if (accept('(')) { const v = or(); expect(')'); return v; }
    p++;
    if (t.t === 'str' || t.t === 'num') return t.v;
    if (t.t !== 'id') throw new Error(`expression: unexpected "${t.v}" in: ${src}`);
    if (t.v === 'true') return true;
    if (t.v === 'false') return false;
    if (t.v === 'null') return null;
    if (accept('(')) {
      const fn = fns[t.v];
      if (!fn) throw new Error(`expression: unsupported function ${t.v}() in: ${src}`);
      const args = [];
      if (!accept(')')) {
        do args.push(or()); while (accept(','));
        expect(')');
      }
      return fn(...args);
    }
    if (!CONTEXTS.has(t.v)) throw new Error(`expression: unknown context "${t.v}" in: ${src}`);
    return ctx[t.v] ?? {};
  }
  function postfix() {
    let v = primary();
    for (;;) {
      if (accept('.')) {
        const t = peek();
        if (!t || t.t !== 'id') throw new Error(`expression: expected a property name in: ${src}`);
        p++;
        v = property(v, t.v);
      } else if (accept('[')) {
        const k = or();
        expect(']');
        v = property(v, k);
      } else {
        return v;
      }
    }
  }
  function unary() { return accept('!') ? !truthy(unary()) : postfix(); }
  function compare() {
    let l = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !['<', '<=', '>', '>='].includes(t.v)) return l;
      p++;
      const r = unary();
      const [a, b] = [toNumber(l), toNumber(r)];
      l = t.v === '<' ? a < b : t.v === '<=' ? a <= b : t.v === '>' ? a > b : a >= b;
    }
  }
  function equality() {
    let l = compare();
    for (;;) {
      if (accept('==')) l = looseEquals(l, compare());
      else if (accept('!=')) l = !looseEquals(l, compare());
      else return l;
    }
  }
  function and() {
    let l = equality();
    while (accept('&&')) { const r = equality(); l = truthy(l) ? r : l; }
    return l;
  }
  function or() {
    let l = and();
    while (accept('||')) { const r = and(); l = truthy(l) ? l : r; }
    return l;
  }

  const value = or();
  if (p !== toks.length) throw new Error(`expression: trailing tokens in: ${src}`);
  return value;
}

export function toText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Substitute every `${{ }}` in a string, as GitHub does before a step runs. */
export function interpolate(text, ctx) {
  return String(text).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, inner) => toText(evaluate(inner, ctx)));
}

/**
 * Evaluate an `if:` the way GitHub does: a condition that calls no status
 * function carries an implicit `success() &&`, so it is skipped once an
 * earlier step has failed.
 */
export function conditionHolds(condition, ctx) {
  if (condition === null || condition === undefined || condition === '') return truthy(evaluate('success()', ctx));
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(String(condition));
  const src = whole ? whole[1] : String(condition);
  return truthy(evaluate(STATUS_FNS.test(src) ? src : `success() && (${src})`, ctx));
}

// ---- running a job -----------------------------------------------------------

function parseStepOutputs(text) {
  const out = {};
  const lines = text.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (!l) continue;
    const heredoc = /^([^=]+?)<<(.+)$/.exec(l);
    if (heredoc) {
      const body = [];
      k++;
      while (k < lines.length && lines[k] !== heredoc[2]) body.push(lines[k++]);
      out[heredoc[1]] = body.join('\n');
      continue;
    }
    const eq = l.indexOf('=');
    if (eq < 0) throw new Error(`GITHUB_OUTPUT line not understood: ${JSON.stringify(l)}`);
    out[l.slice(0, eq)] = l.slice(eq + 1);
  }
  return out;
}

function runBash(script, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd, env });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

const STEP_KEYS = new Set(['name', 'id', 'if', 'uses', 'with', 'env', 'run', 'continue-on-error', 'timeout-minutes']);

/**
 * Run one job of a parsed workflow.
 *
 * `github` and `secrets` become the expression contexts; `uses` maps an
 * action (the part before `@`) to an async handler `({with, env, cwd}) =>
 * ({exitCode, outputs, output})`; `env` is the process environment every
 * `run:` block starts from (PATH with stubs, git isolation, ...).
 *
 * Returns every step with what it saw and did, so a test can assert on
 * skipped steps, on the exact env a step was given, and on the job result.
 */
export async function runJob(jobs, jobName, { github, secrets = {}, uses = {}, cwd, env = process.env }) {
  const job = jobs[jobName];
  if (!job) throw new Error(`no job "${jobName}"`);
  const scratch = mkdtempSync(join(tmpdir(), 'ds-sim-'));
  const ctx = { github, secrets, env: {}, steps: {}, inputs: {}, vars: {}, job: {}, runner: {}, jobFailed: false };

  if (!conditionHolds(job.if, ctx)) return { skipped: true, steps: [], failed: false, jobEnv: {} };
  for (const [k, v] of Object.entries(job.env ?? {})) ctx.env[k] = interpolate(v, ctx);

  const steps = [];
  let n = 0;
  for (const step of job.steps) {
    n++;
    for (const k of Object.keys(step)) {
      if (!STEP_KEYS.has(k)) throw new Error(`step "${step.name}": key "${k}" is not simulated`);
    }
    if (Boolean(step.run) === Boolean(step.uses)) throw new Error(`step "${step.name}": needs exactly one of run/uses`);
    const id = step.id ?? `__step${n}`;
    const record = { id, name: step.name, uses: step.uses ?? null, status: 'skipped', env: {}, with: {}, output: '' };
    steps.push(record);

    if (!conditionHolds(step.if, ctx)) {
      ctx.steps[id] = { outputs: {}, outcome: 'skipped', conclusion: 'skipped' };
      continue;
    }

    const stepCtx = { ...ctx, env: { ...ctx.env } };
    for (const [k, v] of Object.entries(step.env ?? {})) record.env[k] = interpolate(v, ctx);
    Object.assign(stepCtx.env, record.env);

    let exitCode;
    let outputs = {};
    if (step.run) {
      const script = join(scratch, `step${n}.sh`);
      const outFile = join(scratch, `output${n}`);
      writeFileSync(script, interpolate(step.run, stepCtx));
      writeFileSync(outFile, '');
      const res = await runBash(script, {
        cwd,
        env: {
          ...env,
          GITHUB_OUTPUT: outFile,
          GITHUB_ENV: join(scratch, 'github_env'),
          GITHUB_WORKSPACE: cwd,
          GITHUB_REPOSITORY: github.repository,
          GITHUB_EVENT_NAME: github.event_name,
          CI: 'true',
          ...ctx.env,
          ...record.env,
        },
      });
      exitCode = res.exitCode;
      record.output = res.output;
      outputs = parseStepOutputs(readFileSync(outFile, 'utf8'));
    } else {
      const action = step.uses.split('@')[0];
      const handler = uses[action];
      if (!handler) throw new Error(`step "${step.name}": no handler for uses: ${step.uses}`);
      for (const [k, v] of Object.entries(step.with ?? {})) record.with[k] = interpolate(v, stepCtx);
      const res = await handler({ with: record.with, env: stepCtx.env, cwd });
      exitCode = res.exitCode ?? 0;
      outputs = res.outputs ?? {};
      record.output = res.output ?? '';
    }

    const outcome = exitCode === 0 ? 'success' : 'failure';
    const continueOnError = truthy(evaluate(String(step['continue-on-error'] ?? 'false'), ctx));
    const conclusion = outcome === 'failure' && continueOnError ? 'success' : outcome;
    Object.assign(record, { status: outcome, exitCode, outputs });
    ctx.steps[id] = { outputs, outcome, conclusion };
    if (conclusion === 'failure') ctx.jobFailed = true;
  }
  return { skipped: false, steps, failed: ctx.jobFailed, jobEnv: ctx.env };
}
