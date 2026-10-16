// Moonriver Link en el panel: estado del teléfono, enviar cosas, notificaciones y
// portapapeles compartido. Habla con el servicio moonriver-link-daemon por DBus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const LinkIface = `
<node>
  <interface name="org.moonriver.Link">
    <method name="GetStatus"><arg type="s" direction="out"/></method>
    <method name="SendFiles"><arg type="as" direction="in"/></method>
    <method name="SendText"><arg type="s" direction="in"/></method>
    <method name="SendClipboard"><arg type="s" direction="in"/></method>
    <method name="Unpair"><arg type="s" direction="in"/></method>
    <method name="CancelPairing"/>
    <method name="SetAgentControl"><arg type="b" direction="in"/></method>
    <signal name="StatusChanged"><arg type="s"/></signal>
    <signal name="PairRequest"><arg type="s"/><arg type="s"/></signal>
    <signal name="PhoneNotification"><arg type="s"/><arg type="s"/><arg type="s"/></signal>
    <signal name="FileReceived"><arg type="s"/><arg type="s"/></signal>
    <signal name="TextReceived"><arg type="s"/><arg type="b"/></signal>
    <signal name="SetClipboard"><arg type="s"/></signal>
    <signal name="AgentCommand"><arg type="s"/><arg type="s"/><arg type="s"/></signal>
  </interface>
