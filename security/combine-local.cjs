// 隔離テスト用：本番の「prepare」と同じ差し込み方で、手元の仮の旧ルールに personal.rules を足す。
// 本番のルールは読まない・書かない。使い方: node security/combine-local.cjs security/legacy-standin.rules
const fs = require('node:fs');
const path = require('node:path');
let base = fs.readFileSync(process.argv[2] || path.join(__dirname, 'legacy-standin.rules'), 'utf8');
if (!base.includes('function isOwner()')) throw Error('stand-in must define isOwner()');
if (process.argv.includes('--private')) {
  // 架空の管理文書パスを加え、移行後の本人限定ルールも隔離検査する。
  base = base.replace(/\}\s*\}\s*$/, 'match /config/owners { allow get: if request.auth != null; }\n  }\n}');
  base = require('../scripts/legacy-private-rules.cjs').privateRules(base);
}
const clean = base.replace(/\s*\/\/ HIBIRUKA_PERSONAL_V1_BEGIN[\s\S]*?\/\/ HIBIRUKA_PERSONAL_V1_END\s*/, '\n');
const source = clean.replace(/\}\s*\}\s*$/, () => fs.readFileSync(path.join(__dirname, 'personal.rules'), 'utf8') + '\n  }\n}\n');
fs.writeFileSync('/tmp/hibiruka-combined.rules', source);
console.log('Wrote /tmp/hibiruka-combined.rules for the local emulator only.');
