// Copies SignInCheck6492's creation code to the service (src/auth/), which has
// no build step. Run after changing the contract: npm run export:signin-check
// test/signInCheck.test.js fails if the copy and the compiled contract differ.
import { readFileSync, writeFileSync } from 'node:fs';

const art = JSON.parse(readFileSync(new URL('../artifacts/contracts/SignInCheck6492.sol/SignInCheck6492.json', import.meta.url)));
const out = new URL('../../src/auth/signInCheck6492.json', import.meta.url);
writeFileSync(out, JSON.stringify({
  note: 'Creation code of contracts/contracts/SignInCheck6492.sol, run only in a read-only eth_call. Regenerate with `npm run export:signin-check` in contracts/.',
  bytecode: art.bytecode,
}, null, 2) + '\n');
console.log('wrote', out.pathname, (art.bytecode.length - 2) / 2, 'bytes');
