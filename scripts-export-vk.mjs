import * as snarkjs from 'snarkjs';
import fs from 'node:fs';
const vk = await snarkjs.zKey.exportVerificationKey('circuits/vfy-policy_final.zkey');
fs.writeFileSync('circuits/vk.json', JSON.stringify(vk, null, 2));
console.log('protocol:', vk.protocol, 'curve:', vk.curve, 'nPublic:', vk.nPublic, 'IC len:', vk.IC.length);