</node>`;
const LinkProxy = Gio.DBusProxy.makeProxyWrapper(LinkIface);

const SETTINGS_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'moonriver', 'link', 'shell.json']);
const MAX_CLIPBOARD_CHARS = 100000;

function localIp() {
    // Primera IPv4 no local (para mostrar la URL de instalación del .apk)
    try {
        const [, out] = GLib.spawn_command_line_sync('hostname -I');
        return new TextDecoder().decode(out).trim().split(/\s+/).find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
    } catch {
        return null;
    }
}

function loadSettings() {
    try {
        const [, bytes] = GLib.file_get_contents(SETTINGS_FILE);
        return {syncClipboard: true, ...JSON.parse(new TextDecoder().decode(bytes))};
    } catch {
        return {syncClipboard: true};
    }
}

function saveSettings(settings) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(SETTINGS_FILE), 0o700);
        GLib.file_set_contents(SETTINGS_FILE, JSON.stringify(settings));
    } catch {}
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError('Moonriver Link', e.message);
    }
}

// Diálogo con el código de vinculación, grande y legible
const PairDialog = GObject.registerClass(
class PairDialog extends ModalDialog.ModalDialog {
    _init(deviceName, code, onCancel) {
        super._init({styleClass: 'moonriver-pair-dialog', destroyOnClose: true});

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'moonriver-pair-box'});
        box.add_child(new St.Icon({icon_name: 'phone-symbolic', style_class: 'moonriver-pair-icon', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: `«${deviceName}» quiere vincularse`, style_class: 'moonriver-pair-title', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: 'Ingresá este código en el teléfono:', style_class: 'moonriver-pair-hint', x_align: Clutter.ActorAlign.CENTER}));
        // Espacios finos entre dígitos en vez de letter-spacing (St no lo cuenta al medir y corta el texto)
        const codeLabel = new St.Label({
            text: `${[...code.slice(0, 3)].join('\u2009')}  ${[...code.slice(3)].join('\u2009')}`,
            style_class: 'moonriver-pair-code',
            x_align: Clutter.ActorAlign.CENTER,
        });
        codeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(codeLabel);
        this.contentLayout.add_child(box);

        this.setButtons([{
            label: 'Cancelar',
            action: () => {
                onCancel();
                this.close();
            },
            key: Clutter.KEY_Escape,
        }]);
    }
});

// Diálogo para escribir un link o texto y mandarlo al teléfono
const SendTextDialog = GObject.registerClass(
class SendTextDialog extends ModalDialog.ModalDialog {
    _init(onSend) {
        super._init({styleClass: 'moonriver-pair-dialog', destroyOnClose: true});

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'moonriver-pair-box'});
        box.add_child(new St.Label({text: 'Enviar al teléfono', style_class: 'moonriver-pair-title'}));
        box.add_child(new St.Label({text: 'Los links se abren en el teléfono; el texto se copia.', style_class: 'moonriver-pair-hint'}));
        this._entry = new St.Entry({style_class: 'moonriver-send-entry', hint_text: 'https://… o cualquier texto', can_focus: true});
        box.add_child(this._entry);
        this.contentLayout.add_child(box);

        const send = () => {
            const text = this._entry.text.trim();
            if (text)
                onSend(text);
            this.close();
        };
        this._entry.clutter_text.connect('activate', send);
        this.setButtons([
            {label: 'Cancelar', action: () => this.close(), key: Clutter.KEY_Escape},
            {label: 'Enviar', action: send, default: true},
        ]);
        this.setInitialKeyFocus(this._entry);
    }
});

export const PhoneIndicator = GObject.registerClass(
class PhoneIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.5, 'Moonriver Link');
        this.add_style_class_name('moonriver-phone');

        const box = new St.BoxLayout({style_class: 'moonriver-phone-box'});
        this._icon = new St.Icon({icon_name: 'phone-symbolic', style_class: 'system-status-icon'});
        this._label = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, visible: false});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
        this.menu.box.add_style_class_name('moonriver-menu');

        this._extensionPath = extensionPath;
        this._settings = loadSettings();
        this._status = {devices: []};
        this._lastClipboard = null;
        this._pairDialog = null;

        this._source = null;
        this._buildMenu();
        this._connectProxy();

        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed', (_sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onLocalClipboardChanged();
        }, this);
    }

    // ── DBus ──
    _connectProxy() {
        this._proxy = new LinkProxy(Gio.DBus.session, 'org.moonriver.Link', '/org/moonriver/Link', (proxy, error) => {
            if (error) {
                console.warn(`Moonriver Link: ${error.message}`);
                return;
            }
            this._refresh();
        }, null, Gio.DBusProxyFlags.DO_NOT_AUTO_START);

        this._signalIds = [
            this._proxy.connectSignal('StatusChanged', (_p, _s, [json]) => this._setStatus(json)),
            this._proxy.connectSignal('PairRequest', (_p, _s, [name, code]) => this._showPairDialog(name, code)),
            this._proxy.connectSignal('PhoneNotification', (_p, _s, [app, title, text]) => this._onPhoneNotification(app, title, text)),
            this._proxy.connectSignal('FileReceived', (_p, _s, [path, device]) => this._onFileReceived(path, device)),
            this._proxy.connectSignal('TextReceived', (_p, _s, [text, isUrl]) => this._onTextReceived(text, isUrl)),
            this._proxy.connectSignal('SetClipboard', (_p, _s, [text]) => this._setClipboard(text)),
            this._proxy.connectSignal('AgentCommand', (_p, _s, [agent, conversation, text]) =>
                this._notify(`Orden desde el teléfono → ${agent}`,
                    `${conversation ? `${conversation}: ` : ''}${text.length > 160 ? `${text.slice(0, 160)}…` : text}`,
                    {transient: false})),
        ];
        this._proxy.connectObject('notify::g-name-owner', () => this._refresh(), this);
    }

    _refresh() {
        if (!this._proxy.g_name_owner) {
            this._setStatus(null);
            return;
        }
        this._proxy.GetStatusRemote((result, error) => {
            if (!error)
                this._setStatus(result[0]);
        });
    }

    _setStatus(json) {
        try {
            this._status = json ? JSON.parse(json) : {devices: [], offline: true};
        } catch {
            this._status = {devices: [], offline: true};
        }
        const connected = this._connectedDevice();
        if (connected && this._pairDialog) {
            this._pairDialog.close();
            this._pairDialog = null;
        }

        this._icon.icon_name = 'phone-symbolic';
        if (connected)
            this.add_style_class_name('connected');
        else
            this.remove_style_class_name('connected');

        const battery = connected?.battery;
        this._label.visible = battery !== null && battery !== undefined;
        if (this._label.visible)
            this._label.text = `${battery}%${connected.charging ? '+' : ''}`;

        this._buildMenu();
    }

    _connectedDevice() {
        return this._status.devices?.find(d => d.connected) ?? null;
    }

    // ── menú ──
    _buildMenu() {
        this.menu.removeAll();
        const devices = this._status.devices ?? [];
        const connected = this._connectedDevice();

        const header = new PopupMenu.PopupMenuItem('Moonriver Link', {reactive: false});
        header.add_style_class_name('moonriver-section-title');
        this.menu.addMenuItem(header);

        if (this._status.offline) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('El servicio no está corriendo', {reactive: false}));
            this.menu.addAction('Iniciar servicio', () =>
                GLib.spawn_command_line_async('systemctl --user start moonriver-link.service'));
            return;
        }

        if (devices.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Ningún teléfono vinculado', {reactive: false}));
            const ip = localIp();
            if (this._status.apk_available && ip) {
                const hint = new PopupMenu.PopupMenuItem(
                    `Instalá la app abriendo en el teléfono:\nhttp://${ip}:${this._status.apk_port}`, {reactive: false});
                hint.add_style_class_name('moonriver-phone-hint');
                this.menu.addMenuItem(hint);
            }
            const info = new PopupMenu.PopupMenuItem(
                'Abrí Moonriver Link en el teléfono y tocá esta PC para vincularla.', {reactive: false});
            info.add_style_class_name('moonriver-phone-hint');
            this.menu.addMenuItem(info);
            return;
        }

        for (const d of devices) {
            const state = d.connected
                ? `Conectado${d.battery !== null ? ` · ${d.battery}%${d.charging ? ' cargando' : ''}` : ''}`
                : 'Desconectado';
            const item = new PopupMenu.PopupImageMenuItem(`${d.name}\n${state}`,
                'phone-symbolic', {reactive: false});
            item.add_style_class_name(d.connected ? 'moonriver-phone-device connected' : 'moonriver-phone-device');
            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const canSend = Boolean(connected);
        this._action('Enviar archivos…', 'document-send-symbolic', () => this._pickAndSendFiles(), canSend);
        this._action('Enviar link o texto…', 'insert-link-symbolic', () => this._openSendText(), canSend);
        this._action('Enviar portapapeles', 'edit-paste-symbolic', () => this._sendClipboardNow(), canSend);

        const sync = new PopupMenu.PopupSwitchMenuItem('Portapapeles automático', this._settings.syncClipboard);
        sync.connect('toggled', (_i, state) => {
            this._settings.syncClipboard = state;
            saveSettings(this._settings);
        });
        this.menu.addMenuItem(sync);

        const agents = new PopupMenu.PopupSwitchMenuItem('Controlar agentes desde el teléfono', this._status.agent_control !== false);
        agents.connect('toggled', (_i, state) => this._proxy.SetAgentControlRemote(state, () => {}));
        this.menu.addMenuItem(agents);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._action('Archivos recibidos', 'folder-download-symbolic', () => {
            GLib.mkdir_with_parents(this._status.received_dir, 0o755);
            openUri(Gio.File.new_for_path(this._status.received_dir).get_uri());
        });

        const unpair = new PopupMenu.PopupSubMenuMenuItem('Desvincular', true);
        unpair.icon.icon_name = 'edit-delete-symbolic';
        for (const d of devices)
            unpair.menu.addAction(d.name, () => this._proxy.UnpairRemote(d.id, () => {}));
        this.menu.addMenuItem(unpair);
    }

    _action(label, icon, callback, sensitive = true) {
        const item = new PopupMenu.PopupImageMenuItem(label, icon);
        item.setSensitive(sensitive);
        item.connect('activate', callback);
        this.menu.addMenuItem(item);
    }

    // ── enviar ──
    _pickAndSendFiles() {
        try {
            const proc = Gio.Subprocess.new(
                ['zenity', '--file-selection', '--multiple', '--separator=\n', '--title=Enviar al teléfono'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                const [, stdout] = p.communicate_utf8_finish(res);
                const paths = (stdout ?? '').split('\n').filter(Boolean);
                if (paths.length)
                    this._sendFiles(paths);
            });
        } catch (e) {
            Main.notifyError('Moonriver Link', e.message);
        }
    }

    _sendFiles(paths) {
        this._proxy.SendFilesRemote(paths, (_r, error) => {
            if (error)
                Main.notifyError('Moonriver Link', error.message);
            else
                this._notify('Enviando al teléfono', paths.length === 1 ? GLib.path_get_basename(paths[0]) : `${paths.length} archivos`);
        });
    }

    _openSendText() {
        new SendTextDialog(text => this._proxy.SendTextRemote(text, () => {})).open();
    }

    _sendClipboardNow() {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (text) {
                this._proxy.SendClipboardRemote(text.slice(0, MAX_CLIPBOARD_CHARS), () => {});
                this._notify('Portapapeles enviado', text.length > 80 ? `${text.slice(0, 80)}…` : text);
            }
        });
    }

    _onLocalClipboardChanged() {
        if (!this._settings.syncClipboard || !this._connectedDevice())
            return;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (!text || text === this._lastClipboard)
                return;
            this._lastClipboard = text;
            this._proxy.SendClipboardRemote(text.slice(0, MAX_CLIPBOARD_CHARS), () => {});
        });
    }

    // ── recibir ──
    _setClipboard(text) {
        this._lastClipboard = text;   // evita reenviarlo como eco
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _showPairDialog(name, code) {
        this._pairDialog?.close();
        this._pairDialog = new PairDialog(name, code, () => this._proxy.CancelPairingRemote(() => {}));
        this._pairDialog.connect('destroy', () => {
            this._pairDialog = null;
        });
        this._pairDialog.open();
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Teléfono', iconName: 'phone-symbolic'});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    _notify(title, body, {onActivate = null, actions = [], transient = true} = {}) {
        const notification = new MessageTray.Notification({source: this._getSource(), title, body, isTransient: transient});
        if (onActivate)
            notification.connect('activated', onActivate);
        for (const [label, cb] of actions)
            notification.addAction(label, cb);
        this._getSource().addNotification(notification);
    }

    _onPhoneNotification(app, title, text) {
        this._notify(title ? `${app} · ${title}` : app, text, {transient: false});
    }

    _onFileReceived(path, device) {
        const file = Gio.File.new_for_path(path);
        this._notify('Archivo recibido', `${file.get_basename()} — de ${device}`, {
            transient: false,
            onActivate: () => openUri(file.get_uri()),
            actions: [['Abrir carpeta', () => openUri(file.get_parent().get_uri())]],
        });
    }

    _onTextReceived(text, isUrl) {
        if (isUrl) {
            openUri(text);
            this._notify('Link del teléfono', text);
        } else {
            this._setClipboard(text);
            this._notify('Texto del teléfono (copiado)', text.length > 120 ? `${text.slice(0, 120)}…` : text);
        }
    }

    destroy() {
        this._selection?.disconnectObject(this);
        for (const id of this._signalIds ?? [])
            this._proxy.disconnectSignal(id);
        this._proxy?.disconnectObject(this);
        this._pairDialog?.close();
        this._source?.destroy();
        super.destroy();
    }
});
