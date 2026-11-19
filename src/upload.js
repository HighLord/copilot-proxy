'use strict';

// File uploads for Copilot Chat.
//
// Copilot has no direct file upload over the Chathub WebSocket. The browser instead uploads the
// file to the user's "Microsoft Copilot Chat Files" library via Graph, then references it in the
// chat message with a `messageAnnotations` entry of type "LocalFile". This module reproduces that
// flow server-side. The Chathub chat token has no Files scope, so uploads use the M365Chat
// client's own refresh token (captured from MSAL at sign-in) to obtain a Graph/SharePoint token.

const config = require('./config');

class UploadError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

// --- driveId / annotation id helpers (verified against a captured HAR) ---------------------------

// SharePoint `parentReference.driveId` values are `b!<base64url(32 or 48 bytes)>`: two or three GUIDs
// (site id, web id, and on newer tenants the list id), each encoded little-endian (first three fields
// byte-swapped). Returns { siteId, webId, listId } (listId is '' on the 2-GUID form).
function decodeDriveId(driveId) {
  const b64 = String(driveId ?? '').replace(/^b!/, '');
  let buf;
  try {
    buf = Buffer.from(b64, 'base64url');
  } catch {
    return null;
  }
  if (buf.length !== 32 && buf.length !== 48) return null;
  const guidAt = (start) => {
    const b = buf.subarray(start, start + 16);
    const d1 = Buffer.from(b.subarray(0, 4)).reverse().toString('hex');
    const d2 = Buffer.from(b.subarray(4, 6)).reverse().toString('hex');
    const d3 = Buffer.from(b.subarray(6, 8)).reverse().toString('hex');
    const d4 = b.subarray(8, 16).toString('hex');
    return `${d1}-${d2}-${d3}-${d4.slice(0, 4)}-${d4.slice(4)}`;
  };
  return { siteId: guidAt(0), webId: guidAt(16), listId: buf.length === 48 ? guidAt(32) : '' };
}

// The LocalFile annotation id is "SPO_<base64url(siteId,webId,listId)>_<itemId>".
function buildFileAnnotation({ itemId, siteId, webId, listId, name, url }) {
  const encoded = Buffer.from(`${siteId},${webId},${listId}`).toString('base64url');
  return {
    id: `SPO_${encoded}_${itemId}`,
    text: name,
    url,
    messageAnnotationType: 'LocalFile',
  };
}

// --- Graph token acquisition ---------------------------------------------------------------------

function tokenIsValid(rec) {
  return Boolean(rec && rec.graphToken && (rec.graphTokenExp - config.GRAPH_TOKEN_EXPIRY_SKEW_SECONDS) > Math.floor(Date.now() / 1000));
}

// SharePoint host for a tenant's my-site. Prefer a captured value; fall back to deriving it from the
// email domain (e.g. someone@contoso.com -> contoso-my.sharepoint.com).
function sharePointHost(session) {
  if (session.spoHost) return session.spoHost;
  const domain = String(session.email ?? '').split('@')[1];
  if (domain) return `${domain.toLowerCase()}-my.sharepoint.com`;
  return null;
}

async function getGraphToken(session) {
  if (tokenIsValid(session)) return { token: session.graphToken, expiresIn: session.graphTokenExp - Math.floor(Date.now() / 1000) };
  if (!session.refreshToken) {
    throw new UploadError('This session has no file-upload token. Sign in again to re-capture it.', 403);
  }
  const host = sharePointHost(session);
  if (!host) throw new UploadError('Could not determine the SharePoint host for this account.', 403);
  const params = new URLSearchParams({
    client_id: config.UPLOAD_CLIENT_ID,
    redirect_uri: config.UPLOAD_REDIRECT_URI,
    grant_type: 'refresh_token',
    client_info: '1',
    refresh_token: session.refreshToken,
    scope: `https://${host}/.default openid profile offline_access`,
  });
  let res;
  try {
    res = await fetch(`${config.LOGIN_AUTHORITY}/${session.tid}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: params.toString(),
    });
  } catch (error) {
    throw new UploadError(`Could not reach Microsoft to get an upload token: ${error.message}`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error_description ?? ''; } catch { /* ignore */ }
    throw new UploadError(`Microsoft refused to issue an upload token (HTTP ${res.status})${detail ? `: ${detail}` : ''}. Sign in again.`, 403);
  }
  const body = await res.json();
  if (!body.access_token) throw new UploadError('Microsoft returned no upload token. Sign in again.', 403);
  return { token: body.access_token, expiresIn: Number(body.expires_in) || 3600 };
}

// --- upload --------------------------------------------------------------------------------------

// Uploads `data` to the Copilot upload folder and returns { itemId, siteId, webId, listId, name, url, annotation }.
async function uploadFile({ session, name, data, mimeType = 'application/octet-stream' }) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > config.MAX_UPLOAD_BYTES) {
    throw new UploadError(`File is ${buffer.length} bytes; the limit is ${config.MAX_UPLOAD_BYTES}.`, 413);
  }
  const cleanName = String(name ?? 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 255) || 'file';
  const { token } = await getGraphToken(session);
  const headers = { authorization: `Bearer ${token}` };

  // 1. Create an upload session in the Copilot uploads folder.
  let createRes;
  try {
    createRes = await fetch(
      `${config.GRAPH_BASE_URL}/me/drive/special/${config.UPLOAD_FOLDER_PATH}:/${encodeURIComponent(cleanName)}:/createUploadSession`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: cleanName } }),
      },
    );
  } catch (error) {
    throw new UploadError(`Could not reach Microsoft Graph: ${error.message}`);
  }
  if (!createRes.ok) {
    throw new UploadError(`Microsoft Graph rejected the upload session (HTTP ${createRes.status}). Sign in again.`, createRes.status === 401 || createRes.status === 403 ? 403 : 502);
  }
  const { uploadUrl } = await createRes.json();
  if (!uploadUrl) throw new UploadError('Microsoft Graph returned no upload URL.');

  // 2. Put the bytes.
  let putRes;
  try {
    putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-range': `bytes 0-${buffer.length - 1}/${buffer.length}`,
        'content-type': mimeType,
        prefer: 'ExtractTextOnCommit, pacToken=N',
      },
      body: buffer,
    });
  } catch (error) {
    throw new UploadError(`Could not upload the file: ${error.message}`);
  }
  if (!putRes.ok) {
    throw new UploadError(`Uploading the file failed (HTTP ${putRes.status}).`);
  }
  const item = await putRes.json();
  const itemId = item.id;
  const siteId = item.parentReference?.siteId;
  const webUrl = item.webUrl ?? item['@microsoft.graph.downloadUrl'] ?? '';
  if (!itemId || !siteId) throw new UploadError('Microsoft returned an unexpected upload result.');
  const ids = decodeDriveId(item.parentReference?.driveId);
  const webId = ids?.webId ?? '';
  let listId = ids?.listId ?? '';

  // Older tenants encode only site+web in driveId; fall back to a list lookup for the list id.
  if (!listId && item.parentReference?.driveId) {
    try {
      const listRes = await fetch(`${config.GRAPH_BASE_URL}/drives/${encodeURIComponent(item.parentReference.driveId)}/list`, { headers });
      if (listRes.ok) listId = (await listRes.json())?.id ?? '';
    } catch { /* list id is best-effort */ }
  }

  const annotation = buildFileAnnotation({ itemId, siteId, webId, listId, name: cleanName, url: webUrl });
  return { itemId, siteId, webId, listId, name: cleanName, url: webUrl, annotation };
}

module.exports = { uploadFile, getGraphToken, buildFileAnnotation, decodeDriveId, UploadError };
