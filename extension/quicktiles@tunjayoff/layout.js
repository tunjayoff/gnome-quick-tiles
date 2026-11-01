import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSettingsMenu} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {BUILTIN_PREFIX} from './builtinCatalog.js';

const LAYOUT_KEYS = ['order', 'hidden', 'shown-builtins', 'spans', 'columns', 'menu-width', 'show-edit-button'];
const LAYOUT_RESET_KEYS = ['order', 'hidden', 'shown-builtins', 'spans', 'columns'];

// Readable names for Shell items that have no title (or get it late)
const KNOWN_LABELS = {
    SystemItem: 'System buttons',
    OutputStreamSlider: 'Volume',
    InputStreamSlider: 'Microphone',
    BrightnessItem: 'Screen brightness',
    NMWiredToggle: 'Wired network',
    NMWirelessToggle: 'Wi-Fi',
    NMModemToggle: 'Mobile broadband',
    NMBluetoothToggle: 'Bluetooth tethering',
    NMVpnToggle: 'VPN',
    BackgroundAppsToggle: 'Background apps',
};

function typeName(item) {
    // Shell derives GType names from the JS file path, e.g. Gjs_ui_status_volume_OutputStreamSlider
    return GObject.type_name(item.constructor.$gtype).replace(/^Gjs_/, '');
}

export function itemLabel(item) {
    const name = item.constructor.name;
    // The background apps title depends on its content ("2 Background Apps")
    if (name === 'BackgroundAppsToggle')
        return KNOWN_LABELS[name];
    return item.title || KNOWN_LABELS[name] || item.accessible_name || name;
}

export function itemIcon(item) {
    if (item.constructor.name === 'SystemItem')
        return 'system-shutdown-symbolic';
    const gicon = item.gicon ?? item.child?.gicon ?? null;
    return gicon?.to_string() ?? item.iconName ?? item.icon_name ?? '';
}

/**
 * Applies order, visibility and width of the grid items from the settings.
 * Keeps track of the order Shell itself would use, so disabling restores everything.
 */
export class LayoutController {
    constructor(settings) {
        this._settings = settings;
        this._states = new Map();
        // The order Shell would use. The placeholder stays in it: Shell inserts its
        // own items before it and external ones after it.
        this._natural = [];
        this._applyId = 0;
        this._moving = false;
        this._intendedNext = undefined;

        /** Called after every apply, e.g. so edit mode can rebuild its chrome. */
        this.onApplied = null;
        /** Creates the edit button placed in the system row. */
        this.createEditButton = null;
    }

    get menu() {
        return this._menu;
    }

    get grid() {
        return this._grid;
    }

    enable() {
        this._menu = Main.panel.statusArea.quickSettings.menu;
        this._grid = this._menu._grid;
        this._layout = this._grid.layout_manager;
        this._placeholder = this._layout._overlay;
        this._origColumns = this._layout.nColumns;
        this._parking = new St.Widget({visible: false});

        // Don't let Shell trip over inserting before a hidden (removed from the grid) item
        const controller = this;
        this._menu.insertItemBefore = function (item, sibling, colSpan) {
            controller._intendedNext = sibling;
            if (sibling && sibling.get_parent() !== controller._grid)
                sibling = null;
            try {
                QuickSettingsMenu.prototype.insertItemBefore.call(this, item, sibling, colSpan);
            } finally {
                controller._intendedNext = undefined;
            }
        };

        for (const child of this._grid) {
            if (child === this._placeholder)
                this._natural.push(child);
            else
                this._track(child, null);
        }

        this._grid.connectObject(
            'destroy', () => this._onGridDestroyed(),
            'child-added', (_grid, child) => this._onChildAdded(child),
            'child-removed', (_grid, child) => this._onChildRemoved(child),
            this);
        this._settings.connectObject(
            ...LAYOUT_KEYS.flatMap(key => [`changed::${key}`, () => this._queueApply()]),
            this);

        this._apply();
    }

