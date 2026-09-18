import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MikrotikTrafficPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Connection',
            icon_name: 'network-wired-symbolic',
        });
        window.add(page);

        const connGroup = new Adw.PreferencesGroup({
            title: 'Router Connection',
            description:
                'Use a dedicated, read-only RouterOS user for this — the password is ' +
                'stored in plain text in dconf.',
        });
        page.add(connGroup);

        this._addEntryRow(connGroup, settings, 'router-host', 'Router host / IP');
        this._addSpinRow(connGroup, settings, 'router-port', 'REST API port', 1, 65535);
        this._addSwitchRow(connGroup, settings, 'use-https', 'Use HTTPS (www-ssl service)');
        this._addSwitchRow(
            connGroup,
            settings,
            'ignore-cert-errors',
            'Ignore certificate errors (self-signed cert)'
        );
        this._addEntryRow(connGroup, settings, 'username', 'Username');
        this._addPasswordRow(connGroup, settings, 'password', 'Password');

        const monGroup = new Adw.PreferencesGroup({title: 'Monitoring'});
        page.add(monGroup);

        this._addEntryRow(monGroup, settings, 'interface-name', 'Interface name (e.g. ether1)');
        this._addSpinRow(monGroup, settings, 'poll-interval', 'Poll interval (seconds)', 1, 300);
        this._addSpinRow(monGroup, settings, 'graph-width', 'Graph width (characters)', 20, 120);

        const helpGroup = new Adw.PreferencesGroup();
        page.add(helpGroup);
        const helpRow = new Adw.ActionRow({
            title: 'On the router',
            subtitle:
                'IP > Services: enable "www-ssl" (or "www" if not using HTTPS). ' +
                'Create a user whose group has "read" and "api" permissions.',
        });
        helpGroup.add(helpRow);
    }

    _addEntryRow(group, settings, key, title) {
        const entry = new Gtk.Entry({valign: Gtk.Align.CENTER, hexpand: true});
        settings.bind(key, entry, 'text', 0);
        const row = new Adw.ActionRow({title});
        row.add_suffix(entry);
        row.activatable_widget = entry;
        group.add(row);
    }

    _addPasswordRow(group, settings, key, title) {
        const entry = new Gtk.PasswordEntry({
            valign: Gtk.Align.CENTER,
            hexpand: true,
            show_peek_icon: true,
        });
        settings.bind(key, entry, 'text', 0);
        const row = new Adw.ActionRow({title});
        row.add_suffix(entry);
        row.activatable_widget = entry;
        group.add(row);
    }

    _addSpinRow(group, settings, key, title, min, max) {
        const spin = Gtk.SpinButton.new_with_range(min, max, 1);
        spin.valign = Gtk.Align.CENTER;
        settings.bind(key, spin, 'value', 0);
        const row = new Adw.ActionRow({title});
        row.add_suffix(spin);
        row.activatable_widget = spin;
        group.add(row);
    }

    _addSwitchRow(group, settings, key, title) {
        const sw = new Gtk.Switch({valign: Gtk.Align.CENTER});
        settings.bind(key, sw, 'active', 0);
        const row = new Adw.ActionRow({title});
        row.add_suffix(sw);
        row.activatable_widget = sw;
        group.add(row);
    }
}
