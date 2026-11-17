/* 从前端 mock 数据导出服务端种子，避免内容存在两套手工维护的副本 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dataFile = path.join(root, 'prototype', 'data.js');
const outputFile = path.join(root, 'server', 'seed.json');
const source = fs.readFileSync(dataFile, 'utf8');
const sandbox = {};

vm.createContext(sandbox);
vm.runInContext(`${source}\n;globalThis.__seed = { TAXONOMY, TRIPS };`, sandbox, {
  filename: dataFile
});

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(sandbox.__seed, null, 2) + '\n');
console.log(`wrote ${path.relative(root, outputFile)} (${sandbox.__seed.TRIPS.length} trips)`);
