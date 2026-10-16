// Dock inferior estilo macOS: apps fijadas + abiertas, magnificación que sigue al
// cursor, rebote al abrir y papelera al final. Solo se ve en el escritorio: en
// cuanto hay una ventana a la vista baja y las apps pasan a la barra de arriba.
//
// Todo se ubica a mano (sin layout manager) y se anima con un único bucle por
// cuadro que suaviza los valores hacia su objetivo: así la magnificación, las
// altas/bajas de íconos y el fondo se mueven juntos y sin saltos.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

import {TERMINAL_IDS, CLAUDE_KEY, taskbarWindows, appGroup, claudeGroup} from './taskbar.js';

// Medidas en px lógicos (se multiplican por el factor de escala de St)
const ICON = 48;            // ícono en reposo
const MAG = 1.6;            // tamaño máximo bajo el cursor
const SLOT = 58;            // ancho que ocupa cada ícono en reposo
const SEP_SLOT = 15;
const RANGE = 2.6;          // alcance de la magnificación, en íconos
const PAD_X = 8;
const PAD_TOP = 7;
const PAD_BOTTOM = 10;
const MARGIN = 8;           // aire entre el dock y el borde de la pantalla
const DOT = 5;

// Constantes de tiempo del suavizado (ms): más chico = más rápido
const TAU_ZOOM_IN = 55;
const TAU_ZOOM_OUT = 85;
const TAU_PRESENCE = 70;
const SETTLE = 0.002;

const BOUNCE_HEIGHT = 18;
const BOUNCE_MS = 330;
const MAX_BOUNCES = 3;

const TRASH_KEY = 'moonriver:trash';

// Perfil de la magnificación: 1 bajo el cursor, 0 a RANGE de distancia (coseno suave)
function falloff(d, r) {
    return d >= r ? 0 : (1 + Math.cos(Math.PI * d / r)) / 2;
}

// Integral de falloff entre 0 y d: cuánto se corre un punto a esa distancia del cursor
function falloffIntegral(d, r) {
    return d >= r ? r / 2 : d / 2 + r / (2 * Math.PI) * Math.sin(Math.PI * d / r);
}

function approach(value, target, dt, tau) {
    if (tau <= 0)
        return target;
    const next = value + (target - value) * (1 - Math.exp(-dt / tau));
    return Math.abs(target - next) < SETTLE ? target : next;
}

const DockIcon = GObject.registerClass(
class DockIcon extends St.Button {
    _init(dock, {key, name, gicon = null, app = null}) {
        super._init({
            style_class: 'moonriver-dock-item',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            reactive: true,
            can_focus: true,
            track_hover: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 1}),
        });
        this.key = key;
        this.name = name;
        this.accessible_name = name;
        this._dock = dock;

        // El ícono se dibuja al tamaño magnificado y se achica con la escala del
        // actor: así queda nítido justo cuando está más grande.
        const size = Math.round(ICON * MAG);
        this._icon = gicon || !app
            ? new St.Icon({gicon, icon_size: size})
            : app.create_icon_texture(size);
        this._icon.x_align = Clutter.ActorAlign.CENTER;
        this._icon.y_align = Clutter.ActorAlign.END;
        this._icon.x_expand = true;
        this.set_child(this._icon);

        this._press = new Clutter.BrightnessContrastEffect({enabled: false});
        this._press.set_brightness(-0.22);
        this._icon.add_effect(this._press);
        this.connect('notify::pressed', () => (this._press.enabled = this.pressed));

        this.dot = new St.Widget({style_class: 'moonriver-dock-dot', opacity: 0});

        this.connect('destroy', () => {
            this.menu?.destroy();
            this.dot?.destroy();
            this.dot = null;
        });

        this.connect('notify::hover', () => dock.onItemHover(this));
        this.connect('motion-event', (_a, event) => dock.onMotion(event));
        this.connect('leave-event', () => dock.queuePointerCheck());
        this.connect('clicked', (_b, button) => {
            dock.hideTooltip();
            this.onClick(button);
        });
    }

    setGIcon(gicon) {
        if (this._icon instanceof St.Icon)
            this._icon.gicon = gicon;
    }

    bounce(bounces = MAX_BOUNCES) {
        if (this._bouncing || !St.Settings.get().enable_animations)
            return;
        this._bouncing = true;
        const height = BOUNCE_HEIGHT * this._dock.scaleFactor;
        const step = left => {
            this.ease({
                translation_y: -height,
                duration: BOUNCE_MS / 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.ease({
                    translation_y: 0,
                    duration: BOUNCE_MS / 2,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (left > 1 && !this.stopBounce)
                            step(left - 1);
                        else
                            this._bouncing = this.stopBounce = false;
                    },
                }),
            });
        };
        step(bounces);
    }

    onClick(_button) {}

    sync() {}

    get windows() {
        return [];
    }
});

