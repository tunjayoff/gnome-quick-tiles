import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BUILTIN_PREFIX, BUILTIN_TILES} from './builtinCatalog.js';

const FALLBACK_ICON = 'application-x-executable-symbolic';

function iconImage(icon) {
    try {
        // Gio.Icon.new_for_string() also accepts file paths
        return Gtk.Image.new_from_gicon(Gio.Icon.new_for_string(icon || FALLBACK_ICON));
    } catch {
        return Gtk.Image.new_from_icon_name(FALLBACK_ICON);
    }
}

/** Builds an ID from the title that does not clash with existing ones. */
function uniqueId(title, tiles) {
    const base = title.toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ı/g, 'i')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'tile';
    let id = base;
    for (let n = 2; tiles.some(t => t.id === id); n++)
        id = `${base}-${n}`;
    return id;
}

class TilesPage {
    constructor(window, settings, extensionPath) {
        this._window = window;
        this._settings = settings;

        this.page = new Adw.PreferencesPage({title: 'Tiles', icon_name: 'view-app-grid-symbolic'});
        this.page.add(this._builtinGroup(extensionPath));

        const group = new Adw.PreferencesGroup({
            title: 'Custom Tiles',
            description: 'Tiles that run shell commands.',
        });
        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add Tile',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        add.connect('clicked', () => this._openDialog(null));
        group.set_header_suffix(add);

        this._list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        group.add(this._list);
        this.page.add(group);

        this.page.add(new Adw.PreferencesGroup({
            title: 'How It Works',
            description: 'Button: runs its command when clicked.\n' +
                'Toggle: runs the on command when off and the off command when on. If a status command ' +
                'is set, the tile shows as on when it exits with 0, and the first line of its output ' +
                'becomes the subtitle.\n' +
                'Commands run with sh -c. New tiles are added near the end of the menu; use the pencil ' +
                'button in Quick Settings to move them.',
        }));

        settings.connect('changed::custom-tiles', () => this._rebuild());
        this._rebuild();
    }

    _builtinGroup(extensionPath) {
        const group = new Adw.PreferencesGroup({
            title: 'Built-in Tiles',
            description: 'They start out in the Hidden Tiles tray of edit mode. Switch them on here or drag them out of the tray.',
        });
        const rows = BUILTIN_TILES.map(info => {
            const row = new Adw.SwitchRow({title: info.title, subtitle: info.description});
            row.add_prefix(iconImage(info.icon.endsWith('.svg')
                ? GLib.build_filenamev([extensionPath, info.icon]) : info.icon));
            const id = BUILTIN_PREFIX + info.id;
            row.connect('notify::active', () => {
                const shown = new Set(this._settings.get_strv('shown-builtins'));
                if (row.active === shown.has(id))
                    return;
                if (row.active)
                    shown.add(id);
                else
                    shown.delete(id);
                this._settings.set_strv('shown-builtins', [...shown]);
            });
            group.add(row);
            return [id, row];
        });
        const sync = () => {
            const shown = new Set(this._settings.get_strv('shown-builtins'));
            for (const [id, row] of rows)
                row.active = shown.has(id);
        };
        this._settings.connect('changed::shown-builtins', sync);
        sync();
        return group;
    }

    _tiles() {
        try {
            const tiles = JSON.parse(this._settings.get_string('custom-tiles'));
            return Array.isArray(tiles) ? tiles : [];
        } catch {
            return [];
        }
    }

    _save(tiles) {
        this._settings.set_string('custom-tiles', JSON.stringify(tiles));
    }

    _rebuild() {
        this._list.remove_all();
        const tiles = this._tiles();
        if (!tiles.length) {
            this._list.append(new Adw.ActionRow({
                title: 'No custom tiles yet',
                subtitle: 'Press + to add one.',
                activatable: false,
            }));
        }
        tiles.forEach((tile, index) => {
            const summary = tile.kind === 'toggle' ? `Toggle · ${tile.on ?? ''}` : `Button · ${tile.command ?? ''}`;
            const row = new Adw.ActionRow({
                title: tile.title || tile.id,
                subtitle: summary,
                subtitle_lines: 1,
                use_markup: false,
                activatable: true,
            });
            row.add_prefix(iconImage(tile.icon));
            const edit = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                tooltip_text: 'Edit',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Delete',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            row.add_suffix(edit);
            row.add_suffix(remove);
            row.connect('activated', () => this._openDialog(index));
            edit.connect('clicked', () => this._openDialog(index));
            remove.connect('clicked', () => this._delete(index));
            this._list.append(row);
        });
    }

    _delete(index) {
        const tiles = this._tiles();
        const [removed] = tiles.splice(index, 1);
        this._save(tiles);

        const toast = new Adw.Toast({title: `“${removed.title}” deleted`, button_label: 'Undo'});
        toast.connect('button-clicked', () => {
            const current = this._tiles();
            current.splice(Math.min(index, current.length), 0, removed);
            this._save(current);
        });
        this._window.add_toast(toast);
    }