    disable() {
        this._cancelApply();
        if (!this._grid)
            return;
        this._settings.disconnectObject(this);
        this._grid.disconnectObject(this);
        delete this._menu.insertItemBefore;

        this._editButton?.destroy();
        this._editButton = null;

        for (const item of this._items()) {
            const state = this._states.get(item);
            if (state.parked)
                this._unpark(item, state);
        }
        this._natural.forEach((actor, i) => this._grid.set_child_at_index(actor, i));

        this._layout.nColumns = this._origColumns;
        for (const item of this._items()) {
            const state = this._states.get(item);
            if (state.origSpan !== null)
                this._setSpan(item, state.origSpan);
            item.disconnectObject(this);
        }
        this._grid.width = -1;
        this._layout.layout_changed();

        this._parking.destroy();
        this._states.clear();
        this._natural = [];
        this._grid = null;
    }

    // --- API used by edit mode ---

    get columns() {
        return this._layout.nColumns;
    }

    idOf(item) {
        return this._states.get(item)?.id ?? null;
    }

    spanOf(item) {
        return this._getSpan(item);
    }

    /** Items currently in the grid, in grid order (including ones Shell keeps invisible). */
    gridItems() {
        return [...this._grid].filter(actor => actor !== this._placeholder && this._states.has(actor));
    }

    /** Items the user hid, in natural order. */
    hiddenItems() {
        return this._items().filter(item => this._states.get(item).parked);
    }

    /** Reorders the grid directly, e.g. while dragging; call commitOrder() to save. */
    previewOrder(items) {
        items.forEach((item, i) => {
            if (this._grid.get_child_at_index(i + 1) !== item)
                this._grid.set_child_at_index(item, i + 1);
        });
    }

    commitOrder() {
        const ids = this.gridItems().map(item => this.idOf(item));
        // Hidden items keep their relative order after the visible ones
        const hidden = this.hiddenItems().map(item => this.idOf(item));
        this._settings.set_strv('order', [...ids, ...hidden]);
    }

    setHidden(item, hide) {
        const id = this.idOf(item);
        const hidden = new Set(this._settings.get_strv('hidden'));
        const shown = new Set(this._settings.get_strv('shown-builtins'));
        if (hide) {
            hidden.add(id);
            shown.delete(id);
        } else {
            hidden.delete(id);
            if (id.startsWith(BUILTIN_PREFIX))
                shown.add(id);
        }
        this._settings.set_strv('shown-builtins', [...shown]);
        this._settings.set_strv('hidden', [...hidden]);
    }

    get columnSpacing() {
        return this._layout.column_spacing;
    }

    /** Resizes the item directly, e.g. while dragging its grip; call setSpan() to save. */
    previewSpan(item, span) {
        this._setSpan(item, span);
        this._layout.layout_changed();
    }

    setSpan(item, span) {
        const spans = this._settings.get_value('spans').deepUnpack();
        spans[this.idOf(item)] = span;
        this._settings.set_value('spans', new GLib.Variant('a{si}', spans));
    }

    /** Shows a hidden item at the given position among the grid items. */
    showAt(item, index) {
        const id = this.idOf(item);
        const ids = this.gridItems().map(i => this.idOf(i));
        ids.splice(Math.clamp(index, 0, ids.length), 0, id);
        const hidden = this.hiddenItems().map(i => this.idOf(i)).filter(h => h !== id);
        this._settings.set_strv('order', [...ids, ...hidden]);
        this.setHidden(item, false);
    }

    setColumns(columns) {
        this._settings.set_int('columns', Math.clamp(columns, 1, 6));
    }

    reset() {
        for (const key of LAYOUT_RESET_KEYS)
            this._settings.reset(key);
    }

    // --- internals ---

    _items() {
        return this._natural.filter(actor => actor !== this._placeholder);
    }

    _cancelApply() {
        if (this._applyId) {
            GLib.source_remove(this._applyId);
            this._applyId = 0;
        }
    }

    // The grid is destroyed with its items on shutdown; there is nothing left to restore
    _onGridDestroyed() {
        this._cancelApply();
        this._settings.disconnectObject(this);
        this._parking.destroy();
        this._editButton = null;
        this._states.clear();
        this._natural = [];
        this._grid = null;
    }

    _track(child, next) {
        if (child === this._placeholder || this._states.has(child))
            return;

        this._states.set(child, {id: null, origSpan: null, parked: false});
        child.connectObject('destroy', () => this._untrack(child), this);

        const index = next ? this._natural.indexOf(next) : -1;
        if (index >= 0)
            this._natural.splice(index, 0, child);
        else
            this._natural.push(child);
    }

