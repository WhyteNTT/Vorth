'use strict';

/** Loads every module so a syntax error or bad import fails loudly. */
process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');

const roots = ['src'];
const files = [];
for (const root of roots) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('_')) files.push(full);
    }
  };
  walk(root);
}

let failures = 0;
for (const file of files) {
  try {
    require(path.resolve(file));
    console.log(`  ok   ${file}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${file}\n       ${err.message}`);
  }
}

console.log(`\n${files.length - failures}/${files.length} modules loaded`);
process.exit(failures ? 1 : 0);