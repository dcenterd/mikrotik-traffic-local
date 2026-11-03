// Minimal pure-GJS SNMP v2c client (GET / GETNEXT over UDP).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async', 'connect_to_host_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
const TAG_COUNTER32 = 0x41;
const TAG_GAUGE32 = 0x42;
const TAG_TIMETICKS = 0x43;
const TAG_COUNTER64 = 0x46;
const TAG_GET = 0xa0;
const TAG_GETNEXT = 0xa1;
const TAG_RESPONSE = 0xa2;

export const OID_IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';
export const OID_IF_DESCR = '1.3.6.1.2.1.2.2.1.2';
export const OID_HC_IN_OCTETS = '1.3.6.1.2.1.31.1.1.1.6';
export const OID_HC_OUT_OCTETS = '1.3.6.1.2.1.31.1.1.1.10';

// ---- BER encoding ---------------------------------------------------------

function encLength(n) {
    if (n < 0x80)
        return [n];
    if (n < 0x100)
        return [0x81, n];
    return [0x82, (n >> 8) & 0xff, n & 0xff];
}

function tlv(tag, content) {
    return [tag, ...encLength(content.length), ...content];
}

function encInteger(n) {
    const bytes = [];
    let v = n;
    do {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
    } while (v > 0);
    if (bytes[0] & 0x80)
        bytes.unshift(0);
    return tlv(TAG_INTEGER, bytes);
}

function encOctetString(str) {
    return tlv(TAG_OCTET_STRING, [...new TextEncoder().encode(str)]);
}

function encOid(oid) {
    const parts = oid.split('.').map(Number);
    const bytes = [parts[0] * 40 + parts[1]];
    for (const p of parts.slice(2)) {
        const chunk = [p & 0x7f];
        let v = Math.floor(p / 128);
        while (v > 0) {
            chunk.unshift((v & 0x7f) | 0x80);
            v = Math.floor(v / 128);
        }
        bytes.push(...chunk);
    }
    return tlv(TAG_OID, bytes);
}

function buildRequest(pduTag, community, requestId, oids) {
    const varbinds = [];
    for (const oid of oids)
        varbinds.push(...tlv(TAG_SEQUENCE, [...encOid(oid), TAG_NULL, 0]));

    const pdu = tlv(pduTag, [
        ...encInteger(requestId),
        ...encInteger(0), // error-status
        ...encInteger(0), // error-index
        ...tlv(TAG_SEQUENCE, varbinds),
    ]);

    return new Uint8Array(tlv(TAG_SEQUENCE, [
        ...encInteger(1), // version: v2c
        ...encOctetString(community),
        ...pdu,
    ]));
}

// ---- BER decoding ---------------------------------------------------------

function readTlv(buf, pos) {
    if (pos + 2 > buf.length)
        throw new Error('Truncated SNMP packet');
    const tag = buf[pos];
    let len = buf[pos + 1];
    let start = pos + 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++)
            len = len * 256 + buf[start + i];
        start += n;
    }
    if (start + len > buf.length)
        throw new Error('Truncated SNMP packet');
    return {tag, start, end: start + len};
}

function decUnsigned(buf, start, end) {
    let v = 0n;
    for (let i = start; i < end; i++)
        v = (v << 8n) | BigInt(buf[i]);
    return v;
}

function decSigned(buf, start, end) {
    let v = decUnsigned(buf, start, end);
    if (end > start && (buf[start] & 0x80))
        v -= 1n << BigInt(8 * (end - start));
    return v;
}

function decOid(buf, start, end) {
    const parts = [Math.floor(buf[start] / 40), buf[start] % 40];
    let v = 0;
    for (let i = start + 1; i < end; i++) {
        v = v * 128 + (buf[i] & 0x7f);
        if (!(buf[i] & 0x80)) {
            parts.push(v);
            v = 0;
        }
    }
    return parts.join('.');
}

function decodeValue(buf, t) {
    switch (t.tag) {
    case TAG_INTEGER:
        return decSigned(buf, t.start, t.end);
    case TAG_COUNTER32:
    case TAG_GAUGE32:
    case TAG_TIMETICKS:
    case TAG_COUNTER64:
        return decUnsigned(buf, t.start, t.end);
    case TAG_OCTET_STRING:
        return new TextDecoder().decode(buf.subarray(t.start, t.end));
    case TAG_OID:
        return decOid(buf, t.start, t.end);
    case 0x80:
        throw new Error('noSuchObject');
    case 0x81:
        throw new Error('noSuchInstance');
    case 0x82:
        throw new Error('endOfMibView');
    default:
        return null;
    }
}

const ERROR_NAMES = [
    'noError', 'tooBig', 'noSuchName', 'badValue', 'readOnly', 'genErr',
    'noAccess', 'wrongType', 'wrongLength', 'wrongEncoding', 'wrongValue',
    'noCreation', 'inconsistentValue', 'resourceUnavailable', 'commitFailed',
    'undoFailed', 'authorizationError', 'notWritable', 'inconsistentName',
];

