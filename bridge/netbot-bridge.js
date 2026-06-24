#!/usr/bin/env node
'use strict';

/**
 * Local netbot bridge — same controller path as the Firewalla mobile app.
 * Binds localhost only; array-firewalla-api exposes it on the LAN.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.NETBOT_BRIDGE_PORT || 8836);
const BIND = process.env.NETBOT_BRIDGE_BIND || '127.0.0.1';

const cloudWrapper = require('/home/pi/firewalla/api/routes/fastencipher2').cloudWrapper;
const redis = require('/home/pi/firewalla/util/redis_manager.js').getRedisClient();

let gid = process.env.FIREWALLA_GID || '';
let eid = process.env.FIREWALLA_EID || '';

function promisify(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function loadIdentity() {
  if (!gid) gid = await promisify(redis.hget.bind(redis), 'sys:ept', 'gid');
  if (!eid) eid = await promisify(redis.hget.bind(redis), 'sys:ept', 'eid');
  if (!gid || !eid) throw new Error('Firewalla gid/eid not found in sys:ept');
}

function msgId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildEnvelope(mtype, data, target) {
  const id = msgId();
  const payload = { ...(data || {}), eid };
  const obj = { mtype, data: payload, type: 'jsonmsg', id };
  if (target) obj.target = target;
  return {
    mtype: 'msg',
    message: {
      obj,
      type: 'jsondata',
      appInfo: { eid, version: '1.0' },
    },
  };
}

async function invokeNetbot(mtype, data, target) {
  await loadIdentity();
  const controller = await cloudWrapper.getNetBotController(gid);
  const resolvedTarget = target || (data && data.target) || undefined;
  return controller.msgHandlerAsync(gid, buildEnvelope(mtype, data, resolvedTarget));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && path === '/health') {
    try {
      await loadIdentity();
      sendJson(res, 200, { ok: true, gid, eid: eid.slice(0, 8) + '…' });
    } catch (err) {
      sendJson(res, 503, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (req.method === 'POST' && path === '/invoke') {
    try {
      const body = await readBody(req);
      const mtype = body.mtype;
      const data = body.data || {};
      if (!mtype) {
        sendJson(res, 400, { error: 'mtype required' });
        return;
      }
      const result = await invokeNetbot(mtype, data, body.target);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, BIND, () => {
  console.log(`firewalla-netbot-bridge listening on http://${BIND}:${PORT}`);
});
