// Barra de tareas integrada en la barra superior: un ícono chico, teñido de bordó,
// por cada app con ventanas abiertas.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

const ICON_SIZE = 18;
const MAX_DOTS = 3;
const TINT = new Cogl.Color({red: 214, green: 52, blue: 88, alpha: 255});
const TINT_FOCUSED = new Cogl.Color({red: 255, green: 120, blue: 150, alpha: 255});

export const TERMINAL_IDS = new Set(['org.gnome.Ptyxis.desktop', 'org.gnome.Console.desktop', 'org.gnome.Terminal.desktop']);
export const CLAUDE_KEY = 'moonriver:claude-code';
const CLAUDE_ICON_APPS = ['claude-desktop-unofficial.desktop', 'claude-desktop.desktop', 'com.anthropic.claude.desktop'];

export function taskbarWindows(app) {
    return app.get_windows().filter(w => !w.skip_taskbar &&
        [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.UTILITY].includes(w.get_window_type()));
}

// Claude Code pone en el título de la terminal una estrella (✳, ✶, ✻…) o su nombre.
export function isClaudeCodeWindow(window) {
    const title = window.get_title() ?? '';
    return /claude/i.test(title) || /^[\u2722-\u273D]/.test(title);
}

function claudeIcon() {
    const appSystem = Shell.AppSystem.get_default();
    for (const id of CLAUDE_ICON_APPS) {
        const app = appSystem.lookup_app(id);
        if (app?.get_icon())
            return app.get_icon();
    }
    return Gio.ThemedIcon.new('utilities-terminal');
}

/**
 * Un grupo es lo que representa un ícono: normalmente una app, pero las terminales
 * con Claude Code forman su propio grupo (con el logo de Claude).
 */
export function appGroup(app) {
    const isTerminal = TERMINAL_IDS.has(app.get_id());
    return {
        key: app.get_id(),
        app,
        name: app.get_name(),
        gicon: null,
        windows: () => taskbarWindows(app).filter(w => !(isTerminal && isClaudeCodeWindow(w))),
    };
}

export function claudeGroup(terminalApps) {
    return {
        key: CLAUDE_KEY,
        app: terminalApps[0],
        name: 'Claude Code',
        gicon: claudeIcon(),
        windows: () => terminalApps.flatMap(a => taskbarWindows(a)).filter(isClaudeCodeWindow),
    };
}

