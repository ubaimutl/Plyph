import GLib from 'gi://GLib';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export function base64url(bytes) {
    return GLib.base64_encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode64(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
        throw new Error('Invalid sign-in token encoding.');
    const bytes = GLib.base64_decode(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    if (base64url(bytes) !== value)
        throw new Error('Invalid sign-in token encoding.');
    return bytes;
}

export function sha256(bytes) {
    const hex = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);
    return Uint8Array.from(hex.match(/../g), pair => Number.parseInt(pair, 16));
}

function integer(bytes) {
    return BigInt(`0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`);
}

export function verifyIdToken(token, keys, clientId, nonce = null, subject = null, now = Date.now() / 1000) {
    if (typeof token !== 'string' || token.length > 32768)
        throw new Error('Invalid sign-in token.');
    const parts = token.split('.');
    if (parts.length !== 3)
        throw new Error('Invalid sign-in token.');
    const header = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decode64(parts[0])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit || header.b64 === false)
        throw new Error('Unsupported sign-in signature.');
    const matches = keys.filter(key => key.kid === header.kid && key.kty === 'RSA' &&
        (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig') &&
        (!key.key_ops || key.key_ops.includes('verify')));
    if (matches.length !== 1)
        throw new Error('The sign-in signing key could not be verified.');
    const modulus = decode64(matches[0].n);
    const exponent = decode64(matches[0].e);
    const signature = decode64(parts[2]);
    if (modulus.length < 256 || modulus.length > 1024 || modulus[0] < 128 ||
        signature.length !== modulus.length || exponent.length > 4)
        throw new Error('Invalid sign-in signing key.');
    const n = integer(modulus);
    let e = integer(exponent);
    let base = integer(signature);
    if (e < 3n || e % 2n === 0n || base >= n || n % 2n === 0n)
        throw new Error('Invalid sign-in signature.');
    let value = 1n;
    while (e > 0n) {
        if (e & 1n)
            value = value * base % n;
        base = base * base % n;
        e >>= 1n;
    }
    const digest = sha256(new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const digestInfo = '3031300d060960864801650304020105000420' +
        Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    const expected = '0001' + 'ff'.repeat(modulus.length - digestInfo.length / 2 - 3) + '00' + digestInfo;
    if (value.toString(16).padStart(modulus.length * 2, '0') !== expected)
        throw new Error('The sign-in signature is invalid.');
    const claims = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decode64(parts[1])));
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audiences.includes(clientId) ||
        (claims.azp !== undefined && claims.azp !== clientId) ||
        (audiences.length > 1 && claims.azp !== clientId) ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60)) ||
        typeof claims.sub !== 'string' || !claims.sub ||
        (nonce !== null && claims.nonce !== nonce) || (subject !== null && claims.sub !== subject))
        throw new Error('The sign-in identity could not be verified. Please sign in again.');
    return claims;
}

export function callbackResult(query, state, clientId = null) {
    if (!query || query.state !== state)
        throw new Error('Invalid sign-in state.');
    if (query.error)
        throw new Error(query.error === 'access_denied' ? 'ChatGPT sign-in was declined.' : 'ChatGPT sign-in failed.');
    const issued = query.client_id || clientId;
    if (!issued || issued === 'dynamic_agent_client' || !/^[A-Za-z0-9_-]{1,256}$/.test(issued) ||
        (clientId && issued !== clientId) || typeof query.code !== 'string' || !query.code)
        throw new Error('ChatGPT registration was incomplete or changed accounts. Try signing in again.');
    return {clientId: issued, code: query.code};
}

export function chatgptError(code, status = 0) {
    if (['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(code) || status === 429)
        return new Error('ChatGPT usage is unavailable or a limit was reached. Open Manage usage in Plyph settings.');
    if (code === 'invalid_grant' || status === 401)
        return new Error('Your ChatGPT connection expired. Continue with ChatGPT in Plyph settings.');
    if (status === 403)
        return new Error('ChatGPT plan access was denied. Check permissions in ChatGPT settings.');
    return new Error(status ? `ChatGPT could not complete the request (${status}). Try again.` :
        'ChatGPT could not complete the response. Try again.');
}

export class Utf8StreamDecoder {
    constructor() {
        this.pending = new Uint8Array();
        this.decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
    }

    decode(chunk = new Uint8Array(), final = false) {
        const bytes = new Uint8Array(this.pending.length + chunk.length);
        bytes.set(this.pending);
        bytes.set(chunk, this.pending.length);
        let end = bytes.length;
        if (!final && end) {
            let start = end - 1;
            while (start > 0 && (bytes[start] & 0xc0) === 0x80)
                start--;
            const lead = bytes[start];
            const length = lead >= 0xc2 && lead <= 0xdf ? 2
                : lead >= 0xe0 && lead <= 0xef ? 3
                    : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
            if (end - start < length)
                end = start;
        }
        const text = this.decoder.decode(bytes.subarray(0, end));
        this.pending = bytes.slice(end);
        return text;
    }

    finish() {
        return this.decode(new Uint8Array(), true);
    }
}

export class ResponsesStream {
    constructor() {
        this.buffer = '';
        this.size = 0;
        this.output = '';
        this.items = new Map();
        this.completed = false;
    }

    feed(chunk) {
        this.size += chunk.length;
        if (this.size > 8 * 1024 * 1024)
            throw new Error('The ChatGPT response is too large. Select less text.');
        this.buffer += chunk;
        let match;
        while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
            const frame = this.buffer.slice(0, match.index);
            this.buffer = this.buffer.slice(match.index + match[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data || data === '[DONE]')
                continue;
            const event = JSON.parse(data);
            if (event.type === 'error' || event.type === 'response.failed')
                throw chatgptError(event.code ?? event.error?.code ?? event.response?.error?.code);
            if (event.type === 'response.incomplete')
                throw new Error('ChatGPT returned an incomplete response. Try a shorter request.');
            if (event.type === 'response.output_item.done' && event.item?.type === 'message' &&
                Number.isInteger(event.output_index) && event.output_index >= 0)
                this.items.set(event.output_index, event.item);
            if (event.type === 'response.completed') {
                if (event.response?.status !== 'completed')
                    throw new Error('ChatGPT did not complete the response.');
                const output = event.response.output?.length ? event.response.output
                    : [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
                const messages = output.filter(item => item.type === 'message');
                this.output = messages.flatMap(item => item.content ?? [])
                    .filter(item => item.type === 'output_text' || item.type === 'refusal')
                    .map(item => item.text ?? item.refusal ?? '').join('');
                this.completed = true;
            }
        }
    }

    finish() {
        if (!this.completed)
            throw new Error('ChatGPT disconnected before completing the response. Nothing was replaced.');
        if (!this.output.trim())
            throw new Error('ChatGPT returned no text.');
        return this.output.trim();
    }
}
