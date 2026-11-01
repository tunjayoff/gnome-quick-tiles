// Exercises quicktiles@tunjayoff inside a real (headless) GNOME Shell.
// Results are written to the Shell log as "PROBE ..." lines.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'quicktiles@tunjayoff';
const OUT = GLib.getenv('PROBE_OUT');

const menu = () => Main.panel.statusArea.quickSettings.menu;
const grid = () => menu()._grid;
const items = () => [...grid()].filter(c => c !== grid().layout_manager._overlay);
const span = c => grid().layout_manager.get_child_meta(grid(), c).columnSpan;
const name = c => c._quickTilesId ?? c.constructor.name;
const find = n => items().find(c => name(c) === n);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

function check(cond, what) {
    console.log(`PROBE ${cond ? 'ok' : 'FAIL'}: ${what}`);
}

async function screenshot(file) {
    const stream = Gio.File.new_for_path(`${OUT}/${file}`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const shooter = new Shell.Screenshot();
    await new Promise((resolve, reject) => shooter.screenshot(false, stream, (o, res) => {
        try {
            o.screenshot_finish(res);
            resolve();
        } catch (e) {
            reject(e);
        }
    }));
    stream.close(null);
}

// Real pointer input through a virtual device, so the whole event path is exercised
const pointer = global.stage.context.get_backend().get_default_seat()
    .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
const now = () => GLib.get_monotonic_time();

function center(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return [x + w / 2, y + h / 2];
}

async function moveTo(x, y) {
    pointer.notify_absolute_motion(now(), x, y);
    await sleep(40);
}

async function button(state) {
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, state);
    await sleep(60);
}

async function click(actor) {
    await moveTo(...center(actor));
    await button(Clutter.ButtonState.PRESSED);
    await button(Clutter.ButtonState.RELEASED);
    await sleep(300);
}

async function drag(fromActor, to) {
    const [x1, y1] = center(fromActor);
    const [x2, y2] = to;
    await moveTo(x1, y1);
    await button(Clutter.ButtonState.PRESSED);
    for (let i = 1; i <= 12; i++)
        await moveTo(x1 + (x2 - x1) * i / 12, y1 + (y2 - y1) * i / 12);
    await sleep(200);
    await button(Clutter.ButtonState.RELEASED);
    await sleep(400);
}

function findActor(root, pred) {
    if (pred(root))
        return root;
    for (const child of root) {
        const found = findActor(child, pred);
        if (found)
            return found;
    }
    return null;
}

const byClass = cls => findActor(menu().actor, a => a.has_style_class_name?.(cls) && a.mapped);
const chipFor = item => findActor(menu().actor, a => a.hiddenItem === item && a.mapped);

async function layoutChecks(settings) {
    const shellOrder = items().filter(c => !c._quickTilesId).map(name);
    const shellSpans = items().filter(c => !c._quickTilesId).map(span);

    check(find('custom:flag') && find('custom:btn'), 'command tiles were added');
    check(!items().some(c => c._quickTilesId?.startsWith('builtin:')), 'built-in tiles start outside the menu');

    settings.set_strv('shown-builtins', ['builtin:location', 'builtin:keep-awake', 'builtin:touchpad']);
    await sleep(400);
    for (const id of ['location', 'keep-awake'])
        check(find(`builtin:${id}`)?.visible, `showing the built-in ${id} tile adds it to the menu`);
    check(find('builtin:touchpad') && !find('builtin:touchpad').visible, 'touchpad tile stays invisible without a touchpad');
    settings.set_strv('shown-builtins', ['builtin:location']);
    await sleep(400);

    const location = find('builtin:location');
    const locationSettings = new Gio.Settings({schema_id: 'org.gnome.system.location'});
    const wasEnabled = locationSettings.get_boolean('enabled');
    location.emit('clicked', 1);
    await sleep(300);
    check(locationSettings.get_boolean('enabled') === !wasEnabled && location.checked === !wasEnabled,
        'the location tile toggles location services');
    location.emit('clicked', 1);
    await sleep(300);
    const names = items().map(name);
    check(names.indexOf('custom:flag') < names.indexOf('BackgroundAppsToggle'),
        'command tiles come before background apps');

    settings.set_int('columns', 3);
    settings.set_value('spans', new GLib.Variant('a{si}', {'custom:btn': 2}));
    await sleep(400);
    check(grid().layout_manager.nColumns === 3, 'column count is 3');
    check(span(find('custom:btn')) === 2, 'custom button spans 2 columns');

    const flag = find('custom:flag');
    flag.emit('clicked', 1);
    await sleep(800);
    check(flag.checked && flag.subtitle === 'On', 'toggle tile turned on');
    find('custom:btn').emit('clicked', 1);
    await sleep(500);
    check(GLib.file_test(`${OUT}/clicked`, GLib.FileTest.EXISTS), 'button tile ran its command');

    await Main.extensionManager.disableExtension(UUID);
    await sleep(500);
    check(grid().layout_manager.nColumns === 2, 'disable restored the column count');
    check(JSON.stringify(items().map(name)) === JSON.stringify(shellOrder), 'disable restored the Shell order');
    check(JSON.stringify(items().map(span)) === JSON.stringify(shellSpans), 'disable restored the widths');
    check(!items().some(c => c._quickTilesId), 'disable removed the command tiles');

    await Main.extensionManager.enableExtension(UUID);
    await sleep(1000);
    check(grid().layout_manager.nColumns === 3, 're-enable applied the settings again');
    check(!!find('custom:flag'), 're-enable brought the command tiles back');
}

