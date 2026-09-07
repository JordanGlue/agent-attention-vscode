'use strict';

const fs = require('fs');
const path = require('path');

// appRoot comes from vscode.env.appRoot, so this checks the running build,
// not an older installation or just the durable copies in the user profile.
function checkWorkbench(appRoot) {
  const issues = [];
  try {
    const directory = path.join(appRoot, 'out/vs/code/electron-browser/workbench');
    const html = fs.readFileSync(path.join(directory, 'workbench.html'), 'utf8');
    for (const extension of ['js', 'css']) {
      const name = `agent-attention-renderer.${extension}`;
      if (!html.includes(`./${name}?v=`)) issues.push(`Workbench does not load ${name}`);
      if (!fs.existsSync(path.join(directory, name))) issues.push(`Missing ${name}`);
    }
    if (issues.length === 0) {
      const renderer = fs.readFileSync(path.join(directory, 'agent-attention-renderer.js'), 'utf8');
      const version = renderer.match(/const VERSION = "([^"]+)"/)?.[1];
      if (!version || !['js', 'css'].every(extension =>
        html.includes(`./agent-attention-renderer.${extension}?v=${version}"`))) {
        issues.push('Workbench renderer cache versions do not match');
      }
    }
  } catch (error) {
    issues.push(`Could not inspect workbench: ${error.message}`);
  }
  return issues;
}

module.exports = { checkWorkbench };

if (require.main === module) {
  const issues = checkWorkbench(process.argv[2]);
  if (issues.length) {
    console.error(issues.join('\n'));
    process.exitCode = 1;
  }
}
