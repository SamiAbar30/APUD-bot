/**
 * Shared-password access for a publicly reachable simulator.
 *
 * Enabled only when WCE_PUBLIC_PASSWORD is set. Without it the bridge behaves exactly as before,
 * so local development is unchanged. A quick tunnel URL is unauthenticated by default: anyone who
 * finds it could talk to the bot, spend model credits and probe the workflow, so a password gate
 * sits in front of both the page and the socket.
 */
const crypto = require("crypto");
const path = require("path");
const express = require("express");

const COOKIE = "wce_access";
const password = process.env.WCE_PUBLIC_PASSWORD || "";
// Rotates on restart: an old link stops working once the demo is over.
const token = crypto.randomBytes(24).toString("hex");

const readCookie = (header) => Object.fromEntries(
  String(header || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }),
);

const authorized = (request) => !password || readCookie(request.headers?.cookie)[COOKIE] === token;

const loginPage = (error) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulador APOD</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f5}
form{background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);display:grid;gap:12px;min-width:280px}
input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #ccc}button{background:#111;color:#fff;border:0;cursor:pointer}
p{color:#b00020;margin:0;font-size:14px}</style>
<form method="post" action="/login"><strong>Simulador APOD</strong>
${error ? "<p>Contraseña incorrecta</p>" : ""}
<input type="password" name="password" placeholder="Contraseña" autofocus required>
<button type="submit">Entrar</button></form>`;

/** Call before the bridge's own routes. */
function installPublicAccess(app, io) {
  if (!password) return { enabled: false };

  app.get("/login", (_request, response) => response.type("html").send(loginPage(false)));
  app.post("/login", express.urlencoded({ extended: false }), (request, response) => {
    const supplied = String(request.body?.password ?? "");
    const expected = Buffer.from(password);
    const given = Buffer.from(supplied.padEnd(expected.length).slice(0, expected.length));
    if (supplied.length !== password.length || !crypto.timingSafeEqual(expected, given)) {
      return response.status(401).type("html").send(loginPage(true));
    }
    response.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
    response.redirect("/");
  });

  // APOD posts outbound messages here with the shared emulator token. The source address proves
  // nothing: the tunnel connects from this machine, so every public request also looks local.
  // APOD sends this as its Bearer token (WA_ACCESS_TOKEN in .env.wce, WCE_APP_SECRET as fallback).
  const internalToken = process.env.WA_ACCESS_TOKEN || process.env.WCE_APP_SECRET || "";
  const internalRequest = (request) => {
    if (!["/send-to-emulator", "/clear-ui"].includes(request.path) || internalToken.length < 16) return false;
    const supplied = String(request.headers?.authorization || "").replace(/^Bearer\s+/i, "");
    if (supplied.length !== internalToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(internalToken));
  };

  app.use((request, response, next) => {
    if (authorized(request) || internalRequest(request)) return next();
    if (request.accepts("html") && request.method === "GET") return response.redirect("/login");
    return response.status(401).json({ error: "UNAUTHORIZED" });
  });

  // The browser sends the cookie with the socket handshake on the same origin.
  io.use((socket, next) => authorized(socket.request) ? next() : next(new Error("UNAUTHORIZED")));

  // The built chat UI is served from this same origin, so one public URL is enough.
  app.use(express.static(path.resolve(__dirname, "../emulator/dist")));
  return { enabled: true };
}

module.exports = { installPublicAccess };
