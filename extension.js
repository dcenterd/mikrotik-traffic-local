import St from 'gi://St';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SnmpClient, OID_HC_IN_OCTETS, OID_HC_OUT_OCTETS} from './snmp.js';

const HISTORY_SECONDS = 3600; // keep one hour of samples
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function formatBits(bps) {
    if (bps === null || bps === undefined || isNaN(bps))
        return '--';
    const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    let v = Math.abs(bps);
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    return `${v.toFixed(1)}${units[i]}`;
}

// Turn an array of numeric samples into a fixed-width text sparkline.
function sparkline(values, width) {
    if (!values || values.length === 0)
        return ''.padEnd(width, '·');

    const buckets = new Array(width).fill(null);
    const n = values.length;
    for (let i = 0; i < width; i++) {
        const start = Math.floor((i * n) / width);
        const end = Math.max(start + 1, Math.floor(((i + 1) * n) / width));
        const slice = values.slice(start, end);
        if (slice.length > 0)
            buckets[i] = slice.reduce((a, b) => a + b, 0) / slice.length;
    }

    const known = buckets.filter(v => v !== null);
    const maxV = known.length ? Math.max(...known, 1) : 1;

    return buckets
        .map(v => {
            if (v === null)
                return ' ';
            const idx = Math.min(
                SPARK_CHARS.length - 1,
                Math.floor((v / maxV) * (SPARK_CHARS.length - 1))
            );
            return SPARK_CHARS[idx];
        })
        .join('');
}