const AppIcon = GObject.registerClass(
class AppIcon extends DockIcon {
    _init(dock, group) {
        super._init(dock, {key: group.key, name: group.name, gicon: group.gicon, app: group.app});
        this.group = group;

        if (group.key === CLAUDE_KEY) {
            // Menú propio: las sesiones abiertas y "nueva sesión"
            this.menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
            this.menu.connect('open-state-changed', (_m, open) => {
                if (open)
                    this._buildClaudeMenu();
            });
        } else {
            this.menu = new AppMenu(this, St.Side.BOTTOM, {favoritesSection: true, showSingleWindows: true});
            this.menu.setApp(group.app);
        }
        dock.addMenu(this.menu);
    }

    get windows() {
        return this.group.windows();
    }

    _buildClaudeMenu() {
        this.menu.removeAll();
        for (const w of this.windows) {
            const title = (w.get_title() ?? 'Claude Code').replace(/^[✢-✽]\s*/, '');
            this.menu.addAction(title, () => Main.activateWindow(w, global.get_current_time()));
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Nueva sesión de Claude Code', () => this._dock.onNewClaudeCode?.());
    }

    sync() {
        const windows = this.windows;
        const focused = windows.includes(global.display.focus_window);
        this.running = windows.length > 0;
        if (this.running)
            this.stopBounce = true;

        this.dot.ease({
            opacity: this.running ? 255 : 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        if (focused)
            this.dot.add_style_class_name('focused');
        else
            this.dot.remove_style_class_name('focused');
    }

    onClick(button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            this.menu.open();
            return;
        }
        const time = global.get_current_time();
        if (button === Clutter.BUTTON_MIDDLE) {
            if (this.group.key === CLAUDE_KEY) {
                this._dock.onNewClaudeCode?.();
            } else {
                this.group.app.open_new_window(-1);
                this.bounce(1);
            }
            return;
        }

        const windows = this.windows.sort((a, b) => b.get_user_time() - a.get_user_time());
        if (windows.length === 0) {
            if (this.group.key === CLAUDE_KEY) {
                this._dock.onNewClaudeCode?.();
            } else {
                this.group.app.activate();
                this.bounce();
            }
            return;
        }

        const focusedWindow = global.display.focus_window;
        if (!windows.includes(focusedWindow)) {
            // Traer todas las ventanas de la app, la última usada arriba
            for (const w of windows.slice(1).reverse())
                w.raise();
            Main.activateWindow(windows[0], time);
        } else if (windows.length === 1) {
            focusedWindow.minimize();
        } else {
            // Varias ventanas: ir pasando de una a otra (orden estable)
            const stable = [...windows].sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
            Main.activateWindow(stable[(stable.indexOf(focusedWindow) + 1) % stable.length], time);
        }
    }
});

const TrashIcon = GObject.registerClass(
class TrashIcon extends DockIcon {
    _init(dock) {
        super._init(dock, {key: TRASH_KEY, name: 'Papelera', gicon: Gio.ThemedIcon.new('user-trash')});
        this._file = Gio.File.new_for_uri('trash:///');
        try {
            this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this.sync());
            this.connect('destroy', () => this._monitor.cancel());
        } catch (e) {
            console.warn(`Moonriver: no se pudo vigilar la papelera: ${e.message}`);
        }

        this.menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
        this.menu.addAction('Abrir', () => this._open());
        this._emptyItem = this.menu.addAction('Vaciar papelera…', () => this._empty());
        dock.addMenu(this.menu);
        this.sync();
    }

    sync() {
        this._file.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (file, res) => {
                let count = 0;
                try {
                    count = file.query_info_finish(res).get_attribute_uint32('trash::item-count');
                } catch {
                    return;
                }
                this.setGIcon(Gio.ThemedIcon.new(count > 0 ? 'user-trash-full' : 'user-trash'));
                this._emptyItem?.setSensitive(count > 0);
            });
    }

    _open() {
        Gio.AppInfo.launch_default_for_uri_async('trash:///', global.create_app_launch_context(0, -1), null, null);
    }

    // Nautilus pide confirmación antes de borrar nada
    _empty() {
        Gio.DBus.session.call('org.gnome.Nautilus', '/org/gnome/Nautilus',
            'org.gnome.Nautilus.FileOperations2', 'EmptyTrash',
            new GLib.Variant('(ba{sv})', [true, {}]), null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch {
                    this._open();
                }
            });
    }

    onClick(button) {
        if (button === Clutter.BUTTON_SECONDARY)
            this.menu.open();
        else
            this._open();
    }
});

