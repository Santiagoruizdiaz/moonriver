import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Desktop, addAppToDesktop} from './desktop.js';
import {Launcher} from './launcher.js';
import {Dock} from './dock.js';
import {Taskbar} from './taskbar.js';
import {PhoneIndicator} from './phone.js';

const HOME = GLib.get_home_dir();
const AGENT_POLL_SECONDS = 5;
const MAX_RECENT_PROJECTS = 8;

const ANTIGRAVITY_IDS = ['antigravity.desktop', 'google-antigravity.desktop', 'com.google.antigravity.desktop'];
const CLAUDE_DESKTOP_IDS = ['claude-desktop-unofficial.desktop', 'claude-desktop.desktop', 'com.anthropic.claude.desktop'];
const TERMINAL_IDS = ['org.gnome.Ptyxis.desktop', 'org.gnome.Console.desktop', 'org.gnome.Terminal.desktop'];

// Busca por id de .desktop y, si no aparece, por nombre visible
// (los lanzadores hechos a mano, p. ej. con Alacarte, tienen ids genéricos).
function lookupApp(ids, name = null) {
    const appSystem = Shell.AppSystem.get_default();
    for (const id of ids) {
        const app = appSystem.lookup_app(id);
        if (app)
            return app;
    }
    if (!name)
        return null;
    return appSystem.get_installed()
        .filter(info => info.get_name()?.toLowerCase() === name.toLowerCase())
        .map(info => appSystem.lookup_app(info.get_id()))
        .find(Boolean) ?? null;
}

function prettyPath(path) {
    if (path.includes('/.config/Claude/scratch-workspaces/'))
        return 'scratch';
    if (path === HOME)
        return '~';
    return path.startsWith(`${HOME}/`) ? `~/${path.slice(HOME.length + 1)}` : path;
}

// Claude Code guarda cada proyecto en ~/.claude/projects/<ruta con separadores reemplazados por '-'>
function claudeProjectDir(path) {
    return GLib.build_filenamev([HOME, '.claude', 'projects', path.replace(/[^A-Za-z0-9]/g, '-')]);
}

function mtimeOf(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_modification_date_time()?.to_unix() ?? 0;
    } catch {
        return 0;
    }
}

function recentClaudeProjects() {
    let projects;
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([HOME, '.claude.json']));
        projects = Object.keys(JSON.parse(new TextDecoder().decode(bytes)).projects ?? {});
    } catch {
        return [];
    }

    return projects
        .filter(p => !p.includes('/.claude/worktrees/') && !p.includes('/scratch-workspaces/'))
        .filter(p => GLib.file_test(p, GLib.FileTest.IS_DIR))
        .map(p => ({path: p, mtime: mtimeOf(claudeProjectDir(p))}))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, MAX_RECENT_PROJECTS)
        .map(p => p.path);
}

