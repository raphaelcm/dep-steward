'use strict';

/*
 * Fills the install-time placeholders of the two agent prompts, in code, so
 * only the taken branch of each reaches the model:
 *
 *   __WHITELIST_HUMAN__  the managed ecosystems (ecosystems.cjs, from ROOT_FILES)
 *   __ASSIGN_FLAG__      ` --add-assignee <login>`, or nothing
 *   __ASSIGN_NOTE__      the sentence saying who that notifies, or nothing
 *
 * Reads: ROOT_FILES, ASSIGNEE, and the template named by argv[2].
 * Writes: the filled prompt to stdout. Touches nothing else. The per-run
 * values ($PR_NUMBER, $PR_AUTHOR) are filled later by the step that loads the
 * prompt, as before.
 */

const fs = require('fs');
const { ecosystemsFromEnv } = require('./ecosystems.cjs');

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

function render(template, env) {
  const assignee = (env.ASSIGNEE || '').trim();
  if (assignee && !LOGIN.test(assignee)) throw new Error(`assignee "${assignee}" is not a GitHub login`);
  const flag = assignee ? ` --add-assignee ${assignee}` : '';
  const note = assignee ? `, which also assigns \`${assignee}\` so GitHub notifies them` : '';
  let out = template.split('__ASSIGN_FLAG__').join(flag).split('__ASSIGN_NOTE__').join(note);
  if (out.includes('__WHITELIST_HUMAN__')) {
    out = out.split('__WHITELIST_HUMAN__').join(ecosystemsFromEnv(env).human);
  }
  return out;
}

if (require.main === module) {
  process.stdout.write(render(fs.readFileSync(process.argv[2], 'utf8'), process.env));
}

module.exports = { render };
