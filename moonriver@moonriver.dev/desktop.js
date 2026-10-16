// Íconos en el escritorio, estilo Windows/KDE: muestra el contenido de ~/Escritorio
// en una grilla sobre el fondo de pantalla, debajo de las ventanas.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

const CELL_WIDTH = 104;
const CELL_HEIGHT = 112;
const MARGIN = 16;
const ICON_SIZE = 52;
const DOUBLE_CLICK_MS = 400;
const FILE_ATTRIBUTES = 'standard::*,thumbnail::path,metadata::*';
const MOVE_ANIMATION_MS = 180;
const LAYOUT_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'moonriver', 'desktop-layout.json']);

export function desktopDir() {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Escritorio']);
}

function launchContext() {
    return global.create_app_launch_context(0, -1);
}

// Copia el .desktop de una app al Escritorio (usado desde el menú contextual de las apps).
export function addAppToDesktop(app) {
    const source = app?.get_app_info()?.get_filename();
    if (!source)
        return;
    const dir = desktopDir();
    GLib.mkdir_with_parents(dir, 0o755);
    const dest = Gio.File.new_for_path(GLib.build_filenamev([dir, GLib.path_get_basename(source)]));
    try {
        Gio.File.new_for_path(source).copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
        dest.set_attribute_string('metadata::trusted', 'true', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        Main.notifyError('Moonriver', `No se pudo agregar al escritorio: ${e.message}`);
    }
}

class DesktopItem {
    constructor(desktop, file, info) {
        this._desktop = desktop;
        this.file = file;
        this.info = info;
        this._lastClick = 0;

        this.appInfo = null;
        if (info.get_name().endsWith('.desktop')) {
            try {
                this.appInfo = GioUnix.DesktopAppInfo.new_from_filename(file.get_path());
            } catch {}
        }

        this.actor = new St.Button({
            style_class: 'moonriver-desktop-item',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            can_focus: true,
            reactive: true,
            width: CELL_WIDTH - 8,
            height: CELL_HEIGHT - 8,
            clip_to_allocation: true,
        });

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(new St.Icon({
            gicon: this._icon(),
            icon_size: ICON_SIZE,
            style_class: 'moonriver-desktop-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const label = new St.Label({
            text: this.displayName,
            style_class: 'moonriver-desktop-label',
            x_align: Clutter.ActorAlign.CENTER,
            width: CELL_WIDTH - 16,
        });
        label.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
            line_alignment: Pango.Alignment.CENTER,
        });
        box.add_child(label);
        this.actor.set_child(box);

        // Arrastrar para mover: GNOME arrastra un clon, el original queda tenue en su lugar.
        this.actor._delegate = this;
        this._draggable = DND.makeDraggable(this.actor, {dragActorOpacity: 230});
        this._draggable.connect('drag-begin', () => {
            this.actor.opacity = 70;
            this._desktop.onDragBegin(this);
        });
        this._draggable.connect('drag-end', () => {
            this.actor.opacity = 255;
            this._desktop.onDragEnd(this);
        });

        this.actor.connect('clicked', (_b, button) => this._onClicked(button));
        this.actor.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                this.open();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    get key() {
        return this.info.get_name();
    }

    getDragActor() {
        const [w, h] = this.actor.get_size();
        return new Clutter.Clone({source: this.actor, width: w, height: h});
    }

    getDragActorSource() {
        return this.actor;
    }

    get displayName() {
        return this.appInfo?.get_display_name() ?? this.info.get_display_name();
    }

    get isDirectory() {
        return this.info.get_file_type() === Gio.FileType.DIRECTORY;
    }

    _icon() {
        if (this.appInfo?.get_icon())
            return this.appInfo.get_icon();
        const thumb = this.info.get_attribute_byte_string('thumbnail::path');
        if (thumb)
            return Gio.FileIcon.new(Gio.File.new_for_path(thumb));
        return this.info.get_icon() ?? Gio.ThemedIcon.new('text-x-generic');
    }

    _onClicked(button) {
        this._desktop.select(this);
        if (button === Clutter.BUTTON_SECONDARY) {
            this._desktop.openItemMenu(this);
            return;
        }
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastClick < DOUBLE_CLICK_MS) {
            this._lastClick = 0;
            this.open();
        } else {
            this._lastClick = now;
        }
    }

    setSelected(selected) {
        if (selected)
            this.actor.add_style_pseudo_class('selected');
        else
            this.actor.remove_style_pseudo_class('selected');
    }

    open() {
        try {
            if (this.appInfo)
                this.appInfo.launch([], launchContext());
            else
                Gio.AppInfo.launch_default_for_uri(this.file.get_uri(), launchContext());
        } catch (e) {
            Main.notifyError('Moonriver', `No se pudo abrir «${this.displayName}»: ${e.message}`);
        }
    }

    showInFiles() {
        Gio.DBus.session.call(
            'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems',
            new GLib.Variant('(ass)', [[this.file.get_uri()], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    trash() {
        this.file.trash_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
            try {
                f.trash_finish(res);
            } catch (e) {
                Main.notifyError('Moonriver', `No se pudo mover a la papelera: ${e.message}`);
            }
        });
    }
}

export class Desktop {
    constructor() {
        this._items = [];
        this._selected = null;
        this._rebuildId = 0;
        this._cancellable = new Gio.Cancellable();

        this._dir = Gio.File.new_for_path(desktopDir());
        GLib.mkdir_with_parents(this._dir.get_path(), 0o755);

        this._layer = new St.Widget({
            name: 'moonriverDesktop',
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
        });
        Main.layoutManager._backgroundGroup.add_child(this._layer);
        // La capa ocupa toda el área de trabajo: no es reactiva (los clics llegan al fondo),
        // pero sí aparece al soltar un arrastre, así recibe acceptDrop/handleDragOver.
        this._layer._delegate = this;

        this._dropHint = new St.Widget({
            style_class: 'moonriver-desktop-drop',
            width: CELL_WIDTH - 8,
            height: CELL_HEIGHT - 8,
            visible: false,
        });
        this._layer.add_child(this._dropHint);

        this._cells = new Map();      // item.key -> [col, row]
        this._positions = this._loadPositions();

        this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        this._menu.box.add_style_class_name('moonriver-menu');
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuManager = new PopupMenu.PopupMenuManager(this._layer);
        this._menuManager.addMenu(this._menu);

        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', () => this._queueRebuild());

        Main.layoutManager.connectObject(
            'monitors-changed', () => this._layout(),
            'startup-complete', () => this._layout(),
            this);
        global.display.connectObject('workareas-changed', () => this._layout(), this);

        this._rebuild();
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        this._dir.enumerate_children_async(FILE_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (dir, res) => {
                let infos = [];
                try {
                    const enumerator = dir.enumerate_children_finish(res);
                    let info;
                    while ((info = enumerator.next_file(null)))
                        infos.push(info);
                } catch {
                    return;
                }
                infos = infos.filter(i => !i.get_is_hidden() && !i.get_name().startsWith('.'));
                this._setItems(infos.map(i => new DesktopItem(this, dir.get_child(i.get_name()), i)));
            });
    }

    _setItems(items) {
        for (const item of this._items)
            item.actor.destroy();
        this._selected = null;

        // Las que no tienen lugar guardado entran en este orden: apps, carpetas, archivos.
        const rank = it => (it.appInfo ? 0 : it.isDirectory ? 1 : 2);
        this._items = items.sort((a, b) =>
            rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));

        for (const item of this._items)
            this._layer.add_child(item.actor);
        this._layout();
    }

    _grid() {
        const monitor = Main.layoutManager.primaryIndex;
        if (monitor < 0)
            return null;
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const area = {x: work.x, y: work.y, width: work.width, height: work.height - (this._bottomInset ?? 0)};
        return {
            area,
            cols: Math.max(1, Math.floor((area.width - 2 * MARGIN) / CELL_WIDTH)),
            rows: Math.max(1, Math.floor((area.height - 2 * MARGIN) / CELL_HEIGHT)),
        };
    }

    // Espacio que ocupa el dock abajo: los íconos no se ubican ahí
    setBottomInset(px) {
        this._bottomInset = px;
        this._layout();
    }

    _cellPosition([col, row]) {
        return [MARGIN + col * CELL_WIDTH + 4, MARGIN + row * CELL_HEIGHT + 4];
    }

    _cellAt(x, y) {
        const {cols, rows} = this._grid();
        const col = Math.floor((x - MARGIN) / CELL_WIDTH);
        const row = Math.floor((y - MARGIN) / CELL_HEIGHT);
        return [Math.min(Math.max(col, 0), cols - 1), Math.min(Math.max(row, 0), rows - 1)];
    }

    _placeItem(item, cell, animate) {
        this._cells.set(item.key, cell);
        const [x, y] = this._cellPosition(cell);
        if (animate) {
            item.actor.ease({x, y, duration: MOVE_ANIMATION_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            item.actor.remove_all_transitions();
            item.actor.set_position(x, y);
        }
    }

    // Respeta las posiciones guardadas; lo nuevo va al primer hueco libre,
    // en columnas de arriba hacia abajo empezando por la izquierda (como Windows).
    _layout() {
        const grid = this._grid();
        if (!grid)
            return;
        const {area, cols, rows} = grid;
        this._layer.set_position(area.x, area.y);
        this._layer.set_size(area.width, area.height);

        this._cells.clear();
        const taken = new Set();
        const pending = [];
        for (const item of this._items) {
            const saved = this._positions[item.key];
            const id = saved && `${saved[0]},${saved[1]}`;
            if (saved && saved[0] < cols && saved[1] < rows && !taken.has(id)) {
                taken.add(id);
                this._placeItem(item, saved, false);
            } else {
                pending.push(item);
            }
        }

        let next = 0;
        for (const item of pending) {
            while (taken.has(`${Math.floor(next / rows)},${next % rows}`))
                next++;
            const cell = [Math.floor(next / rows), next % rows];
            taken.add(`${cell[0]},${cell[1]}`);
            this._placeItem(item, cell, false);
        }
        if (pending.length)
            this._savePositions();
    }

    _itemAtCell([col, row]) {
        return this._items.find(it => {
            const c = this._cells.get(it.key);
            return c && c[0] === col && c[1] === row;
        });
    }

    onDragBegin(item) {
        const cell = this._cells.get(item.key);
        if (cell)
            this._dropHint.set_position(...this._cellPosition(cell));
        this._layer.set_child_below_sibling(this._dropHint, null);
        this._dropHint.show();
    }

    onDragEnd() {
        this._dropHint.hide();
    }

    // DND: el puntero pasa sobre el escritorio
    handleDragOver(source, _actor, x, y) {
        if (!(source instanceof DesktopItem))
            return DND.DragMotionResult.CONTINUE;
        const [hx, hy] = this._cellPosition(this._cellAt(x, y));
        if (this._dropHint.x !== hx || this._dropHint.y !== hy)
            this._dropHint.ease({x: hx, y: hy, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return DND.DragMotionResult.MOVE_DROP;
    }

    // DND: se soltó sobre el escritorio. Si la celda está ocupada, se intercambian.
    acceptDrop(source, _actor, x, y) {
        if (!(source instanceof DesktopItem) || !this._items.includes(source))
            return false;
        const target = this._cellAt(x, y);
        const from = this._cells.get(source.key);
        const other = this._itemAtCell(target);
        if (other && other !== source && from)
            this._placeItem(other, from, true);
        this._placeItem(source, target, true);
        this.select(source);
        this._savePositions();
        return true;
    }

    _loadPositions() {
        try {
            const [, bytes] = GLib.file_get_contents(LAYOUT_FILE);
            return JSON.parse(new TextDecoder().decode(bytes)) ?? {};
        } catch {
            return {};
        }
    }

    _savePositions() {
        // Se conservan las posiciones de archivos que no están ahora (por si vuelven).
        for (const [key, cell] of this._cells)
            this._positions[key] = cell;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(LAYOUT_FILE), 0o755);
            GLib.file_set_contents(LAYOUT_FILE, JSON.stringify(this._positions, null, 1));
        } catch (e) {
            console.warn(`Moonriver: no se pudo guardar el orden del escritorio: ${e.message}`);
        }
    }

    select(item) {
        this._selected?.setSelected(false);
        this._selected = item;
        item?.setSelected(true);
    }

    openItemMenu(item) {
        this._menu.removeAll();
        this._menu.addAction('Abrir', () => item.open());
        if (!item.appInfo)
            this._menu.addAction('Mostrar en Archivos', () => item.showInFiles());
        if (item.isDirectory) {
            this._menu.addAction('Abrir Claude Code aquí', () =>
                this.onOpenClaudeCode?.(item.file.get_path()));
        }
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(item.appInfo ? 'Quitar del escritorio' : 'Mover a la papelera', () => item.trash());

        const [x, y] = item.actor.get_transformed_position();
        const [w, h] = item.actor.get_transformed_size();
        Main.layoutManager.setDummyCursorGeometry(x + w / 2, y + h / 2, 0, 0);
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._monitor.cancel();
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._menu.destroy();
        this._layer.destroy();
        this._items = [];
    }
}
