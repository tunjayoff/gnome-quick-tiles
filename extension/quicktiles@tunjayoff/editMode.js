import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {registerClass} from './gtype.js';
import {itemIcon, itemLabel} from './layout.js';

const DRAG_THRESHOLD = 8;

// Corner resize grip: an arc that follows the tile's bottom-right corner, just outside it
const GRIP_GAP = 3;
const GRIP_STROKE = 3.5;
const GRIP_SWEEP = 0.6; // half the arc's angle, in radians
const GRIP_MIN_RADIUS = 12;

function iconFor(item) {
    const icon = itemIcon(item);
    try {
        return Gio.Icon.new_for_string(icon || 'application-x-executable-symbolic');
    } catch {
        return Gio.ThemedIcon.new('application-x-executable-symbolic');
    }
}

/** A box that takes the menu's width instead of asking for its own, so it never widens the menu. */
const FlexibleBox = registerClass('QuickTilesFlexibleBox',
class FlexibleBox extends St.BoxLayout {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
});

/** Samsung-style resize handle hugging the tile's bottom-right corner. */
const CornerGrip = registerClass('QuickTilesCornerGrip',
class CornerGrip extends St.DrawingArea {
    _init(tile) {
        super._init({style_class: 'qt-resize-grip', reactive: true, track_hover: true});
        this._tile = tile;
        this.set_cursor_type(Clutter.CursorType.GRAB);
        // The arc's center sits at the grip's origin, on the tile's corner circle
        this._extent = GRIP_GAP + GRIP_STROKE + 1;
        this.translation_x = this._extent;
        this.translation_y = this._extent;
        this.connect('style-changed', () => this.queue_repaint());
        this.connect('repaint', () => this._draw());
        this.updateSize();
    }

    updateSize() {
        const corner = this._tile.get_theme_node().get_border_radius(St.Corner.BOTTOMRIGHT);
        const fits = Math.min(this._tile.width, this._tile.height) / 2;
        this._radius = Math.max(Math.min(corner, fits), GRIP_MIN_RADIUS);
        const size = Math.ceil(this._radius + this._extent);
        this.set_size(size, size);
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const color = this.get_theme_node().get_foreground_color();
        const radius = this._radius + GRIP_GAP;
        const [from, to] = [Math.PI / 4 - GRIP_SWEEP, Math.PI / 4 + GRIP_SWEEP];
        cr.setLineCap(Cairo.LineCap.ROUND);

        // A soft dark edge keeps it visible on light tiles too
        cr.setLineWidth(GRIP_STROKE + 2);
        cr.setSourceRGBA(0, 0, 0, 0.25);
        cr.arc(0, 0, radius, from, to);
        cr.stroke();

        cr.setLineWidth(GRIP_STROKE);
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        cr.arc(0, 0, radius, from, to);
        cr.stroke();
        cr.$dispose();
    }
});