// Returns {requestId, varbinds: [{oid, value}|{oid, error}]}
function parseResponse(buf) {
    const msg = readTlv(buf, 0);
    if (msg.tag !== TAG_SEQUENCE)
        throw new Error('Bad SNMP message');
    let p = msg.start;
    const version = readTlv(buf, p);
    p = version.end;
    const community = readTlv(buf, p);
    p = community.end;
    const pdu = readTlv(buf, p);
    if (pdu.tag !== TAG_RESPONSE)
        throw new Error('Unexpected SNMP PDU type');

    p = pdu.start;
    const reqId = readTlv(buf, p);
    p = reqId.end;
    const errStatus = readTlv(buf, p);
    p = errStatus.end;
    const errIndex = readTlv(buf, p);
    p = errIndex.end;
    const vbList = readTlv(buf, p);

    const status = Number(decSigned(buf, errStatus.start, errStatus.end));
    const requestId = Number(decSigned(buf, reqId.start, reqId.end));
    if (status !== 0)
        return {requestId, error: ERROR_NAMES[status] ?? `error ${status}`, varbinds: []};

    const varbinds = [];
    p = vbList.start;
    while (p < vbList.end) {
        const vb = readTlv(buf, p);
        const oidT = readTlv(buf, vb.start);
        const valT = readTlv(buf, oidT.end);
        const oid = decOid(buf, oidT.start, oidT.end);
        try {
            varbinds.push({oid, value: decodeValue(buf, valT)});
        } catch (e) {
            varbinds.push({oid, error: e.message});
        }
        p = vb.end;
    }
    return {requestId, varbinds};
}

// ---- Client ---------------------------------------------------------------

export class SnmpClient {
    constructor({host, port = 161, community = 'public', timeout = 3}) {
        this.host = host;
        this.port = port;
        this.community = community;
        this.timeout = timeout;
    }

    async _request(pduTag, oids) {
        const requestId = 1 + Math.floor(Math.random() * 0x7ffffffe);
        const packet = buildRequest(pduTag, this.community, requestId, oids);

        const cancellable = new Gio.Cancellable();
        let timedOut = false;
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this.timeout, () => {
            timedOut = true;
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });

        const client = new Gio.SocketClient({
            protocol: Gio.SocketProtocol.UDP,
            type: Gio.SocketType.DATAGRAM,
        });
        let conn = null;
        try {
            conn = await client.connect_to_host_async(
                `${this.host}:${this.port}`, this.port, cancellable);
            await conn.get_output_stream().write_bytes_async(
                new GLib.Bytes(packet), GLib.PRIORITY_DEFAULT, cancellable);

            // Ignore stray datagrams until ours arrives (or the timeout hits).
            for (;;) {
                const bytes = await conn.get_input_stream().read_bytes_async(
                    65535, GLib.PRIORITY_DEFAULT, cancellable);
                const resp = parseResponse(new Uint8Array(bytes.toArray()));
                if (resp.requestId !== requestId)
                    continue;
                if (resp.error)
                    throw new Error(`SNMP error: ${resp.error}`);
                return resp.varbinds;
            }
        } catch (e) {
            if (timedOut)
                throw new Error('SNMP timeout (check host, port, community, router SNMP ACL)');
            throw e;
        } finally {
            if (!timedOut)
                GLib.source_remove(timer);
            try {
                conn?.close(null);
            } catch (_e) {
                // ignore
            }
        }
    }

    // GET several OIDs; returns array of {oid, value} (throws on per-OID errors).
    async get(oids) {
        const vbs = await this._request(TAG_GET, oids);
        for (const vb of vbs) {
            if (vb.error)
                throw new Error(`${vb.oid}: ${vb.error}`);
        }
        return vbs;
    }

    // Walk a subtree with GETNEXT; returns [{oid, value}].
    async walk(rootOid, maxEntries = 512) {
        const out = [];
        let cur = rootOid;
        while (out.length < maxEntries) {
            const [vb] = await this._request(TAG_GETNEXT, [cur]);
            if (!vb || vb.error || !vb.oid.startsWith(`${rootOid}.`))
                break;
            out.push(vb);
            cur = vb.oid;
        }
        return out;
    }

    // Find ifIndex for an interface name (ifName, then ifDescr as fallback).
    async findInterfaceIndex(name) {
        for (const root of [OID_IF_NAME, OID_IF_DESCR]) {
            const entries = await this.walk(root);
            const hit = entries.find(e => e.value === name);
            if (hit)
                return hit.oid.slice(root.length + 1);
        }
        throw new Error(`Interface "${name}" not found via SNMP`);
    }
}