// Una entrada del dock: un ícono o un separador, con su "presencia" animada
// (0 = recién llegado o yéndose, 1 = en su lugar).
class Entry {
    constructor(key, actor, slot) {
        this.key = key;
        this.actor = actor;
        this.slot = slot;
        this.presence = 0;
        this.target = 1;
    }
}

export const Dock = GObject.registerClass(
class Dock extends St.Widget {
    _init() {
        super._init({name: 'moonriverDock', reactive: false, clip_to_allocation: false});

        this.onNewClaudeCode = null;
        this.onShownChanged = null;
        this.shown = true;
        this._entries = [];
        this._pointerX = 0;
        this._zoom = 0;
        this._zoomTarget = 0;
        this._syncId = 0;
        this._watchedWindows = new Set();

        this._bg = new St.Widget({style_class: 'moonriver-dock', reactive: true});
        this.add_child(this._bg);

        this._tooltip = new St.Label({style_class: 'moonriver-dock-tooltip', opacity: 0, visible: false});
        this._tooltipItem = null;

        this.menuManager = new PopupMenu.PopupMenuManager(this);

        // Sin reservar espacio: el dock solo aparece cuando no hay ventanas a la vista
        Main.layoutManager.addChrome(this, {trackFullscreen: true});
        Main.uiGroup.add_child(this._tooltip);

        this._trash = new TrashIcon(this);
        this._sepTrash = new St.Widget({style_class: 'moonriver-dock-sep'});

        this._bg.connect('motion-event', (_a, event) => this.onMotion(event));
        this._bg.connect('enter-event', (_a, event) => this.onMotion(event));
        this._bg.connect('leave-event', () => this.queuePointerCheck());

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());

        const queue = () => this._queueSync();
        Shell.AppSystem.get_default().connectObject('app-state-changed', queue, this);
        AppFavorites.getAppFavorites().connectObject('changed', queue, this);
        Shell.WindowTracker.get_default().connectObject('notify::focus-app', queue, this);
        global.display.connectObject(
            'window-created', queue,
            'notify::focus-window', queue,
            this);
        global.window_manager.connectObject(
            'minimize', queue,
            'unminimize', queue,
            'map', queue,
            'destroy', (_wm, actor) => {
                this._closing.add(actor.meta_window);
                queue();
            },
            'switch-workspace', queue,
            this);
        this._closing = new Set();
        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', () => this._relayout(), this);

        this._sync();
        this._snap();
        this._relayout();

        // Entrada: sube desde abajo (si arrancamos en el escritorio)
        this.shown = false;
        this.translation_y = this._hiddenOffset;
        this.opacity = 0;
        this.visible = false;
        this._updateShown();
    }

    // Alto que el dock le ocupa al escritorio (para que los íconos no queden abajo)
    get reservedHeight() {
        return (ICON + PAD_TOP + PAD_BOTTOM + MARGIN + 8) * this.scaleFactor;
    }

    get _hiddenOffset() {
        return (ICON + PAD_TOP + PAD_BOTTOM + MARGIN + 12) * this.scaleFactor;
    }

    // ¿Hay alguna ventana a la vista en el área de trabajo actual?
    _desktopIsClear() {
        const workspace = global.workspace_manager.get_active_workspace();
        const types = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.UTILITY];
        return !workspace.list_windows().some(w =>
            !w.minimized && !w.skip_taskbar && !this._closing.has(w) &&
            types.includes(w.get_window_type()));
    }

    _updateShown() {
        const shown = this._desktopIsClear();
        this._closing.clear();
        if (shown === this.shown)
            return;
        this.shown = shown;
        this.onShownChanged?.(shown);

        this.remove_transition('translation-y');
        this.remove_transition('opacity');
        if (shown) {
            this.visible = true;
            this.ease({
                translation_y: 0, opacity: 255,
                duration: 420, mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        } else {
            this.hideTooltip();
            this.menuManager.activeMenu?.close();
            this._setZoom(0);
            this.ease({
                translation_y: this._hiddenOffset, opacity: 0,
                duration: 260, mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => (this.visible = false),
            });
        }
    }

    get scaleFactor() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    addMenu(menu) {
        menu.box.add_style_class_name('moonriver-menu');
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this.menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this.hideTooltip();
                this._setZoom(0);
            }
        });
    }

    // ───── Contenido ─────

    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _wantedGroups() {
        const appSystem = Shell.AppSystem.get_default();
        const running = appSystem.get_running();
        const terminals = running.filter(a => TERMINAL_IDS.has(a.get_id()));

        // Las terminales cambian de grupo según su título: escucharlo
        for (const w of terminals.flatMap(a => taskbarWindows(a))) {
            if (!this._watchedWindows.has(w)) {
                this._watchedWindows.add(w);
                w.connectObject('notify::title', () => this._queueSync(), this);
                w.connectObject('unmanaged', () => this._watchedWindows.delete(w), this);
            }
        }

        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favIds = new Set(favorites.map(a => a.get_id()));
        const pinned = favorites.map(appGroup);
        const others = running
            .filter(a => !favIds.has(a.get_id()))
            .map(appGroup)
            .filter(g => g.windows().length > 0);
        if (terminals.length) {
            const claude = claudeGroup(terminals);
            if (claude.windows().length > 0)
                others.push(claude);
        }
        return {pinned, others};
    }

    _sync() {
        const {pinned, others} = this._wantedGroups();

        // Orden deseado: fijadas | abiertas | papelera
        const wanted = [...pinned.map(g => ['app', g])];
        if (others.length) {
            wanted.push(['sep', 'sep:running']);
            wanted.push(...others.map(g => ['app', g]));
        }
        wanted.push(['sep', 'sep:trash'], ['trash', null]);

        const byKey = new Map(this._entries.map(e => [e.key, e]));
        const keep = new Set();
        const ordered = [];
        for (const [kind, data] of wanted) {
            const key = kind === 'app' ? data.key : kind === 'trash' ? TRASH_KEY : data;
            keep.add(key);
            let entry = byKey.get(key);
            if (!entry) {
                entry = this._createEntry(kind, data, key);
            } else if (kind === 'app') {
                entry.actor.group = data;
            }
            entry.target = 1;
            ordered.push(entry);
        }

        // Las que se van se quedan en su lugar mientras se achican
        const leaving = this._entries.filter(e => !keep.has(e.key));
        for (const e of leaving) {
            e.target = 0;
            if (e.actor === this._tooltipItem)
                this.hideTooltip();
        }
        let pos = 0;
        for (const e of this._entries) {
            if (keep.has(e.key))
                pos = ordered.indexOf(e) + 1;
            else
                ordered.splice(pos++, 0, e);
        }
        this._entries = ordered;

        for (const e of this._entries) {
            if (e.actor.group)
                e.actor.sync();
        }

        this._animate();
        this._updateIconGeometry();
        this._updateShown();
    }

    _createEntry(kind, data, key) {
        let actor, slot;
        if (kind === 'sep') {
            actor = key === 'sep:trash' ? this._sepTrash : new St.Widget({style_class: 'moonriver-dock-sep'});
            slot = SEP_SLOT;
        } else {
            actor = kind === 'trash' ? this._trash : new AppIcon(this, data);
            slot = SLOT;
            actor.group?.app.connectObject('windows-changed', () => this._queueSync(), actor);
            this.add_child(actor.dot);
        }
        this.add_child(actor);
        actor.opacity = 0;
        return new Entry(key, actor, slot);
    }

    _destroyEntry(entry) {
        if (entry.actor === this._trash || entry.actor === this._sepTrash) {
            entry.actor.hide();
            return;
        }
        entry.actor.destroy();
    }

    // ───── Animación ─────

    _setZoom(target) {
        this._zoomTarget = target;
        this._animate();
    }

    _animate() {
        if (!this._timeline.is_playing()) {
            this._lastFrame = GLib.get_monotonic_time();
            this._timeline.start();
        }
    }

    // Lleva todo a su estado final sin animar (al iniciar)
    _snap() {
        this._zoom = this._zoomTarget;
        for (const e of this._entries)
            e.presence = e.target;
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._lastFrame) / 1000, 64);
        this._lastFrame = now;
        const animate = St.Settings.get().enable_animations;

        const zoomTau = this._zoomTarget > this._zoom ? TAU_ZOOM_IN : TAU_ZOOM_OUT;
        this._zoom = approach(this._zoom, this._zoomTarget, dt, animate ? zoomTau : 0);
        let settled = this._zoom === this._zoomTarget;
        for (const e of this._entries) {
            e.presence = approach(e.presence, e.target, dt, animate ? TAU_PRESENCE : 0);
            settled &&= e.presence === e.target;
        }

        const gone = this._entries.filter(e => e.target === 0 && e.presence === 0);
        if (gone.length) {
            this._entries = this._entries.filter(e => !gone.includes(e));
            gone.forEach(e => this._destroyEntry(e));
        }

        this._relayout();
        if (settled) {
            this._timeline.stop();
            this._updateIconGeometry();
        }
    }

    // ───── Disposición ─────

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const sf = this.scaleFactor;
        const icon = ICON * sf;
        const bgHeight = (ICON + PAD_TOP + PAD_BOTTOM) * sf;
        const headroom = Math.ceil(icon * (MAG - 1) + 60 * sf);
        const height = bgHeight + MARGIN * sf + headroom;

        this.set_position(monitor.x, monitor.y + monitor.height - height);
        this.set_size(monitor.width, height);

        // Geometría en reposo (coordenadas locales del dock)
        const widths = this._entries.map(e => e.slot * sf * e.presence);
        const total = widths.reduce((a, b) => a + b, 0) + 2 * PAD_X * sf;
        const left = (monitor.width - total) / 2;
        const bgY = headroom;
        const iconBottom = bgY + (PAD_TOP + ICON) * sf;

        // Magnificación: cada punto se corre según cuánto "creció" el espacio
        // entre él y el cursor. El ícono bajo el cursor queda fijo bajo el cursor.
        const x = this._pointerX - monitor.x;
        const range = RANGE * SLOT * sf;
        const amount = (MAG - 1) * this._zoom;
        const shift = u => Math.sign(u - x) * amount * falloffIntegral(Math.abs(u - x), range);

        const bgLeft = left + shift(left);
        const bgRight = left + total + shift(left + total);
        this._bg.set_position(Math.round(bgLeft), bgY);
        this._bg.set_size(Math.round(bgRight - bgLeft), bgHeight);

        let cursor = left + PAD_X * sf;
        this._entries.forEach((e, i) => {
            const base = cursor + widths[i] / 2;
            cursor += widths[i];
            const center = base + shift(base);
            const zoom = 1 + amount * falloff(Math.abs(base - x), range);
            const actor = e.actor;
            actor.opacity = Math.round(255 * Math.min(1, e.presence * 1.4));

            if (e.slot === SEP_SLOT) {
                const h = Math.round(icon * 0.62);
                actor.set_size(Math.max(1, Math.round(sf)), h);
                actor.set_position(Math.round(center), Math.round(iconBottom - icon / 2 - h / 2));
                return;
            }

            const w = SLOT * MAG * sf;
            const h = ICON * MAG * sf;
            actor.set_size(w, h);
            actor.set_position(Math.round(center - w / 2), Math.round(iconBottom - h));
            const scale = zoom * e.presence / MAG;
            actor.set_scale(scale, scale);
            actor._center = center;
            actor._top = iconBottom - icon * zoom * e.presence;

            const dotSize = DOT * sf;
            actor.dot.set_size(dotSize, dotSize);
            actor.dot.set_position(Math.round(center - dotSize / 2), Math.round(bgY + bgHeight - 4 * sf - dotSize));
            actor.dot.visible = e.presence > 0.5;
        });

        this._placeTooltip();
    }

    // Destino de la animación de minimizar de cada ventana: su ícono en el dock (en reposo)
    _updateIconGeometry() {
        if (this._zoom !== 0)
            return;
        for (const e of this._entries) {
            if (!e.actor.group || e.target === 0)
                continue;
            const [x, y] = e.actor.get_transformed_position();
            const [w, h] = e.actor.get_transformed_size();
            // Medido en su lugar final aunque el dock esté escondido abajo
            const rect = new Mtk.Rectangle({x: Math.round(x), y: Math.round(y - this.translation_y), width: Math.round(w), height: Math.round(h)});
            for (const win of e.actor.windows)
                win.set_icon_geometry(rect);
        }
    }

    // ───── Cursor ─────

    onMotion(event) {
        [this._pointerX] = event.get_coords();
        if (this.menuManager.activeMenu)
            return Clutter.EVENT_PROPAGATE;
        if (this._zoomTarget !== 1)
            this._setZoom(1);
        else if (!this._timeline.is_playing())
            this._relayout();
        return Clutter.EVENT_PROPAGATE;
    }

    // Al salir de un ícono o del fondo: si el cursor ya no está sobre nada del
    // dock (y no pasó a un vecino), se achica.
    queuePointerCheck() {
        if (this._pointerCheckId)
            return;
        this._pointerCheckId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pointerCheckId = 0;
            const [x, y] = global.get_pointer();
            const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            if (!actor || !this.contains(actor)) {
                this._setZoom(0);
                this.hideTooltip();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    onItemHover(item) {
        if (item.hover && !this.menuManager.activeMenu)
            this._showTooltip(item);
        else if (this._tooltipItem === item)
            this.hideTooltip();
    }

    _showTooltip(item) {
        this._tooltipItem = item;
        this._tooltip.text = item.name;
        this._tooltip.remove_all_transitions();
        this._tooltip.show();
        this._placeTooltip();
        this._tooltip.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    hideTooltip() {
        if (!this._tooltipItem)
            return;
        this._tooltipItem = null;
        this._tooltip.ease({
            opacity: 0, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._tooltip.hide(),
        });
    }

    _placeTooltip() {
        const item = this._tooltipItem;
        if (!item || item._center === undefined)
            return;
        const [tw, th] = this._tooltip.get_preferred_size().slice(2);
        const x = this.x + item._center - tw / 2;
        const y = this.y + item._top - th - 12 * this.scaleFactor;
        this._tooltip.set_position(Math.round(x), Math.round(y));
    }

    destroy() {
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        if (this._pointerCheckId) {
            GLib.source_remove(this._pointerCheckId);
            this._pointerCheckId = 0;
        }
        this._timeline.stop();
        Shell.AppSystem.get_default().disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        for (const w of this._watchedWindows)
            w.disconnectObject(this);
        this._watchedWindows.clear();
        for (const e of this._entries) {
            for (const w of e.actor.windows ?? [])
                w.set_icon_geometry(null);
            e.actor.destroy();
        }
        this._entries = [];
        this._tooltip.destroy();
        super.destroy();
    }
});