const MikrotikIndicator = GObject.registerClass(
class MikrotikIndicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'MikroTik Traffic Monitor', false);

        this._extension = extensionObject;
        this._settings = extensionObject.getSettings();
        this._session = new Soup.Session();
        this._session.timeout = 8;
        this._timeoutId = null;
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._applySettings();
        });

        this._rxHistory = []; // [{t, v}]
        this._txHistory = [];
        this._resetSnmpState();

        const box = new St.BoxLayout({style_class: 'mikrotik-panel-box'});
        this._label = new St.Label({
            text: '↓-- ↑--',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'mikrotik-panel-label',
        });
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();
        this._startPolling();
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('Connecting…', {
            reactive: false,
            style_class: 'mikrotik-status-item',
        });
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addMenuItem(
            new PopupMenu.PopupMenuItem('RX — last hour', {reactive: false})
        );
        this._rxGraphItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._rxGraphItem.label.add_style_class_name('mikrotik-graph-label');
        this.menu.addMenuItem(this._rxGraphItem);

        this.menu.addMenuItem(
            new PopupMenu.PopupMenuItem('TX — last hour', {reactive: false})
        );
        this._txGraphItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._txGraphItem.label.add_style_class_name('mikrotik-graph-label');
        this.menu.addMenuItem(this._txGraphItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._poll());
        this.menu.addMenuItem(refreshItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings…');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _startPolling() {
        this._stopPolling();
        this._poll();
        const interval = Math.max(1, this._settings.get_int('poll-interval'));
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopPolling() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    _resetSnmpState() {
        this._snmpIfIndex = null;
        this._snmpIfName = null;
        this._snmpLast = null; // {t, rx, tx} BigInt counters
        this._snmpBusy = false;
        this._snmpGeneration = (this._snmpGeneration ?? 0) + 1;
    }

    _applySettings() {
        this._rxHistory = [];
        this._txHistory = [];
        this._resetSnmpState();
        this._startPolling();
    }

    _poll() {
        if (this._settings.get_string('data-source') === 'snmp')
            this._pollSnmp();
        else
            this._pollRest();
    }

    async _pollSnmp() {
        if (this._snmpBusy)
            return;

        const host = this._settings.get_string('router-host');
        const iface = this._settings.get_string('interface-name');
        const monitorRx = this._settings.get_boolean('monitor-rx');
        const monitorTx = this._settings.get_boolean('monitor-tx');

        if (!host || !iface) {
            this._onError('Not configured — set host & interface in Settings');
            return;
        }
        if (!monitorRx && !monitorTx) {
            this._onError('Select receive or transmit traffic in Settings');
            return;
        }

        const generation = this._snmpGeneration;
        this._snmpBusy = true;
        try {
            const client = new SnmpClient({
                host,
                port: this._settings.get_int('snmp-port'),
                community: this._settings.get_string('snmp-community'),
            });

            if (this._snmpIfIndex === null || this._snmpIfName !== iface) {
                const idx = await client.findInterfaceIndex(iface);
                if (generation !== this._snmpGeneration)
                    return;
                this._snmpIfIndex = idx;
                this._snmpIfName = iface;
                this._snmpLast = null;
            }

            const idx = this._snmpIfIndex;
            const vbs = await client.get([
                `${OID_HC_IN_OCTETS}.${idx}`,
                `${OID_HC_OUT_OCTETS}.${idx}`,
            ]);
            if (generation !== this._snmpGeneration)
                return;

            const now = GLib.get_monotonic_time() / 1e6;
            const cur = {t: now, rx: vbs[0].value, tx: vbs[1].value};
            const last = this._snmpLast;
            this._snmpLast = cur;

            if (!last) {
                this._statusItem.label.set_text('Collecting first SNMP sample…');
                return;
            }
            const dt = cur.t - last.t;
            if (dt <= 0 || cur.rx < last.rx || cur.tx < last.tx) {
                // Counter reset (e.g. router reboot): skip this sample.
                return;
            }
            const rate = (a, b) => Math.round(Number(a - b) * 8 / dt);
            this._onData(
                monitorRx ? rate(cur.rx, last.rx) : null,
                monitorTx ? rate(cur.tx, last.tx) : null
            );
        } catch (e) {
            if (generation === this._snmpGeneration) {
                this._snmpIfIndex = null; // re-resolve next time
                this._onError(e.message);
            }
        } finally {
            if (generation === this._snmpGeneration)
                this._snmpBusy = false;
        }
    }

    _pollRest() {
        const host = this._settings.get_string('router-host');
        const port = this._settings.get_int('router-port');
        const useHttps = this._settings.get_boolean('use-https');
        const user = this._settings.get_string('username');
        const pass = this._settings.get_string('password');
        const iface = this._settings.get_string('interface-name');
        const ignoreCert = this._settings.get_boolean('ignore-cert-errors');
        const monitorRx = this._settings.get_boolean('monitor-rx');
        const monitorTx = this._settings.get_boolean('monitor-tx');

        if (!host || !iface) {
            this._onError('Not configured — set host & interface in Settings');
            return;
        }
        if (!monitorRx && !monitorTx) {
            this._onError('Select receive or transmit traffic in Settings');
            return;
        }

        const scheme = useHttps ? 'https' : 'http';
        const url = `${scheme}://${host}:${port}/rest/interface/monitor-traffic`;

        let msg;
        try {
            msg = Soup.Message.new('POST', url);
        } catch (e) {
            this._onError(`Bad URL: ${e.message}`);
            return;
        }
        if (!msg) {
            this._onError('Bad URL');
            return;
        }

        const bodyStr = JSON.stringify({interface: iface, once: ''});
        msg.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(bodyStr))
        );

        const authStr = GLib.base64_encode(new TextEncoder().encode(`${user}:${pass}`));
        msg.get_request_headers().append('Authorization', `Basic ${authStr}`);

        if (ignoreCert)
            msg.connect('accept-certificate', () => true);

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const status = msg.get_status();
                if (status !== Soup.Status.OK) {
                    this._onError(`HTTP ${status}`);
                    return;
                }
                const text = new TextDecoder().decode(bytes.get_data());
                const data = JSON.parse(text);
                const entry = Array.isArray(data) ? data[0] : data;
                if (!entry) {
                    this._onError('Empty response — check interface name');
                    return;
                }
                const rx = parseInt(entry['rx-bits-per-second'] ?? 0, 10);
                const tx = parseInt(entry['tx-bits-per-second'] ?? 0, 10);
                this._onData(monitorRx ? rx : null, monitorTx ? tx : null);
            } catch (e) {
                this._onError(e.message);
            }
        });
    }

    _onData(rx, tx) {
        const now = GLib.get_monotonic_time() / 1e6;
        if (rx !== null)
            this._rxHistory.push({t: now, v: rx});
        if (tx !== null)
            this._txHistory.push({t: now, v: tx});

        const cutoff = now - HISTORY_SECONDS;
        this._rxHistory = this._rxHistory.filter(p => p.t >= cutoff);
        this._txHistory = this._txHistory.filter(p => p.t >= cutoff);

        this._label.set_text(`↓${formatBits(rx)} ↑${formatBits(tx)}`);

        const iface = this._settings.get_string('interface-name');
        this._statusItem.label.set_text(
            `${iface} · ↓${formatBits(rx)} ↑${formatBits(tx)}`
        );

        const width = this._settings.get_int('graph-width');
        this._rxGraphItem.label.set_text(
            rx === null ? '--' : sparkline(this._rxHistory.map(p => p.v), width)
        );
        this._txGraphItem.label.set_text(
            tx === null ? '--' : sparkline(this._txHistory.map(p => p.v), width)
        );
    }

    _onError(message) {
        this._label.set_text('↓err ↑err');
        this._statusItem.label.set_text(`Error: ${message}`);
    }

    destroy() {
        this._stopPolling();
        this._snmpGeneration++; // drop any in-flight SNMP result
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        super.destroy();
    }
});

export default class MikrotikTrafficExtension extends Extension {
    enable() {
        this._indicator = new MikrotikIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
