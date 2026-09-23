/**
 * Manual verification against a *running* harness host.
 *
 * Not part of `node --test`. It proves the plugin is actually activated inside a
 * live host — not merely that its module imports — by asking the host's own
 * `pluginInventory` Remote service for the loader's current entry states.
 *
 *   cd "$DSH_HOME/profiles/web"
 *   node "D:\path\to\dsh-plugin-init\test\live-host.manual.mjs" http://127.0.0.1:45999 <token>
 *
 * The token is the `?token=` value the host prints on startup. Both the auth
 * cookie exchange and the RPC envelope mirror what the browser client does
 * (`@deepseek-ai/dsh-client-connection`: POST /api/<endpoint> with a
 * `client-request` envelope carrying `{ args }`).
 */

import { randomUUID } from "node:crypto";

const [origin, token] = process.argv.slice(2);
if (origin === undefined || token === undefined) {
  console.error("usage: node test/live-host.manual.mjs <origin> <token>");
  process.exit(2);
}

// The host answers the token exchange with a redirect once the cookie is set.
const page = await fetch(`${origin}/?token=${token}`, { redirect: "manual" });
if (page.status !== 303 && !page.ok) throw new Error(`auth exchange failed: HTTP ${page.status}`);
const cookie = (page.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
if (cookie.length === 0) throw new Error("auth exchange returned no cookie");
await page.arrayBuffer();

async function call(endpoint, args) {
  const rpcId = randomUUID();
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } })
  });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.rpcId !== rpcId) throw new Error(`${endpoint}: rpcId mismatch`);
  if (body.result.ok !== true) {
    throw new Error(`${endpoint}: ${body.result.error.code}: ${body.result.error.message}`);
  }
  return body.result.value;
}

const value = await call("pluginInventory/list", {});
const flat = JSON.stringify(value);
console.log("payload bytes:", flat.length);
console.log("payload mentions dsh-plugin-init:", flat.includes("dsh-plugin-init"));

const entries = Array.isArray(value) ? value : (value?.entries ?? value?.plugins ?? []);
console.log("entry count:", Array.isArray(entries) ? entries.length : "unknown shape");
console.log(JSON.stringify(entries.filter((entry) => JSON.stringify(entry).includes("dsh-plugin-init")), null, 2).slice(0, 4000));