    _untrack(child) {
        if (!this._states.delete(child))
            return;
        child.disconnectObject(this);
        this._natural = this._natural.filter(c => c !== child);
        this._queueApply();
    }

    _onChildAdded(child) {
        if (this._moving)
            return;
        this._track(child, this._intendedNext ?? child.get_next_sibling());
        this._queueApply();
    }

    _onChildRemoved(child) {
        if (!this._moving)
            this._untrack(child);
    }

    _queueApply() {
        if (this._applyId || !this._grid)
            return;
        this._applyId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._applyId = 0;
            this._apply();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getSpan(item) {
        return this._layout.get_child_meta(this._grid, item).columnSpan;
    }

    _setSpan(item, span) {
        if (this._getSpan(item) !== span)
            this._layout.child_set_property(this._grid, item, 'column-span', span);
    }

    _park(item, state) {
        this._moving = true;
        this._grid.remove_child(item);
        this._parking.add_child(item);
        this._moving = false;
        state.parked = true;
    }

    _unpark(item, state) {
        this._moving = true;
        this._parking.remove_child(item);
        this._grid.add_child(item);
        this._moving = false;
        state.parked = false;
    }

    _assignIds() {
        const counts = new Map();
        for (const item of this._items()) {
            const base = item._quickTilesId ?? typeName(item);
            const n = (counts.get(base) ?? 0) + 1;
            counts.set(base, n);
            this._states.get(item).id = n === 1 ? base : `${base}#${n}`;
        }
    }

    _effectiveSpan(state, override, columns) {
        if (override === 0)
            return columns;
        if (override > 0)
            return Math.min(override, columns);
        // Items that are full width in Shell (sliders, system row) stay full width
        if (state.origSpan >= this._origColumns)
            return columns;
        return Math.min(state.origSpan, columns);
    }

    _apply() {
        if (!this._grid)
            return;
        const columns = this._settings.get_int('columns');
        const order = this._settings.get_strv('order');
        const hidden = new Set(this._settings.get_strv('hidden'));
        // Built-in tiles wait in the tray until the user adds them
        const shown = new Set(this._settings.get_strv('shown-builtins'));
        const isHidden = id => hidden.has(id) || (id.startsWith(BUILTIN_PREFIX) && !shown.has(id));
        const spans = this._settings.get_value('spans').deepUnpack();
        const menuWidth = this._settings.get_int('menu-width');

        this._assignIds();

        // The span is lost once an item leaves the grid, so record it first
        const items = this._items();
        for (const item of items) {
            const state = this._states.get(item);
            if (state.origSpan === null && !state.parked)
                state.origSpan = this._getSpan(item);
        }

        for (const item of items) {
            const state = this._states.get(item);
            const hide = isHidden(state.id);
            if (hide && !state.parked)
                this._park(item, state);
            else if (!hide && state.parked)
                this._unpark(item, state);
        }
        // During shutdown the grid may have been destroyed by the steps above
        if (!this._grid)
            return;

        const rank = new Map(order.map((id, i) => [id, i]));
        const sorted = items
            .map((item, i) => ({item, key: rank.get(this._states.get(item).id) ?? order.length + i}))
            .sort((a, b) => a.key - b.key)
            .map(({item}) => item)
            .filter(item => !this._states.get(item).parked);

        if (this._grid.get_child_at_index(0) !== this._placeholder)
            this._grid.set_child_at_index(this._placeholder, 0);
        this.previewOrder(sorted);

        if (this._layout.nColumns !== columns)
            this._layout.nColumns = columns;
        for (const item of sorted) {
            const state = this._states.get(item);
            this._setSpan(item, this._effectiveSpan(state, spans[state.id], columns));
        }

        this._grid.width = menuWidth > 0 ? menuWidth : -1;
        this._layout.layout_changed();

        this._syncEditButton();
        this.onApplied?.();
    }

    _syncEditButton() {
        if (!this._settings.get_boolean('show-edit-button')) {
            this._editButton?.destroy();
            this._editButton = null;
            return;
        }
        if (this._editButton?.get_parent() || !this.createEditButton)
            return;

        const box = this._items().find(item => item.constructor.name === 'SystemItem')?.child;
        if (!box)
            return;
        const settingsItem = [...box].find(child => child.constructor.name === 'SettingsItem') ?? null;
        this._editButton ??= this.createEditButton();
        box.insert_child_above(this._editButton, settingsItem);
    }
}
