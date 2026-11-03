# MikroTik Traffic Monitor

A GNOME Shell extension that displays live receive (RX) and transmit (TX) traffic for a MikroTik RouterOS interface in the top panel.

The extension also provides a text-based graph showing the last hour of traffic samples.

## Requirements

- GNOME Shell 45, 46, 47, or 48
- MikroTik RouterOS with either the REST API or SNMP enabled
- REST: a RouterOS user with read-only access and API permissions
- SNMP: SNMP v2c enabled with a read-only community

## Installation

From the extension directory:

```bash
glib-compile-schemas schemas
mkdir -p ~/.local/share/gnome-shell/extensions/mikrotik-traffic@local.dev
cp extension.js snmp.js metadata.json prefs.js stylesheet.css ~/.local/share/gnome-shell/extensions/mikrotik-traffic@local.dev/
cp -r schemas ~/.local/share/gnome-shell/extensions/mikrotik-traffic@local.dev/
```

Enable the extension:

```bash
gnome-extensions enable mikrotik-traffic@local.dev
```

On X11, press `Alt+F2`, enter `r`, and press Enter to reload GNOME Shell. On Wayland, log out and back in.

## RouterOS setup

1. Enable the `www-ssl` service under **IP > Services**.
2. Create a dedicated RouterOS user.
3. Give the user the `read` and `api` permissions.
4. Note the router address, REST API port, username, and password.

The default REST API port is `443` with HTTPS enabled. The extension supports plain HTTP when HTTPS is disabled.

### SNMP setup (alternative to REST)

1. Run `/snmp set enabled=yes` on the router.
2. Add a read-only community under **/snmp community**, restricted to your PC's address.
3. In the extension preferences, set **Read traffic via** to **SNMP v2c**.

The extension reads `ifHCInOctets` / `ifHCOutOctets` and computes bits per second from the difference between polls, so the first sample after applying settings shows no rate. Only SNMP v2c is supported. The community string is sent in clear text and stored in plain text in GNOME settings.

## Configuration

Open the preferences window:

```bash
gnome-extensions prefs mikrotik-traffic@local.dev
```

Configure:

- Data source (REST API or SNMP v2c)
- Router host or IP address
- REST API port
- SNMP port and community
- HTTPS usage
- Certificate validation behavior
- RouterOS username and password
- Interface name, such as `ether1`
- Whether to monitor received traffic (RX)
- Whether to monitor transmitted traffic (TX)
- Poll interval from 1 to 300 seconds
- Graph width from 20 to 120 characters

The default poll interval is 1 second. The password is stored in plain text in GNOME settings, so use a dedicated read-only RouterOS account.

Use the **Apply** button in the preferences window to save changes and restart traffic collection immediately. At least one of RX or TX must be enabled.

## Usage

The top-panel indicator shows the current RX and TX rates. Click it to view:

- Connection status
- RX history for the last hour
- TX history for the last hour
- A manual **Refresh now** action
- A shortcut to the extension settings

## Troubleshooting

Check that:

- The router is reachable from the computer running GNOME Shell.
- The selected RouterOS interface name is correct.
- The REST API service is enabled on the configured port.
- The username has `read` and `api` permissions.
- For SNMP: UDP port 161 is reachable, the community matches, and the router's community address filter allows your PC.
- HTTPS certificate errors are either fixed or intentionally ignored in the preferences.

To inspect the extension state:

```bash
gnome-extensions info mikrotik-traffic@local.dev
```

To disable and re-enable it:

```bash
gnome-extensions disable mikrotik-traffic@local.dev
gnome-extensions enable mikrotik-traffic@local.dev
```