const TaskbarItem = GObject.registerClass(
class TaskbarItem extends St.Button {
    _init(group, taskbar) {
        super._init({
            style_class: 'moonriver-task',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            can_focus: true,
            reactive: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.group = group;
        this.app = group.app;
        this._taskbar = taskbar;

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'moonriver-task-box'});
        this._icon = group.gicon
            ? new St.Icon({gicon: group.gicon, icon_size: ICON_SIZE})
            : group.app.create_icon_texture(ICON_SIZE);
        this._tint = new Clutter.ColorizeEffect({tint: TINT});
        this._icon.add_effect(this._tint);
        box.add_child(this._icon);

        this._dots = new St.BoxLayout({style_class: 'moonriver-task-dots', x_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._dots);
        this.set_child(box);

        this.accessible_name = group.name;

        if (group.key === CLAUDE_KEY) {
            // Menú propio: las sesiones abiertas y "nueva sesión"
            this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
            this._menu.connect('open-state-changed', (_m, open) => {
                if (open)
                    this._buildClaudeMenu();
            });
        } else {
            this._menu = new AppMenu(this, St.Side.TOP, {favoritesSection: true, showSingleWindows: true});
            this._menu.setApp(group.app);
        }
        this._menu.box.add_style_class_name('moonriver-menu');
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        taskbar.menuManager.addMenu(this._menu);
        this._menu.connect('open-state-changed', (_m, open) => {
            if (open)
                taskbar.hideTooltip();
            else
                this.sync();
        });

        this.connect('clicked', (_b, button) => this._onClicked(button));
        this.connect('notify::hover', () => {
            if (this.hover && !this._menu.isOpen)
                taskbar.showTooltip(this);
            else
                taskbar.hideTooltip();
        });
        this.connect('destroy', () => this._menu.destroy());

        this.sync();
    }

    _buildClaudeMenu() {
        this._menu.removeAll();
        for (const w of this.group.windows()) {
            const title = (w.get_title() ?? 'Claude Code').replace(/^[\u2722-\u273D]\s*/, '');
            this._menu.addAction(title, () => Main.activateWindow(w, global.get_current_time()));
        }
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction('Nueva sesión de Claude Code', () => this._taskbar.onNewClaudeCode?.());
    }

    sync() {
        const windows = this.group.windows();
        const focused = windows.includes(global.display.focus_window);

        this._tint.tint = focused ? TINT_FOCUSED : TINT;
        // Clase propia: el pseudo-estado :active de St.Button se pisa al soltar el clic.
        if (focused)
            this.add_style_class_name('focused');
        else
            this.remove_style_class_name('focused');

        const allMinimized = windows.length > 0 && windows.every(w => w.minimized);
        this._icon.opacity = allMinimized ? 130 : 255;

        this._dots.destroy_all_children();
        for (let i = 0; i < Math.min(windows.length, MAX_DOTS); i++)
            this._dots.add_child(new St.Widget({style_class: focused ? 'moonriver-task-dot active' : 'moonriver-task-dot'}));
    }

    _onClicked(button) {
        this._taskbar.hideTooltip();

        if (button === Clutter.BUTTON_SECONDARY) {
            this._menu.open();
            return;
        }
        if (button === Clutter.BUTTON_MIDDLE) {
            if (this.group.key === CLAUDE_KEY)
                this._taskbar.onNewClaudeCode?.();
            else
                this.app.open_new_window(-1);
            return;
        }

        const windows = this.group.windows()
            .sort((a, b) => b.get_user_time() - a.get_user_time());
        if (windows.length === 0) {
            this.app.activate();
            return;
        }

        const focusedWindow = global.display.focus_window;
        const ownsFocus = windows.includes(focusedWindow);
        const time = global.get_current_time();

        if (!ownsFocus) {
            Main.activateWindow(windows[0], time);
        } else if (windows.length === 1) {
            focusedWindow.minimize();
        } else {
            // Varias ventanas: ir pasando de una a otra (orden estable por id)
            const stable = [...windows].sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
            const next = stable[(stable.indexOf(focusedWindow) + 1) % stable.length];
            Main.activateWindow(next, time);
        }
    }
});

export const Taskbar = GObject.registerClass(
class Taskbar extends St.BoxLayout {
    _init() {
        super._init({style_class: 'moonriver-taskbar', y_expand: true});

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this._items = new Map();
        this._order = [];
        this._syncId = 0;
        this._watchedWindows = new Set();
        this.onNewClaudeCode = null;
        this._suppressed = false;

        this._tooltip = new St.Label({style_class: 'moonriver-task-tooltip', visible: false});
        Main.uiGroup.add_child(this._tooltip);

        const queue = () => this._queueSync();
        Shell.AppSystem.get_default().connectObject('app-state-changed', queue, this);
        Shell.WindowTracker.get_default().connectObject('notify::focus-app', queue, this);
        global.display.connectObject(
            'window-created', queue,
            'notify::focus-window', queue,
            this);
        global.window_manager.connectObject(
            'minimize', queue,
            'unminimize', queue,
            'destroy', queue,
            this);

        this._sync();
    }

    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const running = Shell.AppSystem.get_default().get_running();
        const terminals = running.filter(a => TERMINAL_IDS.has(a.get_id()));

        // Las terminales cambian de grupo según su título: escucharlo
        for (const w of terminals.flatMap(a => taskbarWindows(a))) {
            if (!this._watchedWindows.has(w)) {
                this._watchedWindows.add(w);
                w.connectObject('notify::title', () => this._queueSync(), this);
                w.connectObject('unmanaged', () => this._watchedWindows.delete(w), this);
            }
        }

        const groups = running.map(appGroup);
        if (terminals.length)
            groups.push(claudeGroup(terminals));
        const visible = groups.filter(g => g.windows().length > 0);
        const keys = new Set(visible.map(g => g.key));

        // Quitar las que se cerraron
        for (const [key, item] of this._items) {
            if (!keys.has(key)) {
                item.destroy();
                this._items.delete(key);
            }
        }
        this._order = this._order.filter(key => keys.has(key));

        // Agregar las nuevas al final, en orden de aparición
        for (const group of visible) {
            if (!this._items.has(group.key)) {
                const item = new TaskbarItem(group, this);
                this._items.set(group.key, item);
                this._order.push(group.key);
                this.add_child(item);
                group.app.connectObject('windows-changed', () => this._queueSync(), item);
            } else {
                this._items.get(group.key).group = group;
            }
            this._items.get(group.key).sync();
        }
        this._syncVisible();
    }

    // En el escritorio manda el dock: la barra de tareas se esconde
    setSuppressed(suppressed) {
        this._suppressed = suppressed;
        this._syncVisible();
    }

    _syncVisible() {
        const visible = !this._suppressed && this._items.size > 0;
        if (visible === this.visible && !this._fading)
            return;
        this.remove_all_transitions();
        if (visible) {
            this._fading = false;
            this.visible = true;
            this.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this._fading = true;
            this.hideTooltip();
            this.ease({
                opacity: 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._fading = false;
                    this.visible = false;
                },
            });
        }
    }

    showTooltip(item) {
        this._tooltip.text = item.group.name;
        this._tooltip.show();
        const [x, y] = item.get_transformed_position();
        const [w, h] = item.get_transformed_size();
        const [tw] = this._tooltip.get_preferred_width(-1);
        this._tooltip.set_position(Math.round(x + w / 2 - tw / 2), Math.round(y + h + 8));
    }

    hideTooltip() {
        this._tooltip.hide();
    }

    destroy() {
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        Shell.AppSystem.get_default().disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        for (const w of this._watchedWindows)
            w.disconnectObject(this);
        this._watchedWindows.clear();
        this._tooltip.destroy();
        super.destroy();
    }
});
