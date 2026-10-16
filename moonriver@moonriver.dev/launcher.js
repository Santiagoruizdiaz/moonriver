// Menú de aplicaciones: buscador, categorías a la izquierda y lista de apps.
// Versión compacta y minimalista.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import {addAppToDesktop} from './desktop.js';

const ICON_SIZE = 20;

// [id, etiqueta, ícono, categorías freedesktop que entran]
const CATEGORIES = [
    ['all', 'Todas', 'view-app-grid-symbolic', null],
    ['favorites', 'Favoritas', 'starred-symbolic', null],
    ['dev', 'Desarrollo', 'applications-engineering-symbolic', ['Development', 'IDE', 'TextEditor']],
    ['internet', 'Internet', 'network-workgroup-symbolic', ['Network', 'WebBrowser', 'Email', 'Chat']],
    ['games', 'Juegos', 'input-gaming-symbolic', ['Game']],
    ['media', 'Multimedia', 'applications-multimedia-symbolic', ['AudioVideo', 'Audio', 'Video']],
    ['graphics', 'Gráficos', 'applications-graphics-symbolic', ['Graphics']],
    ['office', 'Oficina', 'x-office-document-symbolic', ['Office']],
    ['system', 'Sistema', 'applications-system-symbolic', ['System', 'Settings', 'PackageManager']],
    ['utils', 'Utilidades', 'applications-utilities-symbolic', ['Utility', 'Accessories']],
    ['other', 'Otras', 'view-more-symbolic', null],
];

function categoryOf(appInfo) {
    const cats = (appInfo.get_categories?.() ?? '').split(';').filter(Boolean);
    for (const [id, , , matches] of CATEGORIES) {
        if (matches && cats.some(c => matches.includes(c)))
            return id;
    }
    return 'other';
}

function searchTextOf(app) {
    const info = app.get_app_info();
    return [
        app.get_name(), info.get_generic_name?.(), info.get_executable?.(),
        ...(info.get_keywords?.() ?? []), app.get_id(),
    ].filter(Boolean).join(' ').toLowerCase();
}

const AppRow = GObject.registerClass(
class AppRow extends St.Button {
    _init(app, launcher) {
        super._init({
            style_class: 'mr-app',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            can_focus: true,
            x_expand: true,
        });
        this.app = app;
        this.category = categoryOf(app.get_app_info());
        this.searchText = searchTextOf(app);

        const box = new St.BoxLayout({style_class: 'mr-app-box', x_expand: true});
        box.add_child(app.create_icon_texture(ICON_SIZE));
        box.add_child(new St.Label({text: app.get_name(), y_align: Clutter.ActorAlign.CENTER, style_class: 'mr-app-name'}));
        this.set_child(box);

        this.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_SECONDARY) {
                addAppToDesktop(app);
                Main.notify('Moonriver', `«${app.get_name()}» agregada al escritorio`);
                return;
            }
            launcher.launch(app);
        });
        this.connect('key-press-event', (_a, event) => launcher.onRowKey(this, event));
    }
});

