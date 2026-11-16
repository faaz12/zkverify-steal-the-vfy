// Vercel serverless entry for the Steal the VFY agent.
//
// POST /api/task -> turn handler (HMAC verify -> decide -> prove -> sign)
// GET  /api/task -> preflight {ok:true, protocolVersion:"v1"}
//
// bodyParser is DISABLED: HMAC verification needs the exact raw body.
import { createHandler, PREFLIGHT } from '../src/handler.js';
import { TurnStore } from '../src/store.js';

export const config = { api: { bodyParser: false } };

let handlerPromise = null;
async function getHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const store = new TurnStore();
      await store.load();
      return createHandler({ hmacSecret: process.env.HMAC_SECRET, store });
    })();
  }
  return handlerPromise;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json(PREFLIGHT);
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const { handleTask } = await getHandler();
    const rawBody = await readRawBody(req);
    const result = await handleTask(rawBody, req.headers);
    if (result.signature) res.setHeader('x-agent-games-signature', result.signature);
    res.status(result.status).json(result.body);
  } catch (e) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'api/task', msg: 'handler threw', error: String(e).slice(0, 300) }));
    // createHandler throws at startup if HMAC_SECRET is missing — that is
    // a deploy misconfiguration, not a turn failure.
    res.status(500).json({ error: 'internal error' });
  }
}