async function editModeChecks(settings) {
    settings.set_int('columns', 2);
    settings.set_value('spans', new GLib.Variant('a{si}', {}));
    // The virtual pointer reports its first motion at the old position; move it once beforehand
    await moveTo(20, 600);
    await moveTo(20, 600);
    await sleep(300);

    menu().open();
    await sleep(800);
    const system = find('SystemItem');
    const pencil = [...system.child].find(c => c.constructor.name === 'EditButton');
    check(!!pencil, 'edit button is in the system row');
    await click(pencil);
    check(menu().isOpen, 'menu stays open in edit mode');
    check(!!byClass('qt-edit-header'), 'edit header is shown');
    check(!!byClass('qt-tray'), 'hidden tiles tray is shown');
    const visible = items().filter(c => c.visible);
    const chromes = () => [...findActor(menu().actor, a => a.has_style_class_name?.('qt-edit-tile'))?.get_parent() ?? []]
        .filter(a => a.has_style_class_name?.('qt-edit-tile'));
    check(chromes().length === visible.length, `a frame over every visible tile (${chromes().length}/${visible.length})`);

    // Drag the first small toggle onto the next one
    const toggles = visible.filter(c => span(c) === 1);
    const [a, b] = toggles;
    const before = items().indexOf(a) < items().indexOf(b);
    await drag(chromes().find(c => c.item === a), center(b));
    const order = settings.get_strv('order');
    const ia = order.findIndex(id => id.endsWith(a.constructor.name) || id === a._quickTilesId);
    const ib = order.findIndex(id => id.endsWith(b.constructor.name) || id === b._quickTilesId);
    check(before && ia > ib, `dragging ${name(a)} onto ${name(b)} reordered them`);
    check(items().indexOf(a) > items().indexOf(b), 'grid follows the new order');

    await screenshot('edit-mode.png');

    // Drag a tile into the tray to hide it
    await drag(chromes().find(c => c.item === a), center(byClass('qt-tray')));
    check(!a.get_parent() || a.get_parent() !== grid(), `dropping ${name(a)} on the tray hid it`);
    check(settings.get_strv('hidden').length === 1, 'hidden setting has one entry');
    await screenshot('edit-mode-tray.png');

    // Bring it back from the tray
    const chip = chipFor(a);
    check(!!chip, 'tray shows the hidden tile');
    check(!!byClass('qt-tray-scroll') && !!findActor(menu().actor, x => x.hiddenItem?._quickTilesId === 'builtin:keep-awake'),
        'built-in tiles wait in the scrollable tray');
    check(!findActor(menu().actor, x => x.hiddenItem?._quickTilesId === 'builtin:touchpad'),
        'tiles the system keeps invisible are left out of the tray');
    await click(chip);
    check(a.get_parent() === grid(), 'pressing the tray chip brought it back');

    // Hide with the − badge
    const remove = findActor(chromes().find(c => c.item === b), x => x.has_style_class_name?.('qt-badge-remove'));
    await click(remove);
    check(b.get_parent() !== grid(), `the − badge hid ${name(b)}`);
    await click(chipFor(b));

    // Dragging the grip on the right edge resizes the tile
    const target = items().find(c => c.visible && span(c) === 1 && c.get_allocation_box().x1 === 0);
    const grip = chromes().find(c => c.item === target).grip;
    const [gx, gy] = center(grip);
    await moveTo(gx, gy);
    await button(Clutter.ButtonState.PRESSED);
    for (let i = 1; i <= 8; i++)
        await moveTo(gx + target.width * i / 8, gy);
    await sleep(200);
    check(span(target) === 2, `dragging the grip widens ${name(target)} live`);
    await screenshot('edit-mode-resize.png');
    await button(Clutter.ButtonState.RELEASED);
    await sleep(400);
    check(span(target) === 2 && Object.values(settings.get_value('spans').deepUnpack()).includes(2),
        'releasing the grip saves the width');

    // Drag a hidden tile from the tray to a spot in the grid
    const moved = items().find(c => c.visible && c._quickTilesId === 'builtin:location');
    await click(findActor(chromes().find(c => c.item === moved), x => x.has_style_class_name?.('qt-badge-remove')));
    check(!settings.get_strv('shown-builtins').includes('builtin:location'), 'the − badge sends a built-in tile back to the tray');
    const spot = items().find(c => c.visible && c.constructor.name === 'DarkModeToggle');
    const [sx, sy] = spot.get_transformed_position();
    await drag(chipFor(moved), [sx + 6, sy + spot.height / 2]);
    check(moved.get_parent() === grid(), 'a tile dragged out of the tray is shown again');
    const gridOrder = items().filter(c => c.visible);
    check(gridOrder.indexOf(moved) === gridOrder.indexOf(spot) - 1,
        `it lands right before ${name(spot)}`);
    check(settings.get_strv('shown-builtins').includes('builtin:location'), 'and is remembered as shown');

    // Columns from the header
    const header = byClass('qt-edit-header');
    const plus = [...header].find(c => c.accessible_name === 'More columns');
    await click(plus);
    check(grid().layout_manager.nColumns === 3, 'the + button added a column');
    await sleep(300);
    check(chromes().length === items().filter(c => c.visible).length, 'frames follow the new layout');
    await screenshot('edit-mode-3col.png');

    const done = [...header].find(c => c.label === 'Done');
    await click(done);
    check(!byClass('qt-edit-header') && !byClass('qt-edit-tile'), 'Done leaves edit mode');
    check(menu().isOpen, 'menu is still open after Done');

    // Closing the menu while editing also leaves edit mode
    await click(pencil);
    menu().close();
    await sleep(500);
    check(!byClass('qt-edit-header') && !findActor(menu().actor, x => x.has_style_class_name?.('qt-edit-tile')),
        'closing the menu leaves edit mode');

    // Disabling while editing cleans up
    menu().open();
    await sleep(600);
    await click(pencil);
    await Main.extensionManager.disableExtension(UUID);
    await sleep(400);
    check(!findActor(menu().actor, x => x.has_style_class_name?.('qt-edit-tile')) &&
        !findActor(menu().actor, x => x.has_style_class_name?.('qt-edit-header')), 'disable while editing cleans up');
    await Main.extensionManager.enableExtension(UUID);
    menu().close();
}

