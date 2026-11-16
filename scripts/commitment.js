// Print the strategy commitment hash for dashboard registration.
//
// The commitment is Poseidon([...strategyParams, salt]). Register the hash
// on the zkVerify dashboard when creating the Steal the VFY agent — the
// platform freezes it, and every turn's proof is checked against it.
//
// Usage:
//   STEAL_VFY_PARAMS=8,18,8,0,0,0,0,0 STEAL_VFY_SALT=<salt> npm run commitment
//
// Both hex and decimal are printed; use whichever format the dashboard
// field accepts (hex 0x... is the usual form). NEVER change params or salt
// after registering — the commitment is frozen and every proof would fail.
import { getStrategyConfig, computeCommitment } from '../src/strategy.js';

const { params, salt } = getStrategyConfig();
const c = await computeCommitment(params, salt);
console.log('Strategy Params :', params.map(String).join(','));
console.log('Salt            :', salt.toString());
console.log('Commitment (hex):', c.hex);
console.log('Commitment (dec):', c.decimal);
process.exit(0);
