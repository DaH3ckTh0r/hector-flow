import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { handle } from "./routes.js";

/** Servidor HTTP mínimo sobre el enrutador puro de routes.js. */
export function start(port = 3000) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "json_invalido" }));
      return;
    }
    const result = handle({ method: req.method, path: req.url, body });
    res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
  });
  return server.listen(port, () => console.log(`tienda-api escuchando en http://localhost:${port}`));
}

// Solo arranca si se ejecuta directamente (npm start), no al importarlo.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