function openClaudeCodeIn(dir) {
    const terminal = lookupApp(TERMINAL_IDS);
    const shellCmd = "claude; exec \"${SHELL:-bash}\"";
    // Ptyxis (Fedora), GNOME Console o GNOME Terminal (Ubuntu), según cuál esté instalada
    const argv = {
        'org.gnome.Console.desktop': ['kgx', '--working-directory', dir, '--', 'bash', '-lc', shellCmd],
        'org.gnome.Terminal.desktop': ['gnome-terminal', `--working-directory=${dir}`, '--title', 'Claude Code', '--', 'bash', '-lc', shellCmd],
    }[terminal?.get_id()] ?? ['ptyxis', '--new-window', '-d', dir, '-T', 'Claude Code', '-x', `bash -lc '${shellCmd}'`];
    try {
        GLib.spawn_async(dir, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
    } catch (e) {
        Main.notifyError('Moonriver', `No se pudo abrir Claude Code: ${e.message}`);
    }
}

function launchAppOrCommand(ids, command) {
    const app = lookupApp(ids);
    if (app) {
        app.activate();
        return;
    }
    if (command && GLib.find_program_in_path(command))
        GLib.spawn_async(HOME, [command], null, GLib.SpawnFlags.SEARCH_PATH, null);
}

const MoonMenu = GObject.registerClass(
class MoonMenu extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Moonriver');
        this.add_style_class_name('moonriver-button');

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/moonriver-symbolic.svg`),
            style_class: 'system-status-icon moonriver-logo',
        }));

        this.menu.box.add_style_class_name('moonriver-menu');
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._rebuild();
        });
        this._rebuild();
    }

    _section(title) {
        const header = new PopupMenu.PopupMenuItem(title, {reactive: false, can_focus: false});
        header.add_style_class_name('moonriver-section-title');
        this.menu.addMenuItem(header);
    }

    _item(label, iconName, callback, sensitive = true) {
        const item = new PopupMenu.PopupImageMenuItem(label, iconName);
        item.setSensitive(sensitive);
        item.connect('activate', callback);
        this.menu.addMenuItem(item);
        return item;
    }

    _rebuild() {
        this.menu.removeAll();

        this._section('Agentes');
        const projects = new PopupMenu.PopupSubMenuMenuItem('Claude Code en…', true);
        projects.icon.icon_name = 'utilities-terminal-symbolic';
        const recent = recentClaudeProjects();
        if (recent.length === 0)
            projects.menu.addMenuItem(new PopupMenu.PopupMenuItem('Sin proyectos recientes', {reactive: false}));
        for (const path of recent)
            projects.menu.addAction(prettyPath(path), () => openClaudeCodeIn(path));
        this.menu.addMenuItem(projects);

        this._item('Claude Code en ~', 'utilities-terminal-symbolic', () => openClaudeCodeIn(HOME));

        const claudeDesktop = lookupApp(CLAUDE_DESKTOP_IDS);
        if (claudeDesktop)
            this._item('Claude', claudeDesktop.get_icon(), () => claudeDesktop.activate());

        const antigravity = lookupApp(ANTIGRAVITY_IDS, 'Antigravity');
        if (antigravity)
            this._item('Antigravity', antigravity.get_icon(), () => antigravity.activate());
        else
            this._item('Antigravity (no instalado)', 'applications-engineering-symbolic', () => {}, false);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._item('Terminal', 'utilities-terminal-symbolic', () => launchAppOrCommand(TERMINAL_IDS, 'ptyxis'));
        this._item('Archivos', 'folder-symbolic', () => launchAppOrCommand(['org.gnome.Nautilus.desktop'], 'nautilus'));
        this._item('Configuración', 'emblem-system-symbolic', () => launchAppOrCommand(['org.gnome.Settings.desktop']));

    }
});

const AgentIndicator = GObject.registerClass(
class AgentIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Agentes Claude');
        this.add_style_class_name('moonriver-agents');

        const box = new St.BoxLayout({style_class: 'moonriver-agents-box'});
        this._dot = new St.Widget({style_class: 'moonriver-agents-dot', y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._dot);
        box.add_child(this._label);
        this.add_child(box);

        this.menu.box.add_style_class_name('moonriver-menu');
        this._agents = [];
        this.visible = false;
        this._cancellable = new Gio.Cancellable();

        this._poll();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, AGENT_POLL_SECONDS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _poll() {
        let proc;
        try {
            proc = Gio.Subprocess.new(['pgrep', '-x', 'claude'], Gio.SubprocessFlags.STDOUT_PIPE);
        } catch {
            return;
        }
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            let stdout = '';
            try {
                [, stdout] = p.communicate_utf8_finish(res);
            } catch (e) {
                console.warn(`Moonriver: no se pudo listar agentes: ${e.message}`);
                return;
            }
            const agents = [];
            for (const pid of stdout.split('\n').filter(Boolean)) {
                try {
                    agents.push(GLib.file_read_link(`/proc/${pid}/cwd`));
                } catch {
                    agents.push('(carpeta desconocida)');
                }
            }
            this._update(agents);
        });
    }

    _update(agents) {
        this._agents = agents;
        this.visible = agents.length > 0;
        this._label.text = `${agents.length} ${agents.length === 1 ? 'agente' : 'agentes'}`;

        this.menu.removeAll();
        const byProject = new Map();
        for (const cwd of agents) {
            const name = prettyPath(cwd);
            byProject.set(name, (byProject.get(name) ?? 0) + 1);
        }
        const header = new PopupMenu.PopupMenuItem('Sesiones de Claude Code', {reactive: false});
        header.add_style_class_name('moonriver-section-title');
        this.menu.addMenuItem(header);
        for (const [name, count] of [...byProject].sort((a, b) => b[1] - a[1])) {
            const item = new PopupMenu.PopupMenuItem(name, {reactive: false});
            item.add_child(new St.Label({
                text: `×${count}`, style_class: 'moonriver-count',
                x_expand: true, x_align: Clutter.ActorAlign.END,
            }));
            this.menu.addMenuItem(item);
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }
});

export default class MoonriverExtension extends Extension {
    enable() {
        // Clase raíz: todo el CSS de Moonriver cuelga de acá para ganarle en especificidad al tema base.
        Main.uiGroup.add_style_class_name('moonriver');

        this._menu = new MoonMenu(this);
        Main.panel.addToStatusArea('moonriver-menu', this._menu, 0, 'left');

        this._agents = new AgentIndicator();
        Main.panel.addToStatusArea('moonriver-agents', this._agents, 0, 'right');

        this._phone = new PhoneIndicator(this.path);
        Main.panel.addToStatusArea('moonriver-phone', this._phone, 1, 'right');

        this._desktop = new Desktop();
        this._desktop.onOpenClaudeCode = openClaudeCodeIn;

        // "Agregar al escritorio" en el menú contextual de las apps (overview y dock).
        this._appMenuItems = new Set();
        this._injections = new InjectionManager();
        const items = this._appMenuItems;
        this._injections.overrideMethod(AppMenu.prototype, 'setApp', original => function (app) {
            original.call(this, app);
            if (!this._moonriverDesktopItem) {
                this._moonriverDesktopItem = new PopupMenu.PopupMenuItem('Agregar al escritorio');
                this._moonriverDesktopItem.connect('activate', () => addAppToDesktop(this._app));
                this.addMenuItem(this._moonriverDesktopItem, this._getMenuItems().indexOf(this._toggleFavoriteItem) + 1);
                items.add(this._moonriverDesktopItem);
                const menu = this;
                this._moonriverDesktopItem.connect('destroy', item => {
                    items.delete(item);
                    if (menu._moonriverDesktopItem === item)
                        menu._moonriverDesktopItem = null;
                });
            }
            this._moonriverDesktopItem.visible = Boolean(app?.get_app_info()?.get_filename());
        });

        // Menú de aplicaciones en lugar del botón "Actividades".
        this._launcher = new Launcher();
        Main.panel.addToStatusArea('moonriver-launcher', this._launcher, 1, 'left');
        Main.panel.statusArea.activities?.container.hide();

        // Barra de tareas: justo después del botón de aplicaciones.
        this._taskbar = new Taskbar();
        Main.panel._leftBox.insert_child_above(this._taskbar, this._launcher.container);
        this._taskbar.onNewClaudeCode = () => openClaudeCodeIn(GLib.get_home_dir());

        // Dock abajo, solo en el escritorio: con ventanas a la vista manda la barra de tareas.
        this._dock = new Dock();
        this._dock.onNewClaudeCode = () => openClaudeCodeIn(GLib.get_home_dir());
        this._dock.onShownChanged = shown => this._taskbar.setSuppressed(shown);
        this._taskbar.setSuppressed(this._dock.shown);
        this._desktop.setBottomInset(this._dock.reservedHeight);

        this._blockOverview();
    }

    // Siempre en el escritorio: todo lo que abriría el overview (Super, Super+A, botón,
    // esquina activa) termina en Main.overview.show()/toggle(), y lo mandamos al menú.
    _blockOverview() {
        const launcher = this._launcher;
        const openLauncher = () => {
            if (!launcher.isOpen)
                launcher.open();
        };
        this._injections.overrideMethod(Main.overview, 'show', () => openLauncher);
        this._injections.overrideMethod(Main.overview, 'showApps', () => openLauncher);
        this._injections.overrideMethod(Main.overview, 'toggle', original => function () {
            if (this.visible)
                original.call(this);
            else
                launcher.toggle();
        });
        // La esquina activa no hace nada (si no, abriría el menú al rozar el borde).
        this._injections.overrideMethod(Main.overview, 'shouldToggleByCornerOrButton', () => () => false);

        // Gesto de 3 dedos hacia arriba en el touchpad
        const swipe = Main.overview._swipeTracker;
        if (swipe) {
            this._swipeWasEnabled = swipe.enabled;
            swipe.enabled = false;
        }

        // Al iniciar sesión: arrancar en el escritorio, no en el overview.
        if (Main.layoutManager._startingUp) {
            this._realHasOverview = Main.sessionMode.hasOverview;
            Main.sessionMode.hasOverview = false;
            Main.layoutManager.connectObject('startup-complete', () => {
                Main.sessionMode.hasOverview = this._realHasOverview;
                this._realHasOverview = undefined;
                Main.layoutManager.disconnectObject(this);
                // Respaldo por si la animación de inicio ya había arrancado antes que la extensión.
                if (Main.overview.visible)
                    Main.overview.hide();
            }, this);
        } else if (Main.overview.visible) {
            Main.overview.hide();
        }
    }

    disable() {
        this._injections?.clear();
        this._injections = null;
        if (this._swipeWasEnabled !== undefined && Main.overview._swipeTracker)
            Main.overview._swipeTracker.enabled = this._swipeWasEnabled;
        if (this._realHasOverview !== undefined) {
            Main.sessionMode.hasOverview = this._realHasOverview;
            this._realHasOverview = undefined;
        }
        Main.layoutManager.disconnectObject(this);
        Main.panel.statusArea.activities?.container.show();
        this._dock?.destroy();
        this._dock = null;
        this._taskbar?.destroy();
        this._taskbar = null;
        this._launcher?.destroy();
        this._launcher = null;
        for (const item of this._appMenuItems ?? [])
            item.destroy();
        this._appMenuItems = null;
        this._desktop?.destroy();
        this._desktop = null;
        this._phone?.destroy();
        this._phone = null;
        this._agents?.destroy();
        this._agents = null;
        this._menu?.destroy();
        this._menu = null;
        Main.uiGroup.remove_style_class_name('moonriver');
    }
}
