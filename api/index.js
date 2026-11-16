// GET / -> preflight {ok:true, protocolVersion:"v1"}
// (covers a preflight that hits the bare domain root instead of /api/task)
import { PREFLIGHT } from '../src/handler.js';

export default function handler(req, res) {
  res.status(200).json(PREFLIGHT);
}