export const Launcher = GObject.registerClass(
class Launcher extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Aplicaciones');
        this.add_style_class_name('moonriver-launcher-button');

        const button = new St.BoxLayout({style_class: 'moonriver-launcher-button-box'});
        button.add_child(new St.Icon({icon_name: 'view-app-grid-symbolic', style_class: 'system-status-icon'}));
        button.add_child(new St.Label({text: 'Aplicaciones', y_align: Clutter.ActorAlign.CENTER}));
        this.add_child(button);

        this.menu.box.add_style_class_name('moonriver-menu');
        this.menu.box.add_style_class_name('mr-launcher');
        this.menu.box.add_child(this._buildUi());

        this._category = 'all';
        this._rows = [];
        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject('installed-changed', () => this._loadApps(), this);
        AppFavorites.getAppFavorites().connectObject('changed', () => this._applyFilter(), this);
        this._loadApps();

        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._entry.text = '';
            this._selectCategory('all');
            this._scroll.vadjustment.value = 0;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._entry.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _buildUi() {
        const root = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mr-launcher-root'});

        this._entry = new St.Entry({
            style_class: 'mr-launcher-search',
            hint_text: 'Buscar…',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'mr-launcher-search-icon'}),
        });
        this._entry.clutter_text.connect('text-changed', () => this._applyFilter());
        this._entry.clutter_text.connect('activate', () => {
            const first = this._visibleRows()[0];
            if (first)
                this.launch(first.app);
        });
        this._entry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Down) {
                this._visibleRows()[0]?.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        root.add_child(this._entry);

        const body = new St.BoxLayout({style_class: 'mr-launcher-body'});
        root.add_child(body);

        this._categoryBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mr-launcher-categories'});
        this._categoryButtons = new Map();
        for (const [id, label, icon] of CATEGORIES) {
            const btn = new St.Button({style_class: 'mr-category', can_focus: true, x_expand: true});
            const box = new St.BoxLayout({style_class: 'mr-category-box'});
            box.add_child(new St.Icon({icon_name: icon, icon_size: 14}));
            box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
            btn.set_child(box);
            btn.connect('clicked', () => this._selectCategory(id));
            this._categoryButtons.set(id, btn);
            this._categoryBox.add_child(btn);
        }
        body.add_child(this._categoryBox);

        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'mr-launcher-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'mr-launcher-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            child: this._list,
        });
        body.add_child(this._scroll);

        this._empty = new St.Label({text: 'Sin resultados', style_class: 'mr-launcher-empty', visible: false});
        this._list.add_child(this._empty);

        return root;
    }

    _loadApps() {
        for (const row of this._rows)
            row.destroy();

        const seen = new Set();
        const apps = this._appSystem.get_installed()
            .filter(info => info.should_show())
            .map(info => this._appSystem.lookup_app(info.get_id()))
            .filter(app => app && !seen.has(app.get_id()) && seen.add(app.get_id()))
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));

        this._rows = apps.map(app => new AppRow(app, this));
        for (const row of this._rows)
            this._list.add_child(row);

        const used = new Set(this._rows.map(r => r.category));
        for (const [id, btn] of this._categoryButtons)
            btn.visible = id === 'all' || id === 'favorites' || used.has(id);

        this._applyFilter();
    }

    _selectCategory(id) {
        this._category = id;
        for (const [cid, btn] of this._categoryButtons) {
            if (cid === id)
                btn.add_style_pseudo_class('checked');
            else
                btn.remove_style_pseudo_class('checked');
        }
        this._applyFilter();
    }

    _applyFilter() {
        const terms = this._entry.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const favorites = new Set(AppFavorites.getAppFavorites().getFavorites().map(a => a.get_id()));

        for (const row of this._rows) {
            if (terms.length)
                row.visible = terms.every(t => row.searchText.includes(t));
            else if (this._category === 'all')
                row.visible = true;
            else if (this._category === 'favorites')
                row.visible = favorites.has(row.app.get_id());
            else
                row.visible = row.category === this._category;
        }
        this._categoryBox.opacity = terms.length ? 90 : 255;
        this._empty.visible = this._visibleRows().length === 0;
    }

    _visibleRows() {
        return this._rows.filter(r => r.visible);
    }

    onRowKey(row, event) {
        const key = event.get_key_symbol();
        const rows = this._visibleRows();
        const i = rows.indexOf(row);
        if (key === Clutter.KEY_Down && i < rows.length - 1) {
            rows[i + 1].grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Up) {
            (i > 0 ? rows[i - 1] : this._entry).grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            this.launch(row.app);
            return Clutter.EVENT_STOP;
        }
        // Cualquier letra vuelve al buscador
        const unicode = event.get_key_unicode();
        if (unicode && /\S/.test(unicode)) {
            this._entry.grab_key_focus();
            this._entry.clutter_text.insert_text(unicode, -1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    launch(app) {
        this.menu.close();
        app.activate();
    }

    get isOpen() {
        return this.menu.isOpen;
    }

    open() {
        this.menu.open();
    }

    toggle() {
        this.menu.toggle();
    }

    destroy() {
        this._appSystem.disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        super.destroy();
    }
});