/** Invisible handle over a tile in edit mode, with a hide badge and a resize grip. */
const TileChrome = registerClass('QuickTilesTileChrome',
class TileChrome extends St.Widget {
    _init(item, onHide) {
        super._init({
            style_class: 'qt-edit-tile',
            reactive: true,
        });
        this.item = item;
        this.set_cursor_type(Clutter.CursorType.GRAB);
        // The edit layer shares the grid's coordinate space, so the tile's allocation maps 1:1
        this.add_constraint(new Clutter.BindConstraint({
            source: item,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        const remove = new St.Button({
            style_class: 'qt-badge-remove',
            child: new St.Icon({icon_name: 'list-remove-symbolic', style_class: 'qt-badge-icon'}),
            can_focus: true,
            accessible_name: `Hide ${itemLabel(item)}`,
        });
        remove.set_position(-4, -4);
        remove.set_cursor_type(Clutter.CursorType.DEFAULT);
        remove.connect('clicked', () => onHide(item));
        this.add_child(remove);

        this.grip = new CornerGrip(item);
        this.grip.add_constraint(new Clutter.AlignConstraint({
            source: this,
            align_axis: Clutter.AlignAxis.BOTH,
            factor: 1,
        }));
        this.connect('notify::height', () => this.grip.updateSize());
        this.add_child(this.grip);

        this.spanLabel = new St.Label({style_class: 'qt-span-label', visible: false});
        this.spanLabel.add_constraint(new Clutter.AlignConstraint({
            source: this,
            align_axis: Clutter.AlignAxis.BOTH,
            factor: 0.5,
        }));
        this.add_child(this.spanLabel);
    }
});

/**
 * Android-style editing inside the Quick Settings menu: drag tiles to reorder, drag the
 * grip on their right edge to resize, drop them on the tray (or press −) to hide, and drag
 * or press tiles in the tray to bring them back.
 */
export class EditMode {
    constructor(controller) {
        this._controller = controller;
        this._chromes = [];
        this._press = null;
    }

    get active() {
        return !!this._layer;
    }

    enter() {
        if (this.active)
            return;
        const menu = this._controller.menu;
        const grid = this._controller.grid;
        this._menu = menu;
        this._grid = grid;

        for (const item of this._controller.gridItems())
            item.menu?.close?.();

        this._header = this._buildHeader();
        menu.box.insert_child_below(this._header, grid);
        this._tray = this._buildTray();
        menu.box.insert_child_above(this._tray, grid);

        // The layer lives inside menu.actor so it stays within the menu's input grab
        this._layer = new St.Widget({reactive: true});
        this._layer.connect('captured-event', (_actor, event) => this._onLayerEvent(event));
        menu.actor.add_child(this._layer);
        this._bindLayerToGrid();

        this._dropMarker = new St.Widget({style_class: 'qt-drop-marker', visible: false});
        this._layer.add_child(this._dropMarker);

        menu.connectObject('open-state-changed', (_menu, open) => {
            if (!open)
                this.exit();
        }, this);
        this._controller.onApplied = () => this._refresh();
        this._refresh();
    }

    exit() {
        if (!this.active)
            return;
        this._endPress(false);
        this._controller.onApplied = null;
        this._menu.disconnectObject(this);
        for (const actor of [this._grid, this._menu.box, this._menu._boxPointer.bin])
            actor.disconnectObject(this);
        this._chromes = [];
        this._layer.destroy();
        this._layer = null;
        this._dropMarker = null;
        this._header.destroy();
        this._header = null;
        this._tray.destroy();
        this._tray = null;
    }

    // Same approach Shell uses for the submenu overlay: follow the box pointer plus the grid's offset
    _bindLayerToGrid() {
        const boxPointer = this._menu._boxPointer;
        const xConstraint = new Clutter.BindConstraint({coordinate: Clutter.BindCoordinate.X, source: boxPointer});
        const yConstraint = new Clutter.BindConstraint({coordinate: Clutter.BindCoordinate.Y, source: boxPointer});
        this._layer.add_constraint(xConstraint);
        this._layer.add_constraint(yConstraint);
        this._layer.add_constraint(new Clutter.BindConstraint({
            coordinate: Clutter.BindCoordinate.SIZE,
            source: this._grid,
        }));

        const update = () => {
            global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                if (this._layer) {
                    const offset = this._grid.apply_relative_transform_to_point(
                        boxPointer, new Graphene.Point3D());
                    xConstraint.offset = offset.x;
                    yConstraint.offset = offset.y;
                }
                return GLib.SOURCE_REMOVE;
            });
        };
        for (const actor of [this._grid, this._menu.box, boxPointer.bin])
            actor.connectObject('notify::x', update, 'notify::y', update, this);
        update();
    }

    _buildHeader() {
        const header = new FlexibleBox({style_class: 'qt-edit-header'});
        header.add_child(new St.Label({
            text: 'Edit Tiles',
            style_class: 'qt-edit-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const fewer = this._headerButton('list-remove-symbolic', 'Fewer columns',
            () => this._controller.setColumns(this._controller.columns - 1));
        this._columnsLabel = new St.Label({style_class: 'qt-columns-label', y_align: Clutter.ActorAlign.CENTER});
        const more = this._headerButton('list-add-symbolic', 'More columns',
            () => this._controller.setColumns(this._controller.columns + 1));
        const reset = this._headerButton('edit-undo-symbolic', 'Reset layout', () => this._controller.reset());
        const done = new St.Button({
            style_class: 'qt-done-button button',
            label: 'Done',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        done.connect('clicked', () => this.exit());

        for (const actor of [fewer, this._columnsLabel, more, reset, done])
            header.add_child(actor);
        return header;
    }

    _headerButton(icon, name, onClick) {
        const button = new St.Button({
            style_class: 'qt-header-button icon-button',
            icon_name: icon,
            accessible_name: name,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    _buildTray() {
        const tray = new FlexibleBox({
            style_class: 'qt-tray',
            orientation: Clutter.Orientation.VERTICAL,
            // Only reactive actors get captured events
            reactive: true,
        });
        tray.add_child(new St.Label({text: 'Hidden Tiles', style_class: 'qt-tray-title'}));
        this._trayHint = new St.Label({style_class: 'qt-tray-hint'});
        this._trayHint.clutter_text.line_wrap = true;
        tray.add_child(this._trayHint);
        this._trayGrid = new St.Viewport({
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, row_spacing: 6, column_spacing: 6}),
        });
        // Many tiles can wait here, so the tray scrolls instead of growing the menu
        tray.add_child(new St.ScrollView({
            style_class: 'qt-tray-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._trayGrid,
        }));
        // Chips are dragged by the same code as tiles; the press starts here, the rest goes to the layer
        tray.connect('captured-event', (_actor, event) => this._onTrayEvent(event));
        return tray;
    }

    _refresh() {
        if (!this.active)
            return;
        const columns = this._controller.columns;
        this._columnsLabel.text = `${columns} ${columns === 1 ? 'column' : 'columns'}`;

        this._chromes.forEach(chrome => chrome.destroy());
        this._chromes = this._controller.gridItems()
            .filter(item => item.visible)
            .map(item => {
                const chrome = new TileChrome(item, i => this._controller.setHidden(i, true));
                this._layer.insert_child_below(chrome, this._dropMarker);
                return chrome;
            });

        this._trayGrid.destroy_all_children();
        const layout = this._trayGrid.layout_manager;
        // Tiles Shell keeps invisible (e.g. Touchpad without a touchpad) would show nothing if added
        const hidden = this._controller.hiddenItems().filter(item => item.visible);
        hidden.forEach((item, i) => {
            layout.attach(this._trayChip(item), i % 2, Math.floor(i / 2), 1, 1);
        });
        this._trayHint.text = hidden.length
            ? 'Drag a tile up to place it, or press it to add it at the end. Drag tiles here to hide them.'
            : 'Drag a tile here to hide it.';
    }

    _trayChip(item) {
        const box = new St.BoxLayout({style_class: 'qt-tray-chip-box', x_expand: true});
        box.add_child(new St.Icon({gicon: iconFor(item), style_class: 'qt-tray-chip-icon'}));
        const label = new St.Label({
            text: itemLabel(item),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        box.add_child(new St.Icon({icon_name: 'list-add-symbolic', style_class: 'qt-tray-chip-add'}));

        const chip = new St.Button({
            style_class: 'qt-tray-chip button',
            child: box,
            x_expand: true,
            can_focus: true,
            accessible_name: `Show ${itemLabel(item)}`,
        });
        chip.set_cursor_type(Clutter.CursorType.GRAB);
        chip.hiddenItem = item;
        // Keyboard activation; pointer presses are handled as drags in _onTrayEvent
        chip.connect('clicked', () => this._controller.setHidden(item, false));
        return chip;
    }

    // --- pointer handling ---

    _isPress(event) {
        const type = event.type();
        return (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) ||
            type === Clutter.EventType.TOUCH_BEGIN;
    }

    _startPress(event, props) {
        const [x, y] = event.get_coords();
        this._press = {
            startX: x,
            startY: y,
            dragging: false,
            lastTarget: null,
            grab: global.stage.grab(this._layer),
            ...props,
        };
    }

    _onTrayEvent(event) {
        if (this._press || !this._isPress(event))
            return Clutter.EVENT_PROPAGATE;
        let chip = global.stage.get_event_actor(event);
        while (chip && !chip.hiddenItem && chip !== this._tray)
            chip = chip.get_parent();
        if (!chip?.hiddenItem)
            return Clutter.EVENT_PROPAGATE;
        this._startPress(event, {mode: 'tray', chip, item: chip.hiddenItem});
        return Clutter.EVENT_STOP;
    }

    _onLayerEvent(event) {
        const type = event.type();

        if (!this._press) {
            if (!this._isPress(event))
                return Clutter.EVENT_PROPAGATE;
            const target = global.stage.get_event_actor(event);
            let chrome = null;
            for (let a = target; a && a !== this._layer; a = a.get_parent()) {
                if (a instanceof St.Button)
                    return Clutter.EVENT_PROPAGATE;
                if (a instanceof TileChrome) {
                    chrome = a;
                    break;
                }
            }
            if (!chrome)
                return Clutter.EVENT_PROPAGATE;
            const onGrip = chrome.grip.contains(target);
            this._startPress(event, {mode: onGrip ? 'resize' : 'move', chrome, item: chrome.item});
            if (onGrip)
                this._beginResize();
            return Clutter.EVENT_STOP;
        }

        switch (type) {
        case Clutter.EventType.MOTION:
        case Clutter.EventType.TOUCH_UPDATE: {
            const [x, y] = event.get_coords();
            if (this._press.mode === 'resize') {
                this._updateResize(x);
                return Clutter.EVENT_STOP;
            }
            if (!this._press.dragging &&
                Math.hypot(x - this._press.startX, y - this._press.startY) >= DRAG_THRESHOLD)
                this._beginDrag();
            if (this._press.dragging)
                this._updateDrag(x, y);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.BUTTON_RELEASE:
        case Clutter.EventType.TOUCH_END:
            this._endPress(true, ...event.get_coords());
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_CANCEL:
            this._endPress(false);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_STOP;
        }
    }

    _toLayer(x, y) {
        const [, lx, ly] = this._layer.transform_stage_point(x, y);
        return [lx, ly];
    }

    _isOver(actor, x, y) {
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        return x >= ax && x < ax + aw && y >= ay && y < ay + ah;
    }

    // --- resizing ---

    _beginResize() {
        const press = this._press;
        press.left = press.item.get_allocation_box().x1;
        press.span = this._controller.spanOf(press.item);
        press.origSpan = press.span;
        press.chrome.add_style_class_name('qt-resizing');
        this._showSpan(press);
    }

    _showSpan(press) {
        press.chrome.spanLabel.text = `${press.span}/${this._controller.columns}`;
        press.chrome.spanLabel.show();
    }

    _updateResize(x) {
        const press = this._press;
        const columns = this._controller.columns;
        const spacing = this._controller.columnSpacing;
        const column = (this._grid.width - (columns - 1) * spacing) / columns;
        const [lx] = this._toLayer(x, 0);
        const span = Math.clamp(Math.round((lx - press.left + spacing) / (column + spacing)), 1, columns);
        if (span === press.span)
            return;
        press.span = span;
        this._controller.previewSpan(press.item, span);
        this._showSpan(press);
    }

    // --- dragging ---

    _beginDrag() {
        const press = this._press;
        press.dragging = true;
        const source = press.mode === 'tray' ? press.chip : press.item;
        const [sx, sy] = source.get_transformed_position();
        const [lx, ly] = this._toLayer(sx, sy);
        const [px, py] = this._toLayer(press.startX, press.startY);
        press.offsetX = px - lx;
        press.offsetY = py - ly;
        press.clone = new Clutter.Clone({
            source,
            width: source.width,
            height: source.height,
            opacity: 230,
        });
        this._layer.add_child(press.clone);
        press.clone.set_position(lx, ly);
        if (press.mode === 'move')
            press.item.opacity = 70;
        else
            press.chip.opacity = 90;
    }

    _tileAt(lx, ly) {
        return this._controller.gridItems().find(item => {
            if (!item.visible)
                return false;
            const box = item.get_allocation_box();
            return lx >= box.x1 && lx < box.x2 && ly >= box.y1 && ly < box.y2;
        }) ?? null;
    }

    _updateDrag(x, y) {
        const press = this._press;
        const [lx, ly] = this._toLayer(x, y);
        press.clone.set_position(lx - press.offsetX, ly - press.offsetY);

        if (press.mode === 'tray') {
            this._updateDropMarker(x, y, lx, ly);
            return;
        }

        const overTray = this._isOver(this._tray, x, y);
        if (overTray)
            this._tray.add_style_pseudo_class('drop');
        else
            this._tray.remove_style_pseudo_class('drop');
        if (overTray)
            return;

        const target = this._tileAt(lx, ly);
        // Only react when entering a new tile, so tiles of different sizes don't swap back and forth
        if (!target || target === press.lastTarget) {
            if (!target)
                press.lastTarget = null;
            return;
        }
        press.lastTarget = target;
        if (target === press.item)
            return;

        // Take the target's place: dragging forward lands after it, backward before it
        const items = this._controller.gridItems();
        const to = items.indexOf(target);
        items.splice(items.indexOf(press.item), 1);
        items.splice(to, 0, press.item);
        this._controller.previewOrder(items);
    }

    /** Where a tile dragged from the tray would land: an index among the grid items, or -1. */
    _dropIndex(x, y, lx, ly) {
        if (!this._isOver(this._grid, x, y))
            return -1;
        const items = this._controller.gridItems();
        const target = this._tileAt(lx, ly);
        if (!target)
            return items.length;
        const box = target.get_allocation_box();
        return items.indexOf(target) + (lx > (box.x1 + box.x2) / 2 ? 1 : 0);
    }

    _updateDropMarker(x, y, lx, ly) {
        const target = this._tileAt(lx, ly);
        if (!this._isOver(this._grid, x, y) || !target) {
            this._dropMarker.hide();
            return;
        }
        const box = target.get_allocation_box();
        const after = lx > (box.x1 + box.x2) / 2;
        this._dropMarker.set_position(after ? box.x2 : box.x1 - 4, box.y1);
        this._dropMarker.height = box.y2 - box.y1;
        this._dropMarker.show();
    }

    _endPress(commit, x, y) {
        const press = this._press;
        if (!press)
            return;
        this._press = null;
        press.grab.dismiss();
        this._dropMarker?.hide();

        if (press.mode === 'resize') {
            press.chrome.spanLabel.hide();
            press.chrome.remove_style_class_name('qt-resizing');
            if (commit && press.span !== press.origSpan)
                this._controller.setSpan(press.item, press.span);
            else if (!commit)
                this._controller.previewSpan(press.item, press.origSpan);
            return;
        }

        if (!press.dragging) {
            // A tap on a tray chip adds the tile at the end
            if (commit && press.mode === 'tray')
                this._controller.setHidden(press.item, false);
            return;
        }

        press.clone.destroy();
        if (press.mode === 'tray') {
            press.chip.opacity = 255;
            if (commit) {
                const [lx, ly] = this._toLayer(x, y);
                const index = this._dropIndex(x, y, lx, ly);
                if (index >= 0)
                    this._controller.showAt(press.item, index);
            }
            return;
        }

        press.item.opacity = 255;
        const dropOnTray = this._tray?.has_style_pseudo_class('drop');
        this._tray?.remove_style_pseudo_class('drop');
        if (!commit)
            return;
        this._controller.commitOrder();
        if (dropOnTray)
            this._controller.setHidden(press.item, true);
    }
}
