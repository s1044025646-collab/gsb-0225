import { resolve } from "node:path";
import { getDb } from "./db.js";
import { createApp, listen } from "./server.js";

const dbPath = process.env.ROBOTS_DB_PATH ?? resolve("data/robots-lab.sqlite");
const configuredPort = Number(process.env.PORT ?? "0");
const port = Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 0;

const db = getDb(dbPath);
const server = createApp(db);
const actualPort = await listen(server, port);

console.log(JSON.stringify({
  service: "robots-lab",
  url: `http://127.0.0.1:${actualPort}`,
  port: actualPort,
  db: dbPath,
}, null, 2));