    _openDialog(index) {
        const tiles = this._tiles();
        const tile = index === null ? {} : tiles[index];

        const dialog = new Adw.Dialog({title: index === null ? 'New Tile' : 'Edit Tile', content_width: 520});
        const save = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
        const header = new Adw.HeaderBar();
        header.pack_end(save);

        const entry = (title, text, monospace) => {
            const row = new Adw.EntryRow({title, text: text ?? ''});
            if (monospace)
                row.add_css_class('monospace');
            return row;
        };
        const title = entry('Title', tile.title);
        const subtitle = entry('Subtitle (optional)', tile.subtitle);
        const icon = entry('Icon name or file path', tile.icon);
        let preview = iconImage(tile.icon);
        icon.add_suffix(preview);
        icon.connect('changed', () => {
            const next = iconImage(icon.text);
            icon.remove(preview);
            icon.add_suffix(next);
            preview = next;
        });
        const basics = new Adw.PreferencesGroup();
        [title, subtitle, icon].forEach(row => basics.add(row));

        const kind = new Adw.ComboRow({
            title: 'Kind',
            model: Gtk.StringList.new(['Button', 'Toggle']),
            selected: tile.kind === 'toggle' ? 1 : 0,
        });
        const command = entry('Command', tile.command, true);
        const on = entry('On command', tile.on, true);
        const off = entry('Off command', tile.off, true);
        const status = entry('Status command (exit code 0 = on)', tile.status, true);
        const interval = Adw.SpinRow.new_with_range(0, 3600, 1);
        interval.title = 'Status Refresh Interval';
        interval.subtitle = 'Seconds; 0 = only after a click';
        interval.value = Number(tile.interval) || 0;
        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
        [kind, command, on, off, status, interval].forEach(row => behavior.add(row));

        const syncKind = () => {
            const toggle = kind.selected === 1;
            command.visible = !toggle;
            [on, off, status, interval].forEach(row => (row.visible = toggle));
        };
        syncKind();
        kind.connect('notify::selected', syncKind);

        const syncSave = () => (save.sensitive = title.text.trim() !== '');
        syncSave();
        title.connect('changed', syncSave);

        save.connect('clicked', () => {
            const current = this._tiles();
            const text = row => row.text.trim();
            const edited = {
                id: tile.id ?? uniqueId(text(title), current),
                title: text(title),
                subtitle: text(subtitle),
                icon: text(icon),
                kind: kind.selected === 1 ? 'toggle' : 'button',
            };
            if (edited.kind === 'toggle')
                Object.assign(edited, {on: text(on), off: text(off), status: text(status), interval: interval.value});
            else
                edited.command = text(command);

            const at = current.findIndex(t => t.id === edited.id);
            if (at >= 0)
                current[at] = edited;
            else
                current.push(edited);
            this._save(current);
            dialog.close();
        });

        const page = new Adw.PreferencesPage();
        page.add(basics);
        page.add(behavior);
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(header);
        dialog.child = view;
        dialog.present(this._window);
    }
}

export default class QuickTilesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);

        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'view-grid-symbolic'});
        const editing = new Adw.PreferencesGroup({
            title: 'Editing',
            description: 'To reorder, hide or resize tiles, open Quick Settings and press the pencil button.',
        });
        const editButton = new Adw.SwitchRow({
            title: 'Edit Button',
            subtitle: 'Show the pencil button in the Quick Settings system row',
        });
        settings.bind('show-edit-button', editButton, 'active', Gio.SettingsBindFlags.DEFAULT);
        editing.add(editButton);

        const resetRow = new Adw.ActionRow({
            title: 'Reset Layout',
            subtitle: 'Restore the original order, widths and columns, and put built-in tiles back in the tray',
        });
        const reset = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        reset.connect('clicked', () => {
            for (const key of ['order', 'hidden', 'shown-builtins', 'spans', 'columns'])
                settings.reset(key);
            window.add_toast(new Adw.Toast({title: 'Layout reset'}));
        });
        resetRow.add_suffix(reset);
        editing.add(resetRow);
        general.add(editing);

        const grid = new Adw.PreferencesGroup({title: 'Grid'});
        const columns = Adw.SpinRow.new_with_range(1, 6, 1);
        columns.title = 'Columns';
        settings.bind('columns', columns, 'value', Gio.SettingsBindFlags.DEFAULT);
        const width = Adw.SpinRow.new_with_range(0, 2000, 10);
        width.title = 'Menu Width';
        width.subtitle = 'Pixels; 0 = automatic. Keeps the menu from getting too wide with more columns.';
        settings.bind('menu-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        grid.add(columns);
        grid.add(width);
        general.add(grid);

        window.add(general);
        window.add(new TilesPage(window, settings, this.path).page);

        // Keep the settings object alive for the window's lifetime
        window._settings = settings;
    }
}
