// GET /api/health -> preflight {ok:true, protocolVersion:"v1"}
import { PREFLIGHT } from '../src/handler.js';

export default function handler(req, res) {
  res.status(200).json(PREFLIGHT);
}