async function prefsChecks() {
    Main.extensionManager.openExtensionPrefs(UUID, '', {});
    let window = null;
    for (let i = 0; i < 40 && !window; i++) {
        await sleep(250);
        window = global.display.list_all_windows().find(w => w.get_title()?.includes('Quick Tiles'));
    }
    check(!!window, 'preferences window opened');
    await sleep(1500);
    await screenshot('prefs.png');
    if (GLib.getenv('PROBE_PREFS_CLICKS')) {
        for (const [i, xy] of GLib.getenv('PROBE_PREFS_CLICKS').split(';').entries()) {
            const [x, y] = xy.split(',').map(Number);
            await moveTo(x, y);
            await button(Clutter.ButtonState.PRESSED);
            await button(Clutter.ButtonState.RELEASED);
            await sleep(1200);
            await screenshot(`prefs-${i + 1}.png`);
        }
    }
    // A client still open when the headless Shell is killed causes unrelated criticals
    window?.delete(global.get_current_time());
    await sleep(1000);
}

// Same steps as the Looking Glass one-liner printed by install.sh
async function reloadChecks() {
    const m = Main.extensionManager;
    const dir = GLib.getenv('PROBE_RELOAD_DIR');
    await m.unloadExtension(m.lookup(UUID));
    await m.loadExtension(m.createExtensionObject(UUID, Gio.File.new_for_path(dir), 2));
    m.enableExtension(UUID);
    await sleep(1000);
    const ext = m.lookup(UUID);
    check(ext?.state === 1 && ext.path === dir, 'reload from a new folder is active');
    const pencil = [...find('SystemItem').child].filter(c => c.constructor.name === 'EditButton');
    check(pencil.length === 1, 'exactly one edit button after reload');
    check(!!find('custom:flag'), 'command tiles are back after reload');
}

async function run() {
    await sleep(5000);
    const settings = Extension.lookupByUUID(UUID).getSettings();
    await layoutChecks(settings);
    await editModeChecks(settings);
    await reloadChecks();
    await prefsChecks();
    console.log('PROBE done');
}

export default class Probe extends Extension {
    enable() {
        // Re-enabling an extension makes Shell re-enable the ones after it too
        if (globalThis.quicktilesProbeStarted)
            return;
        globalThis.quicktilesProbeStarted = true;
        run().catch(e => console.log(`PROBE FAIL: ${e}\n${e.stack}`));
    }

    disable() {}
}
